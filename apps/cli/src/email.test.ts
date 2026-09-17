/**
 * `sparrow email …` / `sparrow approvals` — the CLI's half of the email medium,
 * driven end-to-end against a REAL in-process API with the medium ON
 * (`emailOrgSuffix: '.example.com'`, the `fake` provider, the inbound bearer).
 * Inbound mail is injected through `app.emailFake.deliver()` — the same pipeline
 * `POST /email/inbound` runs, minus the HTTP hop and the token.
 *
 * The suite deliberately also re-checks the MEDIUM-SPANNING surfaces that were
 * written against a stub server (`pop`, `inbox`, `loop`, `activity`) against a
 * real inbound email, because a stub can agree with a shape the server never
 * emits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, afterAll } from 'vitest';
import { buildServer } from '@sparrow/api';
import { SparrowClient } from '@sparrow/client';
import { runCli, type CliIO } from './index.js';

/**
 * Isolated loop-state dir for every CLI run in this file. `watch`/`await`/`loop`
 * write their listener kind into `<state>/heartbeat`; without this the suite
 * stamps the developer's real ~/.sparrow/heartbeat with `watch`, which the
 * Stop hook then (correctly) blocks on.
 */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-state-'));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const ADMIN_TOKEN = 'test-admin-token';

let app: ReturnType<typeof buildServer>;
let dataDir: string;
let url: string;
let configDir: string;
let env: Record<string, string | undefined>;

/** The in-process fake provider handle `buildServer` decorates onto the app. */
interface EmailFake {
  deliver(payload: unknown): Promise<{ status: string; email: { id: string; threadId: string } }>;
  sent: unknown[];
}
const fake = (): EmailFake => (app as unknown as { emailFake: EmailFake }).emailFake;

/** Start a server; `email` toggles the whole medium (off ⇒ every route 404s). */
async function startServer(email = true): Promise<void> {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-email-'));
  app = buildServer({
    dataDir,
    baseUrl: 'http://localhost:8722',
    adminToken: ADMIN_TOKEN,
    ...(email
      ? {
          emailOrgSuffix: '.example.com',
          emailProvider: 'fake' as const,
          emailInboundToken: 'test-inbound-token',
        }
      : {}),
  });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

async function stopServer(): Promise<void> {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-email-cfg-'));
  env = {
    XDG_CONFIG_HOME: configDir,
    HOME: os.homedir(),
    SPARROW_STATE_DIR: stateDir,
    PATH: process.env.PATH,
    SPARROW_PASSWORD: 'password123',
  };
});

afterEach(async () => {
  fs.rmSync(configDir, { recursive: true, force: true });
  await stopServer();
});

/* ------------------------------ IO capture ----------------------------- */

interface Capture {
  io: CliIO;
  out(): string;
  err(): string;
}
function capture(opts?: { stdin?: string }): Capture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (s) => outChunks.push(s),
      err: (s) => errChunks.push(s),
      stdin: opts?.stdin,
      prompt: async () => '',
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

/* ------------------------------ fixtures ------------------------------- */

interface Fixture {
  owner: SparrowClient;
  ownerId: string;
  orgId: string;
  agentId: string;
  agentName: string;
  agent: SparrowClient;
  address: string;
}

/**
 * The FIRST human bootstraps an org ("Owner's org" → slug `owners-org`), owns
 * one agent, and both get CLI credential profiles: `bot` (agent key) and
 * `owner` (session). Every command below names its profile explicitly.
 */
async function fixture(agentName = 'fable', email = true): Promise<Fixture> {
  await startServer(email);
  const owner = new SparrowClient({ server: url });
  const signup = await owner.signup({
    email: 'owner@x.com',
    password: 'password123',
    displayName: 'Owner',
  });
  const orgId = (await owner.meOrgs())[0]!.org.id;
  const made = await owner.createAgent({ orgId, name: agentName });
  const agent = new SparrowClient({ server: url, token: made.key });

  const cap = capture();
  expect(await runCli(['login-agent', made.key, '--server', url, '--profile', 'bot'], env, cap.io)).toBe(0);
  expect(
    await runCli(['login', '--server', url, '--email', 'owner@x.com', '--profile', 'owner'], env, cap.io),
  ).toBe(0);

  return {
    owner,
    ownerId: signup.user.id,
    orgId,
    agentId: made.agent.id,
    agentName,
    agent,
    address: made.agent.emailAddress ?? `${agentName}@owners-org.example.com`,
  };
}

