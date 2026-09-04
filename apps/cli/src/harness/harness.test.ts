/**
 * `sparrow harness` end-to-end, against a REAL in-process API (the pattern from
 * cli.test.ts) and a real spawned runner — a tiny node script standing in for
 * `claude -p`. The point of these tests is the contract that makes harness mode
 * worth using: peek, run, reply, and only THEN ack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@sparrow/api';
import { SparrowClient } from '@sparrow/client';
import { runCli, type CliIO } from '../index.js';

const ADMIN_TOKEN = 'test-admin-token';

let app: ReturnType<typeof buildServer>;
let dataDir: string;
let configDir: string;
let stateDir: string;
let scriptDir: string;
let url: string;
let env: Record<string, string | undefined>;

/** The fake runner: reads the prompt on stdin, logs it, prints a reply (or fails). */
const RUNNER_SOURCE = `
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  if (process.env.RUNNER_LOG) {
    fs.appendFileSync(process.env.RUNNER_LOG, JSON.stringify({ prompt }) + '\\n');
  }
  if (process.argv[2] === 'fail') {
    process.stderr.write('the fake runner exploded\\n');
    process.exit(3);
  }
  process.stdout.write(process.env.RUNNER_REPLY || 'ack from the fake runner');
  process.exit(0);
});
`;

let runnerPath: string;
let runnerLog: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-harness-api-'));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-harness-cfg-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-harness-state-'));
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-harness-runner-'));
  runnerPath = path.join(scriptDir, 'runner.cjs');
  runnerLog = path.join(scriptDir, 'runs.jsonl');
  fs.writeFileSync(runnerPath, RUNNER_SOURCE);

  app = buildServer({ dataDir, baseUrl: 'http://localhost:8722', adminToken: ADMIN_TOKEN });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  env = {
    XDG_CONFIG_HOME: configDir,
    HOME: os.homedir(),
    SPARROW_STATE_DIR: stateDir,
    PATH: process.env.PATH,
    SPARROW_POLL_INTERVAL_MS: '15',
  };
});

