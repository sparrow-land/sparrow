/**
 * The outbound pipeline (SPEC v4 "The email medium → The trust engine →
 * Outbound pipeline", "Threading → Outbound header generation", "Providers").
 *
 * The row (with its `Message-ID`) is written BEFORE the relay call, so a crash
 * mid-relay leaves an auditable `send-failed`, never a silent gap — and a
 * `reject` policy still persists the refusal for the audit trail while answering
 * `403`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeEmailServer,
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  makeAgent,
  deliverEmail,
  inboundPayload,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

describe('the outbound pipeline', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;
  let slug: string;
  let fable: { id: string; key: string };

  const at = (name: string): string => `${name}@${slug}.example.com`;

  async function setPolicy(policy: Record<string, unknown>): Promise<void> {
    const res = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { email: policy } },
    });
    if (res.statusCode !== 200) throw new Error(`policy failed: ${res.body}`);
  }

  async function boot(): Promise<void> {
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    slug = org.json().org.slug as string;
    fable = await makeAgent(ts.app, owner.token, orgId, 'fable');
  }

  async function send(payload: Record<string, unknown>) {
    return ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload,
    });
  }

  beforeEach(async () => {
    ts = await makeEmailServer();
    await boot();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('sends to a recognized recipient: 201, `sent`, captured by the fake relay', async () => {
    const res = await send({ to: ['owner@example.com'], subject: 'Hello', text: 'the body' });
    expect(res.statusCode).toBe(201);
    const { email, thread } = res.json();
    expect(email.disposition).toBe('sent');
    expect(email.direction).toBe('out');
    expect(email.reason).toBeNull();
    expect(email.status).toBe('read'); // outbound is never "waiting on" the agent
    expect(thread.subject).toBe('Hello');
    expect(thread.lastEmailAt).not.toBeNull();

    const outbox = ts.app.emailFake!.sent;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toEqual(['owner@example.com']);
    // `Message-ID` is `<{emailId}@{agent address domain}>`, minted before relay.
    expect(outbox[0]!.headers.messageId).toBe(`<${email.id}@${slug}.example.com>`);
    expect(email.rfcMessageId).toBe(outbox[0]!.headers.messageId);
    expect(outbox[0]!.raw.text).toBe('the body');
  });

  it('refuses a send to an unrecognized recipient under the default policy, but PERSISTS it', async () => {
    const res = await send({ to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    expect(ts.app.emailFake!.sent).toHaveLength(0);
    // The audit trail: the agent can see what did not go out (body included).
    const approvals = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/approvals`,
      headers: auth(owner.token),
    });
    expect(approvals.json().items).toHaveLength(0); // a rejection is not pending
    const threads = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/threads',
      headers: auth(fable.key),
    });
    // `last_email_at` is bumped only by a sent email, so the thread is invisible.
    expect(threads.json().items).toHaveLength(0);
  });

  it('`approve` policy holds an unrecognized recipient: 202 + a pending approval', async () => {
    await setPolicy({ outboundUnrecognized: 'approve' });
    const res = await send({ to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' });
    expect(res.statusCode).toBe(202);
    expect(res.json().email.disposition).toBe('held');
    expect(res.json().email.reason).toBe('unrecognized-recipient');
    expect(ts.app.emailFake!.sent).toHaveLength(0);
    const approvals = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/approvals?direction=out`,
      headers: auth(owner.token),
    });
    expect(approvals.json().items).toHaveLength(1);
    expect(approvals.json().items[0].email.disposition).toBe('held');
  });

  it('a blocked recipient is 403 and persists NOTHING', async () => {
    await setPolicy({ outboundUnrecognized: 'approve' });
    // Make the contact exist, then block it.
    await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: 'dana@partner.example.com' } }),
    );
    const contacts = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/contacts`,
      headers: auth(owner.token),
    });
    const contactId = contacts.json().items[0].id as string;
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/email/contacts/${contactId}`,
      headers: auth(owner.token),
      payload: { trust: 'blocked' },
    });

    const before = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/approvals`,
      headers: auth(owner.token),
    });
    const res = await send({ to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' });
    expect(res.statusCode).toBe(403);
    const after = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/approvals`,
      headers: auth(owner.token),
    });
    expect(after.json().items).toHaveLength(before.json().items.length);
  });

  it('a reply derives its recipients from the newest inbound email and threads correctly', async () => {
    await setPolicy({ trustedPatterns: ['*@partner.example.com'] });
    const inbound = await deliverEmail(
      ts.app,
      inboundPayload({
        rfcMessageId: '<parent@mail.example.net>',
        to: [{ email: at('fable') }],
        cc: [{ email: 'colleague@partner.example.com' }],
        from: { email: 'dana@partner.example.com', name: 'Dana' },
        subject: 'Q3 rollout',
      }),
    );
    const threadId = inbound.body.email.threadId as string;

    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/email/threads/${threadId}/reply`,
      headers: auth(fable.key),
      payload: { text: 'on it' },
    });
    expect(res.statusCode).toBe(201);
    const email = res.json().email;
    expect(email.threadId).toBe(threadId);
    // `Re: {thread subject}`, at most one `Re: ` prefix.
    expect(email.subject).toBe('Re: Q3 rollout');
    // from + to + cc of the parent, minus the agent's own address.
    const addresses = [...email.to, ...email.cc].map((p: any) => p.email).sort();
    expect(addresses).toEqual(['colleague@partner.example.com', 'dana@partner.example.com']);
    expect(addresses).not.toContain(at('fable'));
    // Threading identity: In-Reply-To is the parent, References carries the chain.
    const captured = ts.app.emailFake!.sent[0]!;
    expect(captured.headers.inReplyTo).toBe('<parent@mail.example.net>');
    expect(captured.headers.references).toContain('<parent@mail.example.net>');

    // A second reply keeps ONE `Re: ` prefix.
    const again = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/email/threads/${threadId}/reply`,
      headers: auth(fable.key),
      payload: { text: 'more' },
    });
    expect(again.json().email.subject).toBe('Re: Q3 rollout');
  });

  it('a reply on a thread with no inbound email is 400', async () => {
    const sent = await send({ to: ['owner@example.com'], subject: 'Hello', text: 'body' });
    const threadId = sent.json().thread.id as string;
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/email/threads/${threadId}/reply`,
      headers: auth(fable.key),
      payload: { text: 'nobody to reply to' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('a relay failure lands `send-failed`, and retry re-relays it (409 otherwise)', async () => {
    // A webhook provider pointed at a server that always refuses.
    const stub = await startStub(500);
    try {
      await ts.close();
      ts = await makeTestServer({
        emailOrgSuffix: '.example.com',
        emailProvider: 'webhook',
        emailWebhookUrl: stub.url,
        emailWebhookToken: 'relay-token',
      });
      await boot();
      const res = await send({ to: ['owner@example.com'], subject: 'Hello', text: 'body' });
      expect(res.statusCode).toBe(202);
      expect(res.json().email.disposition).toBe('send-failed');
      expect(res.json().email.reason).toBe('relay-error');
      const emailId = res.json().email.id as string;

      // The relay's own failure is `send-failed`, never a 5xx.
      stub.status = 202;
      const retry = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/me/email/emails/${emailId}/retry`,
        headers: auth(fable.key),
      });
      expect(retry.statusCode).toBe(202);
      expect(retry.json().email.disposition).toBe('sent');
      // The v4 envelope reached the relay verbatim.
      expect(stub.received.body.to).toEqual(['owner@example.com']);
      expect(stub.received.body.headers.messageId).toBe(`<${emailId}@${slug}.example.com>`);
      expect(stub.received.authorization).toBe('Bearer relay-token');

      const again = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/me/email/emails/${emailId}/retry`,
        headers: auth(fable.key),
      });
      expect(again.statusCode).toBe(409);

      // A relay failure is a `send-failed` RESOLUTION, not a refusal: the
      // timeline carries `email.resolved`, never `email.rejected` (SPEC "Entry
      // types registry").
      const timeline = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/me/activity?medium=email',
        headers: auth(fable.key),
      });
      const types = (timeline.json().items as any[]).map((e) => e.type);
      expect(types).toContain('email.resolved');
      expect(types).not.toContain('email.rejected');
    } finally {
      await stub.close();
    }
  });

  it('drops self-addressing and caps the recipient list', async () => {
    const res = await send({
      to: [at('fable'), 'owner@example.com'],
      subject: 'Hi',
      text: 'body',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().email.to.map((p: any) => p.email)).toEqual(['owner@example.com']);

    const tooMany = await send({
      to: Array.from({ length: 21 }, (_, i) => `p${i}@partner.example.com`),
      subject: 'Hi',
      text: 'body',
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('a human session cannot send from an agent mailbox', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(owner.token),
      payload: { to: ['owner@example.com'], subject: 'Hi', text: 'body' },
    });
    expect(res.statusCode).toBe(403);
  });
});

/** A stub relay whose status code the test can flip mid-flight. */
interface StubServer {
  url: string;
  status: number;
  received: { authorization?: string; body?: any };
  close(): Promise<void>;
}

async function startStub(status: number): Promise<StubServer> {
  const state: StubServer = {
    url: '',
    status,
    received: {},
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      state.received.authorization = req.headers.authorization;
      try {
        state.received.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        state.received.body = undefined;
      }
      res.statusCode = state.status;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/relay`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
