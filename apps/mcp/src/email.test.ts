/**
 * The MCP server's EMAIL surfaces (SPEC v4 "MCP server (`apps/mcp`)" →
 * "Email tools" / "Approval tools", and "The email medium → Routes").
 *
 * Driven exactly like `server.test.ts`: a real in-process API (here with the
 * medium ON — `.example.com` suffix, the `fake` provider, the inbound bearer)
 * plus the MCP server spoken to over an in-memory transport.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '@sparrow/api';
import { SparrowClient } from '@sparrow/client';
import { EMAIL_REGISTER_NOTE } from '@sparrow/common-types';
import { createMcpServer, EMAIL_TOOL_NAMES, type McpServerDeps } from './server.js';

/* ---------------------------- test harness -------------------------------- */

interface Closer {
  close: () => Promise<void>;
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const ADMIN_TOKEN = 'test-admin-token';
let emailSeq = 0;
const addr = (name = 'user') => `${name}-${Date.now()}-${emailSeq++}@example.com`;

interface Api {
  url: string;
  app: FastifyInstance;
}

/** A listening in-process API; `email` toggles the medium's config. */
async function startApi(opts: { email: boolean }): Promise<Api> {
  const dataDir = tmpDir('sparrow-mcp-email-data-');
  const app = buildServer({
    dataDir,
    baseUrl: 'http://localhost:8722',
    adminToken: ADMIN_TOKEN,
    ...(opts.email
      ? {
          emailOrgSuffix: '.example.com',
          emailProvider: 'fake',
          emailInboundToken: 'test-inbound-token',
        }
      : {}),
  });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  const a = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${a.port}`, app };
}

interface Scene {
  api: Api;
  owner: SparrowClient;
  ownerEmail: string;
  orgId: string;
  slug: string;
  fable: { id: string; key: string };
  /** `<name>@<org-slug>.example.com`. */
  at: (name: string) => string;
}

async function scene(opts: { email?: boolean } = {}): Promise<Scene> {
  const api = await startApi({ email: opts.email ?? true });
  const owner = new SparrowClient({ server: api.url });
  const ownerEmail = addr('owner');
  await owner.signup({ email: ownerEmail, password: 'password123', displayName: 'Owner' });
  const orgId = (await owner.meOrgs())[0]!.org.id;
  const org = await owner.getOrg(orgId);
  const agent = await owner.createAgent({ orgId, name: 'fable' });
  return {
    api,
    owner,
    ownerEmail,
    orgId,
    slug: org.slug,
    fable: { id: agent.agent.id, key: agent.key },
    at: (name: string) => `${name}@${org.slug}.example.com`,
  };
}

/** Loosen the org's email policy so unrecognized mail waits instead of bouncing. */
async function openPolicy(s: Scene): Promise<void> {
  const org = await s.owner.getOrg(s.orgId);
  await s.owner.updateOrg(s.orgId, {
    settings: {
      ...org.settings,
      email: { ...org.settings.email, inboundUnrecognized: 'approve', outboundUnrecognized: 'approve' },
    },
  });
}

function inbound(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rfcMessageId: `<${Math.random().toString(36).slice(2)}@mail.example.net>`,
    from: { email: 'dana@partner.example.com', name: 'Dana Lee' },
    to: [{ email: 'fable@acme.example.com', name: 'fable' }],
    subject: 'Q3 rollout',
    text: 'the body',
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'partner.example.com' },
    ...overrides,
  };
}

async function connectMcp(deps: McpServerDeps): Promise<Client & Closer> {
  const server = createMcpServer(deps);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const closer = client as Client & Closer;
  const origClose = closer.close.bind(closer);
  closer.close = async () => {
    await origClose();
    await server.close();
  };
  cleanups.push(() => closer.close());
  return closer;
}

interface ParsedResult {
  isError: boolean;
  data: any;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ParsedResult> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = res.content[0];
  const text = first && first.type === 'text' ? first.text : '';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(res.isError), data };
}

/* ---------------------------- descriptions -------------------------------- */

describe('email tool descriptions', () => {
  it('every email tool OPENS with the canonical register paragraph', async () => {
    const api = await startApi({ email: false });
    const client = await connectMcp({ server: api.url });
    const { tools } = await client.listTools();
    expect(EMAIL_TOOL_NAMES.length).toBe(9);
    for (const name of EMAIL_TOOL_NAMES) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is registered unconditionally`).toBeDefined();
      expect(tool!.description ?? '', `${name} opens with the register`).toContain(
        EMAIL_REGISTER_NOTE,
      );
      expect(
        (tool!.description ?? '').startsWith(EMAIL_REGISTER_NOTE),
        `${name} register comes FIRST`,
      ).toBe(true);
      // The register is the constant, never a retyped copy.
      expect((tool!.description ?? '').length).toBeGreaterThan(EMAIL_REGISTER_NOTE.length + 40);
    }
  });

  it('carries the per-tool wording from the spec', async () => {
    const api = await startApi({ email: false });
    const client = await connectMcp({ server: api.url });
    const { tools } = await client.listTools();
    const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? '';
    expect(desc('get_email_address')).toContain('renaming yourself CHANGES your address');
    expect(desc('list_email_threads')).toContain('This is a triage list, not the mail');
    expect(desc('read_email')).toContain('Read the WHOLE thread before replying');
    expect(desc('reply_email')).toContain('The subject and the recipient set come from the thread');
    expect(desc('send_email')).toContain('that is not a failure and must not be retried');
    expect(desc('list_email_approvals')).toContain('Human credentials only.');
    expect(desc('approve_email')).toContain('Approving is DURABLE');
    expect(desc('deny_email')).toContain('denying can block that contact permanently');
  });
});

