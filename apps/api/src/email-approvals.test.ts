/**
 * The human / org email surfaces (SPEC v4 "The email medium → Routes → Human /
 * org surfaces" + "Durable approvals").
 *
 * Mail is correspondence, not room data: reading an agent's threads requires
 * its owner, an org owner/admin, or the admin token — never `canAccessAgent`.
 * A caller outside that set gets `404`, never `403`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeEmailServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  makeAgent,
  deliverEmail,
  inboundPayload,
  TEST_ADMIN_TOKEN,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

describe('email approvals, contacts and read rights', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let colleague: SignedUpHuman;
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

  /** Quarantine one inbound email from `from` and return its ids. */
  async function quarantine(from = 'dana@partner.example.com') {
    const res = await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: from, name: 'Dana' } }),
    );
    expect(res.body.status).toBe('quarantined');
    return res.body.email as { id: string; threadId: string };
  }

  async function approvals(token: string, query = ''): Promise<any> {
    return ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/approvals${query}`,
      headers: auth(token),
    });
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
    colleague = await joinOrg(ts.app, owner.token, orgId, 'colleague@example.com', 'Colleague');
    await setPolicy({ inboundUnrecognized: 'approve', outboundUnrecognized: 'approve' });
  });
  afterEach(async () => {
    await ts.close();
  });

  it('lists the queue with its verification block, and filters by agent/direction', async () => {
    const email = await quarantine();
    const res = await approvals(owner.token);
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].email.id).toBe(email.id);
    expect(items[0].email.preview).toBe('the body');
    expect(items[0].agent).toEqual({ id: fable.id, name: 'fable' });
    expect(items[0].verification.dmarc).toBe('pass');
    expect(items[0].judge).toBeNull();

    expect((await approvals(owner.token, `?agent=${fable.id}`)).json().items).toHaveLength(1);
    expect((await approvals(owner.token, '?direction=out')).json().items).toHaveLength(0);
    expect((await approvals(owner.token, '?direction=in')).json().items).toHaveLength(1);
  });

  it('an org MEMBER who is not the owner sees no queue and cannot read the mail', async () => {
    const email = await quarantine();
    // A plain member is not an approver: their scope is "agents I own" = none.
    expect((await approvals(colleague.token)).json().items).toHaveLength(0);
    const read = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}`,
      headers: auth(colleague.token),
    });
    expect(read.statusCode).toBe(404);
    // …and the contact list is closed to them entirely (404, never 403).
    const contacts = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/contacts`,
      headers: auth(colleague.token),
    });
    expect(contacts.statusCode).toBe(404);
  });

  it('a non-member gets 404 on every /orgs/:orgId/email/* route', async () => {
    const outsider = await signup(ts.app, { email: 'outsider@example.com' });
    for (const url of [
      `/api/v1/orgs/${orgId}/email/approvals`,
      `/api/v1/orgs/${orgId}/email/contacts`,
      `/api/v1/orgs/${orgId}/agents/${fable.id}/email/threads`,
      `/api/v1/orgs/${orgId}/agents/${fable.id}/email/address`,
    ]) {
      const res = await ts.app.inject({ method: 'GET', url, headers: auth(outsider.token) });
      expect(res.statusCode).toBe(404);
    }
  });

  it('an org ADMIN sees every agent’s pending mail; the admin token does too', async () => {
    await quarantine();
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/humans/${colleague.userId}`,
      headers: auth(owner.token),
      payload: { role: 'admin' },
    });
    expect((await approvals(colleague.token)).json().items).toHaveLength(1);
    const asAdmin = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/approvals`,
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    expect(asAdmin.json().items).toHaveLength(1);
  });

  it('approve delivers the mail, trusts the thread, and approves the sender contact', async () => {
    const email = await quarantine();
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email.disposition).toBe('delivered');
    expect(res.json().email.resolvedAt).not.toBeNull();

    // The thread is now visible to the agent and marked trusted.
    const threads = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/threads',
      headers: auth(fable.key),
    });
    expect(threads.json().items).toHaveLength(1);
    expect(threads.json().items[0].trusted).toBe(true);

    // The contact is durably approved, with the resolving human recorded.
    const contacts = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/contacts?trust=approved`,
      headers: auth(owner.token),
    });
    expect(contacts.json().items).toHaveLength(1);
    expect(contacts.json().items[0].email).toBe('dana@partner.example.com');
    expect(contacts.json().items[0].resolvedBy.id).toBe(owner.userId);

    // …so the NEXT email from that sender is delivered outright.
    const next = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'dana@partner.example.com' },
        rfcMessageId: '<second@mail.example.net>',
      }),
    );
    expect(next.body.status).toBe('delivered');
  });

  it('approve with `trustSender: false` delivers WITHOUT creating durable contact trust', async () => {
    const email = await quarantine();
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}/approve`,
      headers: auth(owner.token),
      payload: { trustSender: false },
    });
    const contacts = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/contacts?trust=approved`,
      headers: auth(owner.token),
    });
    expect(contacts.json().items).toHaveLength(0);
  });

  it('approving a HELD outbound email relays it', async () => {
    const sent = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload: { to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' },
    });
    expect(sent.statusCode).toBe(202);
    const emailId = sent.json().email.id as string;
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${emailId}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email.disposition).toBe('sent');
    expect(ts.app.emailFake!.sent).toHaveLength(1);
    const contacts = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/contacts?trust=approved`,
      headers: auth(owner.token),
    });
    expect(contacts.json().items.map((c: any) => c.email)).toEqual(['dana@partner.example.com']);
  });

  it('deny rejects with reason `denied`, drops the body, and can block the sender', async () => {
    const email = await quarantine();
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}/deny`,
      headers: auth(owner.token),
      payload: { blockSender: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email.disposition).toBe('rejected');
    expect(res.json().email.reason).toBe('denied');
    expect(res.json().email.text).toBe('');

    // Blocked: every future email either way is rejected at the block rung.
    const next = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'dana@partner.example.com' },
        rfcMessageId: '<later@mail.example.net>',
      }),
    );
    expect(next.body.status).toBe('rejected');
    expect(next.body.reason).toBe('blocked');
  });

  it('resolving a non-pending email is 409, and an unknown id is 404', async () => {
    const email = await quarantine();
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    const again = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}/deny`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    const unknown = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/eml_nope/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('a contact can be returned to unknown, forward-looking', async () => {
    const email = await quarantine();
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    const contacts = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/contacts`,
      headers: auth(owner.token),
    });
    const contactId = contacts.json().items[0].id as string;
    const patched = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/email/contacts/${contactId}`,
      headers: auth(owner.token),
      payload: { trust: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().contact.trust).toBeNull();
    // Already-delivered email is never withdrawn.
    const threads = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/threads',
      headers: auth(fable.key),
    });
    expect(threads.json().items).toHaveLength(1);
    // …but the thread stays trusted, so the conversation continues.
    const next = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'dana@partner.example.com' },
        rfcMessageId: '<third@mail.example.net>',
        inReplyTo: '<' + 'unknown@x' + '>',
      }),
    );
    expect(next.body.status).toBe('quarantined');
  });

  it('the org read surfaces are a peek — a human read never marks the agent’s mail read', async () => {
    const email = await quarantine();
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    const thread = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents/${fable.id}/email/threads/${email.threadId}`,
      headers: auth(owner.token),
    });
    expect(thread.statusCode).toBe(200);
    expect(thread.json().thread.unreadCount).toBe(1);
    const read = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${email.id}`,
      headers: auth(owner.token),
    });
    expect(read.json().email.status).toBe('unread');
    const after = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents/${fable.id}/email/threads/${email.threadId}`,
      headers: auth(owner.token),
    });
    expect(after.json().thread.unreadCount).toBe(1);
  });

  it('an attachment downloads for the agent and the owner, and 404s for anyone else', async () => {
    const res = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'owner@example.com' },
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
        attachments: [
          {
            filename: 'plan.pdf',
            contentType: 'application/pdf',
            dataBase64: Buffer.from('PDF-BYTES').toString('base64'),
          },
        ],
      }),
    );
    expect(res.body.status).toBe('delivered');
    const email = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${res.body.email.id}?peek=true`,
      headers: auth(fable.key),
    });
    const attachmentId = email.json().email.attachments[0].id as string;

    const byAgent = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/attachments/${attachmentId}`,
      headers: auth(fable.key),
    });
    expect(byAgent.statusCode).toBe(200);
    expect(byAgent.headers['content-disposition']).toContain('attachment; filename="plan.pdf"');
    expect(byAgent.rawPayload.toString()).toBe('PDF-BYTES');

    const byOwner = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/attachments/${attachmentId}`,
      headers: auth(owner.token),
    });
    expect(byOwner.statusCode).toBe(200);

    const byColleague = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/attachments/${attachmentId}`,
      headers: auth(colleague.token),
    });
    expect(byColleague.statusCode).toBe(404);
  });

  it('one agent cannot read another agent’s thread or email', async () => {
    const other = await makeAgent(ts.app, owner.token, orgId, 'scribe');
    const email = await quarantine();
    const thread = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/threads/${email.threadId}`,
      headers: auth(other.key),
    });
    expect(thread.statusCode).toBe(404);
    const one = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${email.id}`,
      headers: auth(other.key),
    });
    expect(one.statusCode).toBe(404);
  });
});
