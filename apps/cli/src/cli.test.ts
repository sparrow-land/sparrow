import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@sparrow/api';
import { SparrowClient } from '@sparrow/client';
import { deriveDefaultAgentName } from '@sparrow/common-types/identity';
import {
  AGENT_DM_NO_COMMON_VIEWER_MESSAGE,
  DM_NOT_ELIGIBLE_MESSAGE,
  PRESENCE_TTL_MAX,
} from '@sparrow/common-types';
import { clientBuildVersion } from '@sparrow/client';
import { PassThrough, Writable } from 'node:stream';
import {
  runCli,
  loadUndici,
  transportFactory,
  serverSkewNote,
  installBaseUrl,
  makePrompt,
  type CliIO,
} from './index.js';

/**
 * Isolated loop-state dir for every CLI run in this file. `watch`/`await`/`loop`
 * write their listener kind into `<state>/heartbeat`; without this the suite
 * stamps the developer's real ~/.sparrow/heartbeat with `watch`, which the
 * Stop hook then (correctly) blocks on.
 */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-state-'));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * A real in-process v3 API (buildServer from @sparrow/api) on an ephemeral
 * port, backed by a fresh temp-dir SQLite db. The CLI is driven over real
 * HTTP against it — doubling as a contract check against the live server.
 * ------------------------------------------------------------------ */

const ADMIN_TOKEN = 'test-admin-token';

let app: ReturnType<typeof buildServer>;
let dataDir: string;
let url: string;

beforeAll(async () => {
  // A shared, listening server is created per test (beforeEach) so each test's
  // first signup bootstraps its own org — but the fastify build is created here.
});

async function startServer(opts?: { presenceGraceSeconds?: number }): Promise<void> {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-api-'));
  app = buildServer({
    dataDir,
    baseUrl: 'http://localhost:8722',
    adminToken: ADMIN_TOKEN,
    ...opts,
  });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

let configDir: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  await startServer();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-cfg-'));
  env = {
    XDG_CONFIG_HOME: configDir,
    HOME: os.homedir(),
    SPARROW_STATE_DIR: stateDir,
    PATH: process.env.PATH,
    SPARROW_POLL_INTERVAL_MS: '15',
  };
});

afterEach(async () => {
  fs.rmSync(configDir, { recursive: true, force: true });
  await stopServer();
});

afterAll(() => {
  /* nothing global */
});

/* ------------------------------ IO capture ----------------------------- */