/* ---------------------------- address ------------------------------------- */

describe('get_email_address', () => {
  it('returns the derived address and reports the medium enabled', async () => {
    const s = await scene();
    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });
    const res = await call(agent, 'get_email_address');
    expect(res.isError).toBe(false);
    expect(res.data.address).toBe(s.at('fable'));
    expect(res.data.enabled).toBe(true);
    expect(res.data.agentId).toBe(s.fable.id);
  });
});

/* ---------------------------- threads & reads ----------------------------- */

describe('list_email_threads / read_email', () => {
  it('lists a delivered thread, reads it as a transcript, and reads one email', async () => {
    const s = await scene();
    const delivered = await s.api.app.emailFake!.deliver(
      inbound({ from: { email: s.ownerEmail, name: 'Owner' }, to: [{ email: s.at('fable') }] }),
    );
    expect(delivered.status).toBe('delivered');
    const { emailId, threadId } = delivered.deliveries[0]!;

    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });

    const threads = await call(agent, 'list_email_threads');
    expect(threads.isError).toBe(false);
    expect(threads.data.items).toHaveLength(1);
    expect(threads.data.items[0].id).toBe(threadId);
    expect(threads.data.items[0].subject).toBe('Q3 rollout');
    // The transcript envelope reaches the agent INTACT. `nextBefore` is a real
    // key holding `null`, never an absent one: an `undefined` disappears in JSON
    // and leaves the caller with no way to tell "no more" from "cannot page".
    expect('nextBefore' in threads.data).toBe(true);
    expect(threads.data.nextBefore).toBeNull();
    // Full EmailThread rows — the triage fields ride along, no request per row.
    expect(threads.data.items[0].unreadCount).toBe(1);
    expect(threads.data.items[0].lastDisposition).toBe('delivered');
    expect(Array.isArray(threads.data.items[0].participants)).toBe(true);

    // `eth_…` → the whole thread as a transcript.
    const thread = await call(agent, 'read_email', { id: threadId });
    expect(thread.isError).toBe(false);
    expect(thread.data.thread.id).toBe(threadId);
    expect(thread.data.emails).toHaveLength(1);
    expect(thread.data.emails[0].id).toBe(emailId);

    // `eml_…` → one email in full, with the edge's verdicts.
    const one = await call(agent, 'read_email', { id: emailId });
    expect(one.isError).toBe(false);
    expect(one.data.email.id).toBe(emailId);
    expect(one.data.email.text).toBe('the body');
    expect(one.data.email.verification.dmarc).toBe('pass');
  });

  it('lists threads NEWEST-first and pages backward with before/nextBefore', async () => {
    const s = await scene();
    const ids: string[] = [];
    for (const subject of ['first', 'second', 'third']) {
      const d = await s.api.app.emailFake!.deliver(
        inbound({ from: { email: s.ownerEmail, name: 'Owner' }, to: [{ email: s.at('fable') }], subject }),
      );
      expect(d.status).toBe('delivered');
      ids.push(d.deliveries[0]!.threadId);
    }
    const [firstId, secondId, thirdId] = ids as [string, string, string];

    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });

    // A triage list reads backward from now: the newest thread is row one.
    const all = await call(agent, 'list_email_threads');
    expect(all.isError).toBe(false);
    expect(all.data.items.map((t: any) => t.subject)).toEqual(['third', 'second', 'first']);
    expect(all.data.nextBefore).toBeNull();

    // A capped page names the OLDEST id it returned as `nextBefore` …
    const page1 = await call(agent, 'list_email_threads', { limit: 2 });
    expect(page1.data.items.map((t: any) => t.id)).toEqual([thirdId, secondId]);
    expect(page1.data.nextBefore).toBe(secondId);

    // … and feeding it back returns only threads strictly older.
    const page2 = await call(agent, 'list_email_threads', { before: page1.data.nextBefore });
    expect(page2.data.items.map((t: any) => t.id)).toEqual([firstId]);
    expect(page2.data.nextBefore).toBeNull();
  });

  it('rejects an id that is neither a thread nor an email', async () => {
    const s = await scene();
    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });
    const res = await call(agent, 'read_email', { id: 'msg_abcdefghijkl' });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('bad_request');
  });
});

