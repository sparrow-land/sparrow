/**
 * The WIRE `Message-ID` correction seam (SPEC v4 "The email medium → Threading →
 * The wire Message-ID", "Routes → The inbound seam").
 *
 * Some relays cannot stamp the `Message-ID` we hand them and cannot report the
 * one they DID stamp at send time either — it only becomes knowable later, when
 * the provider's activity webhook names it. `POST /email/wire-message-id` is how
 * the relay pushes it back, minutes or hours after the send. Same bearer as the
 * inbound seam (the instance's `EMAIL_INBOUND_TOKEN`), same acceptance rules as
 * the send-time correction, and idempotent: a webhook that fires twice is
 * ordinary.
 */
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
  TEST_INBOUND_TOKEN,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { openDb } from './db/index.js';

describe('POST /email/wire-message-id', () => {
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

  /** The relay pushing back the id the provider actually put on the wire. */
  async function correct(body: Record<string, unknown>, token = TEST_INBOUND_TOKEN) {
    return ts.app.inject({
      method: 'POST',
      url: '/api/v1/email/wire-message-id',
      headers: auth(token),
      payload: body,
    });
  }

  /** Send one outbound email as `fable`; returns the `201` body. */
  async function send(payload: Record<string, unknown>) {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload,
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  /** Read one of the agent's own emails back (peek — never marks read). */
  async function readEmail(emailId: string) {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${emailId}?peek=true`,
      headers: auth(fable.key),
    });
    return res.json().email as any;
  }

  async function threads(): Promise<any[]> {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/threads',
      headers: auth(fable.key),
    });
    return res.json().items as any[];
  }

  async function threadEmails(threadId: string): Promise<any[]> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/threads/${threadId}`,
      headers: auth(fable.key),
    });
    return res.json().items as any[];
  }

  beforeEach(async () => {
    ts = await makeEmailServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    slug = org.json().org.slug as string;
    fable = await makeAgent(ts.app, owner.token, orgId, 'fable');
    // Everyone at partner.example.com is a recognized correspondent.
    await setPolicy({ trustedPatterns: ['*@partner.example.com'] });
  });
  afterEach(async () => {
    await ts.close();
  });

  it('401s without the inbound bearer and on a wrong one', async () => {
    const anonymous = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/email/wire-message-id',
      payload: { emailId: 'eml_nope', rfcMessageId: '<w@relay.example>' },
    });
    expect(anonymous.statusCode).toBe(401);
    const wrong = await correct(
      { emailId: 'eml_nope', rfcMessageId: '<w@relay.example>' },
      'not-the-token',
    );
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('unauthorized');
  });

  it('404s with the medium off, and without EMAIL_INBOUND_TOKEN configured', async () => {
    await ts.close();
    ts = await makeTestServer({});
    const off = await correct({ emailId: 'eml_x', rfcMessageId: '<w@relay.example>' });
    expect(off.statusCode).toBe(404);
    await ts.close();

    ts = await makeTestServer({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const noToken = await correct({ emailId: 'eml_x', rfcMessageId: '<w@relay.example>' });
    expect(noToken.statusCode).toBe(404);
  });

  it('404s for an unknown id and for an INBOUND email — only this instance’s outbound moves', async () => {
    const unknown = await correct({
      emailId: 'eml_neverExisted',
      rfcMessageId: '<w@relay.example>',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not_found');

    const inbound = await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], subject: 'Hello' }),
    );
    expect(inbound.body.status).toBe('delivered');
    const onInbound = await correct({
      emailId: inbound.body.email.id,
      rfcMessageId: '<w@relay.example>',
    });
    expect(onInbound.statusCode).toBe(404);
  });

  it('400s on a malformed rfcMessageId and on a missing emailId', async () => {
    const sent = await send({ to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' });
    expect(sent.statusCode).toBe(201);
    for (const rfcMessageId of ['not-an-id', '<no-at-sign>', '', 42, null]) {
      const res = await correct({ emailId: sent.body.email.id, rfcMessageId });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    const noId = await correct({ rfcMessageId: '<w@relay.example>' });
    expect(noId.statusCode).toBe(400);
  });

  it('corrects once, then answers `corrected: false` — the webhook may fire twice', async () => {
    const sent = await send({ to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' });
    const emailId = sent.body.email.id as string;
    const local = sent.body.email.rfcMessageId as string;
    expect(local).toBe(`<${emailId}@${slug}.example.com>`);

    const first = await correct({ emailId, rfcMessageId: '<0102019a@relay.example>' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ corrected: true });
    expect((await readEmail(emailId)).rfcMessageId).toBe('<0102019a@relay.example>');

    const again = await correct({ emailId, rfcMessageId: '<0102019a@relay.example>' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ corrected: false });
    expect((await readEmail(emailId)).rfcMessageId).toBe('<0102019a@relay.example>');
  });

  it('409s when the id already belongs to another of that agent’s emails — ours stands', async () => {
    const first = await send({ to: ['dana@partner.example.com'], subject: 'One', text: 'a' });
    const second = await send({ to: ['dana@partner.example.com'], subject: 'Two', text: 'b' });
    const taken = '<0102019a@relay.example>';
    expect((await correct({ emailId: first.body.email.id, rfcMessageId: taken })).statusCode).toBe(
      200,
    );
    const clash = await correct({ emailId: second.body.email.id, rfcMessageId: taken });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('conflict');
    expect((await readEmail(second.body.email.id)).rfcMessageId).toBe(
      second.body.email.rfcMessageId,
    );
  });

  it('only an ACCEPTED send moves: a HELD email keeps its local id', async () => {
    await setPolicy({ trustedPatterns: [], outboundUnrecognized: 'approve' });
    const held = await send({ to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' });
    expect(held.statusCode).toBe(202);
    expect(held.body.email.disposition).toBe('held');
    const res = await correct({
      emailId: held.body.email.id,
      rfcMessageId: '<0102019a@relay.example>',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ corrected: false });
    expect((await readEmail(held.body.email.id)).rfcMessageId).toBe(held.body.email.rfcMessageId);
  });

  it('the FIRST id becomes the row’s own; a second is kept as an alias and leaves it alone', async () => {
    const sent = await send({ to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' });
    const emailId = sent.body.email.id as string;
    const first = await correct({ emailId, rfcMessageId: '<per-recipient-a@relay.example>' });
    expect(first.json()).toEqual({ corrected: true });
    expect((await readEmail(emailId)).rfcMessageId).toBe('<per-recipient-a@relay.example>');

    // A provider that stamps a DIFFERENT Message-ID per recipient reports again.
    // Additive: the id is recorded, but the header id the agent's own replies
    // will cite does not move once it names something the world has seen.
    const second = await correct({ emailId, rfcMessageId: '<per-recipient-b@relay.example>' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ corrected: true });
    expect((await readEmail(emailId)).rfcMessageId).toBe('<per-recipient-a@relay.example>');
  });

  it('two recipients, two wire ids: EITHER reply threads by Message-ID, not by subject', async () => {
    const sent = await send({
      to: ['dana@partner.example.com', 'erin@partner.example.com'],
      subject: 'Ledger sync',
      text: 'body',
    });
    expect(sent.statusCode).toBe(201);
    const threadId = sent.body.thread.id as string;
    // One callback per recipient, in whatever order they arrive.
    for (const rfcMessageId of ['<to-dana@relay.example>', '<to-erin@relay.example>']) {
      const res = await correct({ emailId: sent.body.email.id, rfcMessageId });
      expect(res.json()).toEqual({ corrected: true });
    }

    // Subjects that the fallback could never match — these joins are the ids.
    const fromDana = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'dana@partner.example.com', name: 'Dana' },
        subject: 'unrelated one',
        inReplyTo: '<to-dana@relay.example>',
      }),
    );
    const fromErin = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'erin@partner.example.com', name: 'Erin' },
        subject: 'unrelated two',
        inReplyTo: '<to-erin@relay.example>',
      }),
    );
    expect(fromDana.body.email.threadId).toBe(threadId);
    expect(fromErin.body.email.threadId).toBe(threadId);
    expect(await threads()).toHaveLength(1);
    expect(await threadEmails(threadId)).toHaveLength(3);
  });

  it('409s when the id is already an ALIAS of another email', async () => {
    const first = await send({ to: ['dana@partner.example.com'], subject: 'One', text: 'a' });
    const second = await send({ to: ['dana@partner.example.com'], subject: 'Two', text: 'b' });
    // Two ids on `first`: the second is an alias only.
    for (const rfcMessageId of ['<alias-one@relay.example>', '<alias-two@relay.example>']) {
      expect(
        (await correct({ emailId: first.body.email.id, rfcMessageId })).statusCode,
      ).toBe(200);
    }
    const clash = await correct({
      emailId: second.body.email.id,
      rfcMessageId: '<alias-two@relay.example>',
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('conflict');
  });

  it('the corrected id threads the reply that names it — even with an unrelated subject', async () => {
    const sent = await send({
      to: ['dana@partner.example.com'],
      subject: 'Ledger sync',
      text: 'body',
    });
    const threadId = sent.body.thread.id as string;
    const wire = '<0102019a7e33@relay.example>';
    expect((await correct({ emailId: sent.body.email.id, rfcMessageId: wire })).statusCode).toBe(
      200,
    );

    // A subject the fallback could never match — this join is the corrected id.
    const reply = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        subject: 'something else entirely',
        inReplyTo: wire,
      }),
    );
    expect(reply.body.email.threadId).toBe(threadId);
    expect(await threads()).toHaveLength(1);
    expect(await threadEmails(threadId)).toHaveLength(2);
  });

  it('a correction arriving AFTER the fallback already joined the reply re-threads nothing', async () => {
    const sent = await send({
      to: ['dana@partner.example.com'],
      subject: 'Ledger sync',
      text: 'body',
    });
    const threadId = sent.body.thread.id as string;
    const wire = '<0102019a7e33@relay.example>';

    // The reply arrives first, naming an id we do not know yet: the subject +
    // correspondent fallback lands it on the right thread anyway.
    const reply = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        subject: 'Re: Ledger sync',
        inReplyTo: wire,
      }),
    );
    expect(reply.body.email.threadId).toBe(threadId);

    // The webhook catches up. The row moves; the conversation does not.
    const late = await correct({ emailId: sent.body.email.id, rfcMessageId: wire });
    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ corrected: true });
    expect((await readEmail(sent.body.email.id)).rfcMessageId).toBe(wire);
    expect(await threads()).toHaveLength(1);
    expect(await threadEmails(threadId)).toHaveLength(2);
    const stillThere = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${reply.body.email.id}?peek=true`,
      headers: auth(fable.key),
    });
    expect(stillThere.json().email.threadId).toBe(threadId);
  });

  it('is independent of delivery/bounce events — a later disposition change keeps the corrected id', async () => {
    const sent = await send({
      to: ['dana@partner.example.com'],
      subject: 'Ledger sync',
      text: 'body',
    });
    const emailId = sent.body.email.id as string;
    const wire = '<0102019a7e33@relay.example>';
    expect((await correct({ emailId, rfcMessageId: wire })).statusCode).toBe(200);

    // A bounce lands later and resolves the row differently. The wire id — the
    // thing every reply in the world names — must survive it.
    const handle = openDb(ts.dataDir);
    handle.sqlite
      .prepare("UPDATE emails SET disposition = 'send-failed', reason = 'relay-error' WHERE id = ?")
      .run(emailId);
    handle.close();
    expect((await readEmail(emailId)).rfcMessageId).toBe(wire);
    expect((await readEmail(emailId)).disposition).toBe('send-failed');
    // …and the id still threads: an alias is a fact about what went out, not a
    // fact about how the send ended.
    const reply = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        subject: 'unrelated entirely',
        inReplyTo: wire,
      }),
    );
    expect(reply.body.email.threadId).toBe(sent.body.thread.id);
  });
});