interface Capture {
  io: CliIO;
  out(): string;
  err(): string;
}
function capture(opts?: { stdin?: string; answers?: string[] }): Capture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let ai = 0;
  return {
    io: {
      out: (s) => outChunks.push(s),
      err: (s) => errChunks.push(s),
      stdin: opts?.stdin,
      prompt: async () => opts?.answers?.[ai++] ?? '',
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

/** A stdout stand-in for prompt tests that don't inspect what was written. */
function devNull(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

function credentials(): any {
  return JSON.parse(fs.readFileSync(path.join(configDir, 'sparrow', 'credentials.json'), 'utf8'));
}

async function waitForCreds(pred: (c: any) => boolean, timeoutMs = 2000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const c = credentials();
      if (pred(c)) return c;
    } catch {
      /* not written yet */
    }
    if (Date.now() >= deadline) throw new Error('waitForCreds timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ---------------------------- presence proxy --------------------------- */

/**
 * A pass-through HTTP relay in front of the in-process API that RECORDS every
 * `POST /me/presence` body and can fail it on demand. Nothing else can observe
 * the exact TTL the CLI plants (presence is write-only on the wire) or prove
 * that a failed plant is swallowed rather than surfaced.
 */
interface PresenceProxy {
  url: string;
  /** Every `POST /me/presence` body seen, in order. */
  posts: Array<{ ttlSeconds?: number }>;
  /** When true the relay answers presence POSTs with a 500 (never forwarding). */
  fail: boolean;
  close(): Promise<void>;
}

async function startPresenceProxy(): Promise<PresenceProxy> {
  const upstream = new URL(url);
  const sockets = new Set<Socket>();
  const state = { posts: [] as Array<{ ttlSeconds?: number }>, fail: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (req.method === 'POST' && (req.url ?? '').startsWith('/api/v1/me/presence')) {
        try {
          state.posts.push(JSON.parse(raw.toString('utf8')) as { ttlSeconds?: number });
        } catch {
          state.posts.push({});
        }
        if (state.fail) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'internal', message: 'presence exploded' } }));
          return;
        }
      }
      const up = http.request(
        {
          host: upstream.hostname,
          port: upstream.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: upstream.host, 'content-length': String(raw.length) },
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      up.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      up.end(raw);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get posts() {
      return state.posts;
    },
    get fail() {
      return state.fail;
    },
    set fail(v: boolean) {
      state.fail = v;
    },
    close: async () => {
      for (const s of [...sockets]) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/* ------------------------------ seeding -------------------------------- */

interface Owner {
  client: SparrowClient;
  token: string;
  userId: string;
  orgId: string;
  email: string;
}

/** Sign up the FIRST human (auto-bootstraps an org, owner) and return handles. */
async function boot(email = 'owner@x.com'): Promise<Owner> {
  const client = new SparrowClient({ server: url });
  const res = await client.signup({ email, password: 'password123', displayName: 'Owner' });
  const orgs = await client.meOrgs();
  return { client, token: client.token!, userId: res.user.id, orgId: orgs[0]!.org.id, email };
}

/** Add a human to `orgId` (invite → signup → enroll → approve). */
async function addHuman(
  owner: Owner,
  email: string,
): Promise<{ client: SparrowClient; userId: string; email: string }> {
  const inv = await owner.client.createInvite(owner.orgId);
  const token = inv.url.split('/invite/')[1]!;
  const client = new SparrowClient({ server: url });
  const res = await client.signup({ email, password: 'password123', displayName: email });
  const enr = await client.enrollHuman(token);
  if (enr.status === 'pending') {
    await owner.client.approveEnrollment(owner.orgId, enr.enrollment.id);
  }
  return { client, userId: res.user.id, email };
}

/** Create an agent owned by `owner`; returns id + key + a ready agent client. */
async function makeAgent(
  owner: Owner,
  name: string,
): Promise<{ id: string; key: string; client: SparrowClient }> {
  const res = await owner.client.createAgent({ orgId: owner.orgId, name });
  return { id: res.agent.id, key: res.key, client: new SparrowClient({ server: url, token: res.key }) };
}

/** Set `enroll.agents` policy on the owner's org. */
async function setAgentPolicy(owner: Owner, policy: 'approval' | 'open'): Promise<void> {
  const org = await owner.client.getOrg(owner.orgId);
  await owner.client.updateOrg(owner.orgId, {
    settings: { ...org.settings, enroll: { ...org.settings.enroll, agents: policy } },
  });
}

/* ================================================================== *
 * login / login-agent / whoami
 * ================================================================== */

describe('sparrow CLI — auth & identity', () => {
  it('login prompts for password, stores a ses_ human profile, whoami works', async () => {
    const owner = await boot('login@x.com');
    void owner;
    const cap = capture({ answers: ['password123'] });
    const code = await runCli(['login', '--server', url, '--email', 'login@x.com'], env, cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain('Logged in as');

    const creds = credentials();
    expect(creds.defaultProfile).toBe('login@x.com');
    expect(creds.profiles['login@x.com'].kind).toBe('human');
    expect(creds.profiles['login@x.com'].token).toMatch(/^ses_/);

    const who = capture();
    expect(await runCli(['whoami', '--json'], env, who.io)).toBe(0);
    const me = JSON.parse(who.out());
    expect(me.type).toBe('human');
    expect(me.email).toBe('login@x.com');
  });

  it('login reads password from SPARROW_PASSWORD env when no prompt', async () => {
    await boot('envpw@x.com');
    const cap = capture();
    const e = { ...env, SPARROW_PASSWORD: 'password123' };
    expect(await runCli(['login', '--server', url, '--email', 'envpw@x.com'], e, cap.io)).toBe(0);
    expect(credentials().profiles['envpw@x.com'].token).toMatch(/^ses_/);
  });

  /**
   * `sparrow login </dev/null` used to print `Password: ` and exit **0** having
   * saved nothing: readline's question never settles once stdin hits EOF, the
   * event loop drained, node exited clean. A prompt that cannot be answered must
   * fail loudly and name the non-interactive way in.
   */
  it('login on an exhausted stdin exits 1 naming SPARROW_PASSWORD (never a silent 0)', async () => {
    await boot('eof@x.com');
    const input = new PassThrough();
    input.end(); // `< /dev/null`
    const cap = capture();
    cap.io.prompt = makePrompt(input, devNull());
    const code = await runCli(['login', '--server', url, '--email', 'eof@x.com'], env, cap.io);
    expect(code).toBe(1);
    // The email was on the command line; it is the PASSWORD that cannot be read.
    expect(cap.err()).toContain('No password on stdin');
    expect(cap.err()).toContain('SPARROW_PASSWORD');
    expect(fs.existsSync(path.join(configDir, 'sparrow', 'credentials.json'))).toBe(false);
  });

  /**
   * `printf 'email\npw\n' | sparrow login` hung: a per-question readline consumed
   * the whole piped chunk and threw the remainder away on close, so the second
   * prompt saw EOF. Both prompts must be served from ONE stream reader.
   */
  it('login reads email then password from a single piped stdin', async () => {
    await boot('piped@x.com');
    const input = new PassThrough();
    input.write('piped@x.com\npassword123\n');
    input.end();
    const cap = capture();
    cap.io.prompt = makePrompt(input, devNull());
    expect(await runCli(['login', '--server', url], env, cap.io)).toBe(0);
    expect(cap.out()).toContain('Logged in as');
    expect(credentials().profiles['piped@x.com'].token).toMatch(/^ses_/);
  });

  it('login with a bad password exits 1 (no enumeration)', async () => {
    await boot('bad@x.com');
    const cap = capture({ answers: ['wrongpass'] });
    const code = await runCli(['login', '--server', url, '--email', 'bad@x.com'], env, cap.io);
    expect(code).toBe(1);
    expect(cap.err()).toMatch(/Error/);
  });

  it('login-agent stores an agk_ profile and whoami shows the agent', async () => {
    const owner = await boot('agown@x.com');
    const agent = await makeAgent(owner, 'deploy-bot');

    const cap = capture();
    expect(await runCli(['login-agent', agent.key, '--server', url, '--json'], env, cap.io)).toBe(0);
    const creds = credentials();
    expect(creds.defaultProfile).toBe('deploy-bot');
    expect(creds.profiles['deploy-bot']).toEqual({ server: url, token: agent.key, kind: 'agent' });

    const who = capture();
    expect(await runCli(['whoami', '--json'], env, who.io)).toBe(0);
    const me = JSON.parse(who.out());
    expect(me.type).toBe('agent');
    expect(me.name).toBe('deploy-bot');
  });

  it('rename renames the agent itself (PATCH /me); a name clash → exit 1 with a clear message', async () => {
    const owner = await boot('renown@x.com');
    await makeAgent(owner, 'taken');
    const agent = await makeAgent(owner, 'bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };

    // Rename succeeds; whoami reflects the new name.
    const cap = capture();
    expect(await runCli(['rename', 'scout'], e, cap.io)).toBe(0);
    const who = capture();
    expect(await runCli(['whoami', '--json'], e, who.io)).toBe(0);
    expect(JSON.parse(who.out()).name).toBe('scout');

    // A name already taken by another agent in the org → exit 1, clear message.
    const clash = capture();
    expect(await runCli(['rename', 'taken'], e, clash.io)).toBe(1);
    expect(clash.err()).toMatch(/already exists/i);
  });

  it('role: shows "(no role set)" for a fresh agent, then set/show/clear round-trips', async () => {
    const owner = await boot('roleown@x.com');
    const agent = await makeAgent(owner, 'role-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };

    // Fresh agent: no role.
    const none = capture();
    expect(await runCli(['role'], e, none.io)).toBe(0);
    expect(none.out()).toMatch(/no role set/i);

    // Set both halves.
    const setCap = capture();
    expect(
      await runCli(
        ['role', 'set', '--title', 'Support triage', '--instructions', 'Answer support DMs first.'],
        e,
        setCap.io,
      ),
    ).toBe(0);

    // Show reflects it (JSON has both halves + a timestamp).
    const show = capture();
    expect(await runCli(['role', '--json'], e, show.io)).toBe(0);
    const shown = JSON.parse(show.out());
    expect(shown.roleTitle).toBe('Support triage');
    expect(shown.roleInstructions).toBe('Answer support DMs first.');
    expect(shown.roleUpdatedAt).toBeTruthy();

    // Clear both halves.
    const clr = capture();
    expect(await runCli(['role', 'set', '--none'], e, clr.io)).toBe(0);
    const after = capture();
    expect(await runCli(['role', '--json'], e, after.io)).toBe(0);
    const cleared = JSON.parse(after.out());
    expect(cleared.roleTitle).toBeNull();
    expect(cleared.roleInstructions).toBeNull();
  });

  it('role set --instructions-file reads instructions from a file', async () => {
    const owner = await boot('rolefile@x.com');
    const agent = await makeAgent(owner, 'file-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const roleFile = path.join(configDir, 'role.md');
    fs.writeFileSync(roleFile, '# Job\n\nBe terse and correct.');

    const setCap = capture();
    expect(
      await runCli(['role', 'set', '--title', 'Ops', '--instructions-file', roleFile], e, setCap.io),
    ).toBe(0);
    const show = capture();
    expect(await runCli(['role', '--json'], e, show.io)).toBe(0);
    expect(JSON.parse(show.out()).roleInstructions).toBe('# Job\n\nBe terse and correct.');
  });

  it('role set rejects conflicting flags and an empty invocation', async () => {
    const owner = await boot('rolebad@x.com');
    const agent = await makeAgent(owner, 'bad-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };

    // --instructions + --instructions-file are mutually exclusive.
    const both = capture();
    expect(
      await runCli(
        ['role', 'set', '--instructions', 'x', '--instructions-file', '/nope'],
        e,
        both.io,
      ),
    ).toBe(1);
    expect(both.err()).toMatch(/instructions/i);

    // --none excludes the other set flags.
    const noneAndTitle = capture();
    expect(await runCli(['role', 'set', '--none', '--title', 'x'], e, noneAndTitle.io)).toBe(1);
    expect(noneAndTitle.err()).toMatch(/none/i);

    // No flags at all → error.
    const empty = capture();
    expect(await runCli(['role', 'set'], e, empty.io)).toBe(1);
  });

  it('role is agent-only: a human principal gets a clear error', async () => {
    const owner = await boot('rolehuman@x.com');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: owner.token };
    const cap = capture();
    expect(await runCli(['role'], e, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/agent/i);
  });

  it('whoami shows role lines for an agent with a role', async () => {
    const owner = await boot('rolewho@x.com');
    const agent = await makeAgent(owner, 'who-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    await runCli(['role', 'set', '--title', 'Ops lead', '--instructions', 'own deploys'], e, capture().io);
    const who = capture();
    expect(await runCli(['whoami'], e, who.io)).toBe(0);
    expect(who.out()).toMatch(/roleTitle:\s+Ops lead/);
  });

  it('whoami reports self-presence: offline with no stream and no mark', async () => {
    const owner = await boot('preoff@x.com');
    const agent = await makeAgent(owner, 'off-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const who = capture();
    expect(await runCli(['whoami'], e, who.io)).toBe(0);
    expect(who.out()).toContain('OFFLINE — not holding a stream or mark');
  });

  it('whoami reports "online via mark until HH:MM:SS" when a heartbeat mark is live', async () => {
    const owner = await boot('premark@x.com');
    const agent = await makeAgent(owner, 'mark-bot');
    await agent.client.setPresence(120);
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const who = capture();
    expect(await runCli(['whoami'], e, who.io)).toBe(0);
    expect(who.out()).toMatch(/online via mark until \d{2}:\d{2}:\d{2}/);
  });

  it('whoami --json passes the presence block through', async () => {
    const owner = await boot('prejson@x.com');
    const agent = await makeAgent(owner, 'json-bot');
    const res = await agent.client.setPresence(120);
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const who = capture();
    expect(await runCli(['whoami', '--json'], e, who.io)).toBe(0);
    expect(JSON.parse(who.out()).presence).toEqual({
      online: true,
      via: 'mark',
      onlineUntil: res.onlineUntil,
    });
  });

  it('login-agent rejects a non-agk_ token', async () => {
    const cap = capture();
    expect(await runCli(['login-agent', 'ses_nope', '--server', url], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/agk_/);
  });

  it('SPARROW_SERVER / SPARROW_TOKEN env overrides work without a profile', async () => {
    const owner = await boot('envtok@x.com');
    const agent = await makeAgent(owner, 'envbot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const who = capture();
    expect(await runCli(['whoami', '--json'], e, who.io)).toBe(0);
    expect(JSON.parse(who.out()).name).toBe('envbot');
  });

  it('missing config errors with exit 1', async () => {
    const cap = capture();
    expect(await runCli(['whoami'], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/No server configured|Not authenticated/);
  });

  it('whoami with a dead/invalid default profile gives a profile-aware 401 (names the profile + --profile hint)', async () => {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { 'sparrow-prod': { server: url, token: 'agk_dead', kind: 'agent' } },
        defaultProfile: 'sparrow-prod',
      }),
    );
    const cap = capture();
    expect(await runCli(['whoami'], env, cap.io)).toBe(1);
    const err = cap.err();
    // Names the offending profile and points at recovery — not a bare "Invalid agent key".
    expect(err).toMatch(/profile "sparrow-prod"/);
    expect(err).toMatch(/revoked or expired/i);
    expect(err).toMatch(/--profile/);
  });

  it('inbox with a dead default profile surfaces the same profile-aware hint', async () => {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { 'sparrow-prod': { server: url, token: 'agk_dead', kind: 'agent' } },
        defaultProfile: 'sparrow-prod',
      }),
    );
    const cap = capture();
    expect(await runCli(['inbox'], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/profile "sparrow-prod"/);
    expect(cap.err()).toMatch(/--profile/);
  });
});

/* ================================================================== *
 * enroll
 * ================================================================== */

describe('sparrow CLI — enroll', () => {
  it('open policy: instant 201 stores an agent profile (default name derived)', async () => {
    const owner = await boot('open@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(await runCli(['enroll', inv.url, '--server', url, '--json'], env, cap.io)).toBe(0);
    const out = JSON.parse(cap.out());
    expect(out.agent.name).toBe(deriveDefaultAgentName());
    // Default names are dash-joined `{host}-{folder}` (email-friendly), never colon-form.
    expect(out.agent.name).not.toContain(':');
    const creds = credentials();
    expect(creds.profiles[out.profile].kind).toBe('agent');
    expect(creds.profiles[out.profile].token).toMatch(/^agk_/);
    expect(creds.pending).toBeUndefined();
  });

  it('open policy: success output tells the agent to start listening (come online)', async () => {
    const owner = await boot('openlisten@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(await runCli(['enroll', inv.url, '--server', url, '--name', 'listenbot'], env, cap.io)).toBe(0);
    const out = cap.out();
    expect(out).toContain('You are listenbot');
    // Enrolling is not the end — the agent must start a listening loop to come online.
    expect(out).toMatch(/not online/i);
    expect(out).toMatch(/start listening/i);
    expect(out).toContain('sparrow watch');
    expect(out).toContain('sparrow inbox');
    // Come online FIRST, report second (the live-dogfood fix): start watching before
    // reporting back, and never sit enrolled-but-dark.
    expect(out).toContain('Come online FIRST');
    expect(out).toContain('before you report back to your human');
    expect(out).toMatch(/enrolled but dark/i);
    // Light-touch nudges: the agent can go heavier (skill) and can rename itself later.
    expect(out).toContain('sparrow skill install');
    expect(out).toContain('sparrow rename');
  });

  it('open policy honors --name', async () => {
    const owner = await boot('open2@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);
    const cap = capture();
    expect(await runCli(['enroll', inv.url, '--server', url, '--name', 'namedbot', '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).agent.name).toBe('namedbot');
  });

  it('approval policy: waits, persists a pending record, completes on approval', async () => {
    const owner = await boot('appr@x.com'); // default policy = approval
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    const enrollP = runCli(['enroll', inv.url, '--server', url, '--name', 'waitbot'], env, cap.io);

    const creds = await waitForCreds((c) => c.pending !== undefined);
    expect(creds.pending.enrollmentId).toMatch(/^enl_/);
    expect(creds.pending.enrollmentToken).toMatch(/^enr_/);
    expect(creds.pending.name).toBe('waitbot');

    // Approve out-of-band.
    const pending = await owner.client.listEnrollments(owner.orgId);
    await owner.client.approveEnrollment(owner.orgId, pending[0]!.id);

    expect(await enrollP).toBe(0);
    expect(cap.err()).toContain('Waiting for approval');
    // The waiting line is instructive: run enroll as a background task; the human
    // approves from the Sparrow window, so report there (not the terminal).
    expect(cap.err()).toContain('background task');
    expect(cap.err()).toMatch(/Sparrow window/);
    expect(cap.out()).toContain('You are waitbot');
    // The approved-poll branch must also push the agent to start listening.
    expect(cap.out()).toMatch(/not online/i);
    expect(cap.out()).toContain('sparrow watch');

    const after = credentials();
    expect(after.pending).toBeUndefined();
    expect(after.profiles['waitbot'].kind).toBe('agent');
    expect(after.profiles['waitbot'].token).toMatch(/^agk_/);
  });

  it('approval policy: denial exits 1 and clears the pending record', async () => {
    const owner = await boot('deny@x.com');
    const inv = await owner.client.createInvite(owner.orgId);
    const cap = capture();
    const enrollP = runCli(['enroll', inv.url, '--server', url, '--name', 'denybot'], env, cap.io);
    const creds = await waitForCreds((c) => c.pending !== undefined);
    await owner.client.denyEnrollment(owner.orgId, creds.pending.enrollmentId);
    expect(await enrollP).toBe(1);
    expect(cap.err()).toMatch(/denied/i);
    expect(credentials().pending).toBeUndefined();
    expect(credentials().profiles['denybot']).toBeUndefined();
  });

  it('--timeout leaves the pending record; --resume continues to approval', async () => {
    const owner = await boot('resume@x.com');
    const inv = await owner.client.createInvite(owner.orgId);

    const first = capture();
    expect(
      await runCli(['enroll', inv.url, '--server', url, '--name', 'patientbot', '--timeout', '0'], env, first.io),
    ).toBe(1);
    const enrId = credentials().pending.enrollmentId;
    expect(enrId).toMatch(/^enl_/);

    await owner.client.approveEnrollment(owner.orgId, enrId);
    const resumed = capture();
    expect(await runCli(['enroll', '--resume'], env, resumed.io)).toBe(0);
    expect(resumed.out()).toContain('You are patientbot');
    expect(credentials().pending).toBeUndefined();
    expect(credentials().profiles['patientbot'].kind).toBe('agent');
  });

  it('--resume with no pending record errors', async () => {
    const cap = capture();
    expect(await runCli(['enroll', '--resume'], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/No pending enrollment/i);
  });

  /**
   * A server RESTART while an enroll is waiting used to kill the wait with a
   * bare `Error: fetch failed`. The wait now rides it out, and if the deadline
   * really does pass while the server is unreachable the message says so —
   * and still names the recovery, because the pending record survives.
   */
  it('a wait that ends unreachable says so and still names --resume', async () => {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: {},
        pending: {
          server: 'http://127.0.0.1:1', // nothing listens here: ECONNREFUSED
          inviteToken: 'ivk_dead',
          enrollmentId: 'enl_dead',
          enrollmentToken: 'enr_dead',
          name: 'ghostbot',
          profileName: 'ghostbot',
        },
      }),
    );
    const cap = capture();
    expect(await runCli(['enroll', '--resume', '--timeout', '0'], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/Lost contact with the server/i);
    expect(cap.err()).toContain('--resume');
    expect(cap.err()).not.toMatch(/Still waiting for approval/);
    // The request is still saved — otherwise the recovery line would be a lie.
    expect(credentials().pending).toBeDefined();
  });

  it('explicit --profile is honored: overwrites an existing profile of that name (with a notice)', async () => {
    const owner = await boot('reprofile@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);

    // Seed a stale profile under the exact name the caller will request.
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { 'sparrow-prod': { server: url, token: 'agk_dead', kind: 'agent' } },
        defaultProfile: 'sparrow-prod',
      }),
    );

    const cap = capture();
    expect(
      await runCli(['enroll', inv.url, '--server', url, '--name', 'freshbot', '--profile', 'sparrow-prod'], env, cap.io),
    ).toBe(0);

    const creds = credentials();
    // The requested name is honored verbatim — NOT silently renamed to sparrow-prod-2.
    expect(creds.profiles['sparrow-prod-2']).toBeUndefined();
    // The stale credential is replaced with the freshly-minted key, and it's default.
    expect(creds.profiles['sparrow-prod'].kind).toBe('agent');
    expect(creds.profiles['sparrow-prod'].token).toMatch(/^agk_/);
    expect(creds.profiles['sparrow-prod'].token).not.toBe('agk_dead');
    expect(creds.defaultProfile).toBe('sparrow-prod');
    // A one-line notice tells the caller the existing profile was replaced.
    expect(cap.err()).toMatch(/replacing existing profile "sparrow-prod"/i);
  });

  it('default profile-name path still auto-suffixes rather than clobbering an unnamed profile', async () => {
    const owner = await boot('dupname@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);

    // A profile already exists under the name the enroll would default to (the agent
    // name), and the caller did NOT pass --profile.
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { dupbot: { server: url, token: 'agk_existing', kind: 'agent' } },
        defaultProfile: 'dupbot',
      }),
    );

    const cap = capture();
    expect(await runCli(['enroll', inv.url, '--server', url, '--name', 'dupbot'], env, cap.io)).toBe(0);

    const creds = credentials();
    // The pre-existing (unnamed-by-flag) profile is untouched…
    expect(creds.profiles['dupbot'].token).toBe('agk_existing');
    // …and the new key lands under an auto-suffixed name.
    expect(creds.profiles['dupbot-2'].kind).toBe('agent');
    expect(creds.profiles['dupbot-2'].token).toMatch(/^agk_/);
    // The machine already had a default, so this enrollment does NOT steal it:
    // another agent may be running as `dupbot` in another checkout right now.
    expect(creds.defaultProfile).toBe('dupbot');
    // No "replacing" notice on the auto-suffix path — nothing the user named was clobbered.
    expect(cap.err()).not.toMatch(/replacing existing profile/i);
  });

  it('--exec runs on approval (held 202 path) once the key is delivered', async () => {
    const owner = await boot('execappr@x.com'); // default policy = approval
    const inv = await owner.client.createInvite(owner.orgId);

    const marker = path.join(configDir, 'exec-ran');
    const cap = capture();
    const enrollP = runCli(
      ['enroll', inv.url, '--server', url, '--name', 'execbot', '--exec', `touch ${marker}`],
      env,
      cap.io,
    );

    const creds = await waitForCreds((c) => c.pending !== undefined);
    const pending = await owner.client.listEnrollments(owner.orgId);
    await owner.client.approveEnrollment(owner.orgId, pending[0]!.id);

    expect(await enrollP).toBe(0);
    // The handler fired only after the profile was saved and the banner printed.
    expect(cap.out()).toContain('You are execbot');
    expect(fs.existsSync(marker)).toBe(true);
    expect(credentials().profiles['execbot'].token).toMatch(/^agk_/);
  });

  it('--exec runs on the instant-admit (open 201) path too', async () => {
    const owner = await boot('execopen@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);

    const marker = path.join(configDir, 'exec-ran-open');
    const cap = capture();
    expect(
      await runCli(
        ['enroll', inv.url, '--server', url, '--name', 'execopenbot', '--exec', `touch ${marker}`],
        env,
        cap.io,
      ),
    ).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('--exec nonzero exit fails the enroll (nonzero) with a clear message; profile still saved', async () => {
    const owner = await boot('execfail@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(
      await runCli(
        ['enroll', inv.url, '--server', url, '--name', 'execfailbot', '--exec', 'exit 3'],
        env,
        cap.io,
      ),
    ).toBe(1);
    expect(cap.err()).toMatch(/--exec command exited 3/);
    // Enrollment itself succeeded — the key is saved; only the handler failed.
    expect(credentials().profiles['execfailbot'].token).toMatch(/^agk_/);
  });

  /* ---------------- a dead invite explains itself ---------------- */

  /**
   * An unknown/revoked/expired invite used to print a bare `Error: Not found` —
   * the single most common first-run failure, with nothing in it for the human
   * holding the link. The server now distinguishes the cases (404 not_found /
   * 410 gone) and the CLI must pass ITS sentence through, plus the invite that
   * failed. A stub server stands in so this holds for whatever the live server
   * says (and for an older one that only says "Not found").
   */
  async function inviteStub(
    status: number,
    body: unknown,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const stub = http.createServer((req, res) => {
      req.resume();
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    return {
      url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      close: () =>
        new Promise<void>((r) => {
          stub.closeAllConnections?.();
          stub.close(() => r());
        }),
    };
  }

  it('a revoked invite (410 gone) prints the server sentence and the invite, not "Not found"', async () => {
    const revoked = 'This invite has been revoked. Ask whoever invited you for a new link.';
    const stub = await inviteStub(410, {
      error: { code: 'gone', message: revoked, docs: 'http://example.test/docs/enroll' },
    });
    try {
      const target = `${stub.url}/invite/inv_dead`;
      const cap = capture();
      expect(await runCli(['enroll', target, '--name', 'deadbot'], env, cap.io)).toBe(1);
      expect(cap.err()).toContain(revoked);
      expect(cap.err()).toContain(`Invite: ${target}`);
      expect(cap.err()).not.toMatch(/Error: Not found/);
      expect(fs.existsSync(path.join(configDir, 'sparrow', 'credentials.json'))).toBe(false);

      // `-j` still reports the real code/status the server gave.
      const capJson = capture();
      expect(await runCli(['enroll', target, '--name', 'deadbot', '-j'], env, capJson.io)).toBe(1);
      const err = JSON.parse(capJson.err()).error;
      expect(err.code).toBe('gone');
      expect(err.message).toContain(revoked);
    } finally {
      await stub.close();
    }
  });

  it('an older server`s flat 404 "Not found" becomes a sentence about the invite', async () => {
    const stub = await inviteStub(404, { error: { code: 'not_found', message: 'Not found' } });
    try {
      const target = `${stub.url}/invite/inv_unknown`;
      const cap = capture();
      expect(await runCli(['enroll', target, '--name', 'deadbot'], env, cap.io)).toBe(1);
      expect(cap.err()).not.toMatch(/Error: Not found/);
      expect(cap.err()).toMatch(/not valid|expired|revoked/i);
      expect(cap.err()).toContain(`Invite: ${target}`);
    } finally {
      await stub.close();
    }
  });
});

/* ================================================================== *
 * defaultProfile ownership
 *
 * One machine, one unix user, three agents in three checkouts and (often)
 * three workspaces — all sharing ONE credentials.json. Enrolling used to make
 * the fresh profile the default, so the third agent's enroll silently
 * re-pointed the first two agents' bare `sparrow` commands at its own
 * workspace. The rule now: the default is set by the FIRST enrollment on the
 * machine, or by an explicit `--set-default`, and by nothing else.
 * ================================================================== */

describe('sparrow CLI — defaultProfile is never silently stolen', () => {
  const seedCreds = (creds: unknown): void => {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sparrow', 'credentials.json'), JSON.stringify(creds));
  };

  it('the FIRST enrollment on a machine sets defaultProfile', async () => {
    const owner = await boot('firstdef@x.com');
    await setAgentPolicy(owner, 'open');
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(
      await runCli(['enroll', inv.url, '--server', url, '--name', 'one', '--profile', 'alpha'], env, cap.io),
    ).toBe(0);
    expect(credentials().defaultProfile).toBe('alpha');
    expect(cap.out()).toContain('defaultProfile: "alpha"');
  });

  it('a second enroll --profile leaves the default alone and says how to use the new one', async () => {
    const owner = await boot('seconddef@x.com');
    await setAgentPolicy(owner, 'open');
    seedCreds({
      profiles: { alpha: { server: url, token: 'agk_alpha', kind: 'agent' } },
      defaultProfile: 'alpha',
    });
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(
      await runCli(['enroll', inv.url, '--server', url, '--name', 'two', '--profile', 'beta'], env, cap.io),
    ).toBe(0);

    const creds = credentials();
    expect(creds.profiles['beta'].token).toMatch(/^agk_/);
    expect(creds.defaultProfile).toBe('alpha');
    expect(cap.out()).toContain(
      'defaultProfile stays "alpha" — pass --profile beta (or SPARROW_PROFILE=beta) on commands ' +
        'for this workspace, or re-run with --set-default.',
    );
  });

  it('--set-default moves it, and reports the move', async () => {
    const owner = await boot('setdef@x.com');
    await setAgentPolicy(owner, 'open');
    seedCreds({
      profiles: { alpha: { server: url, token: 'agk_alpha', kind: 'agent' } },
      defaultProfile: 'alpha',
    });
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(
      await runCli(
        ['enroll', inv.url, '--server', url, '--name', 'two', '--profile', 'beta', '--set-default'],
        env,
        cap.io,
      ),
    ).toBe(0);
    expect(credentials().defaultProfile).toBe('beta');
    expect(cap.out()).toContain('defaultProfile: "alpha" → "beta"');
  });

  it('JSON output carries both `profile` and `defaultProfile`', async () => {
    const owner = await boot('jsondef@x.com');
    await setAgentPolicy(owner, 'open');
    seedCreds({
      profiles: { alpha: { server: url, token: 'agk_alpha', kind: 'agent' } },
      defaultProfile: 'alpha',
    });
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(
      await runCli(['enroll', inv.url, '--server', url, '--name', 'two', '--profile', 'beta', '-j'], env, cap.io),
    ).toBe(0);
    const out = JSON.parse(cap.out());
    expect(out.profile).toBe('beta');
    expect(out.defaultProfile).toBe('alpha');
  });

  it('login --profile does not steal an existing default either (same store helper)', async () => {
    await boot('logindef@x.com');
    seedCreds({
      profiles: { alpha: { server: url, token: 'agk_alpha', kind: 'agent' } },
      defaultProfile: 'alpha',
    });

    const cap = capture({ answers: ['password123'] });
    expect(
      await runCli(
        ['login', '--server', url, '--email', 'logindef@x.com', '--profile', 'human'],
        env,
        cap.io,
      ),
    ).toBe(0);
    const creds = credentials();
    expect(creds.profiles['human'].kind).toBe('human');
    expect(creds.defaultProfile).toBe('alpha');
    expect(cap.out()).toContain('defaultProfile stays "alpha"');

    // …and --set-default is the way to move it.
    const cap2 = capture({ answers: ['password123'] });
    expect(
      await runCli(
        ['login', '--server', url, '--email', 'logindef@x.com', '--profile', 'human', '--set-default'],
        env,
        cap2.io,
      ),
    ).toBe(0);
    expect(credentials().defaultProfile).toBe('human');
  });

  it('login-agent --profile does not steal it, and --set-default does', async () => {
    const owner = await boot('lgadef@x.com');
    const agent = await makeAgent(owner, 'lga-bot');
    seedCreds({
      profiles: { alpha: { server: url, token: 'agk_alpha', kind: 'agent' } },
      defaultProfile: 'alpha',
    });

    const cap = capture();
    expect(
      await runCli(['login-agent', agent.key, '--server', url, '--profile', 'gamma'], env, cap.io),
    ).toBe(0);
    expect(credentials().defaultProfile).toBe('alpha');
    expect(cap.out()).toContain('defaultProfile stays "alpha"');

    const cap2 = capture();
    expect(
      await runCli(
        ['login-agent', agent.key, '--server', url, '--profile', 'gamma', '--set-default', '--json'],
        env,
        cap2.io,
      ),
    ).toBe(0);
    expect(credentials().defaultProfile).toBe('gamma');
    expect(JSON.parse(cap2.out()).defaultProfile).toBe('gamma');
  });

  it('re-enrolling INTO the current default keeps it (no confusing "stays" line)', async () => {
    const owner = await boot('samedef@x.com');
    await setAgentPolicy(owner, 'open');
    seedCreds({
      profiles: { alpha: { server: url, token: 'agk_stale', kind: 'agent' } },
      defaultProfile: 'alpha',
    });
    const inv = await owner.client.createInvite(owner.orgId);

    const cap = capture();
    expect(
      await runCli(['enroll', inv.url, '--server', url, '--name', 'again', '--profile', 'alpha'], env, cap.io),
    ).toBe(0);
    expect(credentials().defaultProfile).toBe('alpha');
    expect(cap.out()).toContain('defaultProfile: "alpha"');
    expect(cap.out()).not.toContain('stays');
  });
});

/* ================================================================== *
 * `sparrow skill` flag pass-through
 *
 * The subcommand shares ONE implementation with `npx sparrow-skill`, so all the
 * CLI owes it is the flags: `--profile` (whose identity the hooks act as),
 * `--shared` (write the committed settings file) and `--user`.
 * ================================================================== */

describe('sparrow CLI — skill install flags', () => {
  let projectDir: string;
  let fakeHome: string;
  let previousCwd: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-skill-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-skill-home-'));
    previousCwd = process.cwd();
    process.chdir(projectDir);
  });
  afterEach(() => {
    process.chdir(previousCwd);
    for (const d of [projectDir, fakeHome]) fs.rmSync(d, { recursive: true, force: true });
  });

  /** No SPARROW_STATE_DIR: the install must pick the project on its own. */
  const skillEnv = (extra: Record<string, string | undefined> = {}) => ({
    XDG_CONFIG_HOME: configDir,
    HOME: fakeHome,
    PATH: process.env.PATH,
    ...extra,
  });

  const settings = (file: string): any =>
    JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', file), 'utf8'));

  it('stamps --profile into the hook commands and keeps state in the project', async () => {
    const cap = capture();
    expect(await runCli(['skill', 'install', '--profile', 'workspace-b'], skillEnv(), cap.io)).toBe(0);

    const cmd = settings('settings.local.json').hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('SPARROW_STATE_DIR="$CLAUDE_PROJECT_DIR/.sparrow"');
    expect(cmd).toContain('SPARROW_PROFILE="workspace-b"');
    expect(fs.readFileSync(path.join(projectDir, '.sparrow', 'loop-state'), 'utf8').trim()).toBe(
      'engaged',
    );
    // The user-scope switch is untouched — this agent's pause is its own.
    expect(fs.existsSync(path.join(fakeHome, '.sparrow'))).toBe(false);
    expect(cap.out()).toContain('settings.local.json');
  });

  it('--shared targets the committed .claude/settings.json', async () => {
    const cap = capture();
    expect(await runCli(['skill', 'install', '--shared'], skillEnv(), cap.io)).toBe(0);
    expect(settings('settings.json').hooks.Stop[0].hooks[0].command).toContain(
      'sparrow-stop-check.sh',
    );
    expect(fs.existsSync(path.join(projectDir, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('pause/resume act on THIS project, from a nested working directory', async () => {
    expect(await runCli(['skill', 'install'], skillEnv(), capture().io)).toBe(0);
    const nested = path.join(projectDir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(await runCli(['skill', 'pause'], skillEnv(), capture().io)).toBe(0);
    expect(fs.readFileSync(path.join(projectDir, '.sparrow', 'loop-state'), 'utf8').trim()).toBe(
      'paused',
    );
  });
});

/* ================================================================== *
 * orgs / rooms / invites / requests
 * ================================================================== */

describe('sparrow CLI — orgs, rooms, invites, requests', () => {
  async function ownerProfile(owner: Owner): Promise<void> {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { me: { server: url, token: owner.token, kind: 'human' } },
        defaultProfile: 'me',
      }),
    );
  }

  it('orgs lists your orgs', async () => {
    const owner = await boot('orgs@x.com');
    await ownerProfile(owner);
    const cap = capture();
    expect(await runCli(['orgs', '--json'], env, cap.io)).toBe(0);
    const items = JSON.parse(cap.out()).items;
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('owner');
  });

  it('rooms lists memberships', async () => {
    const owner = await boot('rooms@x.com');
    await owner.client.createRoom(owner.orgId, { name: 'general' });
    await ownerProfile(owner);
    const cap = capture();
    expect(await runCli(['rooms', '--json'], env, cap.io)).toBe(0);
    const names = JSON.parse(cap.out()).items.map((r: any) => r.room.name);
    expect(names).toContain('general');
  });

  it('rooms --all is the org governance list; room archive/restore works off-membership', async () => {
    const owner = await boot('roomsall@x.com');
    const member = await addHuman(owner, 'roomsall-m@x.com');
    const theirs = await member.client.createRoom(owner.orgId, { name: 'their-room' });
    await ownerProfile(owner);

    // The owner is not a member of `theirs`, yet governs it.
    const list = capture();
    expect(await runCli(['rooms', '--all', '--json'], env, list.io)).toBe(0);
    const rows = JSON.parse(list.out()).items;
    expect(rows.map((r: any) => r.id)).toContain(theirs.id);
    expect(rows.find((r: any) => r.id === theirs.id).memberCount).toBe(1);

    const human = capture();
    expect(await runCli(['rooms', '--all'], env, human.io)).toBe(0);
    expect(human.out()).toContain('their-room');

    const arch = capture();
    expect(await runCli(['room', 'archive', theirs.id], env, arch.io)).toBe(0);
    expect(arch.out()).toMatch(/archived/i);
    await expect(member.client.sendMessage(theirs.id, { body: 'hi' })).rejects.toThrow();

    const rest = capture();
    expect(await runCli(['room', 'restore', theirs.id], env, rest.io)).toBe(0);
    await member.client.sendMessage(theirs.id, { body: 'hi' });
  });

  it('invites create → list → revoke', async () => {
    const owner = await boot('inv@x.com');
    await ownerProfile(owner);

    const create = capture();
    expect(await runCli(['invites', 'create', '--note', 'hello', '--json'], env, create.io)).toBe(0);
    const created = JSON.parse(create.out());
    expect(created.url).toContain('/invite/');
    const invId = created.invite.id;

    const list = capture();
    expect(await runCli(['invites', 'list', '--json'], env, list.io)).toBe(0);
    expect(JSON.parse(list.out()).items.map((i: any) => i.id)).toContain(invId);

    const revoke = capture();
    expect(await runCli(['invites', 'revoke', invId, '--json'], env, revoke.io)).toBe(0);
    expect(JSON.parse(revoke.out())).toMatchObject({ ok: true });
  });

  it('human enrollment via invite is immediate; requests queue stays empty', async () => {
    // Contract change 2026-08-26: a valid invite token IS the approval for
    // humans — no pending request is created; `requests` governs agents only.
    const owner = await boot('req@x.com');
    await ownerProfile(owner);
    const inv = await owner.client.createInvite(owner.orgId);
    const token = inv.url.split('/invite/')[1]!;
    const joiner = new SparrowClient({ server: url });
    await joiner.signup({ email: 'joiner@x.com', password: 'password123', displayName: 'Joiner' });
    const enr = await joiner.enrollHuman(token);
    expect(enr.status).toBe('member');
    // Immediately an org member, and nothing waits for approval.
    const orgs = await joiner.meOrgs();
    expect(orgs.map((o) => o.org.id)).toContain(owner.orgId);
    const list = capture();
    expect(await runCli(['requests', 'list', '--json'], env, list.io)).toBe(0);
    expect(JSON.parse(list.out()).items).toHaveLength(0);
  });
});

/* ================================================================== *
 * agents / share / unshare
 * ================================================================== */

describe('sparrow CLI — agents, share, unshare', () => {
  async function ownerProfile(owner: Owner): Promise<void> {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { me: { server: url, token: owner.token, kind: 'human' } },
        defaultProfile: 'me',
      }),
    );
  }

  it('agents lists visible agents (owned)', async () => {
    const owner = await boot('ag@x.com');
    await makeAgent(owner, 'bot-a');
    await makeAgent(owner, 'bot-b');
    await ownerProfile(owner);
    const cap = capture();
    expect(await runCli(['agents', '--json'], env, cap.io)).toBe(0);
    const names = JSON.parse(cap.out()).items.map((a: any) => a.agent.name).sort();
    expect(names).toEqual(['bot-a', 'bot-b']);
  });

  /* ---------------------------------------------------------------- *
   * `--org` takes an id OR a slug (SPEC: "the org to act in"). The server
   * matches org IDs only, so a raw slug forwarded as the `org` query param
   * used to filter EVERYTHING out — empty output, exit 0, no error.
   * ---------------------------------------------------------------- */

  it('--org accepts a slug wherever it accepts an id (agents, rooms, dm)', async () => {
    const owner = await boot('orgsel@x.com');
    const agent = await makeAgent(owner, 'slug-bot');
    const org = await owner.client.getOrg(owner.orgId);
    expect(org.slug).not.toBe(owner.orgId);
    await ownerProfile(owner);
    const agentIds = (c: Capture): string[] =>
      JSON.parse(c.out()).items.map((a: any) => a.agent.id);

    const byId = capture();
    expect(await runCli(['agents', '--org', owner.orgId, '--json'], env, byId.io)).toBe(0);
    const bySlug = capture();
    expect(await runCli(['agents', '--org', org.slug, '--json'], env, bySlug.io)).toBe(0);
    expect(agentIds(bySlug)).toEqual([agent.id]);
    expect(agentIds(bySlug)).toEqual(agentIds(byId));

    // No --org still aggregates over every org rather than narrowing to one.
    const all = capture();
    expect(await runCli(['agents', '--json'], env, all.io)).toBe(0);
    expect(agentIds(all)).toContain(agent.id);

    // `rooms` narrows on the same selector.
    const room = await owner.client.createRoom(owner.orgId, { name: 'orgsel-room' });
    const rooms = capture();
    expect(await runCli(['rooms', '--org', org.slug, '--json'], env, rooms.io)).toBe(0);
    expect(JSON.parse(rooms.out()).items.map((r: any) => r.room.id)).toContain(room.id);

    // `dm` resolves the principal AND opens the DM in the named org.
    const dm = capture();
    expect(await runCli(['dm', 'slug-bot', '--org', org.slug, '--json'], env, dm.io)).toBe(0);
    expect(JSON.parse(dm.out()).dm.room.id).toMatch(/^room_/);
  });

  it('an --org selector that matches nothing fails loudly instead of listing nothing', async () => {
    const owner = await boot('orgbad@x.com');
    await makeAgent(owner, 'lonely-bot');
    await ownerProfile(owner);

    for (const argv of [
      ['agents', '--org', 'no-such-org', '--json'],
      ['rooms', '--org', 'no-such-org', '--json'],
      ['dm', 'lonely-bot', '--org', 'no-such-org', '--json'],
    ]) {
      const cap = capture();
      expect(await runCli(argv, env, cap.io)).toBe(1);
      expect(cap.err()).toContain('No org');
    }
  });

  it('share by agent name + email, then unshare by email', async () => {
    const owner = await boot('sh@x.com');
    const agent = await makeAgent(owner, 'shared-bot');
    const grantee = await addHuman(owner, 'grantee@x.com');
    await ownerProfile(owner);

    const share = capture();
    expect(await runCli(['share', 'shared-bot', 'grantee@x.com', '--json'], env, share.io)).toBe(0);
    expect(JSON.parse(share.out())).toMatchObject({ ok: true, agentId: agent.id });
    // The grantee now sees the agent.
    const granteeAgents = await grantee.client.listAgents();
    expect(granteeAgents.map((a) => a.agent.id)).toContain(agent.id);

    const unshare = capture();
    expect(await runCli(['unshare', 'shared-bot', 'grantee@x.com', '--json'], env, unshare.io)).toBe(0);
    expect(JSON.parse(unshare.out())).toMatchObject({ ok: true, humanId: grantee.userId });
  });

  /* ---------------------------------------------------------------- *
   * `agents` on an AGENT key
   *
   * `GET /me/agents` is the human VISIBILITY list — a human concept (which
   * agents may I see and govern?). An agent key 401s there, and the raw
   * "Sign-in required" reads like broken credentials rather than the wrong
   * kind of credential. Fail fast instead, and name the surfaces an agent
   * legitimately has for finding another agent.
   * ---------------------------------------------------------------- */

  it('agents fails fast on an agent PROFILE, naming the tools an agent has', async () => {
    const owner = await boot('agk1@x.com');
    const agent = await makeAgent(owner, 'agk1-bot');
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);

    const cap = capture();
    expect(await runCli(['agents'], env, cap.io)).toBe(1);
    const err = cap.err();
    expect(err).not.toMatch(/Sign-in required/i);
    expect(err).toMatch(/agent key/i);
    expect(err).toContain('sparrow dm');
    expect(err).toContain('sparrow members');
  });

  it('agents detects an agent key from the token itself (no profile)', async () => {
    const owner = await boot('agk2@x.com');
    const agent = await makeAgent(owner, 'agk2-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };

    const cap = capture();
    expect(await runCli(['agents'], e, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/agent key/i);
    expect(cap.err()).not.toMatch(/Sign-in required/i);
  });

  it('an undetectable credential that 401s on the route gets the same explanation', async () => {
    await boot('agk3@x.com');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: 'opaque-credential' };

    const cap = capture();
    expect(await runCli(['agents'], e, cap.io)).toBe(1);
    const err = cap.err();
    expect(err).toMatch(/agent key/i);
    expect(err).toContain('sparrow dm');
  });
});

/* ================================================================== *
 * room messaging (agent profile, --room)
 * ================================================================== */

describe('sparrow CLI — room messaging', () => {
  /** Owner + a room with the owner and an agent as members; agent = default profile. */
  async function roomFixture(prefix: string): Promise<{
    owner: Owner;
    roomId: string;
    roomName: string;
    agentId: string;
    agentClient: SparrowClient;
  }> {
    const owner = await boot(`${prefix}@x.com`);
    const roomName = `${prefix}-room`;
    const room = await owner.client.createRoom(owner.orgId, { name: roomName });
    const agent = await makeAgent(owner, `${prefix}-bot`);
    await owner.client.addMember(room.id, agent.id);
    // Log the agent in as the default CLI profile.
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    return { owner, roomId: room.id, roomName, agentId: agent.id, agentClient: agent.client };
  }

  it('members lists the room members', async () => {
    const { roomName } = await roomFixture('mem');
    const cap = capture();
    expect(await runCli(['members', '--room', roomName, '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).items.length).toBe(2);
  });

  it('room resolves by name and id; --room required otherwise', async () => {
    const { roomId, roomName } = await roomFixture('res');
    const byName = capture();
    expect(await runCli(['members', '--room', roomName, '--json'], env, byName.io)).toBe(0);
    const byId = capture();
    expect(await runCli(['members', '--room', roomId, '--json'], env, byId.io)).toBe(0);
    const missing = capture();
    expect(await runCli(['members'], env, missing.io)).toBe(1);
    expect(missing.err()).toMatch(/--room/);
  });

  it('send + pop + status happy path (agent ↔ owner)', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('flow');
    // Owner sends to the agent.
    const sent = await owner.client.sendMessage(roomId, { to: agentId, body: 'hello agent' });
    void sent;

    const pop = capture();
    expect(await runCli(['pop', '--room', roomName, '--json'], env, pop.io)).toBe(0);
    const popped = JSON.parse(pop.out());
    expect(popped.message.body).toBe('hello agent');
    expect(popped.room.name).toBe(roomName);

    // Agent replies to 'all' via the CLI.
    const send = capture();
    expect(await runCli(['send', 'all', 'hi owner', '--room', roomName, '--json'], env, send.io)).toBe(0);
    const res = JSON.parse(send.out());
    expect(res.message.body).toBe('hi owner');
    expect(res).toHaveProperty('unreadCount');

    // Per-recipient status of the agent's message: recipient hasn't seen it yet.
    const status = capture();
    expect(await runCli(['status', res.message.id, '--room', roomName, '--json'], env, status.io)).toBe(0);
    const unreadRec = JSON.parse(status.out()).recipients[0];
    expect(unreadRec.status).toBe('unread');
    expect(unreadRec.receivedAt).toBeNull();

    // Owner lists the inbox → server-observed delivery marks the message received.
    await owner.client.listInbox(roomId);
    const received = capture();
    expect(await runCli(['status', res.message.id, '--room', roomName, '--json'], env, received.io)).toBe(0);
    const recvRec = JSON.parse(received.out()).recipients[0];
    expect(recvRec.status).toBe('received');
    expect(recvRec.receivedAt).toBeTruthy();
    expect(recvRec.readAt).toBeNull();

    // Human-readable rendering surfaces the RECEIVED AT column + timestamp.
    const humanStatus = capture();
    expect(await runCli(['status', res.message.id, '--room', roomName], env, humanStatus.io)).toBe(0);
    expect(humanStatus.out()).toContain('RECEIVED AT');
    expect(humanStatus.out()).toContain(recvRec.receivedAt);

    // Owner pops → read; receivedAt is preserved alongside readAt.
    await owner.client.popNextMessage(roomId);
    const readCap = capture();
    expect(await runCli(['status', res.message.id, '--room', roomName, '--json'], env, readCap.io)).toBe(0);
    const readRec = JSON.parse(readCap.out()).recipients[0];
    expect(readRec.status).toBe('read');
    expect(readRec.receivedAt).toBe(recvRec.receivedAt);
    expect(readRec.readAt).toBeTruthy();
  });

  it('read <id> acks a specific message by id (no --room); --peek does not consume', async () => {
    const { owner, roomId, agentId } = await roomFixture('ackid');
    // Owner sends two DMs to the agent (the CLI default profile); the agent will
    // handle the NEWER one specifically — blind `pop` would take the older.
    const first = await owner.client.sendMessage(roomId, { to: agentId, body: 'older one' });
    const second = await owner.client.sendMessage(roomId, { to: agentId, body: 'the one I saw' });

    const statusOf = async (id: string) =>
      (await owner.client.getMessageStatus(roomId, id)).recipients[0]!.status;

    // Peek by id (no --room): prints the body, marks nothing read.
    const peek = capture();
    expect(await runCli(['read', second.message.id, '--peek', '--json'], env, peek.io)).toBe(0);
    expect(JSON.parse(peek.out()).message.body).toBe('the one I saw');
    expect(await statusOf(second.message.id)).not.toBe('read');

    // Ack by id (no --room): marks THAT id read; the older message stays unread.
    const ack = capture();
    expect(await runCli(['read', second.message.id, '--json'], env, ack.io)).toBe(0);
    expect(JSON.parse(ack.out()).message.id).toBe(second.message.id);
    expect(await statusOf(second.message.id)).toBe('read');
    expect(await statusOf(first.message.id)).not.toBe('read');

    // Human rendering prints the body (and the room tag).
    const human = capture();
    expect(await runCli(['read', second.message.id], env, human.io)).toBe(0);
    expect(human.out()).toContain('the one I saw');
  });

  it('log prints a chronological transcript; -j is raw newest-first; pages via --before', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('log');
    // Owner sends three DMs to the agent (the CLI's default profile).
    for (const body of ['first', 'second', 'third']) {
      await owner.client.sendMessage(roomId, { to: agentId, body });
    }

    // JSON: the raw response, newest-first, with a nextBefore cursor.
    const j = capture();
    expect(await runCli(['log', '--room', roomName, '-j'], env, j.io)).toBe(0);
    const res = JSON.parse(j.out());
    expect(res.items.map((m: { body: string }) => m.body)).toEqual(['third', 'second', 'first']);
    expect(res.nextBefore).toBeNull();

    // Human: oldest-first chronological transcript.
    const human = capture();
    expect(await runCli(['log', '--room', roomName], env, human.io)).toBe(0);
    const text = human.out();
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));

    // Paging: --limit caps the window; --before walks older.
    const p1 = capture();
    expect(await runCli(['log', '--room', roomName, '--limit', '2', '-j'], env, p1.io)).toBe(0);
    const page1 = JSON.parse(p1.out());
    expect(page1.items.map((m: { body: string }) => m.body)).toEqual(['third', 'second']);
    expect(page1.nextBefore).toBeTruthy();
    const p2 = capture();
    expect(
      await runCli(
        ['log', '--room', roomName, '--limit', '2', '--before', page1.nextBefore, '-j'],
        env,
        p2.io,
      ),
    ).toBe(0);
    expect(JSON.parse(p2.out()).items.map((m: { body: string }) => m.body)).toEqual(['first']);
  });

  it('send --suggest + read shows suggestions; --in-reply-to/--reply-value echoes', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('sg');
    // Owner asks with a suggestion; agent will reply structurally.
    const ask = await owner.client.sendMessage(roomId, {
      to: agentId,
      body: 'ship?',
      suggestedReplies: [{ label: 'Ship it', value: 'ship' }],
    });
    // Agent pops it (must be able to read to reply-to it).
    await runCli(['pop', '--room', roomName], env, capture().io);

    const reply = capture();
    expect(
      await runCli(
        ['send', 'all', 'Ship it', '--room', roomName, '--in-reply-to', ask.message.id, '--reply-value', 'ship', '--json'],
        env,
        reply.io,
      ),
    ).toBe(0);
    const replied = JSON.parse(reply.out()).message;
    expect(replied.inReplyTo).toBe(ask.message.id);
    expect(replied.replyValue).toBe('ship');

    // Owner reads the reply and sees the echo.
    const asHuman = await owner.client.readMessage(roomId, replied.id, { peek: true });
    expect(asHuman.inReplyTo).toBe(ask.message.id);

    // Agent send with a suggestion; read --peek renders it.
    const suggest = capture();
    await runCli(['send', 'all', 'go?', '--room', roomName, '--suggest', 'Yes=y', '--suggest', 'No', '--json'], env, suggest.io);
    const sid = JSON.parse(suggest.out()).message.id;
    const read = capture();
    await runCli(['read', sid, '--room', roomName, '--peek'], env, read.io);
    expect(read.out()).toContain('suggested replies:');
    expect(read.out()).toContain('Yes = y');
    expect(read.out()).toContain('- No');
  });

  it('send --origin voice round-trips; --json and read/pop mark [voice]', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('orig');

    // Agent sends a dictated message to all; --json passes origin through.
    const send = capture();
    expect(
      await runCli(['send', 'all', 'dictated body', '--room', roomName, '--origin', 'voice', '--json'], env, send.io),
    ).toBe(0);
    const sent = JSON.parse(send.out()).message;
    expect(sent.origin).toBe('voice');
    // Owner reads it back: origin echoes on the wire.
    const asHuman = await owner.client.readMessage(roomId, sent.id, { peek: true });
    expect(asHuman.origin).toBe('voice');

    // A voice-origin message inbound to the agent renders a [voice] tag in
    // human output of both `read` and `pop`. (owner.client forwards the body
    // as-is; its param type does not yet list origin — cast in the test.)
    await owner.client.sendMessage(roomId, {
      to: agentId,
      body: 'spoken to you',
      origin: 'voice',
    } as unknown as Parameters<typeof owner.client.sendMessage>[1]);

    const pop = capture();
    expect(await runCli(['pop', '--room', roomName], env, pop.io)).toBe(0);
    expect(pop.out()).toContain('[voice]');
    // The popped id, re-read (peek), still shows the tag.
    const poppedId = pop.out().match(/id:\s+(\S+)/)![1]!;
    const read = capture();
    await runCli(['read', poppedId, '--room', roomName, '--peek'], env, read.io);
    expect(read.out()).toContain('[voice]');
  });

  it('a typed (no --origin) message shows no [voice] tag', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('typd');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'plain' });
    const pop = capture();
    expect(await runCli(['pop', '--room', roomName], env, pop.io)).toBe(0);
    expect(pop.out()).not.toContain('[voice]');
  });

  it('send --origin with a non-voice value exits 1 before sending', async () => {
    const { roomName } = await roomFixture('obad');
    const cap = capture();
    const code = await runCli(['send', 'all', 'x', '--room', roomName, '--origin', 'email', '--json'], env, cap.io);
    expect(code).toBe(1);
    expect(cap.err()).toMatch(/origin/i);
  });

  it('--reply-value without --in-reply-to is a bad_request', async () => {
    const { roomName } = await roomFixture('rb');
    const cap = capture();
    const code = await runCli(['send', 'all', 'x', '--room', roomName, '--reply-value', 'ship', '--json'], env, cap.io);
    expect(code).toBe(1);
    expect(cap.err()).toContain('bad_request');
  });

  it('send --stdin reads the body from stdin', async () => {
    const { roomName } = await roomFixture('stdin');
    const cap = capture({ stdin: 'piped body' });
    expect(await runCli(['send', 'all', '--stdin', '--room', roomName, '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).message.body).toBe('piped body');
  });

  it('inbox (room), outbox, and pop on empty inbox', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('io');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'one' });

    const inbox = capture();
    expect(await runCli(['inbox', '--room', roomName, '--json'], env, inbox.io)).toBe(0);
    expect(JSON.parse(inbox.out()).items).toHaveLength(1);

    // Agent sends → appears in outbox.
    await runCli(['send', 'all', 'out msg', '--room', roomName], env, capture().io);
    const outbox = capture();
    expect(await runCli(['outbox', '--room', roomName, '--json'], env, outbox.io)).toBe(0);
    expect(JSON.parse(outbox.out()).items.some((m: any) => m.body === 'out msg')).toBe(true);

    // Drain then pop empty.
    await runCli(['pop', '--room', roomName], env, capture().io);
    const empty = capture();
    expect(await runCli(['pop', '--room', roomName, '--json'], env, empty.io)).toBe(0);
    expect(JSON.parse(empty.out())).toEqual({ message: null });
  });

  it('status working/list/idle manage the working indicator', async () => {
    const { roomName } = await roomFixture('ws');
    const set = capture();
    expect(await runCli(['status', 'working', '--note', 'thinking', '--room', roomName, '--json'], env, set.io)).toBe(0);
    expect(JSON.parse(set.out())).toMatchObject({ state: 'working', note: 'thinking' });

    const list = capture();
    expect(await runCli(['status', 'list', '--room', roomName, '--json'], env, list.io)).toBe(0);
    expect(JSON.parse(list.out()).items).toHaveLength(1);

    const human = capture();
    await runCli(['status', 'list', '--room', roomName], env, human.io);
    expect(human.out()).toContain('thinking');

    const idle = capture();
    expect(await runCli(['status', 'idle', '--room', roomName, '--json'], env, idle.io)).toBe(0);
    const after = capture();
    await runCli(['status', 'list', '--room', roomName, '--json'], env, after.io);
    expect(JSON.parse(after.out()).items).toHaveLength(0);
  });

  it('status working --sticky sets a no-TTL indicator (expiresAt null)', async () => {
    const { roomName } = await roomFixture('sticky');
    const set = capture();
    expect(
      await runCli(
        ['status', 'working', '--note', 'long task', '--sticky', '--room', roomName, '--json'],
        env,
        set.io,
      ),
    ).toBe(0);
    expect(JSON.parse(set.out())).toMatchObject({ state: 'working', sticky: true, expiresAt: null });
  });

  it('presence --ttl marks online without a stream; --ttl 0 clears', async () => {
    await roomFixture('pres'); // logs in the agent profile (presence is not room-scoped)
    const mark = capture();
    expect(await runCli(['presence', '--ttl', '60', '--json'], env, mark.io)).toBe(0);
    expect(JSON.parse(mark.out()).onlineUntil).toEqual(expect.any(String));

    const clear = capture();
    expect(await runCli(['presence', '--ttl', '0', '--json'], env, clear.io)).toBe(0);
    expect(JSON.parse(clear.out()).onlineUntil).toBeNull();
  });

  it('pop --ack advertises a status scoped to the sender', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('ack');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'reply please' });
    const pop = capture();
    expect(await runCli(['pop', '--ack', '--room', roomName, '--json'], env, pop.io)).toBe(0);
    expect(JSON.parse(pop.out()).message.body).toBe('reply please');
    // The owner sees the agent's working status scoped to them.
    const seen = await owner.client.listStatuses(roomId);
    expect(seen.items).toHaveLength(1);
    expect(seen.items[0]!.note).toBe('reading your message');
  });

  it('attachment send + get roundtrip: bytes identical', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('att');
    const original = Buffer.from([0, 1, 2, 250, 128, 64, 33]);
    const inFile = path.join(configDir, 'payload.bin');
    fs.writeFileSync(inFile, original);
    // Owner sends the attachment TO the agent (recipient can download).
    const sent = await owner.client.sendMessage(roomId, {
      to: agentId,
      body: 'file!',
      attachments: [
        { filename: 'payload.bin', contentType: 'application/octet-stream', dataBase64: original.toString('base64') },
      ],
    });
    const attId = sent.message.attachments[0]!.id;

    const outFile = path.join(configDir, 'out.bin');
    const get = capture();
    expect(
      await runCli(['attachment', 'get', attId, '-o', outFile, '--room', roomName, '--json'], env, get.io),
    ).toBe(0);
    expect(Buffer.compare(fs.readFileSync(outFile), original)).toBe(0);
  });

  it('send --attach: agent uploads a file; owner downloads identical bytes', async () => {
    const { owner, roomId, roomName } = await roomFixture('sendatt');
    const original = Buffer.from([9, 8, 7, 200, 44, 255, 0, 1]);
    const inFile = path.join(configDir, 'screenshot.png');
    fs.writeFileSync(inFile, original);

    // The agent (default CLI profile) broadcasts a captioned message with a file.
    const send = capture();
    expect(
      await runCli(
        ['send', 'all', 'here is the screenshot', '--room', roomName, '--attach', inFile, '--json'],
        env,
        send.io,
      ),
    ).toBe(0);
    const res = JSON.parse(send.out());
    expect(res.message.body).toBe('here is the screenshot');
    // The sent message lists the attachment (name + inferred image content-type).
    expect(res.message.attachments).toHaveLength(1);
    expect(res.message.attachments[0].filename).toBe('screenshot.png');
    expect(res.message.attachments[0].contentType).toBe('image/png');

    // The receiving side (owner) fetches identical bytes via the existing download.
    const dl = await owner.client.getAttachment(roomId, res.message.attachments[0].id);
    expect(Buffer.compare(Buffer.from(dl.bytes), original)).toBe(0);
  });

  it('send --attach: oversize file fails with a friendly client-side error', async () => {
    const { roomName } = await roomFixture('bigatt');
    const bigFile = path.join(configDir, 'huge.bin');
    fs.writeFileSync(bigFile, Buffer.alloc(5 * 1024 * 1024 + 1)); // > 5 MB per-file limit
    const send = capture();
    expect(
      await runCli(['send', 'all', 'too big', '--room', roomName, '--attach', bigFile], env, send.io),
    ).toBe(1);
    expect(send.err()).toMatch(/limit is 5 MB per file/i);
  });

  it('watch --room tails events', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('watch');
    const cap = capture();
    const watch = runCli(['watch', '--room', roomName], env, cap.io);
    await new Promise((r) => setTimeout(r, 150));
    await owner.client.sendMessage(roomId, { to: agentId, body: 'ping' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !cap.out().includes('message.new')) {
      await new Promise((r) => setTimeout(r, 25));
    }
    process.emit('SIGINT');
    expect(await watch).toBe(0);
    expect(cap.out()).toContain('message.new');
  });

  it('watch renders message.received when the recipient is online', async () => {
    const { owner, roomId, roomName, agentClient } = await roomFixture('rwatch');
    const cap = capture();
    // The agent (default CLI profile) tails the room; it is the sender, so it
    // sees receipts for its own messages.
    const watch = runCli(['watch', '--room', roomName], env, cap.io);
    await new Promise((r) => setTimeout(r, 150));
    // Owner comes online so the send is delivered → marked received.
    const ownerStream = owner.client.events(roomId, () => {});
    await new Promise((r) => setTimeout(r, 100));
    const ownerMember = await owner.client.whoami(roomId);
    await agentClient.sendMessage(roomId, { to: ownerMember.id, body: 'receipt please' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !cap.out().includes('message.received')) {
      await new Promise((r) => setTimeout(r, 25));
    }
    ownerStream.close();
    await ownerStream.closed;
    process.emit('SIGINT');
    expect(await watch).toBe(0);
    expect(cap.out()).toContain('message.received');
  });

  it('a room-scoped API error yields exit 1', async () => {
    const { roomName } = await roomFixture('err');
    const cap = capture();
    // A reply to a nonexistent message is a room-scoped 404 from the API.
    const code = await runCli(
      ['send', 'hi', '--in-reply-to', 'msg_nope', '--room', roomName],
      env,
      cap.io,
    );
    expect(code).toBe(1);
    expect(cap.err()).toMatch(/Error:/);
  });
});

/* ================================================================== *
 * Clawback — retract your own still-unread message
 * ================================================================== */

describe('sparrow CLI — clawback', () => {
  /** Owner + a room with the owner and an agent as members; agent = default profile. */
  async function fixture(prefix: string): Promise<{
    owner: Owner;
    roomId: string;
    roomName: string;
    agentId: string;
    agentClient: SparrowClient;
  }> {
    const owner = await boot(`${prefix}@x.com`);
    const roomName = `${prefix}-room`;
    const room = await owner.client.createRoom(owner.orgId, { name: roomName });
    const agent = await makeAgent(owner, `${prefix}-bot`);
    await owner.client.addMember(room.id, agent.id);
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    return { owner, roomId: room.id, roomName, agentId: agent.id, agentClient: agent.client };
  }

  it('clawback <id> retracts an unread message and prints the body verbatim', async () => {
    const { agentClient, roomId, roomName } = await fixture('cbid');
    const sent = await agentClient.sendMessage(roomId, { body: 'secret **draft** body' });

    const cap = capture();
    expect(await runCli(['clawback', sent.message.id, '--room', roomName], env, cap.io)).toBe(0);
    expect(cap.out()).toContain(`Clawed back ${sent.message.id} — body restored below:`);
    expect(cap.out()).toContain('secret **draft** body');

    // The message is dead everywhere: a by-id GET now 404s.
    await expect(
      agentClient.readMessage(roomId, sent.message.id, { peek: true }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('with no id, claws back the caller’s NEWEST own message and prints its body', async () => {
    const { agentClient, roomId, roomName } = await fixture('cbnew');
    const older = await agentClient.sendMessage(roomId, { body: 'older keeper' });
    const newest = await agentClient.sendMessage(roomId, { body: 'newest — oops' });

    const cap = capture();
    expect(await runCli(['clawback', '--room', roomName], env, cap.io)).toBe(0);
    expect(cap.out()).toContain(`Clawed back ${newest.message.id} — body restored below:`);
    expect(cap.out()).toContain('newest — oops');

    // The OLDER message was never touched.
    const kept = await agentClient.readMessage(roomId, older.message.id, { peek: true });
    expect(kept.body).toBe('older keeper');
  });

  it('a read message is refused with the reason; no-arg never walks past it to an older one', async () => {
    const { owner, agentClient, roomId, roomName } = await fixture('cbread');
    const older = await agentClient.sendMessage(roomId, { body: 'older unread' });
    const newest = await agentClient.sendMessage(roomId, { body: 'newest, read' });
    // The owner reads exactly the NEWEST message by id.
    await owner.client.readMessage(roomId, newest.message.id);

    // Explicit id: exit 1 and a one-line error naming the reason.
    const explicit = capture();
    expect(await runCli(['clawback', newest.message.id, '--room', roomName], env, explicit.io)).toBe(1);
    expect(explicit.err()).toMatch(/read/i);

    // No-arg: the newest is ineligible — report WHY, and do NOT claw the older one.
    const noArg = capture();
    expect(await runCli(['clawback', '--room', roomName], env, noArg.io)).toBe(1);
    expect(noArg.err()).toMatch(/read/i);
    const kept = await agentClient.readMessage(roomId, older.message.id, { peek: true });
    expect(kept.body).toBe('older unread');
  });

  it('--json returns the ClawbackMessageResponse shape ({ message })', async () => {
    const { agentClient, roomId, roomName } = await fixture('cbjson');
    const sent = await agentClient.sendMessage(roomId, { body: 'json body' });

    const cap = capture();
    expect(await runCli(['clawback', sent.message.id, '--room', roomName, '--json'], env, cap.io)).toBe(0);
    const res = JSON.parse(cap.out());
    expect(res.message.id).toBe(sent.message.id);
    expect(res.message.body).toBe('json body');
  });

  it('an unknown or foreign id is a clear 404 error', async () => {
    const { roomName } = await fixture('cb404');
    const cap = capture();
    expect(await runCli(['clawback', 'msg_nope', '--room', roomName], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/msg_nope/);
  });

  it('watch --room prints the message.clawback frame', async () => {
    const { agentClient, roomId, roomName } = await fixture('cbwatch');
    const cap = capture();
    const watch = runCli(['watch', '--room', roomName], env, cap.io);
    try {
      await new Promise((r) => setTimeout(r, 150));
      const sent = await agentClient.sendMessage(roomId, { body: 'now you see me' });
      await agentClient.clawbackMessage(roomId, sent.message.id);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !cap.out().includes('message.clawback')) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(cap.out()).toContain('message.clawback');
      expect(cap.out()).toContain(sent.message.id);
    } finally {
      process.emit('SIGINT');
    }
    expect(await watch).toBe(0);
  });
});

/* ================================================================== *
 * DMs + principal inbox aggregation
 * ================================================================== */

describe('sparrow CLI — DMs and principal inbox', () => {
  /** Agent that is a member of a project room and has a DM with its owner. */
  async function fixture(prefix: string): Promise<{
    owner: Owner;
    roomId: string;
    roomName: string;
    dmRoomId: string;
    agentId: string;
  }> {
    const owner = await boot(`${prefix}@x.com`);
    const roomName = `${prefix}-proj`;
    const room = await owner.client.createRoom(owner.orgId, { name: roomName });
    const agent = await makeAgent(owner, `${prefix}-bot`);
    await owner.client.addMember(room.id, agent.id);
    const dm = await owner.client.ensureDm({ principal: agent.id });
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    return { owner, roomId: room.id, roomName, dmRoomId: dm.room.id, agentId: agent.id };
  }

  it('dm to a visible agent (as owner) opens a DM and sends a message', async () => {
    const owner = await boot('dmown@x.com');
    const agent = await makeAgent(owner, 'dm-bot');
    // owner profile
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { me: { server: url, token: owner.token, kind: 'human' } }, defaultProfile: 'me' }),
    );
    const cap = capture();
    expect(await runCli(['dm', 'dm-bot', 'hi bot', '--json'], env, cap.io)).toBe(0);
    const out = JSON.parse(cap.out());
    expect(out.dm.room.kind).toBe('dm');
    expect(out.dm.created).toBe(true);
    expect(out.dm.counterpart.id).toBe(agent.id);
    expect(out.sent.message.body).toBe('hi bot');
  });

  it('inbox without --room aggregates a project room and a DM', async () => {
    const { owner, roomId, dmRoomId, agentId } = await fixture('agg');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'project msg' });
    await owner.client.sendMessage(dmRoomId, { to: 'all', body: 'dm msg' });

    const cap = capture();
    expect(await runCli(['inbox', '--json'], env, cap.io)).toBe(0);
    const items = JSON.parse(cap.out()).items;
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.room.kind).sort()).toEqual(['dm', 'project']);

    const human = capture();
    await runCli(['inbox'], env, human.io);
    // v4: the union table leads with the medium and names WHERE the item lives
    // (the room for chat, the thread for email).
    expect(human.out()).toContain('WHERE');
    expect(human.out()).toContain('@'); // DM counterpart rendered @person
  });

  it('pop without --room drains oldest-first across memberships as typed WORK ITEMS', async () => {
    const { owner, roomId, roomName, dmRoomId, agentId } = await fixture('drain');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'first project' });
    await owner.client.sendMessage(dmRoomId, { to: 'all', body: 'second dm' });

    // -j prints the discriminated envelope verbatim: `{ item: { type, … } }`.
    const p1 = capture();
    expect(await runCli(['pop', '--json'], env, p1.io)).toBe(0);
    const first = JSON.parse(p1.out());
    expect(first.item.type).toBe('chat.message');
    expect(first.item.message.body).toBe('first project');
    expect(first.item.room.kind).toBe('project');

    // Human output LEADS WITH THE MEDIUM, so the register is obvious first.
    const p2 = capture();
    expect(await runCli(['pop'], env, p2.io)).toBe(0);
    expect(p2.out()).toContain('second dm');
    expect(p2.out().split('\n')[0]).toMatch(/^\[room: /);
    void roomName;

    const p3 = capture();
    expect(await runCli(['pop', '--json'], env, p3.io)).toBe(0);
    // The queue is drained: `item: null`. This is THE PAUSE, so the envelope may
    // also carry the one hint the server attaches there — the item is what this
    // test is about, and it must be null.
    expect(JSON.parse(p3.out()).item).toBeNull();
  });

  it('pop human output leads with the room medium (project rooms as #name)', async () => {
    const { owner, roomId, roomName, agentId } = await fixture('lead');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'lead with me' });
    const cap = capture();
    expect(await runCli(['pop'], env, cap.io)).toBe(0);
    expect(cap.out().split('\n')[0]).toBe(`[room: #${roomName}]`);
  });

  it('inbox without --room renders the typed union (medium column, room label)', async () => {
    const { owner, roomId, dmRoomId, agentId } = await fixture('union');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'project msg' });
    await owner.client.sendMessage(dmRoomId, { to: 'all', body: 'dm msg' });

    const cap = capture();
    expect(await runCli(['inbox', '--json'], env, cap.io)).toBe(0);
    const items = JSON.parse(cap.out()).items;
    expect(items.every((i: any) => i.type === 'chat.message')).toBe(true);

    const human = capture();
    expect(await runCli(['inbox'], env, human.io)).toBe(0);
    expect(human.out()).toContain('MEDIUM');
    expect(human.out()).toContain('chat');
    expect(human.out()).toContain('WHERE');

    // `--medium email` narrows to the (empty in v4) email half.
    const emailOnly = capture();
    expect(await runCli(['inbox', '--medium', 'email', '--json'], env, emailOnly.io)).toBe(0);
    expect(JSON.parse(emailOnly.out()).items).toHaveLength(0);
  });

  it('activity renders the interleaved timeline oldest-first (chat today)', async () => {
    const { owner, roomId, agentId } = await fixture('act');
    const sent = await owner.client.sendMessage(roomId, { to: agentId, body: 'journaled line' });

    // The agent profile reads its OWN timeline.
    const cap = capture();
    expect(await runCli(['activity', '--json'], env, cap.io)).toBe(0);
    const page = JSON.parse(cap.out());
    expect(page.items.some((e: any) => e.refs.messageId === sent.message.id)).toBe(true);
    // -j is the RAW transcript page: `nextBefore` is always a present key
    // (null when exhausted), never an absent one a script cannot page on.
    expect('nextBefore' in page).toBe(true);
    expect(page.nextBefore === null || typeof page.nextBefore === 'string').toBe(true);

    const human = capture();
    expect(await runCli(['activity', '--limit', '5'], env, human.io)).toBe(0);
    expect(human.out()).toContain('[chat]');
    expect(human.out()).toContain('journaled line');
    expect(human.out()).toContain(sent.message.id);
  });

  // Issue #28: an empty timeline is the NORMAL state of a workspace whose agents
  // have not started working yet, and "No activity." alone reads as broken. The
  // line that follows says what the timeline is anchored to.
  it('activity explains an EMPTY timeline instead of printing a bare line', async () => {
    const { owner } = await fixture('actempty');
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { me: { server: url, token: owner.token, kind: 'human' } },
        defaultProfile: 'me',
      }),
    );
    const cap = capture();
    // `--medium voice` is a medium that writes no entries of its own, so this
    // human's timeline is guaranteed empty without depending on fixture order.
    expect(await runCli(['activity', '--medium', 'voice'], env, cap.io)).toBe(0);
    expect(cap.out()).toContain('No activity.');
    expect(cap.out()).toMatch(/timeline follows your agents/i);
    // `--json` stays a machine surface: the prose belongs to the human output only.
    const raw = capture();
    expect(await runCli(['activity', '--medium', 'voice', '--json'], env, raw.io)).toBe(0);
    expect(JSON.parse(raw.out()).items).toEqual([]);
    expect(raw.out()).not.toMatch(/timeline follows/i);
  });

  it('activity --agent reads one agent’s timeline (owner credential)', async () => {
    const { owner, roomId, agentId } = await fixture('actag');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'per-agent entry' });
    // Switch the default profile to the owning HUMAN.
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { me: { server: url, token: owner.token, kind: 'human' } },
        defaultProfile: 'me',
      }),
    );
    const cap = capture();
    expect(await runCli(['activity', '--agent', 'actag-bot', '--json'], env, cap.io)).toBe(0);
    const items = JSON.parse(cap.out()).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((e: any) => e.agent.id === agentId)).toBe(true);
  });

  it('watch prints the unwrapped activity.appended entry sensibly', async () => {
    const { owner, roomId, agentId } = await fixture('watchact');
    // The agent watches its own stream; `activity.appended` goes to the OWNER, so
    // watch as the owner instead.
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { me: { server: url, token: owner.token, kind: 'human' } },
        defaultProfile: 'me',
      }),
    );
    const cap = capture();
    const watch = runCli(['watch', '--poll-seconds', '0'], env, cap.io);
    const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    await nap(250);
    await owner.client.sendMessage(roomId, { to: agentId, body: 'appended live' });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !cap.out().includes('[activity]')) await nap(25);
    process.emit('SIGINT');
    await watch;
    const line = cap.out().split('\n').find((l) => l.includes('[activity]'))!;
    expect(line).toContain('chat.message');
    expect(line).toContain('appended live');
  });
});

