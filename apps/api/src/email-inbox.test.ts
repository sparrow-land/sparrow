/**
 * Layer 3 for the email medium (SPEC v4 "Unified attention → The
 * medium-spanning work queue", "→ `/me/events` in v4", "→ Entry types
 * registry").
 *
 * An agent runs ONE loop: it drains `/me/inbox/pop` until empty across every
 * membership AND every delivered inbound email, oldest first, chat before email
 * on a tie. Popping is reading; listing is not — and an `ack` on an email item
 * sets nothing, because an email has no room.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeEmailServer,
  auth,
  signup,
  firstOrgId,
  makeAgent,
  deliverEmail,
  inboundPayload,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

describe('email in the medium-spanning work queue', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;
  let slug: string;
  let fable: { id: string; key: string };
  let dmRoom: string;

  const at = (name: string): string => `${name}@${slug}.example.com`;

  async function inbound(overrides: Record<string, unknown> = {}) {
    return deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'owner@example.com', name: 'Owner' },
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
        ...overrides,
      }),
    );
  }

  async function pop(payload: Record<string, unknown> = {}) {
    return ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(fable.key),
      payload,
    });
  }

  async function inboxItems(query = ''): Promise<any[]> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/inbox${query}`,
      headers: auth(fable.key),
    });
    expect(res.statusCode).toBe(200);
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
    const dm = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: fable.id },
    });
    dmRoom = dm.json().room.id as string;
  });
  afterEach(async () => {
    await ts.close();
  });

  it('pop returns { type: "email", email, thread } and marks it read', async () => {
    const res = await inbound({ subject: 'Q3 rollout', text: 'the body' });
    expect(res.body.status).toBe('delivered');
    const popped = await pop();
    expect(popped.statusCode).toBe(200);
    const item = popped.json().item;
    expect(item.type).toBe('email');
    expect(item.email.id).toBe(res.body.email.id);
    expect(item.email.text).toBe('the body');
    expect(item.email.status).toBe('read'); // the pop IS the read
    expect(item.thread.id).toBe(res.body.email.threadId);
    expect(item.thread.subject).toBe('Q3 rollout');
    // A popped item is never returned again.
    expect((await pop()).json().item).toBeNull();
  });

  it('drains chat and email in ONE queue, oldest first, chat before email on a tie', async () => {
    // A chat message first, then an email.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoom}/messages`,
      headers: auth(owner.token),
      payload: { body: 'chat first' },
    });
    await inbound({ subject: 'email second' });

    const first = await pop();
    expect(first.json().item.type).toBe('chat.message');
    expect(first.json().item.message.body).toBe('chat first');
    const second = await pop();
    expect(second.json().item.type).toBe('email');
    expect(second.json().item.email.subject).toBe('email second');
    expect((await pop()).json().item).toBeNull();
  });

  it('`ack: true` on an email item sets nothing and is not an error', async () => {
    await inbound({});
    const res = await pop({ ack: true, note: 'reading your message' });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.type).toBe('email');
    // Working status is room-scoped and member-scoped; an email has no room.
    const statuses = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${dmRoom}/status`,
      headers: auth(owner.token),
    });
    expect(statuses.json().items ?? []).toHaveLength(0);
  });

  it('GET /me/inbox carries the email preview + its thread, and marks nothing', async () => {
    const res = await inbound({ subject: 'Q3 rollout', text: 'x'.repeat(250) });
    const items = await inboxItems();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('email');
    expect(items[0].id).toBe(res.body.email.id);
    expect(items[0].direction).toBe('in');
    expect(items[0].from.email).toBe('owner@example.com');
    expect(items[0].preview).toHaveLength(200);
    expect(items[0].truncated).toBe(true);
    expect(items[0].status).toBe('unread');
    expect(items[0].thread).toEqual({
      id: res.body.email.threadId,
      subject: 'Q3 rollout',
      lastEmailAt: expect.any(String),
    });
    // Listing never marks an email read.
    expect((await inboxItems())[0].status).toBe('unread');
  });

  it('`?medium=` narrows and `?all=true` includes read email', async () => {
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoom}/messages`,
      headers: auth(owner.token),
      payload: { body: 'chat' },
    });
    await inbound({});
    expect(await inboxItems()).toHaveLength(2);
    expect((await inboxItems('?medium=email')).every((i) => i.type === 'email')).toBe(true);
    expect((await inboxItems('?medium=chat')).every((i) => i.type === 'chat.message')).toBe(true);

    await pop(); // reads the chat message
    await pop(); // reads the email
    expect(await inboxItems()).toHaveLength(0);
    expect(await inboxItems('?all=true')).toHaveLength(2);
    expect(await inboxItems('?medium=email&all=true')).toHaveLength(1);
  });

  it('quarantined, rejected and outbound email are never work items', async () => {
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { email: { inboundUnrecognized: 'approve' } } },
    });
    // A stranger → quarantined (the owner's queue, not the agent's work).
    await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: 'dana@partner.example.com' } }),
    );
    // The agent's own outbound mail.
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload: { to: ['owner@example.com'], subject: 'out', text: 'body' },
    });
    expect(await inboxItems('?all=true')).toHaveLength(0);
    expect((await pop()).json().item).toBeNull();
  });

  it('a non-peek read marks the email read; `?peek=true` never does', async () => {
    const res = await inbound({});
    const emailId = res.body.email.id as string;
    const peek = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${emailId}?peek=true`,
      headers: auth(fable.key),
    });
    expect(peek.json().email.status).toBe('unread');
    expect(await inboxItems()).toHaveLength(1);

    const read = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${emailId}`,
      headers: auth(fable.key),
    });
    expect(read.json().email.status).toBe('read');
    expect(await inboxItems()).toHaveLength(0);
  });

  it('pages across BOTH mediums with one cursor, in the one queue order', async () => {
    for (let i = 0; i < 2; i++) {
      await ts.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${dmRoom}/messages`,
        headers: auth(owner.token),
        payload: { body: `chat ${i}` },
      });
      await inbound({ subject: `email ${i}`, rfcMessageId: `<m${i}@x.test>` });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: any = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/me/inbox?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers: auth(fable.key),
      });
      expect(res.statusCode).toBe(200);
      for (const item of res.json().items as any[]) seen.push(item.id);
      cursor = res.json().nextCursor as string | null;
      if (!cursor) break;
    }
    // Every item exactly once, ascending, no duplicates and nothing skipped.
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it('a human’s inbox contains NO email items (v4 gives addresses to agents only)', async () => {
    await inbound({});
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox?all=true',
      headers: auth(owner.token),
    });
    expect((res.json().items as any[]).some((i) => i.type === 'email')).toBe(false);
  });

  it('journals the six activity entry types with `{ emailThreadId, emailId }` refs', async () => {
    const delivered = await inbound({ subject: 'Q3 rollout' });
    const timeline = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity',
      headers: auth(fable.key),
    });
    const entries = timeline.json().items as any[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      medium: 'email',
      type: 'email.received',
      summary: 'Q3 rollout',
      agent: { id: fable.id, name: 'fable' },
      actor: { kind: 'human', id: owner.userId, displayName: 'Owner' },
      refs: { emailThreadId: delivered.body.email.threadId, emailId: delivered.body.email.id },
    });

    // An outbound send journals `email.sent` with the agent as its own actor.
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload: { to: ['owner@example.com'], subject: 'out', text: 'body' },
    });
    const after = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity',
      headers: auth(fable.key),
    });
    // Newest-first: the send is the head, the delivery the tail.
    const types = (after.json().items as any[]).map((e) => e.type);
    expect(types).toEqual(['email.sent', 'email.received']);

    // A rejection journals `email.rejected` on the anchor agent's timeline, with
    // the external sender as a `contact` actor.
    await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: 'dana@partner.example.com', name: 'Dana' } }),
    );
    const rejected = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?medium=email',
      headers: auth(fable.key),
    });
    const newest = (rejected.json().items as any[])[0];
    expect(newest.type).toBe('email.rejected');
    expect(newest.actor.kind).toBe('contact');
    // The frozen label for an UNTRUSTED sender is the raw ADDRESS, never the
    // self-chosen display name — an attacker could name themselves after the
    // org's owner (Jake's ruling, 2026-09-02).
    expect(newest.actor.displayName).toBe('dana@partner.example.com');

    // The owner sees the same entries on their own timeline (owner_human_id).
    const ownerTimeline = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?medium=email',
      headers: auth(owner.token),
    });
    expect((ownerTimeline.json().items as any[]).length).toBe(3);
  });

  it('an approval journals `email.resolved` alongside the delivery', async () => {
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { email: { inboundUnrecognized: 'approve' } } },
    });
    const res = await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: 'dana@partner.example.com' } }),
    );
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${res.body.email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    const timeline = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?medium=email',
      headers: auth(fable.key),
    });
    const types = (timeline.json().items as any[]).map((e) => e.type);
    expect(types).toEqual(['email.resolved', 'email.received', 'email.quarantined']);
    const resolved = (timeline.json().items as any[])[0];
    expect(resolved.actor).toMatchObject({ kind: 'human', id: owner.userId });
  });
});