afterEach(async () => {
  await app.close();
  for (const d of [dataDir, configDir, stateDir, scriptDir]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

interface Capture {
  io: CliIO;
  out(): string;
  err(): string;
}
function capture(): Capture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

function credentials(): {
  profiles: Record<string, { server: string; token: string; kind: string }>;
  defaultProfile?: string;
} {
  return JSON.parse(fs.readFileSync(path.join(configDir, 'sparrow', 'credentials.json'), 'utf8'));
}

/** `--exec` command line for the fake runner, with its log wired up. */
function fakeRunner(mode: 'reply' | 'fail' = 'reply', reply?: string): string {
  const replyEnv = reply === undefined ? '' : `RUNNER_REPLY=${JSON.stringify(reply)} `;
  return `${replyEnv}RUNNER_LOG=${JSON.stringify(runnerLog)} node ${JSON.stringify(runnerPath)} ${mode}`;
}

function runs(): Array<{ prompt: string }> {
  if (!fs.existsSync(runnerLog)) return [];
  return fs
    .readFileSync(runnerLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { prompt: string });
}

interface Owner {
  client: SparrowClient;
  orgId: string;
  userId: string;
}

async function boot(email = 'owner@x.com'): Promise<Owner> {
  const client = new SparrowClient({ server: url });
  const res = await client.signup({ email, password: 'password123', displayName: 'Jake Quist' });
  const orgs = await client.meOrgs();
  return { client, orgId: orgs[0]!.org.id, userId: res.user.id };
}

/** Flip the org to instant agent admission, so an invite needs no approver. */
async function openAgentPolicy(owner: Owner): Promise<void> {
  const org = await owner.client.getOrg(owner.orgId);
  await owner.client.updateOrg(owner.orgId, {
    settings: { ...org.settings, enroll: { ...org.settings.enroll, agents: 'open' } },
  });
}

async function inviteUrl(owner: Owner): Promise<string> {
  const inv = await owner.client.createInvite(owner.orgId);
  const token = inv.url.split('/invite/')[1]!;
  return `${url}/invite/${token}`;
}

/** The agent's own client, from the profile the harness just wrote. */
function agentClient(): SparrowClient {
  const creds = credentials();
  const profile = creds.profiles[creds.defaultProfile!]!;
  return new SparrowClient({ server: profile.server, token: profile.token });
}

/** A project room the owner and the agent both belong to. */
async function sharedRoom(owner: Owner, name = 'Product'): Promise<string> {
  const room = await owner.client.createRoom(owner.orgId, { name });
  const me = await agentClient().me();
  await owner.client.addMember(room.id, me.id);
  return room.id;
}

/* ================================================================== *
 * enroll-or-run
 * ================================================================== */

describe('sparrow harness — enroll then run', () => {
  it('follows an invite, saves an agent profile, and runs in one command', async () => {
    const owner = await boot();
    await openAgentPolicy(owner);
    const cap = capture();

    const code = await runCli(
      [
        'harness',
        '--url',
        await inviteUrl(owner),
        '--name',
        'harness-bot',
        '--exec',
        fakeRunner(),
        '--batch-window',
        '0',
        '--once',
      ],
      env,
      cap.io,
    );

    expect(code).toBe(0);
    const creds = credentials();
    expect(creds.profiles['harness-bot']!.kind).toBe('agent');
    expect(creds.profiles['harness-bot']!.token).toMatch(/^agk_/);
    expect(cap.out()).toContain('enrolled as harness-bot');
    // Never a token, in any mode.
    expect(cap.out()).not.toContain(creds.profiles['harness-bot']!.token);
  });

  it('waits for an approver when the org holds enrollments, then runs', async () => {
    const owner = await boot();
    const cap = capture();
    const running = runCli(
      [
        'harness',
        '--url',
        await inviteUrl(owner),
        '--name',
        'held-bot',
        '--exec',
        fakeRunner(),
        '--batch-window',
        '0',
        '--once',
      ],
      env,
      cap.io,
    );

    // Approve out-of-band, exactly as a human would from the Sparrow window.
    for (let i = 0; i < 200; i++) {
      const pending = await owner.client.listEnrollments(owner.orgId);
      if (pending.length > 0) {
        await owner.client.approveEnrollment(owner.orgId, pending[0]!.id);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(await running).toBe(0);
    expect(cap.out()).toContain('waiting for approval');
    expect(credentials().profiles['held-bot']!.token).toMatch(/^agk_/);
  });

  it('re-running with the same invite reuses the profile instead of enrolling again', async () => {
    const owner = await boot();
    await openAgentPolicy(owner);
    const invite = await inviteUrl(owner);
    const args = (): string[] => [
      'harness',
      '--url',
      invite,
      '--name',
      'once-bot',
      '--exec',
      fakeRunner(),
      '--batch-window',
      '0',
      '--once',
    ];

    expect(await runCli(args(), env, capture().io)).toBe(0);
    const first = credentials();

    const second = capture();
    expect(await runCli(args(), env, second.io)).toBe(0);
    expect(second.out()).toContain('already enrolled as once-bot');
    expect(Object.keys(credentials().profiles)).toEqual(Object.keys(first.profiles));
    expect(credentials().profiles['once-bot']!.token).toBe(first.profiles['once-bot']!.token);
    expect((await owner.client.listAgents({ org: owner.orgId })).length).toBe(1);
  });

  it('without --url and without credentials it exits 1 pointing at the invite dialog', async () => {
    const cap = capture();
    const code = await runCli(['harness', '--once'], env, cap.io);
    expect(code).toBe(1);
    expect(cap.err()).toContain('--url');
    expect(cap.err()).toContain('Invite dialog');
  });
});

/* ================================================================== *
 * the run loop
 * ================================================================== */

describe('sparrow harness — run, reply, ack', () => {
  async function enrolled(owner: Owner, name = 'run-bot'): Promise<void> {
    await openAgentPolicy(owner);
    const code = await runCli(
      ['harness', '--url', await inviteUrl(owner), '--name', name, '--exec', fakeRunner(), '--batch-window', '0', '--once'],
      env,
      capture().io,
    );
    expect(code).toBe(0);
  }

  it('posts the runner output as a reply with inReplyTo, and only then marks the item read', async () => {
    const owner = await boot();
    await enrolled(owner);
    const roomId = await sharedRoom(owner);
    const sent = await owner.client.sendMessage(roomId, { body: 'can you check the deploy?' });

    const cap = capture();
    const code = await runCli(
      ['harness', '--exec', fakeRunner('reply', 'on it — deploy looks green'), '--batch-window', '0', '--once'],
      env,
      cap.io,
    );
    expect(code).toBe(0);

    const { items } = await owner.client.listRoomMessages(roomId, { limit: 10 });
    const reply = items.find((m) => m.body === 'on it — deploy looks green');
    expect(reply).toBeDefined();
    expect(reply!.inReplyTo).toBe(sent.message.id);

    // Acked only after the reply landed: the queue is empty now.
    expect((await agentClient().meInbox()).items).toHaveLength(0);
    expect(cap.out()).toContain('replied in #Product');
  });

  it('hands the runner a prompt naming the agent, the room and the message', async () => {
    const owner = await boot();
    await enrolled(owner, 'prompt-bot');
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'what is the status?' });

    expect(
      await runCli(['harness', '--exec', fakeRunner(), '--batch-window', '0', '--once'], env, capture().io),
    ).toBe(0);

    expect(runs()).toHaveLength(1);
    const prompt = runs()[0]!.prompt;
    expect(prompt).toContain('prompt-bot');
    expect(prompt).toContain('#Product');
    expect(prompt).toContain('sparrow harness');
    expect(prompt).toContain('what is the status?');
    expect(prompt).toContain('Jake Quist');
  });

  it('a failing runner acks NOTHING and leaves the item unread', async () => {
    const owner = await boot();
    await enrolled(owner, 'fail-bot');
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'this one will fail' });

    const cap = capture();
    expect(
      await runCli(['harness', '--exec', fakeRunner('fail'), '--batch-window', '0', '--once'], env, cap.io),
    ).toBe(0);

    const inbox = await agentClient().meInbox();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.preview).toContain('this one will fail');
    expect(cap.out()).toContain('exited 3');
    expect(cap.out()).toContain('left unread');

    // And no reply was posted.
    const { items } = await owner.client.listRoomMessages(roomId, { limit: 10 });
    expect(items).toHaveLength(1);
  });

  it('posts nothing but still acks when the runner says (no reply)', async () => {
    const owner = await boot();
    await enrolled(owner, 'quiet-bot');
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'fyi, no answer needed' });

    const cap = capture();
    expect(
      await runCli(
        ['harness', '--exec', fakeRunner('reply', '(no reply)'), '--batch-window', '0', '--once'],
        env,
        cap.io,
      ),
    ).toBe(0);

    expect((await owner.client.listRoomMessages(roomId, { limit: 10 })).items).toHaveLength(1);
    expect((await agentClient().meInbox()).items).toHaveLength(0);
    expect(cap.out()).toContain('nothing to say');
  });

  it('batches two messages in one room into a single runner invocation', async () => {
    const owner = await boot();
    await enrolled(owner, 'batch-bot');
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'first thing' });
    await owner.client.sendMessage(roomId, { body: 'and another thing' });

    const cap = capture();
    expect(
      await runCli(['harness', '--exec', fakeRunner(), '--batch-window', '0', '--once'], env, cap.io),
    ).toBe(0);

    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.prompt).toContain('first thing');
    expect(runs()[0]!.prompt).toContain('and another thing');
    expect(runs()[0]!.prompt).toContain('2 new messages');
    expect(cap.out()).toContain('2 messages');
    expect((await agentClient().meInbox()).items).toHaveLength(0);
  });

  it('runs two different rooms as two separate invocations', async () => {
    const owner = await boot();
    await enrolled(owner, 'two-bot');
    const a = await sharedRoom(owner, 'Product');
    const b = await sharedRoom(owner, 'Support');
    await owner.client.sendMessage(a, { body: 'about product' });
    await owner.client.sendMessage(b, { body: 'about support' });

    expect(
      await runCli(['harness', '--exec', fakeRunner(), '--batch-window', '0', '--once'], env, capture().io),
    ).toBe(0);

    expect(runs()).toHaveLength(2);
    const prompts = runs().map((r) => r.prompt);
    expect(prompts.some((p) => p.includes('about product') && !p.includes('about support'))).toBe(true);
    expect(prompts.some((p) => p.includes('about support') && !p.includes('about product'))).toBe(true);
  });

  it('a clawed-back message is dropped before it reaches a runner', async () => {
    const owner = await boot();
    await enrolled(owner, 'claw-bot');
    const roomId = await sharedRoom(owner);
    const keep = await owner.client.sendMessage(roomId, { body: 'this one stands' });
    const pull = await owner.client.sendMessage(roomId, { body: 'ignore me' });
    await owner.client.clawbackMessage(roomId, pull.message.id);

    expect(
      await runCli(['harness', '--exec', fakeRunner(), '--batch-window', '0', '--once'], env, capture().io),
    ).toBe(0);

    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.prompt).toContain('this one stands');
    expect(runs()[0]!.prompt).not.toContain('ignore me');
    const { items } = await owner.client.listRoomMessages(roomId, { limit: 10 });
    expect(items.find((m) => m.inReplyTo === keep.message.id)).toBeDefined();
  });

  it('--once with nothing waiting exits 0 and spawns no runner', async () => {
    const owner = await boot();
    await enrolled(owner, 'idle-bot');
    await sharedRoom(owner);

    expect(
      await runCli(['harness', '--exec', fakeRunner(), '--batch-window', '0', '--once'], env, capture().io),
    ).toBe(0);
    expect(runs()).toHaveLength(0);
  });

  it('-j prints JSON events on stdout and nothing else', async () => {
    const owner = await boot();
    await enrolled(owner, 'json-bot');
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'json please' });

    const cap = capture();
    expect(
      await runCli(['harness', '--exec', fakeRunner(), '--batch-window', '0', '--once', '-j'], env, cap.io),
    ).toBe(0);

    const lines = cap.out().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    for (const e of events) expect(e.type.startsWith('harness.')).toBe(true);
    expect(events.map((e) => e.type)).toContain('harness.run.start');
    expect(events.map((e) => e.type)).toContain('harness.reply');
  });

  it('a runner that exits past --run-timeout is a failure and acks nothing', async () => {
    const owner = await boot();
    await enrolled(owner, 'slow-bot');
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'take your time' });

    const cap = capture();
    expect(
      await runCli(
        ['harness', '--exec', 'sleep 30', '--run-timeout', '1', '--batch-window', '0', '--once'],
        env,
        cap.io,
      ),
    ).toBe(0);

    expect((await agentClient().meInbox()).items).toHaveLength(1);
    expect(cap.out()).toContain('timed out');
  });

  it('truncates a very long reply and says so', async () => {
    const owner = await boot();
    await enrolled(owner, 'long-bot');
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'write me an essay' });

    const cap = capture();
    expect(
      await runCli(
        ['harness', '--exec', `RUNNER_REPLY=${'x'.repeat(9000)} ${fakeRunner()}`, '--batch-window', '0', '--once'],
        env,
        cap.io,
      ),
    ).toBe(0);

    const { items } = await owner.client.listRoomMessages(roomId, { limit: 10 });
    const reply = items.find((m) => m.body.startsWith('x'));
    expect(reply).toBeDefined();
    expect(reply!.body).toContain('(truncated');
    expect(cap.out()).toContain('truncated');
  });
});