/** Deliver one inbound email to `f.address`. `from` defaults to the org owner (trusted). */
async function inbound(
  f: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<{ status: string; emailId: string; threadId: string }> {
  const res = await fake().deliver({
    rfcMessageId: `<${Math.random().toString(36).slice(2)}@mail.example.net>`,
    from: { email: 'owner@x.com', name: 'Owner' },
    to: [{ email: f.address, name: f.agentName }],
    subject: 'Q3 rollout',
    text: 'the body',
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'x.com' },
    ...overrides,
  });
  return { status: res.status, emailId: res.email.id, threadId: res.email.threadId };
}

/** Open the org's trust policy so unrecognized mail queues instead of bouncing. */
async function openPolicy(f: Fixture): Promise<void> {
  const org = await f.owner.getOrg(f.orgId);
  await f.owner.updateOrg(f.orgId, {
    settings: {
      ...org.settings,
      email: {
        ...org.settings.email,
        inboundUnrecognized: 'approve',
        outboundUnrecognized: 'approve',
      },
    },
  });
}

const asBot = (...argv: string[]): string[] => [...argv, '--profile', 'bot'];
const asOwner = (...argv: string[]): string[] => [...argv, '--profile', 'owner'];

/* ================================================================== *
 * sparrow email address
 * ================================================================== */