/* ================================================================== *
 * send resolution + reply + use + loop  (new ergonomics)
 * ================================================================== */

describe('sparrow CLI — send resolution, reply, use, loop', () => {
  const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Owner + project room with an agent member; the agent is the default CLI profile. */
  async function roomFixture(prefix: string): Promise<{
    owner: Owner;
    roomId: string;
    roomName: string;
    agentId: string;
    ownerMemberId: string;
  }> {
    const owner = await boot(`${prefix}@x.com`);
    const roomName = `${prefix}-room`;
    const room = await owner.client.createRoom(owner.orgId, { name: roomName });
    const agent = await makeAgent(owner, `${prefix}-bot`);
    await owner.client.addMember(room.id, agent.id);
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    const ownerMember = await owner.client.whoami(room.id);
    return { owner, roomId: room.id, roomName, agentId: agent.id, ownerMemberId: ownerMember.id };
  }

  it('send reaches the whole room; a leading recipient positional is ignored', async () => {
    // Two positionals: the first (a legacy recipient) is accepted-and-ignored,
    // the second is the body. The message still reaches every other member.
    const { roomName, ownerMemberId } = await roomFixture('sbn');
    const cap = capture();
    expect(await runCli(['send', 'Owner', 'hey there', '--room', roomName, '--json'], env, cap.io)).toBe(0);
    const msg = JSON.parse(cap.out()).message;
    expect(msg.body).toBe('hey there');
    expect(msg.to.map((t: any) => t.id)).toContain(ownerMemberId);
  });

  it('an unknown recipient positional is ignored — the message still sends', async () => {
    // Recipients are no longer resolved: a bogus leading positional is discarded
    // and the trailing body is sent to the whole room.
    const { roomName } = await roomFixture('sun');
    const cap = capture();
    expect(await runCli(['send', 'Nobody', 'hi', '--room', roomName, '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).message.body).toBe('hi');
  });

  it('send --all is accepted; a single positional is the body', async () => {
    const { roomName } = await roomFixture('sall');
    const cap = capture();
    expect(await runCli(['send', '--all', 'broadcast body', '--room', roomName, '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).message.body).toBe('broadcast body');
  });

  it('send in a DM room defaults to broadcast when the recipient is omitted', async () => {
    const owner = await boot('sdm@x.com');
    const agent = await makeAgent(owner, 'sdm-bot');
    const dm = await owner.client.ensureDm({ principal: agent.id });
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    const cap = capture();
    // A single positional in a DM room is the MESSAGE, not a recipient.
    expect(await runCli(['send', 'hello dm', '--room', dm.room.id, '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).message.body).toBe('hello dm');
  });

  it('reply --last targets the sender of the last popped message with inReplyTo set', async () => {
    const { owner, roomId, roomName, agentId, ownerMemberId } = await roomFixture('rl');
    const asked = await owner.client.sendMessage(roomId, { to: agentId, body: 'ping?' });
    // Agent pops (records last inbound), then replies with no ids.
    await runCli(['pop', '--room', roomName], env, capture().io);
    const cap = capture();
    expect(await runCli(['reply', 'pong', '--json'], env, cap.io)).toBe(0);
    const replied = JSON.parse(cap.out()).message;
    expect(replied.body).toBe('pong');
    expect(replied.inReplyTo).toBe(asked.message.id);
    expect(replied.to.map((t: any) => t.id)).toContain(ownerMemberId);
  });

  it('reply --to <messageId> replies to that message’s sender', async () => {
    const { owner, roomId, roomName, agentId, ownerMemberId } = await roomFixture('rto');
    const asked = await owner.client.sendMessage(roomId, { to: agentId, body: 'question?' });
    const cap = capture();
    expect(
      await runCli(['reply', 'answer', '--to', asked.message.id, '--room', roomName, '--json'], env, cap.io),
    ).toBe(0);
    const replied = JSON.parse(cap.out()).message;
    expect(replied.inReplyTo).toBe(asked.message.id);
    expect(replied.to.map((t: any) => t.id)).toContain(ownerMemberId);
  });

  it('reply --to <messageId> resolves the room automatically (no --room needed)', async () => {
    const { owner, roomId, agentId, ownerMemberId } = await roomFixture('rtar');
    const asked = await owner.client.sendMessage(roomId, { to: agentId, body: 'no-room-question?' });
    // No --room / SPARROW_ROOM: the room is resolved from the message id itself.
    const cap = capture();
    expect(await runCli(['reply', 'answer', '--to', asked.message.id, '--json'], env, cap.io)).toBe(0);
    const replied = JSON.parse(cap.out()).message;
    expect(replied.inReplyTo).toBe(asked.message.id);
    expect(replied.to.map((t: any) => t.id)).toContain(ownerMemberId);
  });

  it('reply --to a nonexistent message id errors clearly (no --room)', async () => {
    await roomFixture('rtae');
    const cap = capture();
    expect(await runCli(['reply', 'answer', '--to', 'msg_nope', '--json'], env, cap.io)).toBe(1);
    expect(cap.err()).not.toMatch(/acts in a room/i); // not the missing-room error
  });

  it('reply with no last inbound message errors clearly', async () => {
    await roomFixture('rn');
    const cap = capture();
    expect(await runCli(['reply', 'hi', '--json'], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/No last inbound/i);
  });

  it('use <room> sets a sticky default; pop/whoami honor it; --clear clears', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('use');
    const setc = capture();
    expect(await runCli(['use', roomName, '--json'], env, setc.io)).toBe(0);
    expect(JSON.parse(setc.out()).defaultRoom).toBe(roomId);

    const who = capture();
    await runCli(['whoami', '--json'], env, who.io);
    expect(JSON.parse(who.out()).defaults.room).toBe(roomId);

    // pop WITHOUT --room now uses the default room (not the /me aggregate).
    await owner.client.sendMessage(roomId, { to: agentId, body: 'via default' });
    const pop = capture();
    expect(await runCli(['pop', '--json'], env, pop.io)).toBe(0);
    const popped = JSON.parse(pop.out());
    expect(popped.message.body).toBe('via default');
    expect(popped.room.id).toBe(roomId);

    const clear = capture();
    expect(await runCli(['use', '--clear', '--json'], env, clear.io)).toBe(0);
    const who2 = capture();
    await runCli(['whoami', '--json'], env, who2.io);
    expect(JSON.parse(who2.out()).defaults.room).toBeNull();
  });

  it('use <org slug> sets a sticky default org', async () => {
    const owner = await boot('useorg@x.com');
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { me: { server: url, token: owner.token, kind: 'human' } }, defaultProfile: 'me' }),
    );
    const org = await owner.client.getOrg(owner.orgId);
    const cap = capture();
    expect(await runCli(['use', org.slug, '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).defaultOrg).toBe(owner.orgId);
  });

  it('--room flag overrides a stored default room (precedence)', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('prec');
    // Point the default at a DIFFERENT (empty) room.
    const other = await owner.client.createRoom(owner.orgId, { name: 'prec-other' });
    await runCli(['use', other.id], env, capture().io);
    // Send into the real room; an explicit --room must win over the default.
    await owner.client.sendMessage(roomId, { to: agentId, body: 'explicit wins' });
    const pop = capture();
    expect(await runCli(['pop', '--room', roomName, '--json'], env, pop.io)).toBe(0);
    expect(JSON.parse(pop.out()).message.body).toBe('explicit wins');
  });

  it('loop drains pop and prints each message as a JSON line', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('loop');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'do work' });
    const cap = capture();
    const loopP = runCli(['loop', '--room', roomName], env, cap.io);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !cap.out().includes('do work')) await nap(25);
    process.emit('SIGINT');
    expect(await loopP).toBe(0);
    const line = cap.out().trim().split('\n').find((l) => l.includes('do work'))!;
    expect(JSON.parse(line).body).toBe('do work');
  });

  it('loop --exec runs a handler per message with the message JSON on stdin', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('lex');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'exec me' });
    const outFile = path.join(configDir, 'handled.jsonl');
    const cmd = `cat >> ${JSON.stringify(outFile)}`;
    const cap = capture();
    const loopP = runCli(['loop', '--room', roomName, '--exec', cmd], env, cap.io);
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').includes('exec me'))
    ) {
      await nap(25);
    }
    process.emit('SIGINT');
    expect(await loopP).toBe(0);
    const written = fs.readFileSync(outFile, 'utf8').trim();
    expect(JSON.parse(written).body).toBe('exec me');
  });

  it('watch --no-reconnect still tails and exits 0 on Ctrl-C', async () => {
    const { owner, roomId, roomName, agentId } = await roomFixture('wnr');
    const cap = capture();
    const watch = runCli(['watch', '--room', roomName, '--no-reconnect'], env, cap.io);
    await nap(150);
    await owner.client.sendMessage(roomId, { to: agentId, body: 'ping' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !cap.out().includes('message.new')) await nap(25);
    process.emit('SIGINT');
    expect(await watch).toBe(0);
    expect(cap.out()).toContain('message.new');
  });
});

/* ================================================================== *
 * `sparrow await` — the WAKE primitive for turn-based agents
 *
 * A background listener makes an agent ONLINE, not ATTENTIVE: a harness that
 * only thinks when it is invoked needs a PROCESS EXIT to be re-invoked. `await`
 * holds the stream (so presence rides it) until a work item is available, prints
 * one JSON line describing it, and exits 0 — deliberately WITHOUT consuming it,
 * because the woken agent pops it in-turn.
 * ================================================================== */

describe('sparrow CLI — await (wake on a work item, without consuming it)', () => {
  const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Owner + project room with an agent member; the agent is the default CLI profile. */
  async function awaitFixture(prefix: string): Promise<{
    owner: Owner;
    roomId: string;
    agentId: string;
  }> {
    const owner = await boot(`${prefix}@x.com`);
    const room = await owner.client.createRoom(owner.orgId, { name: `${prefix}-room` });
    const agent = await makeAgent(owner, `${prefix}-bot`);
    await owner.client.addMember(room.id, agent.id);
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    return { owner, roomId: room.id, agentId: agent.id };
  }

  /** The single JSON line `await` prints on stdout — its whole output contract. */
  function wakeLine(cap: Capture): any {
    const lines = cap.out().trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!);
  }

  it('exits 0 with the already-waiting work item and does NOT consume it', async () => {
    const { owner, roomId, agentId } = await awaitFixture('awt');
    const sent = await owner.client.sendMessage(roomId, { to: agentId, body: 'wake up' });

    const cap = capture();
    expect(await runCli(['await', '--timeout', '10'], env, cap.io)).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.type).toBe('await.item');
    expect(wake.reason).toBe('waiting');
    expect(wake.consumed).toBe(false);
    expect(wake.drain).toBe('sparrow pop');
    expect(wake.item.type).toBe('chat.message');
    expect(wake.item.id).toBe(sent.message.id);

    // NOT consumed: the item is still UNREAD in the inbox…
    const inbox = capture();
    expect(await runCli(['inbox', '--json'], env, inbox.io)).toBe(0);
    expect(JSON.parse(inbox.out()).items.map((i: any) => i.id)).toContain(sent.message.id);
    // …and the pop the woken agent performs in-turn still yields exactly it.
    const pop = capture();
    expect(await runCli(['pop', '--json'], env, pop.io)).toBe(0);
    expect(JSON.parse(pop.out()).item.message.id).toBe(sent.message.id);
  });

  it('holds the stream and wakes on a message that arrives while it waits', async () => {
    const { owner, roomId, agentId } = await awaitFixture('awtl');
    const cap = capture();
    const running = runCli(['await', '--timeout', '15'], env, cap.io);
    await nap(250); // let the stream establish (nothing waiting → it must block)
    expect(cap.out()).toBe('');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'arrived live' });
    expect(await running).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.type).toBe('await.item');
    expect(wake.reason).toBe('message.new');
    expect(wake.item.preview).toContain('arrived live');
    // Still unread — waking is a notification, not a read.
    const pop = capture();
    expect(await runCli(['pop', '--json'], env, pop.io)).toBe(0);
    expect(JSON.parse(pop.out()).item.message.body).toBe('arrived live');
  });

  it('--timeout expires with exit 2 (so a harness can re-arm) and one await.timeout line', async () => {
    await awaitFixture('awto');
    const cap = capture();
    expect(await runCli(['await', '--timeout', '1'], env, cap.io)).toBe(2);
    const line = wakeLine(cap);
    expect(line.type).toBe('await.timeout');
    expect(line.timeoutSeconds).toBe(1);
  });

  it('watch --exit-on-item is the same wake primitive', async () => {
    const { owner, roomId, agentId } = await awaitFixture('awtw');
    const sent = await owner.client.sendMessage(roomId, { to: agentId, body: 'via watch alias' });
    const cap = capture();
    expect(await runCli(['watch', '--exit-on-item', '--timeout', '10'], env, cap.io)).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.type).toBe('await.item');
    expect(wake.item.id).toBe(sent.message.id);
    // The alias must not consume either.
    const pop = capture();
    expect(await runCli(['pop', '--json'], env, pop.io)).toBe(0);
    expect(JSON.parse(pop.out()).item.message.id).toBe(sent.message.id);
  });

  it('a work-item-less event does not wake it — inbox availability is the gate', async () => {
    const { owner, roomId } = await awaitFixture('awtn');
    const cap = capture();
    const running = runCli(['await', '--timeout', '2'], env, cap.io);
    await nap(200);
    // The agent's OWN send produces stream traffic but leaves its inbox empty.
    const me = capture();
    await runCli(['send', 'talking to myself', '--room', roomId, '--json'], env, me.io);
    void owner;
    expect(await running).toBe(2); // timed out — never woke on its own message
    expect(wakeLine(cap).type).toBe('await.timeout');
  });

  /* ---------------------------------------------------------------- *
   * The turn heartbeat (PROD BUG): `await` exits to wake the agent, so
   * while the agent PROCESSES the item it holds NO stream. Past the
   * presence grace it read OFFLINE — its owner saw "isn't listening yet"
   * and got hinted to start listening, while the agent was mid-turn on
   * that very message. The wake now plants a `POST /me/presence` mark
   * (SPEC "Presence → Self-reported heartbeat") covering the turn.
   * ---------------------------------------------------------------- */

  /** Whether the owner sees `agentId` as online (`isPrincipalOnline`: stream OR mark). */
  async function ownerSeesOnline(owner: Owner, agentId: string): Promise<boolean> {
    const agents = await owner.client.listAgents({ org: owner.orgId });
    const found = agents.find((a) => a.agent.id === agentId);
    expect(found).toBeDefined(); // the owner must actually see its own agent
    return found!.agent.online === true;
  }

  it('a wake plants a heartbeat mark, so the agent stays online through its turn', async () => {
    const { owner, roomId, agentId } = await awaitFixture('awtp');
    // Nothing has ever opened a stream for this agent — it is plainly offline.
    expect(await ownerSeesOnline(owner, agentId)).toBe(false);
    await owner.client.sendMessage(roomId, { to: agentId, body: 'do the thing' });

    const cap = capture();
    expect(await runCli(['await', '--timeout', '10'], env, cap.io)).toBe(0);
    expect(wakeLine(cap).type).toBe('await.item');
    // `await` has EXITED and holds no socket — yet the turn reads online.
    expect(await ownerSeesOnline(owner, agentId)).toBe(true);
  });

  it('a wake off the live stream plants the mark too (it outlives the presence grace)', async () => {
    // A tiny presence grace so "the stream is gone" is observable in-test.
    await stopServer();
    await startServer({ presenceGraceSeconds: 0.15 });
    const { owner, roomId, agentId } = await awaitFixture('awtg');

    const cap = capture();
    const running = runCli(['await', '--timeout', '15'], env, cap.io);
    await nap(250);
    await owner.client.sendMessage(roomId, { to: agentId, body: 'arrived live' });
    expect(await running).toBe(0);
    await nap(400); // past the grace — the stream can no longer hold presence up
    expect(await ownerSeesOnline(owner, agentId)).toBe(true);
  });

  it('a --timeout expiry plants NO mark — a re-arming harness is not a turn', async () => {
    await stopServer();
    await startServer({ presenceGraceSeconds: 0.15 });
    const { owner, agentId } = await awaitFixture('awtq');

    const cap = capture();
    expect(await runCli(['await', '--timeout', '1'], env, cap.io)).toBe(2);
    await nap(400); // past the grace
    expect(await ownerSeesOnline(owner, agentId)).toBe(false);
  });

  it('--turn-seconds 0 disables the mark', async () => {
    const { owner, roomId, agentId } = await awaitFixture('awtz');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'no heartbeat please' });

    const cap = capture();
    expect(await runCli(['await', '--timeout', '10', '--turn-seconds', '0'], env, cap.io)).toBe(0);
    expect(wakeLine(cap).type).toBe('await.item');
    expect(await ownerSeesOnline(owner, agentId)).toBe(false);
  });

  it('the mark TTL is --turn-seconds (default 180), clamped to the server max', async () => {
    const { owner, roomId, agentId } = await awaitFixture('awtt');
    const proxy = await startPresenceProxy();
    try {
      await owner.client.sendMessage(roomId, { to: agentId, body: 'one' });
      const a = capture();
      expect(await runCli(['await', '--timeout', '10', '--server', proxy.url], env, a.io)).toBe(0);
      expect(await runCli(['pop', '--json'], env, capture().io)).toBe(0);
      expect(proxy.posts).toEqual([{ ttlSeconds: 180 }]);

      await owner.client.sendMessage(roomId, { to: agentId, body: 'two' });
      const b = capture();
      expect(
        await runCli(
          ['await', '--timeout', '10', '--turn-seconds', '9999', '--server', proxy.url],
          env,
          b.io,
        ),
      ).toBe(0);
      // Over the server's cap would be a 400; the CLI clamps instead.
      expect(proxy.posts[1]).toEqual({ ttlSeconds: PRESENCE_TTL_MAX });
      expect(await ownerSeesOnline(owner, agentId)).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('a failed presence POST is best-effort: exit 0, wake line intact, one stderr note', async () => {
    const { owner, roomId, agentId } = await awaitFixture('awtf');
    const proxy = await startPresenceProxy();
    proxy.fail = true;
    try {
      const sent = await owner.client.sendMessage(roomId, { to: agentId, body: 'heartbeat dies' });
      const cap = capture();
      expect(await runCli(['await', '--timeout', '10', '--server', proxy.url], env, cap.io)).toBe(0);
      const wake = wakeLine(cap); // still EXACTLY one stdout line…
      expect(wake.type).toBe('await.item');
      expect(wake.item.id).toBe(sent.message.id);
      expect(cap.err()).toContain('presence'); // …and the failure is a stderr note only
      // The item was never consumed by the failed heartbeat path either.
      const pop = capture();
      expect(await runCli(['pop', '--json'], env, pop.io)).toBe(0);
      expect(JSON.parse(pop.out()).item.message.id).toBe(sent.message.id);
    } finally {
      await proxy.close();
    }
  });

  /* ---------------------------------------------------------------- *
   * WAKE GRANULARITY (`--wake-on` / `--batch-after`)
   *
   * Field report: in a five-member room every status broadcast woke the
   * agent. The ask was granularity, NOT muting — wake urgently for DMs and
   * @-mentions, batch the rest. So `--wake-on` narrows what wakes you
   * IMMEDIATELY and `--batch-after` is the floor under it: anything unread
   * still wakes you once it has waited that long. Only `--batch-after 0`
   * truly defers indefinitely, and even then the item stays queued for
   * `sparrow pop`.
   * ---------------------------------------------------------------- */

  /** `awaitFixture` plus a DM room between the owner and the agent. */
  async function granularityFixture(prefix: string): Promise<{
    owner: Owner;
    roomId: string;
    dmRoomId: string;
    agentId: string;
    agentName: string;
  }> {
    const base = await awaitFixture(prefix);
    const dm = await base.owner.client.ensureDm({ principal: base.agentId });
    return { ...base, dmRoomId: dm.room.id, agentName: `${prefix}-bot` };
  }

  it('--wake-on dm does not wake on project-room traffic — but never mutes it', async () => {
    const { owner, roomId, agentId } = await granularityFixture('awtg1');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'status broadcast' });

    const cap = capture();
    expect(
      await runCli(['await', '--wake-on', 'dm', '--batch-after', '0', '--timeout', '1'], env, cap.io),
    ).toBe(2);
    expect(wakeLine(cap).type).toBe('await.timeout');
    // Deferred, NOT muted: the item is still in the queue for an in-turn drain.
    const pop = capture();
    expect(await runCli(['pop', '--json'], env, pop.io)).toBe(0);
    expect(JSON.parse(pop.out()).item.message.body).toBe('status broadcast');
  });

  it('--wake-on dm wakes on a DM even with older project traffic ahead of it', async () => {
    const { owner, roomId, dmRoomId, agentId } = await granularityFixture('awtg2');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'noise' });
    await owner.client.sendMessage(dmRoomId, { to: 'all', body: 'urgent, please' });

    const cap = capture();
    expect(
      await runCli(['await', '--wake-on', 'dm', '--batch-after', '0', '--timeout', '10'], env, cap.io),
    ).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.type).toBe('await.item');
    expect(wake.matched).toBe('dm');
    expect(wake.consumed).toBe(false);
    expect(wake.item.room.kind).toBe('dm');
    expect(wake.item.preview).toContain('urgent');
  });

  it('--wake-on mention wakes on an @name in a project room, not on other chatter', async () => {
    const { owner, roomId, agentId, agentName } = await granularityFixture('awtg3');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'unrelated chatter' });
    await owner.client.sendMessage(roomId, {
      to: agentId,
      body: `hey @${agentName} can you look?`,
    });

    const cap = capture();
    expect(
      await runCli(
        ['await', '--wake-on', 'mention', '--batch-after', '0', '--timeout', '10'],
        env,
        cap.io,
      ),
    ).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.matched).toBe('mention');
    expect(wake.item.preview).toContain('can you look');
  });

  it('--wake-on mention sees an @name past the preview cutoff (a peek, still unread)', async () => {
    const { owner, roomId, agentId, agentName } = await granularityFixture('awtg7');
    const body = `${'x'.repeat(400)} @${agentName} at the very end`;
    const sent = await owner.client.sendMessage(roomId, { to: agentId, body });

    const cap = capture();
    expect(
      await runCli(
        ['await', '--wake-on', 'mention', '--batch-after', '0', '--timeout', '10'],
        env,
        cap.io,
      ),
    ).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.matched).toBe('mention');
    expect(wake.item.truncated).toBe(true);
    // The peek wrote no read state — the woken agent still pops it in-turn.
    const pop = capture();
    expect(await runCli(['pop', '--json'], env, pop.io)).toBe(0);
    expect(JSON.parse(pop.out()).item.message.id).toBe(sent.message.id);
  });

  it('non-urgent work already waiting wakes on the --batch-after deadline', async () => {
    const { owner, roomId, agentId } = await granularityFixture('awtg4');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'batch me' });

    const cap = capture();
    expect(
      await runCli(['await', '--wake-on', 'dm', '--batch-after', '1', '--timeout', '15'], env, cap.io),
    ).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.type).toBe('await.item');
    expect(wake.matched).toBe('batch');
    expect(wake.item.preview).toContain('batch me');
  });

  it('a non-urgent arrival DURING the wait is deferred, then batched', async () => {
    const { owner, roomId, agentId } = await granularityFixture('awtg5');
    const cap = capture();
    const running = runCli(
      ['await', '--wake-on', 'dm,mention', '--batch-after', '1', '--timeout', '15'],
      env,
      cap.io,
    );
    await nap(250); // stream established, nothing waiting
    await owner.client.sendMessage(roomId, { to: agentId, body: 'later is fine' });
    await nap(300);
    expect(cap.out()).toBe(''); // still deferred — the deadline has not passed
    expect(await running).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.matched).toBe('batch');
    expect(wake.item.preview).toContain('later is fine');
  });

  it('the default (no --wake-on) still wakes on anything, tagged matched:"all"', async () => {
    const { owner, roomId, agentId } = await granularityFixture('awtg6');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'anything at all' });

    const cap = capture();
    expect(await runCli(['await', '--timeout', '10'], env, cap.io)).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.reason).toBe('waiting'); // existing fields stay stable
    expect(wake.consumed).toBe(false);
    expect(wake.drain).toBe('sparrow pop');
    expect(wake.matched).toBe('all');
  });

  it('--wake-on rejects an unknown kind before touching the network', async () => {
    await granularityFixture('awtg8');
    const cap = capture();
    expect(await runCli(['await', '--wake-on', 'dm,shouty', '--timeout', '1'], env, cap.io)).toBe(1);
    const err = cap.err();
    expect(err).toContain('shouty');
    expect(err).toContain('dm');
    expect(err).toContain('mention');
    expect(err).toContain('email');
  });

  it('watch --exit-on-item honours --wake-on too (one implementation)', async () => {
    const { owner, roomId, dmRoomId, agentId } = await granularityFixture('awtg9');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'broadcast noise' });
    await owner.client.sendMessage(dmRoomId, { to: 'all', body: 'a real dm' });

    const cap = capture();
    expect(
      await runCli(
        ['watch', '--exit-on-item', '--wake-on', 'dm', '--batch-after', '0', '--timeout', '10'],
        env,
        cap.io,
      ),
    ).toBe(0);
    const wake = wakeLine(cap);
    expect(wake.matched).toBe('dm');
    expect(wake.item.preview).toContain('a real dm');
  });
});