/* ================================================================== *
 * Delivery receipts
 * ================================================================== */

describe('sparrow harness — the `received` receipt', () => {
  it('the inbox peek marks the message `received` before the reply makes it `read`', async () => {
    const owner = await boot();
    await openAgentPolicy(owner);
    expect(
      await runCli(
        ['harness', '--url', await inviteUrl(owner), '--name', 'recv-bot', '--exec', fakeRunner(), '--batch-window', '0', '--once'],
        env,
        capture().io,
      ),
    ).toBe(0);
    const roomId = await sharedRoom(owner);

    // Nothing is listening, so the send itself observes no delivery.
    const sent = await owner.client.sendMessage(roomId, { body: 'are you there?' });
    const statusOf = async (): Promise<string> =>
      (await owner.client.getMessageStatus(roomId, sent.message.id)).recipients[0]!.status;
    expect(await statusOf()).toBe('unread');

    // A runner slow enough to observe mid-flight.
    const running = runCli(
      ['harness', '--exec', 'sleep 2; echo on it', '--batch-window', '0', '--once'],
      env,
      capture().io,
    );

    const seen = new Set<string>();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      seen.add(await statusOf());
      if (seen.has('read')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await running).toBe(0);

    // "picked up" is visible to the human while the run is in flight.
    expect([...seen]).toContain('received');
    expect(await statusOf()).toBe('read');
  }, 20_000);

  it('a held events stream marks it `received` at SEND time, before any peek', async () => {
    const owner = await boot();
    await openAgentPolicy(owner);
    expect(
      await runCli(
        ['harness', '--url', await inviteUrl(owner), '--name', 'live-bot', '--exec', fakeRunner(), '--batch-window', '0', '--once'],
        env,
        capture().io,
      ),
    ).toBe(0);
    const roomId = await sharedRoom(owner);

    // Exactly what the harness's work source holds open for the whole process.
    const stream = agentClient().meEvents(() => {}, { quiet: ['presence', 'status'] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('stream never opened')), 5_000);
      const tick = setInterval(async () => {
        const statuses = await owner.client.listStatuses(roomId);
        if (statuses.presence.online.length > 0) {
          clearInterval(tick);
          clearTimeout(deadline);
          resolve();
        }
      }, 25);
    });

    try {
      const sent = await owner.client.sendMessage(roomId, { body: 'you are listening' });
      const status = await owner.client.getMessageStatus(roomId, sent.message.id);
      // No inbox call has happened: this receipt is the SSE write itself.
      expect(status.recipients[0]!.status).toBe('received');
    } finally {
      stream.close();
    }
  }, 20_000);
});