/* ---------------------------- reply & send -------------------------------- */

describe('reply_email / send_email', () => {
  it('replies inside a thread and relays it', async () => {
    const s = await scene();
    const delivered = await s.api.app.emailFake!.deliver(
      inbound({ from: { email: s.ownerEmail, name: 'Owner' }, to: [{ email: s.at('fable') }] }),
    );
    const { threadId } = delivered.deliveries[0]!;
    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });
    const res = await call(agent, 'reply_email', {
      threadId,
      text: 'Hello Owner,\n\nHere is the whole answer.\n\n— fable, acme',
    });
    expect(res.isError).toBe(false);
    expect(res.data.email.disposition).toBe('sent');
    expect(res.data.email.direction).toBe('out');
    expect(s.api.app.emailFake!.sent).toHaveLength(1);
  });

  it('sends to a recognized recipient: disposition sent', async () => {
    const s = await scene();
    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });
    const res = await call(agent, 'send_email', {
      to: [s.ownerEmail],
      subject: 'Deploy window',
      text: 'Hello Owner,\n\nThe deploy window is Thursday.\n\n— fable, acme',
    });
    expect(res.isError).toBe(false);
    expect(res.data.email.disposition).toBe('sent');
    expect(res.data.held).toBe(false);
    expect(res.data.thread.id).toMatch(/^eth_/);
  });

  it('a HELD send is reported loudly as not-a-failure and not-to-be-retried', async () => {
    const s = await scene();
    await openPolicy(s);
    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });
    const res = await call(agent, 'send_email', {
      to: ['stranger@partner.example.com'],
      subject: 'Introducing myself',
      text: 'Hello,\n\nI am fable, an agent working for Owner at acme.\n\n— fable, acme',
    });
    expect(res.isError).toBe(false);
    expect(res.data.email.disposition).toBe('held');
    expect(res.data.held).toBe(true);
    expect(res.data.message).toMatch(/not a failure/i);
    expect(res.data.message).toMatch(/do not retry|must not be retried/i);
    expect(res.data.message).toMatch(/email\.resolved/);
    // Nothing left the building.
    expect(s.api.app.emailFake!.sent).toHaveLength(0);
  });
});

/* ---------------------------- attachments --------------------------------- */

describe('get_email_attachment', () => {
  it('inlines textual bytes and saves them when savePath is given', async () => {
    const s = await scene();
    const delivered = await s.api.app.emailFake!.deliver(
      inbound({
        from: { email: s.ownerEmail, name: 'Owner' },
        to: [{ email: s.at('fable') }],
        attachments: [
          {
            filename: 'notes.txt',
            contentType: 'text/plain',
            dataBase64: Buffer.from('rollout notes').toString('base64'),
          },
        ],
      }),
    );
    const { emailId } = delivered.deliveries[0]!;
    const cwd = tmpDir('sparrow-mcp-email-cwd-');
    const agent = await connectMcp({ server: s.api.url, token: s.fable.key, cwd });

    const one = await call(agent, 'read_email', { id: emailId });
    const attachmentId = one.data.email.attachments[0].id as string;
    expect(attachmentId).toMatch(/^att_/);

    const inline = await call(agent, 'get_email_attachment', { attachmentId });
    expect(inline.isError).toBe(false);
    expect(inline.data.content).toBe('rollout notes');
    expect(inline.data.filename).toBe('notes.txt');

    const saved = await call(agent, 'get_email_attachment', {
      attachmentId,
      savePath: 'copy.txt',
    });
    expect(saved.isError).toBe(false);
    expect(saved.data.savedTo).toBe(path.join(cwd, 'copy.txt'));
    expect(fs.readFileSync(path.join(cwd, 'copy.txt'), 'utf8')).toBe('rollout notes');
  });
});