/* ================================================================== *
 * room create/add/invite + invitations
 * ================================================================== */

describe('sparrow CLI — room management + invitations', () => {
  async function ownerProfile(owner: Owner): Promise<void> {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { me: { server: url, token: owner.token, kind: 'human' } }, defaultProfile: 'me' }),
    );
  }

  it('room create → add agent', async () => {
    const owner = await boot('rc@x.com');
    const agent = await makeAgent(owner, 'attachable');
    await ownerProfile(owner);

    const create = capture();
    expect(await runCli(['room', 'create', 'built-by-cli', '--json'], env, create.io)).toBe(0);
    const room = JSON.parse(create.out());
    expect(room.name).toBe('built-by-cli');

    const add = capture();
    expect(await runCli(['room', 'add', 'attachable', '--room', room.id, '--json'], env, add.io)).toBe(0);
    expect(JSON.parse(add.out()).principalId).toBe(agent.id);
  });

  it('room invite a human → they list, accept the invitation', async () => {
    const owner = await boot('ri@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'invite-room' });
    const guest = await addHuman(owner, 'guest@x.com');
    await ownerProfile(owner);

    const invite = capture();
    expect(await runCli(['room', 'invite', 'guest@x.com', '--room', room.id, '--json'], env, invite.io)).toBe(0);
    expect(JSON.parse(invite.out()).invitation).toBeTruthy();

    // Guest CLI profile.
    const guestCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-guest-'));
    const guestEnv = { ...env, XDG_CONFIG_HOME: guestCfg };
    fs.mkdirSync(path.join(guestCfg, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(guestCfg, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { me: { server: url, token: guest.client.token, kind: 'human' } }, defaultProfile: 'me' }),
    );

    const list = capture();
    expect(await runCli(['invitations', 'list', '--json'], guestEnv, list.io)).toBe(0);
    const inv = JSON.parse(list.out()).items[0];
    expect(inv.room.name).toBe('invite-room');

    const accept = capture();
    expect(await runCli(['invitations', 'accept', inv.id, '--json'], guestEnv, accept.io)).toBe(0);
    expect(JSON.parse(accept.out()).room.name).toBe('invite-room');

    fs.rmSync(guestCfg, { recursive: true, force: true });
  });
});

