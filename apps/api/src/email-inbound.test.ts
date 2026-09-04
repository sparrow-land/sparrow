/**
 * The inbound seam and its pipeline (SPEC v4 "The email medium → The trust
 * engine → Inbound pipeline", "The inbound payload", "Threading").
 *
 * `202` for every classification, including `rejected`: the seam's contract is
 * "I have taken custody of this message", not "I liked it". A `4xx` means the
 * caller should retry or bounce.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeEmailServer,
  auth,
  signup,
  firstOrgId,
  makeAgent,
  joinOrg,
  shareAgent,
  deliverEmail,
  inboundPayload,
  TEST_INBOUND_TOKEN,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

describe('POST /email/inbound', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;
  let slug: string;
  let fable: { id: string; key: string };

  /** `to` addressed at one of this org's agents. */
  const at = (name: string): string => `${name}@${slug}.example.com`;

  /** Deliver a payload, defaulting `to` at this org's `fable` (the slug is generated). */
  async function send(overrides: Record<string, unknown> = {}) {
    return deliverEmail(ts.app, inboundPayload({ to: [{ email: at('fable') }], ...overrides }));
  }

  /** A sender membership already trusts: the org's own owner, fully verified. */
  const fromOwner = {
    from: { email: 'owner@example.com', name: 'Owner' },
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
  };

  async function setPolicy(policy: Record<string, unknown>): Promise<void> {
    const res = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { email: policy } },
    });
    if (res.statusCode !== 200) throw new Error(`policy failed: ${res.body}`);
  }

  async function threads(): Promise<any[]> {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/threads',
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
  });
  afterEach(async () => {
    await ts.close();
  });

  it('delivers mail from an org human (membership IS the grant) and opens a thread', async () => {
    const res = await send(
      ({
        from: { email: 'OWNER@example.com', name: 'Owner' },
        to: [{ email: at('fable') }],
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
      }),
    );
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('delivered');
    expect(res.body.reason).toBeNull();
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.email.id).toMatch(/^eml_/);
    expect(res.body.email.threadId).toMatch(/^eth_/);

    const list = await threads();
    expect(list).toHaveLength(1);
    expect(list[0].subject).toBe('Q3 rollout');
    expect(list[0].lastEmailAt).not.toBeNull();
    // The From resolved to a principal, so no contact row is minted for it.
    const contacts = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/contacts`,
      headers: auth(owner.token),
    });
    expect(contacts.json().items).toHaveLength(0);
  });

  it('the thread list is a transcript of FULL threads: newest-first, `before`/`nextBefore`', async () => {
    const older = await send({ ...fromOwner, subject: 'older', rfcMessageId: '<a@mail.example.net>' });
    await send({ ...fromOwner, subject: 'newer', rfcMessageId: '<b@mail.example.net>' });

    const list = await threads();
    expect(list.map((t) => t.subject)).toEqual(['newer', 'older']);
    // A row carries everything a triage list renders — no second request.
    expect(list[0]).toMatchObject({ emailCount: 1, unreadCount: 1, lastDisposition: 'delivered' });
    expect(list[0].participants.length).toBeGreaterThan(0);

    const page = async (qs: string) =>
      ts.app.inject({ method: 'GET', url: `/api/v1/me/email/threads${qs}`, headers: auth(fable.key) });
    const head = (await page('?limit=1')).json();
    expect(head.items[0].subject).toBe('newer');
    expect(head.nextBefore).toBe(head.items[0].id);
    const next = (await page(`?limit=1&before=${head.nextBefore}`)).json();
    expect(next.items[0].subject).toBe('older');
    expect(next.items[0].id).toBe(older.body.email.threadId);
    expect(next.nextBefore).toBeNull();

    // An unknown `before` — or another agent's thread id — is a bad_request, never
    // a silent first page.
    const bad = await page('?before=eth_nope');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('bad_request');
  });

  it('the visibility list carries `emailUnreadCount` — for the OWNER only', async () => {
    const list = async (token: string) =>
      (
        await ts.app.inject({
          method: 'GET',
          url: `/api/v1/orgs/${orgId}/me/agents`,
          headers: auth(token),
        })
      ).json().items as any[];

    // No mail yet: a count, not a null — the medium is on and this is my agent.
    expect((await list(owner.token)).find((e) => e.agent.id === fable.id).emailUnreadCount).toBe(0);

    const res = await send({ ...fromOwner, subject: 'unread me' });
    expect((await list(owner.token)).find((e) => e.agent.id === fable.id).emailUnreadCount).toBe(1);

    // Reading the email clears it — the same rule a thread's `unreadCount` uses.
    await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${res.body.email.id}`,
      headers: auth(fable.key),
    });
    expect((await list(owner.token)).find((e) => e.agent.id === fable.id).emailUnreadCount).toBe(0);

    // Mail is correspondence, not room data: a colleague the agent is SHARED with
    // sees the agent but never its mail count.
    const peer = await joinOrg(ts.app, owner.token, orgId, 'peer@example.com', 'Peer');
    await shareAgent(ts.app, owner.token, fable.id, peer.userId);
    const seen = (await list(peer.token)).find((e) => e.agent.id === fable.id);
    expect(seen).toBeDefined();
    expect(seen.emailUnreadCount).toBeNull();
  });

  it('plus-addressing and case fold to the same agent', async () => {
    const res = await send(
      ({ to: [{ email: `FABLE+github@${slug.toUpperCase()}.EXAMPLE.COM` }] }),
    );
    expect(res.body.deliveries[0].agentId).toBe(fable.id);
  });

  it('an unresolvable recipient is `unknown-recipient` and persists NOTHING', async () => {
    const res = await send({ to: [{ email: at('ghost') }] });
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('unknown-recipient');
    expect(res.body.deliveries).toEqual([]);
    expect(res.body.email).toBeNull();
    expect(await threads()).toHaveLength(0);
  });

  it('fans out one row per anchor agent, each in its OWN thread', async () => {
    const scribe = await makeAgent(ts.app, owner.token, orgId, 'scribe');
    await setPolicy({ inboundUnrecognized: 'approve' });
    const res = await send(
      ({ to: [{ email: at('fable') }], cc: [{ email: at('scribe') }] }),
    );
    expect(res.body.deliveries).toHaveLength(2);
    const ids = res.body.deliveries.map((d: any) => d.agentId);
    expect(ids).toEqual([fable.id, scribe.id]);
    const threadIds = new Set(res.body.deliveries.map((d: any) => d.threadId));
    expect(threadIds.size).toBe(2);
  });

  it('is idempotent PER ANCHOR — a retried fan-out completes the half that failed', async () => {
    const rfc = '<dup@mail.example.net>';
    const first = await send(({ rfcMessageId: rfc, from: { email: 'owner@example.com' } }),
    );
    expect(first.body.status).toBe('delivered');
    // Same message id, now also cc'ing a second agent: the first anchor reports
    // `duplicate` and writes nothing; the new anchor lands.
    const scribe = await makeAgent(ts.app, owner.token, orgId, 'scribe');
    const second = await send(({
        rfcMessageId: rfc,
        from: { email: 'owner@example.com' },
        to: [{ email: at('fable') }],
        cc: [{ email: at('scribe') }],
      }),
    );
    expect(second.body.deliveries[0]).toMatchObject({ agentId: fable.id, status: 'duplicate' });
    expect(second.body.deliveries[1]).toMatchObject({ agentId: scribe.id, status: 'delivered' });
    // The summary is the most permissive outcome present.
    expect(second.body.status).toBe('delivered');
    expect(await threads()).toHaveLength(1);
  });

  it('rejects a virus whatever the sender’s standing', async () => {
    const res = await send(
      ({
        from: { email: 'owner@example.com' },
        verification: {
          spf: 'pass',
          dkim: 'pass',
          dmarc: 'pass',
          virus: 'fail',
          domain: 'example.com',
        },
      }),
    );
    expect(res.body.status).toBe('rejected');
    expect(res.body.reason).toBe('virus');
  });

  it('hard-rejects a SPOOF: unauthenticated, but the From would match the trust set', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const res = await send(
      ({
        from: { email: 'owner@example.com', name: 'Not Owner' },
        verification: { spf: 'fail', dkim: 'fail', dmarc: 'fail', domain: 'evil.test' },
      }),
    );
    expect(res.body.status).toBe('rejected');
    expect(res.body.reason).toBe('spoof');
  });

  it('a rejected inbound email keeps METADATA ONLY — never the body', async () => {
    const res = await send(({ text: 'secret payload' }));
    expect(res.body.status).toBe('rejected');
    expect(res.body.reason).toBe('unrecognized-sender');
    const read = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${res.body.email.id}`,
      headers: auth(owner.token),
    });
    expect(read.statusCode).toBe(200);
    const email = read.json().email;
    // `text` is never null on the wire — a refusal renders "".
    expect(email.text).toBe('');
    expect(email.html).toBeNull();
    expect(email.subject).toBe('Q3 rollout');
    expect(email.verification.dmarc).toBe('pass');
    expect(email.reason).toBe('unrecognized-sender');
  });

  it('the default policy rejects an unrecognized sender; `approve` quarantines it', async () => {
    const rejected = await send(({}));
    expect(rejected.body.status).toBe('rejected');

    await setPolicy({ inboundUnrecognized: 'approve' });
    const quarantined = await send(({}));
    expect(quarantined.body.status).toBe('quarantined');
    expect(quarantined.body.reason).toBe('unrecognized-sender');
    // A quarantined stranger cannot push a subject into the agent's thread list.
    expect(await threads()).toHaveLength(0);
  });

  it('the AGENT never sees a quarantined email — not in the transcript, not by id — until a human approves it', async () => {
    // Seed a real thread with delivered mail from the owner…
    const seeded = await send({ ...fromOwner, rfcMessageId: '<seed@mail.example.net>' });
    expect(seeded.body.status).toBe('delivered');
    const threadId = seeded.body.deliveries[0].threadId as string;
    // …then a STRANGER replies into that same thread under the approve policy.
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send({ inReplyTo: '<seed@mail.example.net>' });
    expect(q.body.status).toBe('quarantined');
    expect(q.body.deliveries[0].threadId).toBe(threadId); // same conversation

    // The agent's transcript shows ONLY the delivered mail — the pending
    // stranger's message is the human's to see first (Jake's rule: only
    // approved senders reach an agent; everyone else needs the human's OK).
    const transcript = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/threads/${threadId}`,
      headers: auth(fable.key),
    });
    const items = transcript.json().items as any[];
    expect(items).toHaveLength(1);
    expect(items[0].disposition).toBe('delivered');

    // The by-id read refuses too — existence never leaks to the agent.
    const byId = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${q.body.email.id}`,
      headers: auth(fable.key),
    });
    expect(byId.statusCode).toBe(404);

    // The OWNER's oversight transcript keeps seeing everything.
    const oversight = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents/${fable.id}/email/threads/${threadId}`,
      headers: auth(owner.token),
    });
    const seen = (oversight.json().items as any[]).map((e) => e.disposition).sort();
    expect(seen).toEqual(['delivered', 'quarantined']);

    // Approval flips the switch: the agent's transcript gains the message.
    const approve = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${q.body.email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    const after = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/threads/${threadId}`,
      headers: auth(fable.key),
    });
    expect((after.json().items as any[]).length).toBe(2);
  });

  it('a spam verdict diverts even a recognized sender, with reason `spam`', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const res = await send(
      ({
        from: { email: 'owner@example.com' },
        verification: {
          spf: 'pass',
          dkim: 'pass',
          dmarc: 'pass',
          spam: 'fail',
          domain: 'example.com',
        },
      }),
    );
    expect(res.body.status).toBe('quarantined');
    expect(res.body.reason).toBe('spam');
  });

  it('an org `trustedPatterns` glob delivers a whole partner domain', async () => {
    await setPolicy({ trustedPatterns: ['*@partner.example.com'] });
    const res = await send(({}));
    expect(res.body.status).toBe('delivered');
  });

  it('joins a thread by In-Reply-To, then by References right-to-left', async () => {
    await setPolicy({ trustedPatterns: ['*@partner.example.com'] });
    const first = await send(({ rfcMessageId: '<a@x.test>' }));
    const threadId = first.body.email.threadId;

    const reply = await send(({
        rfcMessageId: '<b@x.test>',
        inReplyTo: '<a@x.test>',
        subject: 'Re: something else entirely',
      }),
    );
    expect(reply.body.email.threadId).toBe(threadId);

    const grand = await send(({
        rfcMessageId: '<c@x.test>',
        references: ['<unknown@x.test>', '<b@x.test>'],
      }),
    );
    expect(grand.body.email.threadId).toBe(threadId);

    // The thread keeps its FIRST subject forever; each email keeps its own.
    const list = await threads();
    expect(list).toHaveLength(1);
    expect(list[0].subject).toBe('Q3 rollout');
    const full = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/threads/${threadId}`,
      headers: auth(fable.key),
    });
    expect(full.json().items).toHaveLength(3);
    expect(full.json().items[1].subject).toBe('Re: something else entirely');
  });

  it('threading never spans agents — a foreign ancestor starts a new thread', async () => {
    await setPolicy({ trustedPatterns: ['*@partner.example.com'] });
    const scribe = await makeAgent(ts.app, owner.token, orgId, 'scribe');
    const toFable = await send(({ rfcMessageId: '<a@x.test>', to: [{ email: at('fable') }] }),
    );
    const toScribe = await send(({
        rfcMessageId: '<b@x.test>',
        inReplyTo: '<a@x.test>',
        to: [{ email: at('scribe') }],
      }),
    );
    expect(toScribe.body.email.threadId).not.toBe(toFable.body.email.threadId);
    expect(toScribe.body.deliveries[0].agentId).toBe(scribe.id);
  });

  it('rejects a payload carrying Bcc, and a malformed verification block', async () => {
    const bcc = await send(({ bcc: [{ email: 'x@y.test' }] }));
    expect(bcc.statusCode).toBe(400);
    const bad = await send(({ verification: { spf: 'maybe', dkim: 'pass', dmarc: 'pass', domain: 'x' } }),
    );
    expect(bad.statusCode).toBe(400);
  });

  it('caps the per-org inbound rate with `429`', async () => {
    await ts.close();
    ts = await makeEmailServer({ emailInboundRatePerMin: 2 });
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    slug = org.json().org.slug as string;
    fable = await makeAgent(ts.app, owner.token, orgId, 'fable');
    for (let i = 0; i < 2; i++) {
      const ok = await send(({ to: [{ email: at('fable') }] }));
      expect(ok.statusCode).toBe(202);
    }
    const limited = await send(({ to: [{ email: at('fable') }] }));
    expect(limited.statusCode).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
  });

  it('the fake provider’s admin inject runs the SAME pipeline', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/email/inject',
      headers: { 'x-admin-token': 'test-admin-token' },
      payload: inboundPayload({
        from: { email: 'owner@example.com' },
        to: [{ email: at('fable') }],
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('delivered');
  });

  it('the in-process `app.emailFake.deliver()` needs no HTTP and no token', async () => {
    const result = await ts.app.emailFake!.deliver(
      inboundPayload({ from: { email: 'owner@example.com' }, to: [{ email: at('fable') }] }),
    );
    expect(result.status).toBe('delivered');
    expect(TEST_INBOUND_TOKEN).toBeTruthy();
  });
});