describe('sparrow email address', () => {
  it('an agent profile reads its OWN derived address', async () => {
    const f = await fixture();
    const cap = capture();
    expect(await runCli(asBot('email', 'address'), env, cap.io)).toBe(0);
    expect(cap.out()).toContain('fable@owners-org.example.com');
    expect(cap.out()).toContain('owners-org.example.com');

    const json = capture();
    expect(await runCli(asBot('email', 'address', '--json'), env, json.io)).toBe(0);
    expect(JSON.parse(json.out())).toEqual({
      address: 'fable@owners-org.example.com',
      domain: 'owners-org.example.com',
      orgId: f.orgId,
      agentId: f.agentId,
    });
  });

  it('a human profile reads its agent’s address — auto with one agent, --agent otherwise', async () => {
    const f = await fixture();
    const auto = capture();
    expect(await runCli(asOwner('email', 'address'), env, auto.io)).toBe(0);
    expect(auto.out()).toContain('fable@owners-org.example.com');

    // A second agent with email makes --agent REQUIRED (SPEC → "Email commands").
    await f.owner.createAgent({ orgId: f.orgId, name: 'scout' });
    const ambiguous = capture();
    expect(await runCli(asOwner('email', 'address'), env, ambiguous.io)).toBe(1);
    expect(ambiguous.err()).toMatch(/--agent/);

    const named = capture();
    expect(await runCli(asOwner('email', 'address', '--agent', 'scout'), env, named.io)).toBe(0);
    expect(named.out()).toContain('scout@owners-org.example.com');
  });

  it('an agent profile may not point --agent at someone else', async () => {
    const f = await fixture();
    await f.owner.createAgent({ orgId: f.orgId, name: 'scout' });
    const cap = capture();
    expect(await runCli(asBot('email', 'address', '--agent', 'scout'), env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/own mailbox/i);
  });
});

/* ================================================================== *
 * sparrow email threads
 * ================================================================== */

describe('sparrow email threads', () => {
  it('lists the agent’s threads oldest-first, honors --limit, and -j is the raw page', async () => {
    const f = await fixture();
    await inbound(f, { subject: 'first' });
    await inbound(f, { subject: 'second' });

    const cap = capture();
    expect(await runCli(asBot('email', 'threads'), env, cap.io)).toBe(0);
    const body = cap.out();
    expect(body).toContain('THREAD ID');
    expect(body.indexOf('first')).toBeGreaterThan(-1);
    // oldest-first: `first` precedes `second`
    expect(body.indexOf('first')).toBeLessThan(body.indexOf('second'));

    // -j is the RAW page — newest-first, exactly as the wire ordered it, with the
    // `nextBefore` cursor a script pages backward on. Only the table reverses.
    const raw = capture();
    expect(await runCli(asBot('email', 'threads', '--json'), env, raw.io)).toBe(0);
    const page = JSON.parse(raw.out());
    expect(page.items.map((t: { subject: string }) => t.subject)).toEqual(['second', 'first']);
    expect('nextBefore' in page).toBe(true);
    expect(page.nextBefore).toBeNull();

    const limited = capture();
    expect(await runCli(asBot('email', 'threads', '--limit', '1', '--json'), env, limited.io)).toBe(0);
    const one = JSON.parse(limited.out());
    expect(one.items).toHaveLength(1);
    // The capped page keeps the NEWEST thread and names it as the next `before`.
    expect(one.items[0].subject).toBe('second');
    expect(one.nextBefore).toBe(one.items[0].id);
  });

  it('says so plainly when there are no threads', async () => {
    await fixture();
    const cap = capture();
    expect(await runCli(asBot('email', 'threads'), env, cap.io)).toBe(0);
    expect(cap.out()).toMatch(/No email threads/);
  });

  it('a human profile reads its agent’s threads through the org twin', async () => {
    const f = await fixture();
    await inbound(f, { subject: 'owner can see this' });
    const cap = capture();
    expect(await runCli(asOwner('email', 'threads', '--agent', 'fable', '--json'), env, cap.io)).toBe(0);
    const items = JSON.parse(cap.out()).items;
    expect(items).toHaveLength(1);
    expect(items[0].subject).toBe('owner can see this');
    expect(items[0].agentId).toBe(f.agentId);
  });
});

/* ================================================================== *
 * sparrow email read
 * ================================================================== */

describe('sparrow email read', () => {
  it('an eth_ id prints the thread as an oldest-first transcript, including what did NOT go out', async () => {
    const f = await fixture();
    await openPolicy(f);
    const first = await inbound(f, { subject: 'Q3 rollout', text: 'the body' });
    await f.agent.replyEmail(first.threadId, { text: 'thanks!' });
    // A reply that adds an unrecognized cc is HELD — and must still show up.
    await f.agent.replyEmail(first.threadId, { text: 'looping in dana', cc: ['dana@partner.example.com'] });

    const cap = capture();
    expect(await runCli(asBot('email', 'read', first.threadId), env, cap.io)).toBe(0);
    const body = cap.out();
    expect(body).toContain(first.threadId);
    expect(body).toContain('Q3 rollout');
    expect(body.indexOf('the body')).toBeLessThan(body.indexOf('thanks!'));
    expect(body).toContain('looping in dana');
    expect(body).toMatch(/\[held: unrecognized-recipient\]/);
  });

  it('an eml_ id prints ONE email in full — headers, inbound verification, body, attachment ids', async () => {
    const f = await fixture();
    const del = await inbound(f, {
      subject: 'with a sheet',
      text: 'numbers attached',
      attachments: [
        {
          filename: 'sheet.csv',
          contentType: 'text/csv',
          dataBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
        },
      ],
    });

    const cap = capture();
    expect(await runCli(asBot('email', 'read', del.emailId), env, cap.io)).toBe(0);
    const body = cap.out();
    expect(body).toContain(`[email: ${del.threadId}`);
    expect(body).toContain('from: owner@x.com');
    expect(body).toContain(`to:   ${f.address}`);
    expect(body).toContain('subj: with a sheet');
    expect(body).toContain('auth: spf=pass dkim=pass dmarc=pass');
    expect(body).toMatch(/att_[A-Za-z0-9]+ {2}sheet\.csv/);
    expect(body).toContain('numbers attached');
  });

  it('reading an eml_ records lastEmail so `email reply --last` needs no id', async () => {
    const f = await fixture();
    const del = await inbound(f);
    expect(await runCli(asBot('email', 'read', del.emailId), env, capture().io)).toBe(0);

    const cap = capture();
    expect(await runCli(asBot('email', 'reply', 'on it'), env, cap.io)).toBe(0);
    expect(cap.out()).toContain(del.threadId);

    const thread = await f.agent.getEmailThread(del.threadId);
    expect(thread.items.map((e) => e.text)).toContain('on it');
  });

  it('rejects an id that is neither a thread nor an email', async () => {
    await fixture();
    const cap = capture();
    expect(await runCli(asBot('email', 'read', 'msg_nope'), env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/eth_|eml_/);
  });

  it('a human profile reads one of its agent’s emails through the ORG route', async () => {
    const f = await fixture();
    const del = await inbound(f, { subject: 'owner reads this' });
    const cap = capture();
    expect(await runCli(asOwner('email', 'read', del.emailId, '--json'), env, cap.io)).toBe(0);
    expect(JSON.parse(cap.out()).subject).toBe('owner reads this');
  });
});

/* ================================================================== *
 * sparrow email reply
 * ================================================================== */

describe('sparrow email reply', () => {
  it('--to EMLID answers that email’s thread; --cc adds people; the subject comes from the thread', async () => {
    const f = await fixture();
    await openPolicy(f);
    const del = await inbound(f, { subject: 'Q3 rollout' });

    const cap = capture();
    expect(
      await runCli(
        asBot('email', 'reply', 'ack', '--to', del.emailId, '--cc', 'dana@partner.example.com'),
        env,
        cap.io,
      ),
    ).toBe(0);
    const thread = await f.agent.getEmailThread(del.threadId);
    const reply = thread.items.find((e) => e.text === 'ack')!;
    expect(reply.subject).toBe('Re: Q3 rollout');
    expect(reply.cc.map((c) => c.email)).toContain('dana@partner.example.com');
  });

  it('reads the body from --stdin', async () => {
    const f = await fixture();
    const del = await inbound(f);
    const cap = capture({ stdin: 'piped body\n' });
    expect(await runCli(asBot('email', 'reply', '--to', del.emailId, '--stdin'), env, cap.io)).toBe(0);
    const thread = await f.agent.getEmailThread(del.threadId);
    expect(thread.items.map((e) => e.text)).toContain('piped body\n');
  });

  it('with no last email and no --to it explains how to target one', async () => {
    await fixture();
    const cap = capture();
    expect(await runCli(asBot('email', 'reply', 'hi'), env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/email pop|sparrow pop|email read/);
  });

  it('a HELD reply exits 0 and says a human must approve it — never a failure to retry', async () => {
    const f = await fixture();
    await openPolicy(f);
    const del = await inbound(f);
    const cap = capture();
    expect(
      await runCli(
        asBot('email', 'reply', 'looping in dana', '--to', del.emailId, '--cc', 'dana@partner.example.com'),
        env,
        cap.io,
      ),
    ).toBe(0);
    expect(cap.out()).toContain('held for Owner to approve');
    expect(cap.out()).toContain('email.resolved');
    expect(cap.out()).toMatch(/not a failure|do not retry/i);
  });
});

/* ================================================================== *
 * sparrow email send
 * ================================================================== */

describe('sparrow email send', () => {
  it('starts a new thread to a trusted recipient', async () => {
    const f = await fixture();
    const cap = capture();
    expect(
      await runCli(
        asBot('email', 'send', '--to', 'owner@x.com', '--subject', 'status', 'all green'),
        env,
        cap.io,
      ),
    ).toBe(0);
    expect(cap.out()).toMatch(/eml_/);

    const json = capture();
    expect(
      await runCli(
        asBot('email', 'send', '--to', 'owner@x.com', '--subject', 's2', '--stdin', '--json'),
        { ...env },
        { ...json.io, stdin: 'from stdin' },
      ),
    ).toBe(0);
    const res = JSON.parse(json.out());
    expect(res.email.disposition).toBe('sent');
    expect(res.email.text).toBe('from stdin');
    expect(res.thread.subject).toBe('s2');
  });

  it('a HELD send exits 0 and names the owner + the email.resolved event', async () => {
    const f = await fixture();
    await openPolicy(f);
    const cap = capture();
    expect(
      await runCli(
        asBot('email', 'send', '--to', 'stranger@nowhere.example', '--subject', 'hi', 'hello'),
        env,
        cap.io,
      ),
    ).toBe(0);
    expect(cap.out()).toContain('held for Owner to approve');
    expect(cap.out()).toContain('email.resolved');
    expect(cap.out()).toContain('unrecognized-recipient');
    void f;
  });

  it('a policy REJECT is a real failure (exit 1)', async () => {
    await fixture(); // default policy: outboundUnrecognized = reject
    const cap = capture();
    expect(
      await runCli(
        asBot('email', 'send', '--to', 'stranger@nowhere.example', '--subject', 'hi', 'hello'),
        env,
        cap.io,
      ),
    ).toBe(1);
    expect(cap.err()).toMatch(/policy/i);
  });

  it('requires --to and --subject', async () => {
    await fixture();
    const noTo = capture();
    expect(await runCli(asBot('email', 'send', '--subject', 's', 'body'), env, noTo.io)).not.toBe(0);
    const noSubject = capture();
    expect(await runCli(asBot('email', 'send', '--to', 'owner@x.com', 'body'), env, noSubject.io)).not.toBe(0);
  });
});

/* ================================================================== *
 * sparrow email attachment get
 * ================================================================== */

describe('sparrow email attachment get', () => {
  async function seedAttachment(f: Fixture): Promise<string> {
    const del = await inbound(f, {
      attachments: [
        {
          filename: 'sheet.csv',
          contentType: 'text/csv',
          dataBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
        },
      ],
    });
    const email = await f.agent.readEmail(del.emailId, { peek: true });
    return email.attachments[0]!.id;
  }

  it('an agent downloads through /me/email/attachments; -o names the file', async () => {
    const f = await fixture();
    const attId = await seedAttachment(f);
    const out = path.join(configDir, 'grabbed.csv');
    const cap = capture();
    expect(await runCli(asBot('email', 'attachment', 'get', attId, '-o', out), env, cap.io)).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe('a,b\n1,2\n');
  });

  it('a human downloads the same bytes through the ORG route', async () => {
    const f = await fixture();
    const attId = await seedAttachment(f);
    const out = path.join(configDir, 'owner.csv');
    const cap = capture();
    expect(await runCli(asOwner('email', 'attachment', 'get', attId, '-o', out), env, cap.io)).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe('a,b\n1,2\n');
  });
});

/* ================================================================== *
 * sparrow approvals — the owning human's queue
 * ================================================================== */

describe('sparrow approvals', () => {
  /** A pending enrollment from the owner's OWN invite + one held + one quarantined email. */
  async function queue(f: Fixture): Promise<{ enrollmentId: string; heldId: string; quarantinedId: string }> {
    const inv = await f.owner.createInvite(f.orgId);
    const anon = new SparrowClient({ server: url });
    const enr = await anon.enrollAgent(inv.url.split('/invite/')[1]!, { name: 'newbie' });
    if (enr.status !== 'pending') throw new Error('expected a pending enrollment');

    await openPolicy(f);
    const held = await f.agent.sendEmail({
      to: ['stranger@nowhere.example'],
      subject: 'outbound hold',
      text: 'body',
    });
    const quarantined = await inbound(f, {
      from: { email: 'dana@partner.example.com', name: 'Dana Lee' },
      subject: 'cold outreach',
      verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'partner.example.com' },
    });
    expect(quarantined.status).toBe('quarantined');
    return {
      enrollmentId: enr.enrollment.id,
      heldId: held.email.id,
      quarantinedId: quarantined.emailId,
    };
  }

  it('lists BOTH pending enrollments from your own invites AND email waiting on you', async () => {
    const f = await fixture();
    const q = await queue(f);

    const cap = capture();
    expect(await runCli(asOwner('approvals'), env, cap.io)).toBe(0);
    const body = cap.out();
    expect(body).toContain(q.enrollmentId);
    expect(body).toContain('newbie');
    expect(body).toContain(q.heldId);
    expect(body).toContain(q.quarantinedId);
    expect(body).toContain('unrecognized-recipient');
    expect(body).toContain('unrecognized-sender');

    const json = capture();
    expect(await runCli(asOwner('approvals', 'list', '--json'), env, json.io)).toBe(0);
    const res = JSON.parse(json.out());
    expect(res.enrollments.map((e: { id: string }) => e.id)).toEqual([q.enrollmentId]);
    expect(res.email.map((i: { email: { id: string } }) => i.email.id).sort()).toEqual(
      [q.heldId, q.quarantinedId].sort(),
    );
  });

  it('refuses an agent profile — an agent never approves mail addressed to itself', async () => {
    const f = await fixture();
    await queue(f);
    const cap = capture();
    expect(await runCli(asBot('approvals'), env, cap.io)).toBe(1);
    expect(cap.err()).toMatch(/agent/i);
    expect(cap.err()).not.toMatch(/Sign-in required/);
  });

  it('approve relays a held email and trusts the other party; --no-trust approves just this one', async () => {
    const f = await fixture();
    const q = await queue(f);

    const cap = capture();
    expect(await runCli(asOwner('approvals', 'approve', q.heldId), env, cap.io)).toBe(0);
    expect(cap.out()).toContain(q.heldId);
    expect(await f.owner.getOrgEmail(f.orgId, q.heldId)).toMatchObject({ disposition: 'sent' });
    // Durable trust: the same recipient now goes straight out.
    const again = await f.agent.sendEmail({
      to: ['stranger@nowhere.example'],
      subject: 'second',
      text: 'b',
    });
    expect(again.email.disposition).toBe('sent');

    const once = capture();
    expect(
      await runCli(asOwner('approvals', 'approve', q.quarantinedId, '--no-trust'), env, once.io),
    ).toBe(0);
    expect(await f.owner.getOrgEmail(f.orgId, q.quarantinedId)).toMatchObject({
      disposition: 'delivered',
    });
    const contacts = await f.owner.listEmailContacts(f.orgId, { q: 'dana@partner.example.com' });
    expect(contacts.items[0]?.trust ?? null).toBeNull(); // nothing was trusted
  });

  it('deny drops the email; --block blocks the contact for the org', async () => {
    const f = await fixture();
    const q = await queue(f);
    const cap = capture();
    expect(await runCli(asOwner('approvals', 'deny', q.quarantinedId, '--block'), env, cap.io)).toBe(0);
    expect(await f.owner.getOrgEmail(f.orgId, q.quarantinedId)).toMatchObject({
      disposition: 'rejected',
      reason: 'denied',
    });
    const contacts = await f.owner.listEmailContacts(f.orgId, { q: 'dana@partner.example.com' });
    expect(contacts.items[0]?.trust).toBe('blocked');
  });

  it('`sparrow requests` stays the enrollment-only alias (unchanged)', async () => {
    const f = await fixture();
    const q = await queue(f);
    const cap = capture();
    expect(await runCli(asOwner('requests'), env, cap.io)).toBe(0);
    expect(cap.out()).toContain(q.enrollmentId);
    expect(cap.out()).not.toContain(q.heldId);
  });
});

/* ================================================================== *
 * The medium-spanning surfaces, against REAL inbound email
 * ================================================================== */

describe('sparrow pop / inbox / loop / activity with a real email', () => {
  it('pop renders the email register and records lastEmail; --ack is accepted-and-ignored', async () => {
    const f = await fixture();
    const del = await inbound(f, { subject: 'Q3 rollout', text: 'the body' });

    const cap = capture();
    // `--ack` has no room and no member to scope a `working` status to: accepted,
    // ignored, and NOT an error (SPEC → CLI, "Typed work items").
    expect(await runCli(asBot('pop', '--ack', '--note', 'on it'), env, cap.io)).toBe(0);
    const body = cap.out();
    expect(body.split('\n')[0]).toContain(`[email: ${del.threadId}`);
    expect(body).toContain('from: owner@x.com (Owner)');
    expect(body).toContain(`to:   ${f.address}`);
    expect(body).toContain('subj: Q3 rollout');
    expect(body).toContain('the body');

    // lastEmail is now set — `email reply --last` answers the popped thread.
    const reply = capture();
    expect(await runCli(asBot('email', 'reply', 'popped and answered', '--last'), env, reply.io)).toBe(0);
    const thread = await f.agent.getEmailThread(del.threadId);
    expect(thread.items.map((e) => e.text)).toContain('popped and answered');
  });

  it('pop -j is the `{ item }` envelope with type "email"', async () => {
    const f = await fixture();
    const del = await inbound(f);
    const cap = capture();
    expect(await runCli(asBot('pop', '--json'), env, cap.io)).toBe(0);
    const res = JSON.parse(cap.out());
    expect(res.item.type).toBe('email');
    expect(res.item.email.id).toBe(del.emailId);
    expect(res.item.thread.id).toBe(del.threadId);
  });

  it('inbox leads the row with the medium and names the thread', async () => {
    const f = await fixture();
    const del = await inbound(f, { subject: 'Q3 rollout' });
    const cap = capture();
    expect(await runCli(asBot('inbox'), env, cap.io)).toBe(0);
    expect(cap.out()).toContain('MEDIUM');
    expect(cap.out()).toContain('email');
    expect(cap.out()).toContain(del.threadId);
    expect(cap.out()).toContain('Q3 rollout');

    const narrowed = capture();
    expect(await runCli(asBot('inbox', '--medium', 'email', '--json'), env, narrowed.io)).toBe(0);
    expect(JSON.parse(narrowed.out()).items).toHaveLength(1);
  });

  it('loop drains an email work item as one JSON line', async () => {
    const f = await fixture();
    const del = await inbound(f);
    const cap = capture();
    const loop = runCli(asBot('loop', '--stale-seconds', '0', '--max-stream-age', '0'), env, cap.io);
    const deadline = Date.now() + 5000;
    while (!cap.out().includes(del.emailId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    process.emit('SIGINT');
    await loop;
    const line = cap
      .out()
      .split('\n')
      .find((l) => l.includes(del.emailId))!;
    expect(JSON.parse(line)).toMatchObject({ type: 'email', email: { id: del.emailId } });
  });

  it('activity interleaves the email entry with its typed ref', async () => {
    const f = await fixture();
    const del = await inbound(f);
    const cap = capture();
    expect(await runCli(asBot('activity'), env, cap.io)).toBe(0);
    expect(cap.out()).toContain('[email]');
    expect(cap.out()).toContain(del.emailId);
  });
});

/* ================================================================== *
 * An instance with the email medium OFF
 * ================================================================== */

describe('an email-disabled instance', () => {
  const MSG = 'email is not enabled on this server';

  it('every `sparrow email` command exits 1 with the one honest sentence', async () => {
    const f = await fixture('fable', false);
    for (const argv of [
      ['email', 'address'],
      ['email', 'threads'],
      ['email', 'read', 'eth_nope'],
      ['email', 'read', 'eml_nope'],
      ['email', 'reply', 'hi', '--to', 'eml_nope'],
      ['email', 'send', '--to', 'a@b.com', '--subject', 's', 'body'],
      ['email', 'attachment', 'get', 'att_nope'],
    ]) {
      const cap = capture();
      expect(await runCli(asBot(...argv), env, cap.io), argv.join(' ')).toBe(1);
      expect(cap.err(), argv.join(' ')).toContain(MSG);
    }
    void f;
  });

  it('`approvals` still lists ENROLLMENTS; only its email half degrades', async () => {
    const f = await fixture('fable', false);
    const inv = await f.owner.createInvite(f.orgId);
    const anon = new SparrowClient({ server: url });
    const enr = await anon.enrollAgent(inv.url.split('/invite/')[1]!, { name: 'newbie' });
    if (enr.status !== 'pending') throw new Error('expected a pending enrollment');

    const cap = capture();
    // The enrollment half is answerable and IS answered; the email half is not,
    // so the exit code is 1 (SPEC → CLI, the email-disabled rule).
    expect(await runCli(asOwner('approvals'), env, cap.io)).toBe(1);
    expect(cap.out()).toContain(enr.enrollment.id);
    expect(cap.out()).toContain('newbie');
    expect(cap.err()).toContain(MSG);

    const json = capture();
    expect(await runCli(asOwner('approvals', '--json'), env, json.io)).toBe(1);
    const res = JSON.parse(json.out());
    expect(res.enrollments).toHaveLength(1);
    expect(res.email).toBeNull();
  });

  it('`approvals approve` / `deny` are pure email and refuse outright', async () => {
    await fixture('fable', false);
    for (const argv of [
      ['approvals', 'approve', 'eml_nope'],
      ['approvals', 'deny', 'eml_nope'],
    ]) {
      const cap = capture();
      expect(await runCli(asOwner(...argv), env, cap.io)).toBe(1);
      expect(cap.err()).toContain(MSG);
    }
  });

  it('`sparrow requests` is untouched by the medium being off', async () => {
    const f = await fixture('fable', false);
    const inv = await f.owner.createInvite(f.orgId);
    const anon = new SparrowClient({ server: url });
    const enr = await anon.enrollAgent(inv.url.split('/invite/')[1]!, { name: 'newbie' });
    if (enr.status !== 'pending') throw new Error('expected a pending enrollment');
    const cap = capture();
    expect(await runCli(asOwner('requests'), env, cap.io)).toBe(0);
    expect(cap.out()).toContain(enr.enrollment.id);
  });
});