/* ================================================================== *
 * admin
 * ================================================================== */

describe('sparrow CLI — admin', () => {
  it('admin orgs and rooms list; delete room works', async () => {
    const owner = await boot('adm@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'admin-room' });

    const orgs = capture();
    expect(
      await runCli(['admin', 'orgs', '--server', url, '--admin-token', ADMIN_TOKEN, '--json'], env, orgs.io),
    ).toBe(0);
    expect(JSON.parse(orgs.out()).items.length).toBeGreaterThanOrEqual(1);

    const rooms = capture();
    expect(
      await runCli(['admin', 'rooms', '--server', url, '--admin-token', ADMIN_TOKEN, '--json'], env, rooms.io),
    ).toBe(0);
    expect(JSON.parse(rooms.out()).items.some((r: any) => r.name === 'admin-room')).toBe(true);

    const del = capture();
    expect(
      await runCli(['admin', 'delete', 'room', room.id, '--server', url, '--admin-token', ADMIN_TOKEN, '--json'], env, del.io),
    ).toBe(0);
    expect(JSON.parse(del.out())).toMatchObject({ ok: true });
  });

  it('admin without a token errors', async () => {
    const cap = capture();
    expect(await runCli(['admin', 'orgs', '--server', url], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/admin-token/);
  });
});

/* ================================================================== *
 * argument / command errors
 * ================================================================== */

describe('sparrow CLI — errors', () => {
  it('unknown command exits non-zero', async () => {
    const cap = capture();
    expect(await runCli(['bogus-command'], env, cap.io)).not.toBe(0);
  });

  it('v2 command names (join / login-bot) are gone', async () => {
    const join = capture();
    expect(await runCli(['join', 'http://x/rooms/room_x/join'], env, join.io)).not.toBe(0);
    const loginBot = capture();
    expect(await runCli(['login-bot', 'acp_x', '--server', url], env, loginBot.io)).not.toBe(0);
  });
});

/* ================================================================== *
 * The interactive prompt. `sparrow login`'s password prompt built its
 * readline with `terminal: true` unconditionally — and on a NON-TTY stdin
 * that makes readline echo every byte it reads straight back to stdout, so
 * `echo "$PW" | sparrow login` printed the password into the caller's logs.
 * ================================================================== */

describe('sparrow CLI — password prompt never echoes on a non-TTY stdin', () => {
  const sink = (): { stream: Writable; text(): string } => {
    const chunks: string[] = [];
    return {
      stream: new Writable({
        write(chunk, _enc, cb) {
          chunks.push(String(chunk));
          cb();
        },
      }),
      text: () => chunks.join(''),
    };
  };

  it('a piped password is read but never written to stdout', async () => {
    const input = new PassThrough(); // no isTTY — exactly what a pipe looks like
    const out = sink();
    const answer = makePrompt(input, out.stream)('Password: ', { hidden: true });
    input.write('hunter2\n');
    expect(await answer).toBe('hunter2');
    expect(out.text()).not.toContain('hunter2');
    // The question itself is not the secret — it may still be shown.
    expect(out.text()).toContain('Password: ');
  });

  it('a piped non-hidden answer is read the same way (and echoes nothing either)', async () => {
    const input = new PassThrough();
    const out = sink();
    const answer = makePrompt(input, out.stream)('Email: ');
    input.write('someone@example.com\n');
    expect(await answer).toBe('someone@example.com');
    expect(out.text()).not.toContain('someone@example.com');
  });

  it('on a real TTY the hidden prompt still masks by redrawing the question', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const out = sink();
    const answer = makePrompt(input as PassThrough & { isTTY: true }, out.stream)('Password: ', {
      hidden: true,
    });
    // A TTY delivers one keystroke at a time; the redraw wipes each echoed char.
    for (const ch of 'hunter2\n') {
      input.write(ch);
      await new Promise((r) => setImmediate(r));
    }
    expect(await answer).toBe('hunter2');
    // The clear-line redraw ran — the secret never survives as a contiguous run.
    expect(out.text()).toContain('\x1b[2K');
    expect(out.text()).not.toContain('hunter2');
  });

  /**
   * EOF is not an answer. `rl.question()` on an ended stream never settles — the
   * process simply drained and exited 0 with nothing saved. The prompt must
   * reject, naming the env-var escape hatch a non-interactive caller needs.
   */
  it('an ENDED stdin with no data REJECTS (never hangs, never resolves empty)', async () => {
    const input = new PassThrough();
    const out = sink();
    const answer = makePrompt(input, out.stream)('Password: ', { hidden: true });
    input.end();
    await expect(answer).rejects.toThrow(/No password on stdin[\s\S]*SPARROW_PASSWORD/);
  });

  it('an ENDED stdin rejects the non-hidden prompt too, naming both escape hatches', async () => {
    const input = new PassThrough();
    const out = sink();
    const answer = makePrompt(input, out.stream)('Email: ');
    input.end();
    await expect(answer).rejects.toThrow(/SPARROW_EMAIL[\s\S]*SPARROW_PASSWORD|SPARROW_PASSWORD/);
  });

  it('ONE prompt function answers sequential questions from a single piped chunk', async () => {
    const input = new PassThrough();
    const out = sink();
    const prompt = makePrompt(input, out.stream);
    input.write('a@b.com\nhunter2\n'); // both lines arrive as one chunk
    input.end();
    expect(await prompt('Email: ')).toBe('a@b.com');
    expect(await prompt('Password: ', { hidden: true })).toBe('hunter2');
    expect(out.text()).toContain('Password: ');
    expect(out.text()).not.toContain('hunter2');
    prompt.close();
  });

  it('a third question, past the piped lines, rejects rather than hanging', async () => {
    const input = new PassThrough();
    const prompt = makePrompt(input, devNull());
    input.write('a@b.com\nhunter2\n');
    input.end();
    expect(await prompt('Email: ')).toBe('a@b.com');
    expect(await prompt('Password: ', { hidden: true })).toBe('hunter2');
    await expect(prompt('Again: ', { hidden: true })).rejects.toThrow(/SPARROW_PASSWORD/);
  });
});

/* ================================================================== *
 * Global option position: `sparrow --profile x <cmd>` used to die with a
 * bare "unknown option '--profile'" — the flag exists, it was just being
 * typed one word early. The connective options are accepted in BOTH
 * positions; anything genuinely command-scoped says where it belongs.
 * ================================================================== */

describe('sparrow CLI — options in the global position', () => {
  it('--profile before the command selects that profile (not "unknown option")', async () => {
    const owner = await boot('globalopt@x.com');
    const bot = await makeAgent(owner, 'globalbot');
    expect(await runCli(['login-agent', bot.key, '--server', url], env, capture().io)).toBe(0);
    // Same flag, one word earlier — this is the shape that used to fail outright.
    const cap = capture();
    const code = await runCli(['--profile', 'globalbot', 'whoami', '--json'], env, cap.io);
    expect(cap.err()).not.toMatch(/unknown option/i);
    expect(code).toBe(0);
    expect(JSON.parse(cap.out()).name).toBe('globalbot');
  });

  it('--server and --json work globally too', async () => {
    await boot('globalsrv@x.com');
    const cap = capture({ answers: ['password123'] });
    const code = await runCli(
      ['--json', '--server', url, 'login', '--email', 'globalsrv@x.com'],
      env,
      cap.io,
    );
    expect(cap.err()).not.toMatch(/unknown option/i);
    expect(code).toBe(0);
    expect(JSON.parse(cap.out()).user.email).toBe('globalsrv@x.com');
  });

  it('a command-scoped option in the global position says where it belongs', async () => {
    const cap = capture();
    const code = await runCli(['--room', 'general', 'send', 'hi'], env, cap.io);
    expect(code).not.toBe(0);
    expect(cap.err()).toContain('--room');
    // Not the bare commander line — it must name the fix.
    expect(cap.err()).toMatch(/after the command|belongs/i);
  });
});

/* ================================================================== *
 * watch/loop stream-health: zombie-stream watchdog, periodic refresh,
 * and no-message-loss across a forced reconnect. These drive a *stub* SSE
 * server (raw http) so a stream can be made to go silent-without-close or a
 * message can be timed to arrive precisely inside a reconnect window —
 * behaviors the real API never exhibits on demand.
 * ================================================================== */

describe('sparrow CLI — watch/loop stream health', () => {
  const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const SSE_HEAD = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  };

  async function listen(
    handler: http.RequestListener,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${addr.port}`,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
    };
  }

  it('watch: a stale stream (silent, never closed) trips the watchdog and reconnects', async () => {
    // First connection establishes then goes ZOMBIE — no bytes, no FIN, ever.
    // Without a watchdog the client would read() forever; with it, ~1s of silence
    // forces a reconnect. The second connection heartbeats and stays healthy.
    let conns = 0;
    const stub = await listen((req, res) => {
      if (req.url!.startsWith('/api/v1/me/events')) {
        conns += 1;
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        if (conns >= 2) {
          const hb = setInterval(() => res.write(': ping\n\n'), 100);
          req.on('close', () => clearInterval(hb));
        }
        return; // conn 1: intentionally never write/close again
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      // `-v`: the watchdog line is routine lifecycle chatter, quiet by default.
      const watch = runCli(['watch', '-v', '--stale-seconds', '1', '--max-stream-age', '0'], e, cap.io);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && conns < 2) await nap(25);
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(conns).toBeGreaterThanOrEqual(2); // reconnected from a fresh connection
      expect(cap.out()).toContain('stale stream'); // logged exactly the watchdog line
    } finally {
      await stub.close();
    }
  });

  it('watch: max-age unconditionally re-establishes a healthy stream', async () => {
    // Every connection heartbeats (never stale); stale is disabled, so the ONLY
    // thing that can force a second connection is the max-age refresh.
    let conns = 0;
    const beats: NodeJS.Timeout[] = [];
    const stub = await listen((req, res) => {
      if (req.url!.startsWith('/api/v1/me/events')) {
        conns += 1;
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        const hb = setInterval(() => res.write(': ping\n\n'), 100);
        beats.push(hb);
        req.on('close', () => clearInterval(hb));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      // `-v`: the refresh line is routine lifecycle chatter, quiet by default.
      const watch = runCli(['watch', '-v', '--stale-seconds', '0', '--max-stream-age', '1'], e, cap.io);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && conns < 2) await nap(25);
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(conns).toBeGreaterThanOrEqual(2); // torn down + re-established at the interval
      expect(cap.out()).toContain('refreshing stream');
    } finally {
      beats.forEach(clearInterval);
      await stub.close();
    }
  });

  it('loop: a message sent during a forced reconnect is recovered via REPLAY (resume), not a blind drain', async () => {
    // The stream now carries `id:` cursors. loop remembers the last id and, on a
    // forced (max-age) reconnect, resumes with `?since=`. The stub seeds a cursor
    // on connection 1 (a non-message event), then on the resuming connection 2
    // REPLAYS the message.new that "arrived" during the window — which is what
    // drives the pop. loop does NOT blind-drain on a resuming reconnect, so
    // delivery here is proof of replay, not of the old inbox-reconcile.
    let conns = 0;
    const connUrls: string[] = [];
    const inbox: Array<{ message: unknown; room: unknown }> = [];
    const message = {
      id: 'msg_recovered',
      from: { id: 'mem_owner', kind: 'human', displayName: 'Owner' },
      to: [{ id: 'mem_bot', kind: 'agent', displayName: 'bot' }],
      kind: 'dm',
      subject: null,
      body: 'recovered-after-reconnect',
      attachments: [],
      suggestedReplies: [],
      inReplyTo: null,
      replyValue: null,
      origin: null,
      createdAt: '2026-08-24T00:00:00Z',
    };
    const room = {
      id: 'room_dm',
      name: '',
      orgId: 'org_a',
      kind: 'dm',
      counterpart: { type: 'agent', id: 'agt_x', displayName: 'bot' },
    };
    const beats: NodeJS.Timeout[] = [];
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events')) {
        conns += 1;
        const myConn = conns;
        connUrls.push(u);
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        if (myConn === 1) {
          // Seed the resume cursor with a non-drain event (id 5); then go quiet
          // until the max-age refresh tears this stream down.
          res.write(
            'id: 5\nevent: presence.changed\n' +
              'data: {"member":{"id":"mem_bot","kind":"agent","displayName":"bot"},"state":"online"}\n\n',
          );
        } else {
          // The resuming reconnect: the missed message is now deliverable, and
          // we REPLAY its message.new (id 6) — this is what makes loop pop it.
          inbox.push({ message, room });
          res.write(
            `id: 6\nevent: message.new\ndata: ${JSON.stringify({
              room,
              messageId: 'msg_recovered',
              from: message.from,
              preview: 'recovered-after-reconnect',
              kind: 'dm',
            })}\n\n`,
          );
        }
        const hb = setInterval(() => res.write(': ping\n\n'), 100);
        beats.push(hb);
        req.on('close', () => clearInterval(hb));
        return;
      }
      if (u === '/api/v1/me/inbox/pop' && req.method === 'POST') {
        req.resume();
        const item = inbox.shift();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            item
              ? { item: { type: 'chat.message', message: item.message, room: item.room } }
              : { item: null },
          ),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      // `-v`: the resume line is routine lifecycle chatter, quiet by default.
      const loop = runCli(['loop', '-v', '--stale-seconds', '0', '--max-stream-age', '1'], e, cap.io);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !cap.out().includes('recovered-after-reconnect')) await nap(25);
      process.emit('SIGINT');
      expect(await loop).toBe(0);
      expect(conns).toBeGreaterThanOrEqual(2); // recovery required a reconnect
      expect(cap.out()).toContain('recovered-after-reconnect'); // delivered via replay
      // The reconnect resumed from the seeded cursor (proof of replay path).
      expect(connUrls.slice(1).some((u) => u.includes('since=5'))).toBe(true);
      expect(cap.err()).toContain('[loop] resumed from 5'); // quiet resume log line
    } finally {
      beats.forEach(clearInterval);
      await stub.close();
    }
  });

  it('loop: replay.gap triggers a full inbox drain (reconcile when replay is incomplete)', async () => {
    // When the server can't replay (cursor pruned) it sends a structural
    // replay.gap. loop must fall back to draining the inbox even though no
    // message.new was replayed.
    let conns = 0;
    let popped = 0;
    const inbox: Array<{ message: unknown; room: unknown }> = [];
    const message = {
      id: 'msg_gap',
      from: { id: 'mem_owner', kind: 'human', displayName: 'Owner' },
      to: [{ id: 'mem_bot', kind: 'agent', displayName: 'bot' }],
      kind: 'dm',
      subject: null,
      body: 'drained-after-gap',
      attachments: [],
      suggestedReplies: [],
      inReplyTo: null,
      replyValue: null,
      origin: null,
      createdAt: '2026-08-24T00:00:00Z',
    };
    const room = {
      id: 'room_dm',
      name: '',
      orgId: 'org_a',
      kind: 'dm',
      counterpart: { type: 'agent', id: 'agt_x', displayName: 'bot' },
    };
    const beats: NodeJS.Timeout[] = [];
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events')) {
        conns += 1;
        const myConn = conns;
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        if (myConn === 1) {
          res.write(
            'id: 9\nevent: presence.changed\n' +
              'data: {"member":{"id":"mem_bot","kind":"agent","displayName":"bot"},"state":"online"}\n\n',
          );
        } else {
          // Cursor pruned → structural replay.gap (NO message.new). loop must
          // still reconcile by draining, where the backlogged message waits.
          inbox.push({ message, room });
          res.write('event: replay.gap\ndata: {"since":9}\n\n');
        }
        const hb = setInterval(() => res.write(': ping\n\n'), 100);
        beats.push(hb);
        req.on('close', () => clearInterval(hb));
        return;
      }
      if (u === '/api/v1/me/inbox/pop' && req.method === 'POST') {
        req.resume();
        popped += 1;
        const item = inbox.shift();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            item
              ? { item: { type: 'chat.message', message: item.message, room: item.room } }
              : { item: null },
          ),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      const loop = runCli(['loop', '--stale-seconds', '0', '--max-stream-age', '1'], e, cap.io);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !cap.out().includes('drained-after-gap')) await nap(25);
      process.emit('SIGINT');
      expect(await loop).toBe(0);
      expect(conns).toBeGreaterThanOrEqual(2);
      expect(popped).toBeGreaterThan(0); // the gap forced a drain
      expect(cap.out()).toContain('drained-after-gap'); // reconciled via drain
      // Each drained line is a typed WORK ITEM (handlers switch on `type`), not
      // the v3 bare message.
      const line = cap.out().split('\n').find((l) => l.includes('drained-after-gap'))!;
      const item = JSON.parse(line);
      expect(item.type).toBe('chat.message');
      expect(item.message.body).toBe('drained-after-gap');
      expect(item.room.id).toBe('room_dm');
    } finally {
      beats.forEach(clearInterval);
      await stub.close();
    }
  });

  /* ---- reconcile poll: GET /me/events/log as a belt-and-suspenders floor ---- */
  // A stream can BLACK-HOLE behind a tunnel (TCP stays ESTAB, zero bytes flow,
  // never a FIN) AND its own reconnect dials inherit the dead path — the watchdog
  // can then take the full max-age window to recover. The reconcile poll is the
  // guarantee: a one-shot `GET /me/events/log` (a fresh request) surfaces anything
  // the silent stream missed within ~one poll interval. These wedge the SSE (it
  // establishes, then never emits) and serve the journal read separately.

  const sampleMessage = {
    id: 'msg_poll',
    from: { id: 'mem_owner', kind: 'human', displayName: 'Owner' },
    to: [{ id: 'mem_bot', kind: 'agent', displayName: 'bot' }],
    kind: 'dm',
    subject: null,
    body: 'poll-body',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-08-24T00:00:00Z',
  };
  const sampleRoom = {
    id: 'room_dm',
    name: '',
    orgId: 'org_a',
    kind: 'dm',
    counterpart: { type: 'agent', id: 'agt_x', displayName: 'bot' },
  };
  const messageNewData = (preview: string) => ({
    room: sampleRoom,
    messageId: 'msg_poll',
    from: sampleMessage.from,
    preview,
    kind: 'dm',
  });
  const sinceOf = (u: string): number =>
    Number(new URL(u, 'http://x').searchParams.get('since') ?? '0');

  it('watch: a wedged (silent) stream still delivers via the reconcile poll', async () => {
    // The journal read is the ONLY way a frame can surface here — the stream
    // establishes then goes permanently silent (no watchdog: stale/max-age off).
    const journal: Array<{ id: number; event: string; data: unknown }> = [];
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        const since = sinceOf(u);
        const events = journal.filter((e) => e.id > since);
        const latest = journal.length ? journal[journal.length - 1]!.id : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, latest }));
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n'); // establishes (onOpen), then never emits — wedged
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub', SPARROW_RECONCILE_POLL_MS: '80' };
      const cap = capture();
      const watch = runCli(
        ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'],
        e,
        cap.io,
      );
      await nap(200); // establish + let the poll begin
      // "Journal" a message server-side; the silent stream can never carry it.
      journal.push({ id: 1, event: 'message.new', data: messageNewData('via-poll') });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('via-poll')) await nap(25);
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(cap.out()).toContain('via-poll'); // delivered by the reconcile poll
    } finally {
      await stub.close();
    }
  });

  it('watch: the cursor persists across processes (restart resumes; no journal re-flood)', async () => {
    // Regression (2026-08-29 prod): every watch restart lost its in-memory
    // cursor, so the first poll backfilled from 0 and re-flooded ~24h of
    // journal history. With a NAMED profile the cursor persists in state.json:
    // a restarted watch resumes `?since=` from where the last process stopped.
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { w: { server: '', token: 'agk_stub', kind: 'agent' } } }),
    );
    const journal: Array<{ id: number; event: string; data: unknown }> = [
      { id: 7, event: 'message.new', data: messageNewData('old-history') },
    ];
    const sinceSeen: Array<string | null> = [];
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        const since = sinceOf(u);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            events: journal.filter((ev) => ev.id > since),
            latest: journal.length ? journal[journal.length - 1]!.id : 0,
          }),
        );
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        sinceSeen.push(new URL(u, 'http://x').searchParams.get('since'));
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        // Emit one live frame so process #1 advances (and persists) its cursor.
        res.write(`id: 9\nevent: message.new\ndata: ${JSON.stringify(messageNewData('live-9'))}\n\n`);
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_PROFILE: 'w', SPARROW_RECONCILE_POLL_MS: '0' };
      // Process #1: no persisted cursor yet → connects with no since, sees id 9.
      const cap1 = capture();
      const w1 = runCli(['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'], e, cap1.io);
      const d1 = Date.now() + 4000;
      while (Date.now() < d1 && !cap1.out().includes('live-9')) await nap(25);
      process.emit('SIGINT');
      expect(await w1).toBe(0);
      expect(cap1.out()).toContain('live-9');
      // The cursor survived the process.
      const state = JSON.parse(fs.readFileSync(path.join(configDir, 'sparrow', 'state.json'), 'utf8'));
      expect(state.profiles.w.lastEventId).toBe('9');
      // Process #2: resumes with ?since=9 — and never re-surfaces old history.
      const cap2 = capture();
      const w2 = runCli(['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'], e, cap2.io);
      const d2 = Date.now() + 4000;
      while (Date.now() < d2 && sinceSeen.length < 2) await nap(25);
      process.emit('SIGINT');
      expect(await w2).toBe(0);
      expect(sinceSeen[0]).toBeNull();
      expect(sinceSeen[1]).toBe('9');
      expect(cap2.out()).not.toContain('old-history');
    } finally {
      await stub.close();
    }
  });

  it('watch: --poll-seconds 0 disables the poll (a wedged stream delivers nothing)', async () => {
    const journal: Array<{ id: number; event: string; data: unknown }> = [];
    let logHits = 0;
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        logHits += 1;
        const since = sinceOf(u);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: journal.filter((ev) => ev.id > since), latest: journal.length }));
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        return;
      }
      res.writeHead(404).end();
    });
    try {
      // The ms override is present but must NOT re-enable an explicit `0`.
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub', SPARROW_RECONCILE_POLL_MS: '60' };
      const cap = capture();
      const watch = runCli(
        ['watch', '--poll-seconds', '0', '--stale-seconds', '0', '--max-stream-age', '0', '--json'],
        e,
        cap.io,
      );
      await nap(200);
      journal.push({ id: 1, event: 'message.new', data: messageNewData('never-via-poll') });
      await nap(500); // several intervals would have elapsed had the poll been on
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(cap.out()).not.toContain('never-via-poll');
      expect(logHits).toBe(0); // the poll never ran
    } finally {
      await stub.close();
    }
  });

  it('watch: a live frame and the poll never surface the same id twice (dedupe gate)', async () => {
    // The poll surfaces id 1 first; the stream then RE-delivers the same id 1.
    // The single lastId gate both paths pass through must drop the duplicate.
    const journal = [{ id: 1, event: 'message.new', data: messageNewData('dup-body') }];
    let logPolls = 0;
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        logPolls += 1;
        const since = sinceOf(u);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: journal.filter((ev) => ev.id > since), latest: 1 }));
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        // Once the poll has surfaced id 1, the stream ALSO delivers id 1.
        const t = setInterval(() => {
          if (logPolls > 0) {
            res.write(
              `id: 1\nevent: message.new\ndata: ${JSON.stringify(messageNewData('dup-body'))}\n\n`,
            );
            clearInterval(t);
          }
        }, 20);
        req.on('close', () => clearInterval(t));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub', SPARROW_RECONCILE_POLL_MS: '60' };
      const cap = capture();
      const watch = runCli(
        ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'],
        e,
        cap.io,
      );
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('dup-body')) await nap(25);
      await nap(400); // give the stream's duplicate + further polls time to (not) re-print
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      const count = cap
        .out()
        .split('\n')
        .filter((l) => l.includes('dup-body')).length;
      expect(count).toBe(1); // surfaced exactly once across both paths
    } finally {
      await stub.close();
    }
  });

  it('loop: a poll-reported gap triggers an inbox reconcile drain', async () => {
    // The stream is silent and the log carries NO events — only gap:true. The sole
    // route to the backlogged message is the gap-driven drain.
    const inbox: Array<{ message: unknown; room: unknown }> = []; // empty at connect
    let popped = 0;
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: [], latest: 0, gap: true }));
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        return;
      }
      if (u === '/api/v1/me/inbox/pop' && req.method === 'POST') {
        req.resume();
        popped += 1;
        const item = inbox.shift();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            item
              ? { item: { type: 'chat.message', message: item.message, room: item.room } }
              : { item: null },
          ),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub', SPARROW_RECONCILE_POLL_MS: '80' };
      const cap = capture();
      const loop = runCli(['loop', '--stale-seconds', '0', '--max-stream-age', '0'], e, cap.io);
      await nap(250); // establish + initial drain (inbox empty) + a gap poll or two
      inbox.push({ message: { ...sampleMessage, body: 'drained-after-gap' }, room: sampleRoom });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('drained-after-gap')) await nap(25);
      process.emit('SIGINT');
      expect(await loop).toBe(0);
      expect(popped).toBeGreaterThan(0);
      expect(cap.out()).toContain('drained-after-gap'); // reconciled via the gap drain
    } finally {
      await stub.close();
    }
  });

  it('watch: reconnect dials a FRESH socket (undici fetch + per-attempt Agent), end-to-end', async () => {
    // conn 1 wedges (silent, never closed) → the watchdog forces a reconnect;
    // conn 2 heartbeats. With the fresh-transport path ACTIVE (undici installed),
    // the SSE runs through undici's own fetch driving a fresh single-connection
    // Agent per attempt — so the two connections arrive on DISTINCT client sockets
    // and the reconnect cannot inherit conn 1's dead path. The poll is disabled so
    // recovery here is purely the SSE reconnect, exercising the fresh transport.
    const ports = new Set<number>();
    let conns = 0;
    const beats: NodeJS.Timeout[] = [];
    const stub = await listen((req, res) => {
      if (req.url!.startsWith('/api/v1/me/events')) {
        conns += 1;
        if (req.socket.remotePort) ports.add(req.socket.remotePort);
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        if (conns >= 2) {
          const hb = setInterval(() => res.write(': ping\n\n'), 100);
          beats.push(hb);
          req.on('close', () => clearInterval(hb));
        }
        return; // conn 1: intentionally silent forever (wedged)
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      const watch = runCli(
        ['watch', '--stale-seconds', '1', '--max-stream-age', '0', '--poll-seconds', '0'],
        e,
        cap.io,
      );
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && conns < 2) await nap(25);
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(conns).toBeGreaterThanOrEqual(2); // reconnected through the fresh transport
      expect(ports.size).toBeGreaterThanOrEqual(2); // a distinct socket per (re)connect
    } finally {
      beats.forEach(clearInterval);
      await stub.close();
    }
  });

  it('watch: the reconcile poll fires even while the stream is actively delivering bytes', async () => {
    // The OLD design gated the poll behind "no stream bytes since the last poll",
    // so a stream that keeps emitting bytes (heartbeats — even a SICK stream can)
    // would suppress the poll indefinitely. The fix makes the poll UNCONDITIONAL:
    // here the SSE heartbeats continuously (bytes always flowing), yet a message
    // that only ever exists in the journal must still surface via the poll.
    const journal: Array<{ id: number; event: string; data: unknown }> = [];
    const beats: NodeJS.Timeout[] = [];
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        const since = sinceOf(u);
        const events = journal.filter((e) => e.id > since);
        const latest = journal.length ? journal[journal.length - 1]!.id : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, latest }));
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        // Bytes never stop flowing — under the old gate this alone suppressed
        // every poll. The stream still never carries the journaled message.new.
        const hb = setInterval(() => res.write(': ping\n\n'), 20);
        beats.push(hb);
        req.on('close', () => clearInterval(hb));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub', SPARROW_RECONCILE_POLL_MS: '80' };
      const cap = capture();
      const watch = runCli(
        ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'],
        e,
        cap.io,
      );
      await nap(200); // establish + let heartbeats + polling begin
      journal.push({ id: 1, event: 'message.new', data: messageNewData('via-poll-while-active') });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('via-poll-while-active')) await nap(25);
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(cap.out()).toContain('via-poll-while-active'); // polled despite live bytes
    } finally {
      beats.forEach(clearInterval);
      await stub.close();
    }
  });

  it('watch: a poll request that HANGS is aborted at the timeout; the next poll delivers', async () => {
    // Flaw #2 in the prod incident: a poll request hung on a dead pooled path with
    // no timeout wedged the loop forever. The fix aborts each poll after the
    // per-poll timeout, so the NEXT interval's poll runs and delivers. The first
    // journal read here hangs (accepted, never answered); once aborted, the second
    // succeeds. SPARROW_RECONCILE_TIMEOUT_MS keeps the abort fast for the test.
    const journal = [{ id: 1, event: 'message.new', data: messageNewData('after-hang') }];
    let logReqs = 0;
    let firstAborted = false;
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        logReqs += 1;
        if (logReqs === 1) {
          req.on('close', () => (firstAborted = true));
          return; // HANG: accept the request, never respond
        }
        const since = sinceOf(u);
        const events = journal.filter((ev) => ev.id > since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, latest: 1 }));
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n'); // establishes then silent — the poll is the floor
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = {
        ...env,
        SPARROW_SERVER: stub.url,
        SPARROW_TOKEN: 'agk_stub',
        SPARROW_RECONCILE_POLL_MS: '60',
        SPARROW_RECONCILE_TIMEOUT_MS: '150',
      };
      const cap = capture();
      const watch = runCli(
        ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'],
        e,
        cap.io,
      );
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !cap.out().includes('after-hang')) await nap(25);
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(firstAborted).toBe(true); // the hung poll was aborted at the timeout
      expect(logReqs).toBeGreaterThanOrEqual(2); // the loop survived and polled again
      expect(cap.out()).toContain('after-hang'); // the next poll delivered
    } finally {
      await stub.close();
    }
  });

  it('watch: each poll dials a FRESH socket (per-call undici dispatcher)', async () => {
    // Flaw #2 fix, transport half: like the SSE reconnect, each poll uses a fresh
    // single-connection undici Agent + undici's own fetch, so a poisoned pooled
    // path can never wedge polls. Proof: distinct client sockets across polls. The
    // stream is wedged (silent) so only the poll drives traffic to the log route.
    const ports = new Set<number>();
    let logReqs = 0;
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/events/log')) {
        logReqs += 1;
        if (req.socket.remotePort) ports.add(req.socket.remotePort);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: [], latest: 0 }));
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n'); // wedged: silent forever
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub', SPARROW_RECONCILE_POLL_MS: '60' };
      const cap = capture();
      const watch = runCli(
        ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'],
        e,
        cap.io,
      );
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && (logReqs < 3 || ports.size < 2)) await nap(25);
      process.emit('SIGINT');
      expect(await watch).toBe(0);
      expect(logReqs).toBeGreaterThanOrEqual(2);
      expect(ports.size).toBeGreaterThanOrEqual(2); // a distinct socket per poll
    } finally {
      await stub.close();
    }
  });

  it('await: a replay.gap heals the cursor AND wakes (a gap means work may exist)', async () => {
    // The cursor is beyond retention, so the server can only say "you missed
    // things". `await` cannot know whether a work item is among them, and the
    // whole point of the command is to not sit deaf: it wakes, names the gap,
    // and tells the caller to drain.
    const stub = await listen((req, res) => {
      const u = req.url!;
      if (u.startsWith('/api/v1/me/inbox')) {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [], nextCursor: null })); // nothing VISIBLE — the gap is the news
        return;
      }
      if (u.startsWith('/api/v1/me/events')) {
        res.writeHead(200, SSE_HEAD);
        res.write(': open\n\n');
        res.write('event: replay.gap\ndata: {"since":2634,"latest":115}\n\n');
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      const code = await runCli(
        ['await', '--timeout', '10', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
        e,
        cap.io,
      );
      expect(code).toBe(0);
      const wake = JSON.parse(cap.out().trim());
      expect(wake.type).toBe('await.item');
      expect(wake.reason).toBe('replay.gap');
      expect(wake.item).toBeNull(); // nothing to preview — the instruction is the payload
      expect(wake.drain).toBe('sparrow pop');
      // The gap is reported honestly, and the cursor went through the shared
      // heal (nothing to adopt here — this profile had no stored cursor).
      expect(wake.since).toBe(2634);
      expect(wake.latest).toBe(115);
      expect(wake.cursor).toBeNull();
    } finally {
      await stub.close();
    }
  });
});

/* ================================================================== *
 * fresh-connection transport (undici Agent + its own fetch)
 * ================================================================== */

describe('sparrow CLI — fresh-connection transport', () => {
  it('produces a transport pairing a fresh undici Agent with undici’s OWN fetch', async () => {
    const undici = await loadUndici();
    expect(undici).toBeDefined(); // undici is a declared dependency of the CLI
    const make = transportFactory(undici);
    const t = make();
    expect(t).toBeDefined();
    // The dispatcher (Agent) and the matching fetch travel together — a foreign
    // dispatcher would not drive Node's bundled fetch, so they MUST pair up.
    expect(t!.dispatcher).toBeDefined();
    expect(typeof t!.fetchImpl).toBe('function');
    expect(t!.fetchImpl).toBe(undici!.fetch);
    // Each call yields a DISTINCT Agent — no pooled reuse across reconnects.
    const t2 = make();
    expect(t2!.dispatcher).not.toBe(t!.dispatcher);
    t!.close();
    t2!.close();
  });

  it('degrades gracefully to no transport when undici is unavailable', () => {
    const make = transportFactory(undefined);
    expect(make()).toBeUndefined(); // the reconcile-poll floor then carries reliability
  });
});

/* ================================================================== *
 * Forward compatibility + the email register (stubbed server)
 *
 * The email medium does not exist in v4 wave 3a — the routes are unbuilt and
 * `GET /capabilities` says `email: false` — but the CLI's HALF of the contract
 * (a typed union it must render, an unknown type it must not choke on, the
 * rename address warning) is testable today against a stub upstream.
 * ================================================================== */

describe('sparrow CLI — typed work items across mediums', () => {
  async function stub(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${addr.port}`,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
    };
  }

  /** A stub that answers exactly one `POST /me/inbox/pop` with `payload`. */
  async function popStub(payload: unknown) {
    return stub((req, res) => {
      if (req.url === '/api/v1/me/inbox/pop' && req.method === 'POST') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404).end();
    });
  }

  const emailItem = {
    type: 'email',
    email: {
      id: 'eml_1',
      threadId: 'eth_9fQ2',
      direction: 'in',
      from: { email: 'dana@partner.example.com', name: 'Dana Reyes' },
      to: [{ email: 'fable@acme.example.com', name: null }],
      cc: [],
      bcc: [],
      subject: 'Re: quarterly numbers',
      text: 'The numbers look right to me — see the attached sheet.',
      html: null,
      attachments: [],
      rfcMessageId: '<abc@partner.example.com>',
      inReplyTo: null,
      verification: null,
      disposition: 'delivered',
      reason: null,
      judge: null,
      status: 'unread',
      createdAt: '2026-08-31T17:00:00.000Z',
      resolvedAt: null,
    },
    thread: {
      id: 'eth_9fQ2',
      orgId: 'org_1',
      agentId: 'agt_1',
      subject: 'quarterly numbers',
      trusted: true,
      lastEmailAt: '2026-08-31T17:00:00.000Z',
      createdAt: '2026-08-30T09:00:00.000Z',
    },
  };

  it('pop renders an email work item leading with the medium; -j is the envelope verbatim', async () => {
    const s = await popStub({ item: emailItem });
    try {
      const e = { ...env, SPARROW_SERVER: s.url, SPARROW_TOKEN: 'agk_stub' };
      const human = capture();
      expect(await runCli(['pop'], e, human.io)).toBe(0);
      const lines = human.out().split('\n');
      expect(lines[0]).toContain('[email: eth_9fQ2');
      expect(human.out()).toContain('from: dana@partner.example.com');
      expect(human.out()).toContain('to:   fable@acme.example.com');
      expect(human.out()).toContain('subj: Re: quarterly numbers');
      expect(human.out()).toContain('The numbers look right');
    } finally {
      await s.close();
    }

    const s2 = await popStub({ item: emailItem });
    try {
      const e = { ...env, SPARROW_SERVER: s2.url, SPARROW_TOKEN: 'agk_stub' };
      const json = capture();
      expect(await runCli(['pop', '--json'], e, json.io)).toBe(0);
      expect(JSON.parse(json.out())).toEqual({ item: emailItem });
    } finally {
      await s2.close();
    }
  });

  it('pop leaves an UNKNOWN work-item type for a newer client — printed, never an error', async () => {
    const unknown = { type: 'fax', fax: { id: 'fax_1' }, line: { id: 'lin_1' } };
    const s = await popStub({ item: unknown });
    try {
      const e = { ...env, SPARROW_SERVER: s.url, SPARROW_TOKEN: 'agk_stub' };
      const human = capture();
      expect(await runCli(['pop'], e, human.io)).toBe(0); // exit 0: not an error
      expect(human.out()).toContain('fax');
      expect(human.err()).toBe('');
    } finally {
      await s.close();
    }

    const s2 = await popStub({ item: unknown });
    try {
      const e = { ...env, SPARROW_SERVER: s2.url, SPARROW_TOKEN: 'agk_stub' };
      const json = capture();
      expect(await runCli(['pop', '--json'], e, json.io)).toBe(0);
      // -j stays the envelope verbatim so a newer script can still switch on type.
      expect(JSON.parse(json.out())).toEqual({ item: unknown });
    } finally {
      await s2.close();
    }
  });

  it('rename warns that the OLD address bounces once an agent has one', async () => {
    // PATCH /me returns the renamed principal; with the email medium on it carries
    // the NEW derived address, and mail to the old one starts bouncing.
    const before = {
      type: 'agent',
      id: 'agt_1',
      name: 'oldname',
      orgId: 'org_1',
      owner: { id: 'usr_1', displayName: 'Owner' },
      emailAddress: 'oldname@acme.example.com',
    };
    const after = { ...before, name: 'newname', emailAddress: 'newname@acme.example.com' };
    const s = await stub((req, res) => {
      if (req.url === '/api/v1/me' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ principal: before }));
        return;
      }
      if (req.url === '/api/v1/me' && req.method === 'PATCH') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ principal: after }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const e = { ...env, SPARROW_SERVER: s.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      expect(await runCli(['rename', 'newname'], e, cap.io)).toBe(0);
      expect(cap.out()).toContain('oldname@acme.example.com');
      expect(cap.out()).toContain('newname@acme.example.com');
      expect(cap.out()).toMatch(/bounce/i);
    } finally {
      await s.close();
    }
  });

  it('rename stays a one-liner while agents have no address (v4 today)', async () => {
    const principal = {
      type: 'agent',
      id: 'agt_1',
      name: 'plain',
      orgId: 'org_1',
      owner: { id: 'usr_1', displayName: 'Owner' },
      emailAddress: null,
    };
    const s = await stub((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ principal }));
    });
    try {
      const e = { ...env, SPARROW_SERVER: s.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      expect(await runCli(['rename', 'plain'], e, cap.io)).toBe(0);
      expect(cap.out()).toMatch(/Renamed to/);
      expect(cap.out()).not.toMatch(/bounce/i);
    } finally {
      await s.close();
    }
  });
});