/* ---------------------------- approvals ----------------------------------- */

describe('the approval tools (a human session)', () => {
  it('lists the queue, approves one, and denies another', async () => {
    const s = await scene();
    await openPolicy(s);
    const one = await s.api.app.emailFake!.deliver(
      inbound({ from: { email: 'dana@partner.example.com' }, to: [{ email: s.at('fable') }] }),
    );
    const two = await s.api.app.emailFake!.deliver(
      inbound({ from: { email: 'spam@nowhere.example.com' }, to: [{ email: s.at('fable') }] }),
    );
    expect(one.status).toBe('quarantined');
    expect(two.status).toBe('quarantined');

    const human = await connectMcp({
      server: s.api.url,
      token: s.owner.token,
      orgId: s.orgId,
    });

    const queue = await call(human, 'list_email_approvals');
    expect(queue.isError).toBe(false);
    expect(queue.data.items).toHaveLength(2);
    expect(queue.data.items[0].email.id).toBe(one.deliveries[0]!.emailId);
    expect(queue.data.items[0].agent.name).toBe('fable');

    const approved = await call(human, 'approve_email', {
      emailId: one.deliveries[0]!.emailId,
    });
    expect(approved.isError).toBe(false);
    expect(approved.data.email.disposition).toBe('delivered');

    const denied = await call(human, 'deny_email', {
      emailId: two.deliveries[0]!.emailId,
      blockSender: true,
    });
    expect(denied.isError).toBe(false);
    expect(denied.data.email.disposition).toBe('rejected');
    expect(denied.data.email.reason).toBe('denied');

    const rest = await call(human, 'list_email_approvals');
    expect(rest.data.items).toHaveLength(0);
  });

  it('refuses an agent key: an agent never approves the mail addressed to it', async () => {
    const s = await scene();
    const agent = await connectMcp({
      server: s.api.url,
      token: s.fable.key,
      orgId: s.orgId,
    });
    for (const name of ['list_email_approvals', 'approve_email', 'deny_email']) {
      const res = await call(agent, name, { emailId: 'eml_abcdefghijkl' });
      expect(res.isError, name).toBe(true);
      expect(res.data.error.code, name).toBe('forbidden');
      expect(res.data.error.message, name).toMatch(/never approves/i);
    }
  });

  it('needs an org: no orgId argument and no SPARROW_ORG is a clear bad_request', async () => {
    const s = await scene();
    const human = await connectMcp({ server: s.api.url, token: s.owner.token });
    const res = await call(human, 'list_email_approvals');
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('bad_request');
    expect(res.data.error.message).toMatch(/SPARROW_ORG/);
  });
});

/* ---------------------------- medium off ---------------------------------- */

describe('an instance without the email medium', () => {
  it('reports "email is not enabled on this server" instead of a bare 404', async () => {
    const s = await scene({ email: false });
    const agent = await connectMcp({
      server: s.api.url,
      token: s.fable.key,
      orgId: s.orgId,
    });
    for (const [name, args] of [
      ['get_email_address', {}],
      ['list_email_threads', {}],
      ['read_email', { id: 'eth_abcdefghijkl' }],
      ['reply_email', { threadId: 'eth_abcdefghijkl', text: 'hi' }],
      ['send_email', { to: ['x@example.com'], subject: 's', text: 't' }],
      ['get_email_attachment', { attachmentId: 'att_abcdefghijkl' }],
    ] as const) {
      const res = await call(agent, name, args as Record<string, unknown>);
      expect(res.isError, name).toBe(true);
      expect(res.data.error.message, name).toBe('email is not enabled on this server');
    }
  });

  it('says the same on the human approval surface', async () => {
    const s = await scene({ email: false });
    const human = await connectMcp({ server: s.api.url, token: s.owner.token, orgId: s.orgId });
    const res = await call(human, 'list_email_approvals');
    expect(res.isError).toBe(true);
    expect(res.data.error.message).toBe('email is not enabled on this server');
  });

  it('a genuine 404 still reads as not_found when the medium is ON', async () => {
    const s = await scene();
    const agent = await connectMcp({ server: s.api.url, token: s.fable.key });
    const res = await call(agent, 'read_email', { id: 'eth_abcdefghijkl' });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('not_found');
  });
});