/* ================================================================== *
 * Banner + prompt say WHERE, in words
 * ================================================================== */

describe('sparrow harness — naming the org, the profile and the mode', () => {
  it('the banner shows the org NAME, the profile, and the one-pass line under --once', async () => {
    const owner = await boot();
    await openAgentPolicy(owner);
    const org = await owner.client.getOrg(owner.orgId);
    const cap = capture();

    expect(
      await runCli(
        ['harness', '--url', await inviteUrl(owner), '--name', 'named-bot', '--exec', fakeRunner(), '--batch-window', '0', '--once'],
        env,
        cap.io,
      ),
    ).toBe(0);

    expect(cap.out()).toContain(`named-bot · ${org.name} · profile named-bot`);
    expect(cap.out()).not.toContain(owner.orgId);
    expect(cap.out()).toContain('one pass — handling what is waiting, then exiting');
    expect(cap.out()).not.toContain('waiting for messages');
  });

  it('the prompt names the org, not its id — on a later run with no invite in hand', async () => {
    const owner = await boot();
    await openAgentPolicy(owner);
    const org = await owner.client.getOrg(owner.orgId);
    await runCli(
      ['harness', '--url', await inviteUrl(owner), '--name', 'org-bot', '--exec', fakeRunner(), '--batch-window', '0', '--once'],
      env,
      capture().io,
    );
    const roomId = await sharedRoom(owner);
    await owner.client.sendMessage(roomId, { body: 'where am I?' });

    const cap = capture();
    expect(
      await runCli(['harness', '--exec', fakeRunner(), '--batch-window', '0', '--once'], env, cap.io),
    ).toBe(0);

    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.prompt).toContain(`the ${org.name} organisation`);
    expect(runs()[0]!.prompt).not.toContain(owner.orgId);
    // And the no---url path names its profile too.
    expect(cap.out()).toContain('profile org-bot');
  });

  it('a profile enrolled without the harness learns the org name from the invite', async () => {
    const owner = await boot();
    await openAgentPolicy(owner);
    const org = await owner.client.getOrg(owner.orgId);
    const invite = await inviteUrl(owner);

    // `sparrow enroll` instant-admit writes the profile without the harness.
    expect(await runCli(['enroll', invite, '--name', 'plain-bot'], env, capture().io)).toBe(0);

    const cap = capture();
    expect(
      await runCli(
        ['harness', '--url', invite, '--exec', fakeRunner(), '--batch-window', '0', '--once'],
        env,
        cap.io,
      ),
    ).toBe(0);
    expect(cap.out()).toContain('already enrolled as plain-bot');
    expect(cap.out()).toContain(`plain-bot · ${org.name} · profile plain-bot`);
  });
});