/* ================================================================== *
 * Client versioning: --version, upgrade, whoami skew note
 * ================================================================== */

describe('sparrow CLI — client versioning', () => {
  it('--version prints the shared build version (<pkg>+dev in tests)', async () => {
    const cap = capture();
    const code = await runCli(['--version'], env, cap.io);
    expect(code).toBe(0);
    expect(cap.out().trim()).toBe(clientBuildVersion());
    expect(cap.out()).toContain('+dev');
  });

  it('sends X-Sparrow-Client and is gated by a server minimum (426 → exit 1)', async () => {
    // Point the CLI's client at the real server, but stand up a fresh server whose
    // minimum is far above this client's 0.1.0 so the send is rejected 426.
    const gated = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-gated-'));
    const gApp = buildServer({
      dataDir: gated,
      baseUrl: 'http://localhost:8722',
      adminToken: ADMIN_TOKEN,
      clientMinVersion: '99.0.0',
    });
    await gApp.ready();
    await gApp.listen({ port: 0, host: '127.0.0.1' });
    const gAddr = gApp.server.address() as AddressInfo;
    const gUrl = `http://127.0.0.1:${gAddr.port}`;
    // Bootstrap an owner + agent on the gated server via a plain (unidentified) client.
    const ownerC = new SparrowClient({ server: gUrl });
    await ownerC.signup({ email: 'g@x.com', password: 'password123', displayName: 'G' });
    const orgId = (await ownerC.meOrgs())[0]!.org.id;
    const agent = await ownerC.createAgent({ orgId, name: 'bot' });
    // The CLI (which DOES send X-Sparrow-Client) is rejected 426.
    const e = { ...env, SPARROW_SERVER: gUrl, SPARROW_TOKEN: agent.key };
    const cap = capture();
    const code = await runCli(['whoami'], e, cap.io);
    expect(code).toBe(1);
    expect(cap.err()).toMatch(/client|upgrade|426/i);
    await gApp.close();
    fs.rmSync(gated, { recursive: true, force: true });
  });

  /**
   * A `426` floor is the one stream failure NO retry can clear: the client is
   * simply too old. watch/loop must stop on it — print the server's explanation
   * plus `sparrow upgrade` and exit nonzero — instead of reconnect-looping
   * forever (and holding a presence that can never receive anything).
   */
  async function gate426(): Promise<{ url: string; conns: () => number; close: () => Promise<void> }> {
    let conns = 0;
    const stub = http.createServer((req, res) => {
      conns += 1;
      req.resume();
      res.writeHead(426, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'client_upgrade_required',
            // Deliberately WITHOUT the upgrade hint: the CLI must add the action.
            message: 'Your Sparrow client (0.1.0) is below the minimum this server requires (99.0.0).',
            docs: 'http://example.test/docs/api/versioning',
          },
        }),
      );
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    return {
      url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      conns: () => conns,
      close: () => new Promise<void>((r) => {
        stub.closeAllConnections?.();
        stub.close(() => r());
      }),
    };
  }

  it('watch: a 426 client floor on stream open exits 1 naming `sparrow upgrade` — no reconnect loop', async () => {
    const stub = await gate426();
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      const code = await runCli(
        ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
        e,
        cap.io,
      );
      expect(code).toBe(1);
      expect(cap.err()).toMatch(/below the minimum/);
      expect(cap.err()).toContain('sparrow upgrade');
      expect(stub.conns()).toBe(1); // stopped at the floor, did not retry
    } finally {
      await stub.close();
    }
  });

  it('loop: a 426 client floor ends the loop the same way', async () => {
    const stub = await gate426();
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      const code = await runCli(
        ['loop', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
        e,
        cap.io,
      );
      expect(code).toBe(1);
      expect(cap.err()).toContain('sparrow upgrade');
      expect(stub.conns()).toBeLessThanOrEqual(2); // stream open (+ at most the connect drain)
    } finally {
      await stub.close();
    }
  });

  it('await: a 426 client floor is terminal — exit 1, never a re-arm loop', async () => {
    const stub = await gate426();
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      const code = await runCli(
        ['await', '--timeout', '10', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
        e,
        cap.io,
      );
      // NOT 0 (no work) and NOT 2 (timeout): a harness must not re-arm forever
      // against a floor no retry can clear.
      expect(code).toBe(1);
      expect(cap.err()).toContain('sparrow upgrade');
      expect(cap.out()).toBe(''); // no wake line — nothing was learned about work
    } finally {
      await stub.close();
    }
  });

  it('pop: a 426 surfaces the same actionable upgrade error', async () => {
    const stub = await gate426();
    try {
      const e = { ...env, SPARROW_SERVER: stub.url, SPARROW_TOKEN: 'agk_stub' };
      const cap = capture();
      expect(await runCli(['pop'], e, cap.io)).toBe(1);
      expect(cap.err()).toContain('sparrow upgrade');
      // `-j` keeps the machine-readable code intact.
      const capJson = capture();
      expect(await runCli(['pop', '-j'], e, capJson.io)).toBe(1);
      expect(JSON.parse(capJson.err()).error.code).toBe('client_upgrade_required');
    } finally {
      await stub.close();
    }
  });

  /**
   * The install home is CANONICAL, not per-instance: bundles come from
   * `https://sparrow.land` (overridable with `SPARROW_INSTALL_URL`) no matter
   * which server the active profile talks to — instances 302 `/install/*`
   * there rather than serving it.
   */
  it('installBaseUrl: canonical home by default; SPARROW_INSTALL_URL overrides; profile server never does', () => {
    expect(installBaseUrl({})).toBe('https://sparrow.land');
    expect(installBaseUrl({ SPARROW_INSTALL_URL: 'https://mirror.test' })).toBe('https://mirror.test');
    // Trailing slashes and stray whitespace are trimmed before paths are joined.
    expect(installBaseUrl({ SPARROW_INSTALL_URL: '  https://mirror.test//  ' })).toBe('https://mirror.test');
    // An empty/blank override is not an override.
    expect(installBaseUrl({ SPARROW_INSTALL_URL: '   ' })).toBe('https://sparrow.land');
    // The instance the profile points at is irrelevant to where bundles come from.
    expect(installBaseUrl({ SPARROW_SERVER: 'https://instance.test' })).toBe('https://sparrow.land');
  });

  /** The request path without the cache-busting `?v=<ms>` the CLI appends. */
  const stripV = (u: string): string => u.replace(/\?v=\d+$/, '');

  /** A stub install home serving (or redirecting to) the two bundles. */
  async function installHome(opts?: { redirect?: boolean }): Promise<{
    url: string;
    body: string;
    hits: () => string[];
    close: () => void;
  }> {
    const body = 'console.log("9.9.9+new");\n';
    const hits: string[] = [];
    const stub = http.createServer((req, res) => {
      const u = req.url ?? '';
      hits.push(u);
      if (opts?.redirect && u.startsWith('/install/')) {
        res.writeHead(302, { location: `/bundles/${u.slice('/install/'.length)}` });
        res.end();
        return;
      }
      if (u.startsWith('/install/') || u.startsWith('/bundles/')) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    return {
      url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      body,
      hits: () => hits,
      close: () => stub.close(),
    };
  }

  /** A `~/.local/bin` holding an old bundle, as install.sh would have left it. */
  function installedHome(): { home: string; cliPath: string; binDir: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-home-'));
    const binDir = path.join(home, '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const cliPath = path.join(binDir, 'sparrow.mjs');
    fs.writeFileSync(cliPath, 'console.log("0.0.1+old");\n');
    return { home, cliPath, binDir };
  }

  it('upgrade downloads from the install home (NOT the profile server) and reports old → new', async () => {
    const stub = await installHome();
    const { home, cliPath, binDir } = installedHome();
    const cap = capture();
    const code = await runCli(
      ['upgrade'],
      // The profile server is a dead port: if upgrade consulted it, this fails.
      { ...env, HOME: home, SPARROW_INSTALL_URL: stub.url, SPARROW_SERVER: 'http://127.0.0.1:1' },
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain('0.0.1+old');
    expect(cap.out()).toContain('9.9.9+new');
    expect(fs.readFileSync(cliPath, 'utf8')).toBe(stub.body);
    expect(fs.existsSync(path.join(binDir, 'sparrow-mcp.mjs'))).toBe(true);
    // Cache-busted: every upgrade must reach origin, never a stale edge copy.
    expect(stub.hits().map(stripV)).toEqual(['/install/sparrow.js', '/install/sparrow-mcp.js']);
    for (const hit of stub.hits()) expect(hit).toMatch(/\?v=\d+$/);

    stub.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('upgrade follows redirects (an install home may 302 elsewhere)', async () => {
    const stub = await installHome({ redirect: true });
    const { home, cliPath } = installedHome();
    const cap = capture();
    const code = await runCli(['upgrade'], { ...env, HOME: home, SPARROW_INSTALL_URL: stub.url }, cap.io);
    expect(code).toBe(0);
    expect(fs.readFileSync(cliPath, 'utf8')).toBe(stub.body);
    expect(stub.hits().map(stripV)).toContain('/bundles/sparrow.js');

    stub.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * Edge caches have been observed serving `/install/sparrow.js` well past the
   * `max-age` the origin asks for, so an upgrade could re-install the bundle it
   * already had. A per-run `?v=<Date.now()>` makes every upgrade a cache miss.
   */
  it('upgrade cache-busts both bundle URLs with a fresh timestamp', async () => {
    const stub = await installHome();
    const { home } = installedHome();
    const before = Date.now();
    const cap = capture();
    const code = await runCli(['upgrade'], { ...env, HOME: home, SPARROW_INSTALL_URL: stub.url }, cap.io);
    expect(code).toBe(0);
    const hits = stub.hits();
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      const q = new URL(hit, 'http://x').searchParams.get('v');
      expect(q, hit).toMatch(/^\d+$/);
      // A real clock reading from THIS run, not a constant baked into the build.
      expect(Number(q)).toBeGreaterThanOrEqual(before);
      expect(Number(q)).toBeLessThanOrEqual(Date.now());
    }
    // Both bundles, each stamped.
    expect(hits.map((h) => h.split('?')[0])).toEqual(['/install/sparrow.js', '/install/sparrow-mcp.js']);

    stub.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('`sparrow update` is an alias of `sparrow upgrade` — same code path', async () => {
    const stub = await installHome();
    const { home, cliPath } = installedHome();
    const cap = capture();
    const code = await runCli(['update'], { ...env, HOME: home, SPARROW_INSTALL_URL: stub.url }, cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain('9.9.9+new');
    expect(fs.readFileSync(cliPath, 'utf8')).toBe(stub.body);
    expect(stub.hits().map(stripV)).toEqual(['/install/sparrow.js', '/install/sparrow-mcp.js']);
    // The alias is discoverable in help, not a hidden synonym.
    const help = capture();
    await runCli(['--help'], env, help.io);
    expect(help.out()).toContain('upgrade|update');

    stub.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('upgrade errors clearly when not installed via install.sh, naming the canonical installer', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-home-'));
    const cap = capture();
    const code = await runCli(['upgrade', '--server', url], { ...env, HOME: home }, cap.io);
    expect(code).toBe(1);
    expect(cap.err()).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
    // Never the instance's own host — instances do not serve the installer.
    expect(cap.err()).not.toContain(url);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('upgrade errors when the install home is unreachable, naming the URL it tried', async () => {
    const { home } = installedHome();
    const cap = capture();
    // Port 1 refuses connections → fetch throws → a clear "unreachable" error.
    const code = await runCli(['upgrade'], { ...env, HOME: home, SPARROW_INSTALL_URL: 'http://127.0.0.1:1' }, cap.io);
    expect(code).toBe(1);
    expect(cap.err()).toMatch(/unreachable|could not reach/i);
    expect(cap.err()).toContain('http://127.0.0.1:1/install/sparrow.js');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('serverSkewNote fires only when the client is newer by a minor+', () => {
    // Client newer than server by a minor → a note.
    expect(serverSkewNote('0.3.0', '0.1.0')).toContain('newer than the server');
    // Equal, patch-only, or behind → silent.
    expect(serverSkewNote('0.1.0', '0.1.0')).toBeUndefined();
    expect(serverSkewNote('0.1.5', '0.1.0')).toBeUndefined();
    expect(serverSkewNote('0.1.0', '0.3.0')).toBeUndefined();
    // No server version (meta unavailable) → silent.
    expect(serverSkewNote('0.3.0', undefined)).toBeUndefined();
  });

  it('whoami prints no skew note against a same-version server', async () => {
    const owner = await boot('skew@x.com');
    const agent = await makeAgent(owner, 'skewbot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const cap = capture();
    expect(await runCli(['whoami'], e, cap.io)).toBe(0);
    expect(cap.err()).not.toContain('newer than the server');
  });
});

/* ================================================================== *
 * name resolution from an AGENT profile
 *
 * A name → id resolution must never route through `GET /me/agents`: that
 * surface is session-only (the visibility list is a human concept) and an
 * agent key gets a `401 Sign-in required` there — masking the command's real
 * semantics. An agent resolves names from the surfaces it legitimately has:
 * its owner (on `GET /me`) and its rooms' member lists.
 * ================================================================== */

describe('sparrow CLI — agent-profile name resolution', () => {
  /** Put a human into `owner`'s org AND into `roomId` (invite → accept). */
  async function joinRoom(
    owner: Owner,
    roomId: string,
    email: string,
    displayName: string,
  ): Promise<{ client: SparrowClient; userId: string }> {
    const h = await addHuman(owner, email);
    await h.client.updateMe({ displayName });
    const inv = await owner.client.inviteHuman(roomId, email);
    await h.client.acceptRoomInvitation(inv.invitation.id);
    return { client: h.client, userId: h.userId };
  }

  it('dm resolves a room-mate human by display name (no /me/agents, no 401)', async () => {
    const owner = await boot('nres1@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'ops' });
    const agent = await makeAgent(owner, 'nres1-bot');
    await owner.client.addMember(room.id, agent.id);
    const bo = await joinRoom(owner, room.id, 'bo1@x.com', 'Bo Diddley');
    // agent → human (not its owner) needs that human to hold visibility.
    await owner.client.shareAgent(agent.id, 'bo1@x.com');

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const cap = capture();
    expect(await runCli(['dm', 'bo diddley', 'hi', '--json'], e, cap.io)).toBe(0);
    const out = JSON.parse(cap.out());
    expect(out.dm.counterpart.id).toBe(bo.userId);
    expect(out.sent.message.body).toBe('hi');
  });

  it('dm resolves the agent’s OWNER by display name via GET /me (no shared room needed)', async () => {
    const owner = await boot('nres2@x.com');
    const agent = await makeAgent(owner, 'nres2-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const cap = capture();
    // boot() signs the owner up with displayName 'Owner'.
    expect(await runCli(['dm', 'owner', 'hello boss', '--json'], e, cap.io)).toBe(0);
    const out = JSON.parse(cap.out());
    expect(out.dm.counterpart.id).toBe(owner.userId);
  });

  it('an ambiguous name across the agent’s rooms errors listing the principal ids', async () => {
    const owner = await boot('nres3@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'ops' });
    const agent = await makeAgent(owner, 'nres3-bot');
    const twin = await makeAgent(owner, 'sam');
    await owner.client.addMember(room.id, agent.id);
    await owner.client.addMember(room.id, twin.id);
    const human = await joinRoom(owner, room.id, 'sam@x.com', 'sam');

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const cap = capture();
    expect(await runCli(['dm', 'SAM'], e, cap.io)).toBe(1);
    const err = cap.err();
    expect(err).toMatch(/Ambiguous/i);
    expect(err).toContain(twin.id);
    expect(err).toContain(human.userId);
    expect(err).not.toMatch(/Sign-in required/i);
  });

  it('an unresolvable name names the limitation and the id workaround — never a bare 401', async () => {
    const owner = await boot('nres4@x.com');
    const agent = await makeAgent(owner, 'nres4-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const cap = capture();
    expect(await runCli(['dm', 'ghost'], e, cap.io)).toBe(1);
    const err = cap.err();
    expect(err).not.toMatch(/Sign-in required/i);
    expect(err).toMatch(/rooms/i);
    expect(err).toContain('agt_');
    expect(err).toContain('usr_');
  });

  it('a resolved agent name reaches the DM route — same-owner agents are now eligible', async () => {
    const owner = await boot('nres5@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'ops' });
    const a = await makeAgent(owner, 'nres5-a');
    const b = await makeAgent(owner, 'nres5-b');
    await owner.client.addMember(room.id, a.id);
    await owner.client.addMember(room.id, b.id);

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: a.key };
    const cap = capture();
    // The NAME resolves through the agent's rooms (the resolvePrincipal door),
    // and the route now says yes: their shared owner can see both agents, so
    // the pair may hold a direct conversation (agent↔agent DMs).
    expect(await runCli(['dm', 'nres5-b', '--json'], e, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).dm.counterpart.id).toBe(b.id);
  });

  it('the by-id path is unchanged: dm usr_<owner> still opens the DM', async () => {
    const owner = await boot('nres6@x.com');
    const agent = await makeAgent(owner, 'nres6-bot');
    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: agent.key };
    const cap = capture();
    expect(await runCli(['dm', owner.userId, 'by id', '--json'], e, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).dm.counterpart.id).toBe(owner.userId);
  });

  it('room add from an agent profile reaches the route (403), not /me/agents (401)', async () => {
    const owner = await boot('nres7@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'ops' });
    const a = await makeAgent(owner, 'nres7-a');
    const b = await makeAgent(owner, 'nres7-b');
    await owner.client.addMember(room.id, a.id);
    await owner.client.addMember(room.id, b.id);
    const other = await owner.client.createRoom(owner.orgId, { name: 'other' });
    await owner.client.addMember(other.id, a.id);

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: a.key };
    const cap = capture();
    expect(await runCli(['room', 'add', 'nres7-b', '--room', other.id], e, cap.io)).toBe(1);
    expect(cap.err()).not.toMatch(/Sign-in required/i);
    expect(cap.err()).toMatch(/access to that agent/i);
  });

  it('activity --agent from an agent profile says what the rule is (never a bogus 401)', async () => {
    const owner = await boot('nres8@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'ops' });
    const a = await makeAgent(owner, 'nres8-a');
    const b = await makeAgent(owner, 'nres8-b');
    await owner.client.addMember(room.id, a.id);
    await owner.client.addMember(room.id, b.id);

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: a.key };
    const cap = capture();
    // A timeline is correspondence — owner / org admin only. The refusal is the
    // RULE, not "your key is dead".
    expect(await runCli(['activity', '--agent', 'nres8-b'], e, cap.io)).toBe(1);
    expect(cap.err()).not.toMatch(/Sign-in required|revoked or expired/i);
    expect(cap.err()).toMatch(/own timeline/i);

    // Naming ITSELF is just its own timeline.
    const own = capture();
    expect(await runCli(['activity', '--agent', 'nres8-a', '--json'], e, own.io)).toBe(0);
    expect(JSON.parse(own.out())).toHaveProperty('items');
  });

  it('sparrow use org_… works from an agent profile (its org comes from GET /me)', async () => {
    const owner = await boot('nres10@x.com');
    const agent = await makeAgent(owner, 'nres10-bot');
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    const cap = capture();
    // `GET /me/orgs` is session-only; the agent's single org rides on `GET /me`.
    expect(await runCli(['use', owner.orgId], env, cap.io)).toBe(0);
    expect(cap.out()).toContain(owner.orgId);
  });

  it('a HUMAN profile still resolves names through the visibility list', async () => {
    const owner = await boot('nres9@x.com');
    const agent = await makeAgent(owner, 'nres9-bot');
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { me: { server: url, token: owner.token, kind: 'human' } },
        defaultProfile: 'me',
      }),
    );
    const cap = capture();
    expect(await runCli(['dm', 'nres9-bot', 'hi', '--json'], env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).dm.counterpart.id).toBe(agent.id);

    // A name outside the visibility list keeps the human-facing message.
    const miss = capture();
    expect(await runCli(['dm', 'nobody-here'], env, miss.io)).toBe(1);
    expect(miss.err()).toMatch(/visible to you/i);
  });
});

/* ================================================================== *
 * Agent↔agent DM oversight (`sparrow agent-dms`)
 * ================================================================== */

describe('sparrow CLI — agent↔agent DM oversight', () => {
  /** Write a human credentials profile directly (the login shortcut tests use). */
  function humanProfile(token: string): void {
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { me: { server: url, token, kind: 'human' } },
        defaultProfile: 'me',
      }),
    );
  }

  /** Owner + two of their agents in a shared room, with a live agent↔agent DM. */
  async function fixture(prefix: string): Promise<{
    owner: Owner;
    a: Awaited<ReturnType<typeof makeAgent>>;
    b: Awaited<ReturnType<typeof makeAgent>>;
    dmRoomId: string;
  }> {
    const owner = await boot(`${prefix}@x.com`);
    const room = await owner.client.createRoom(owner.orgId, { name: `${prefix}-ops` });
    const a = await makeAgent(owner, `${prefix}-alpha`);
    const b = await makeAgent(owner, `${prefix}-beta`);
    await owner.client.addMember(room.id, a.id);
    await owner.client.addMember(room.id, b.id);
    const dm = await a.client.ensureDm({ principal: b.id });
    return { owner, a, b, dmRoomId: dm.room.id };
  }

  it('agent-dms lists a box (pair ↔, preview, room id) for a human who sees both; -j is the raw page', async () => {
    const f = await fixture('adm1');
    await f.a.client.sendMessage(f.dmRoomId, { body: 'compare notes?' });
    humanProfile(f.owner.token);

    const cap = capture();
    expect(await runCli(['agent-dms'], env, cap.io)).toBe(0);
    // The pair is UNORDERED on the wire — assert the ↔ row, not one ordering.
    expect(cap.out()).toMatch(/adm1-(alpha|beta) ↔ adm1-(alpha|beta)/);
    expect(cap.out()).toContain('adm1-alpha');
    expect(cap.out()).toContain('adm1-beta');
    expect(cap.out()).toContain('compare notes?');
    expect(cap.out()).toContain(f.dmRoomId); // the id `agent-dms read` takes

    const json = capture();
    expect(await runCli(['agent-dms', '--json'], env, json.io)).toBe(0);
    const page = JSON.parse(json.out());
    expect(page.items).toHaveLength(1);
    expect(page.items[0].roomId).toBe(f.dmRoomId);
    expect(page.items[0].agents.map((x: any) => x.id).sort()).toEqual([f.a.id, f.b.id].sort());
  });

  it('agent-dms is empty for a human who cannot see both agents', async () => {
    const f = await fixture('adm2');
    await f.a.client.sendMessage(f.dmRoomId, { body: 'private-ish' });
    const eve = await addHuman(f.owner, 'adm2-eve@x.com'); // in the org, sees neither agent
    humanProfile(eve.client.token!);

    const json = capture();
    expect(await runCli(['agent-dms', '--json'], env, json.io)).toBe(0);
    expect(JSON.parse(json.out()).items).toHaveLength(0);

    const human = capture();
    expect(await runCli(['agent-dms'], env, human.io)).toBe(0);
    expect(human.out()).toMatch(/No agent/);
  });

  it('agent-dms under an AGENT credential explains the human-only surface instead of "Sign-in required"', async () => {
    const f = await fixture('adm4');
    await f.a.client.sendMessage(f.dmRoomId, { body: 'hello' });
    // A perfectly valid AGENT profile: the 401 is "wrong kind of credential",
    // not "bad credential", and the error must say so (the raw route answer,
    // "Sign-in required", reads as a broken key and sent a real agent to
    // re-enroll).
    fs.mkdirSync(path.join(configDir, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'sparrow', 'credentials.json'),
      JSON.stringify({
        profiles: { bot: { server: url, token: f.a.key, kind: 'agent' } },
        defaultProfile: 'bot',
      }),
    );
    for (const argv of [['agent-dms'], ['agent-dms', 'read', f.dmRoomId]]) {
      const cap = capture();
      expect(await runCli(argv, env, cap.io)).not.toBe(0);
      expect(cap.err()).toMatch(/human oversight/i);
      expect(cap.err()).toContain('sparrow dm');
      expect(cap.err()).not.toMatch(/re-?enroll/i);
    }
  });

  it('agent-dms read renders an oldest-first transcript (sender + body) and writes no read state', async () => {
    const f = await fixture('adm3');
    await f.a.client.sendMessage(f.dmRoomId, { body: 'first line\nsecond line' });
    await f.b.client.sendMessage(f.dmRoomId, { body: 'reply' });
    humanProfile(f.owner.token);

    const cap = capture();
    expect(await runCli(['agent-dms', 'read', f.dmRoomId], env, cap.io)).toBe(0);
    const out = cap.out();
    // Oldest-first `time  sender: body` lines — the room-log idiom; a
    // multi-line body collapses to its first line with an ellipsis.
    expect(out.indexOf('adm3-alpha: first line')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('adm3-alpha: first line')).toBeLessThan(out.indexOf('adm3-beta: reply'));
    expect(out).toContain('…');

    // -j: the raw newest-first page with its cursor.
    const json = capture();
    expect(await runCli(['agent-dms', 'read', f.dmRoomId, '--json'], env, json.io)).toBe(0);
    const page = JSON.parse(json.out());
    expect(page.items[0].body).toBe('reply');
    expect(page).toHaveProperty('nextBefore');

    // Overseeing is a peek: the owner's read never promotes the agents' own
    // receipt state to `read` (it stays at the delivery-receipt stage).
    const inbox = await f.b.client.listInbox(f.dmRoomId, { all: true });
    const fromAlpha = inbox.items.find((m) => m.from.displayName === 'adm3-alpha')!;
    expect(fromAlpha.status).not.toBe('read');
  });

  it('agent-dms read errors cleanly on an ineligible or unknown room (one 404, no leak)', async () => {
    const f = await fixture('adm4');
    await f.a.client.sendMessage(f.dmRoomId, { body: 'secret plans' });
    const eve = await addHuman(f.owner, 'adm4-eve@x.com');
    humanProfile(eve.client.token!);

    const cap = capture();
    expect(await runCli(['agent-dms', 'read', f.dmRoomId], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/No such conversation/i);
    expect(cap.err()).not.toContain('secret plans');

    const nope = capture();
    expect(await runCli(['agent-dms', 'read', 'room_doesnotexist'], env, nope.io)).toBe(1);
    expect(nope.err()).toMatch(/No such conversation/i);
  });

  it('dm agent→agent: ensure + send works end-to-end via name resolution; the box surfaces for the owner', async () => {
    const owner = await boot('adm5@x.com');
    const room = await owner.client.createRoom(owner.orgId, { name: 'adm5-ops' });
    const a = await makeAgent(owner, 'adm5-alpha');
    const b = await makeAgent(owner, 'adm5-beta');
    await owner.client.addMember(room.id, a.id);
    await owner.client.addMember(room.id, b.id);

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: a.key };
    const cap = capture();
    // 'adm5-beta' resolves through the agent's rooms' member lists (the one
    // resolvePrincipal door, ee8a8a5); the route says yes: the owner sees both.
    expect(await runCli(['dm', 'adm5-beta', 'ping', '--json'], e, cap.io)).toBe(0);
    const out = JSON.parse(cap.out());
    expect(out.dm.counterpart.id).toBe(b.id);
    expect(out.dm.created).toBe(true);
    expect(out.sent.message.body).toBe('ping');

    // The conversation immediately surfaces as the owner's oversight box.
    humanProfile(owner.token);
    const boxes = capture();
    expect(await runCli(['agent-dms', '--json'], env, boxes.io)).toBe(0);
    expect(JSON.parse(boxes.out()).items.map((i: any) => i.roomId)).toContain(out.dm.room.id);
  });

  it('agent-dms sever cuts the pair; allow lets them re-open it', async () => {
    const f = await fixture('adm7');
    await f.a.client.sendMessage(f.dmRoomId, { body: 'plotting' });
    humanProfile(f.owner.token);

    const cut = capture();
    expect(await runCli(['agent-dms', 'sever', f.dmRoomId], env, cut.io)).toBe(0);
    expect(cut.out()).toMatch(/severed/i);
    expect(cut.out()).toContain('adm7-alpha');
    // The agents' line is dead; the human's transcript is not.
    await expect(f.a.client.sendMessage(f.dmRoomId, { body: 'still there?' })).rejects.toThrow();
    const still = capture();
    expect(await runCli(['agent-dms', 'read', f.dmRoomId], env, still.io)).toBe(0);
    expect(still.out()).toContain('plotting');
    // The listing flags it rather than hiding it.
    const listed = capture();
    expect(await runCli(['agent-dms', '--json'], env, listed.io)).toBe(0);
    expect(JSON.parse(listed.out()).items[0].severedAt).not.toBeNull();

    const ok = capture();
    expect(await runCli(['agent-dms', 'allow', f.dmRoomId], env, ok.io)).toBe(0);
    expect(ok.out()).toMatch(/allow/i);
    // Allowing permits; the agents themselves re-open the line.
    await f.a.client.ensureDm({ principal: f.b.id });
    await f.a.client.sendMessage(f.dmRoomId, { body: 'back' });
  });

  it('agent-dms sever from a human who governs nothing says so (404), not a bogus auth error', async () => {
    const f = await fixture('adm8');
    await f.a.client.sendMessage(f.dmRoomId, { body: 'hello' });
    const eve = await addHuman(f.owner, 'adm8-eve@x.com');
    humanProfile(eve.client.token!);
    const cap = capture();
    expect(await runCli(['agent-dms', 'sever', f.dmRoomId], env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/No such conversation/i);
  });

  it('dm agent→agent surfaces the no-common-viewer 403 message verbatim when ineligible', async () => {
    const owner = await boot('adm6@x.com');
    const a = await makeAgent(owner, 'adm6-alpha');
    const other = await addHuman(owner, 'adm6-other@x.com');
    const bRes = await other.client.createAgent({ orgId: owner.orgId, name: 'adm6-beta' });
    // They MEET in one room (so the pair may hear the real rule), but each agent
    // is shared only to its own owner — no human can currently see both.
    const room = await owner.client.createRoom(owner.orgId, { name: 'adm6-ops' });
    await owner.client.addMember(room.id, a.id);
    const inv = await owner.client.inviteHuman(room.id, other.userId);
    await other.client.acceptRoomInvitation(inv.invitation.id);
    await other.client.addMember(room.id, bRes.agent.id);
    await owner.client.setAgentSharing(a.id, 'selected');
    await other.client.setAgentSharing(bRes.agent.id, 'selected');

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: a.key };
    const cap = capture();
    expect(await runCli(['dm', bRes.agent.id], e, cap.io)).toBe(1);
    expect(cap.err()).toContain(AGENT_DM_NO_COMMON_VIEWER_MESSAGE);
  });

  it('dm agent→agent with an id it has never met is refused like a bogus id (no oracle)', async () => {
    const owner = await boot('adm9@x.com');
    const a = await makeAgent(owner, 'adm9-alpha');
    const b = await makeAgent(owner, 'adm9-beta'); // same owner, no shared room

    const e = { ...env, SPARROW_SERVER: url, SPARROW_TOKEN: a.key };
    const real = capture();
    expect(await runCli(['dm', b.id], e, real.io)).toBe(1);
    const fake = capture();
    expect(await runCli(['dm', `agt_${'z'.repeat(21)}`], e, fake.io)).toBe(1);
    expect(real.err()).toContain(DM_NOT_ELIGIBLE_MESSAGE);
    expect(real.err()).toBe(fake.err());
  });
});


/* ================================================================== *
 * The attention wave: hints at the PAUSE, `sparrow tips`, quiet listeners
 *
 * The design, in one line: the right time to inform an agent is BETWEEN
 * tasks, and the right channel is one the agent CHOSE. So a hint appears
 * on exactly one surface — the `{ item: null }` pop that ends a drain —
 * as ORDINARY OUTPUT (stdout in human mode, the envelope under `-j`).
 * Never on a send, never on a pop that hands back work, never on stderr.
 * `sparrow tips` is the pull half: ask, and get everything at once.
 * ================================================================== */

describe('sparrow CLI — hints arrive at the pause', () => {
  const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Owner + a room the agent is in; the agent is the default CLI profile. */
  async function hintFixture(prefix: string): Promise<{
    owner: Owner;
    roomId: string;
    roomName: string;
    agentId: string;
  }> {
    const owner = await boot(`${prefix}@x.com`);
    const roomName = `${prefix}-room`;
    const room = await owner.client.createRoom(owner.orgId, { name: roomName });
    const agent = await makeAgent(owner, `${prefix}-bot`);
    await owner.client.addMember(room.id, agent.id);
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    // The agent has never held an events stream and planted no presence mark,
    // so it is plainly offline — `start-listening` is armed for its first
    // PAUSE, which is how these tests force a real hint.
    return { owner, roomId: room.id, roomName, agentId: agent.id };
  }

  /** Every `[hint] …` line a run wrote to stdout, in order. */
  const hintLines = (cap: Capture): string[] =>
    cap.out().split('\n').filter((l) => l.startsWith('[hint]'));

  it('the empty pop prints "Inbox empty." and then the hint, on STDOUT', async () => {
    const { } = await hintFixture('hnta');
    const cap = capture();
    expect(await runCli(['pop'], env, cap.io)).toBe(0);

    const lines = cap.out().split('\n');
    expect(lines[0]).toBe('Inbox empty.');
    expect(hintLines(cap)[0]).toMatch(/^\[hint\] start-listening: /);
    expect(cap.out()).toContain('You look offline');
    // Ordinary output — NOT a diagnostic. stderr stays clean.
    expect(cap.err()).toBe('');
  });

  it('a hint with an action prints the action line and the docs URL', async () => {
    await hintFixture('hntc');
    const cap = capture();
    expect(await runCli(['pop'], env, cap.io)).toBe(0);
    const lines = hintLines(cap);
    expect(lines).toContain('[hint]   -> GET /api/v1/me/events');
    // `docs` is the absolute canonical-home URL the SERVER builds (DOCS_URL,
    // default https://sparrow.land/docs) — print it verbatim.
    expect(lines).toContain('[hint]   docs: https://sparrow.land/docs/api/me/events.md');
  });

  it('--json needs no extra rendering: the hint already rides the envelope', async () => {
    await hintFixture('hntb');
    const cap = capture();
    expect(await runCli(['pop', '--json'], env, cap.io)).toBe(0);
    // stdout parses WHOLE and is exactly the pretty-printed envelope.
    const envelope = JSON.parse(cap.out());
    expect(cap.out()).toBe(`${JSON.stringify(envelope, null, 2)}\n`);
    expect(envelope.item).toBeNull();
    expect(envelope.hints[0].id).toBe('start-listening');
    // No human-rendered lines leak into the machine channel, and nothing to stderr.
    expect(cap.out()).not.toContain('[hint]');
    expect(cap.err()).toBe('');
  });

  it('a pop that HANDS BACK WORK is never hinted — the next, empty one is', async () => {
    const { owner, roomId, agentId } = await hintFixture('hntd');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'work for you' });

    const working = capture();
    expect(await runCli(['pop'], env, working.io)).toBe(0);
    expect(working.out()).toContain('work for you');
    expect(hintLines(working)).toEqual([]); // mid-stride: say nothing
    expect(working.err()).toBe('');

    const pause = capture();
    expect(await runCli(['pop'], env, pause.io)).toBe(0);
    expect(pause.out()).toContain('Inbox empty.');
    expect(hintLines(pause).length).toBeGreaterThan(0);
  });

  it('a quiet pause is just "Inbox empty." — the server owns the frequency', async () => {
    await hintFixture('hnte');
    // The first pause burns `start-listening`'s 24h cooldown.
    expect(await runCli(['pop'], env, capture().io)).toBe(0);

    const cap = capture();
    expect(await runCli(['pop'], env, cap.io)).toBe(0);
    expect(cap.out()).toBe('Inbox empty.\n');
    expect(cap.err()).toBe('');
  });

  it('send, reply and dm are silent — coaching never interrupts a task', async () => {
    const { owner, roomId, roomName, agentId } = await hintFixture('hntf');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'question?' });
    await runCli(['pop'], env, capture().io); // records `lastInbound` for reply

    const sent = capture();
    expect(await runCli(['send', 'one', '--room', roomName], env, sent.io)).toBe(0);
    expect(sent.out()).not.toContain('[hint]');
    expect(sent.err()).toBe('');

    const replied = capture();
    expect(await runCli(['reply', 'answer'], env, replied.io)).toBe(0);
    expect(replied.out()).not.toContain('[hint]');
    expect(replied.err()).toBe('');

    const dmed = capture();
    expect(await runCli(['dm', owner.userId, 'hello owner'], env, dmed.io)).toBe(0);
    expect(dmed.out()).not.toContain('[hint]');
    expect(dmed.err()).toBe('');
  });

  it('the room-scoped pop stays silent — that response carries no hints at all', async () => {
    const { owner, roomId, roomName, agentId } = await hintFixture('hnti');
    await owner.client.sendMessage(roomId, { to: agentId, body: 'room-scoped' });

    const cap = capture();
    expect(await runCli(['pop', '--room', roomName], env, cap.io)).toBe(0);
    expect(cap.out()).toContain('room-scoped');
    const empty = capture();
    expect(await runCli(['pop', '--room', roomName], env, empty.io)).toBe(0);
    // POST /rooms/:roomId/inbox/pop is not a hinted surface: the CLI must not
    // invent one, and must not fabricate a hint the server never sent.
    expect(empty.out()).toBe('Inbox empty.\n');
  });

  /* ------------------------------- sparrow tips ------------------------- */

  it('`tips` prints every hint that applies right now, with actions and docs', async () => {
    await hintFixture('tipa');
    const cap = capture();
    expect(await runCli(['tips'], env, cap.io)).toBe(0);
    expect(hintLines(cap)[0]).toMatch(/^\[hint\] start-listening: /);
    expect(hintLines(cap)).toContain('[hint]   -> GET /api/v1/me/events');
    expect(cap.err()).toBe('');
  });

  it('`tips --json` is the raw { hints } envelope', async () => {
    await hintFixture('tipb');
    const cap = capture();
    expect(await runCli(['tips', '--json'], env, cap.io)).toBe(0);
    const res = JSON.parse(cap.out());
    expect(cap.out()).toBe(`${JSON.stringify(res, null, 2)}\n`);
    expect(Array.isArray(res.hints)).toBe(true);
    expect(res.hints.some((x: { id: string }) => x.id === 'start-listening')).toBe(true);
  });

  it('`tips` is FREE: looking costs no cooldown, so the pause still delivers', async () => {
    await hintFixture('tipc');
    expect(await runCli(['tips'], env, capture().io)).toBe(0);
    expect(await runCli(['tips'], env, capture().io)).toBe(0);

    const pause = capture();
    expect(await runCli(['pop'], env, pause.io)).toBe(0);
    expect(hintLines(pause)[0]).toMatch(/^\[hint\] start-listening: /);
  });

  it('`tips` with nothing to say says exactly that', async () => {
    await hintFixture('tipd');
    // Hold the stream: an ONLINE, freshly-created agent with no work behind it
    // and no coaching history has nothing the engine wants to teach.
    const watchCap = capture();
    const watching = runCli(['watch'], env, watchCap.io);
    await nap(400);
    const cap = capture();
    expect(await runCli(['tips'], env, cap.io)).toBe(0);
    process.emit('SIGINT');
    await watching;

    expect(cap.out()).toBe("Nothing right now — you're set up well.\n");
  });
});

/* ================================================================== *
 * Quiet listeners
 *
 * `await`/`watch`/`loop` are LISTENERS: an agent runs one and reads what
 * comes back. Routine lifecycle chatter — reconnected, refreshing, the
 * reconcile poll — is the runtime talking about itself, and it drowns the
 * signal. It is silent by default and `-v` brings it back. Anomalies (a
 * replay gap, a terminal 426, exhausted retries) always print, and the
 * `-j` line protocols are byte-identical either way.
 * ================================================================== */

describe('sparrow CLI — listeners are quiet by default', () => {
  const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function listenerFixture(prefix: string): Promise<{ owner: Owner; roomId: string }> {
    const owner = await boot(`${prefix}@x.com`);
    const room = await owner.client.createRoom(owner.orgId, { name: `${prefix}-room` });
    const agent = await makeAgent(owner, `${prefix}-bot`);
    await owner.client.addMember(room.id, agent.id);
    await runCli(['login-agent', agent.key, '--server', url], env, capture().io);
    return { owner, roomId: room.id };
  }

  it('watch: the max-age refresh is silent by default and restored by -v', async () => {
    await listenerFixture('qla');

    const quiet = capture();
    const w1 = runCli(['watch', '--stale-seconds', '0', '--max-stream-age', '1'], env, quiet.io);
    await nap(1800);
    process.emit('SIGINT');
    expect(await w1).toBe(0);
    expect(quiet.out()).not.toContain('refreshing stream');
    expect(quiet.err()).not.toContain('refreshing stream');

    const loud = capture();
    const w2 = runCli(
      ['watch', '--verbose', '--stale-seconds', '0', '--max-stream-age', '1'],
      env,
      loud.io,
    );
    await nap(1800);
    process.emit('SIGINT');
    expect(await w2).toBe(0);
    expect(loud.out()).toContain('refreshing stream');
  }, 20_000);

  it('watch -j: the JSON line protocol is byte-identical — quiet never touches it', async () => {
    await listenerFixture('qlb');
    const cap = capture();
    const w = runCli(
      ['watch', '-j', '--stale-seconds', '0', '--max-stream-age', '1'],
      env,
      cap.io,
    );
    await nap(1800);
    process.emit('SIGINT');
    expect(await w).toBe(0);
    // No -v: the machine channel still carries the lifecycle frame verbatim.
    const types = cap
      .out()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).type);
    expect(types).toContain('watch.refresh');
  }, 20_000);

  it('loop: the reconnect line is silent by default and restored by -v', async () => {
    await listenerFixture('qlc');

    const quiet = capture();
    const l1 = runCli(['loop', '--stale-seconds', '0', '--max-stream-age', '1'], env, quiet.io);
    await nap(1800);
    process.emit('SIGINT');
    expect(await l1).toBe(0);
    expect(quiet.err()).not.toContain('[loop] refreshing stream');
    expect(quiet.err()).not.toContain('[loop] reconnected');

    const loud = capture();
    const l2 = runCli(
      ['loop', '-v', '--stale-seconds', '0', '--max-stream-age', '1'],
      env,
      loud.io,
    );
    await nap(1800);
    process.emit('SIGINT');
    expect(await l2).toBe(0);
    expect(loud.err()).toContain('[loop] refreshing stream');
  }, 20_000);

  it('await: the refresh note is silent by default and restored by -v', async () => {
    await listenerFixture('qld');

    const quiet = capture();
    const a1 = runCli(
      ['await', '--timeout', '3', '--stale-seconds', '0', '--max-stream-age', '1', '--poll-seconds', '0'],
      env,
      quiet.io,
    );
    await nap(1800);
    process.emit('SIGINT');
    await a1;
    expect(quiet.err()).not.toContain('[await] refreshing stream');

    const loud = capture();
    const a2 = runCli(
      ['await', '-v', '--timeout', '3', '--stale-seconds', '0', '--max-stream-age', '1', '--poll-seconds', '0'],
      env,
      loud.io,
    );
    await nap(1800);
    process.emit('SIGINT');
    await a2;
    expect(loud.err()).toContain('[await] refreshing stream');
  }, 20_000);

  it('exhausted retries are an ANOMALY and still report without -v', async () => {
    await listenerFixture('qle');
    // Nothing is listening on this port: every reconnect fails until --retry-max
    // runs out. Quieting the routine chatter must never quiet the moment the
    // listener gives up — that is the agent going deaf, and it must say so.
    const e = { ...env, SPARROW_SERVER: 'http://127.0.0.1:1' };
    const cap = capture();
    expect(
      await runCli(
        ['watch', '--retry-max', '1', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
        e,
        cap.io,
      ),
    ).toBe(1);
    expect(cap.err()).toContain('reconnect retries exhausted');
  }, 20_000);

  /* ------------------- presence/status opt-in ------------------------- */

  it('watch: presence churn is filtered out by default, and --with-presence brings it back', async () => {
    const { owner, roomId } = await listenerFixture('qlf');
    // Two FRESH flippers, one per half: presence has a grace window, so reusing
    // one principal would make the second flip a no-op (it never went offline)
    // and the test would prove nothing.
    const flipA = await makeAgent(owner, 'qlf-flip-a');
    const flipB = await makeAgent(owner, 'qlf-flip-b');
    await owner.client.addMember(roomId, flipA.id);
    await owner.client.addMember(roomId, flipB.id);

    // --with-presence: opted back in, so the flip arrives.
    const loud = capture();
    const w1 = runCli(
      ['watch', '--with-presence', '--stale-seconds', '0', '--max-stream-age', '0'],
      env,
      loud.io,
    );
    await nap(400);
    const sA = flipA.client.meEvents(() => {});
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !loud.out().includes('[presence.changed]')) await nap(25);
    sA.close();
    await sA.closed;
    process.emit('SIGINT');
    expect(await w1).toBe(0);
    expect(loud.out()).toContain('[presence.changed]');

    // Default: the server never writes those frames to this subscription.
    const quiet = capture();
    const w2 = runCli(['watch', '--stale-seconds', '0', '--max-stream-age', '0'], env, quiet.io);
    await nap(400);
    const sB = flipB.client.meEvents(() => {});
    await nap(1500);
    sB.close();
    await sB.closed;
    await nap(300);
    process.emit('SIGINT');
    expect(await w2).toBe(0);
    expect(quiet.out()).not.toContain('[presence.changed]');
  }, 30_000);
});
