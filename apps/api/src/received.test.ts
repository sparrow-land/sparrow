/**
 * Delivery receipts (SPEC "Read state"): the three-valued unread → received →
 * read progression. `received` is server-observed delivery, set once via two
 * triggers — (a) a `message.new` written to an open stream at send time, and
 * (b) the recipient listing the message in an inbox — each emitting
 * `message.received` to the sender. Reads never backfill received.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  listen,
  openSse,
  sleep,
  type TestServer,
  type SignedUpHuman,
  type SseClient,
} from './test-helpers.js';

async function addToRoom(
  ts: TestServer,
  ownerToken: string,
  roomId: string,
  invitee: SignedUpHuman,
): Promise<string> {
  const inv = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/invitations`,
    headers: auth(ownerToken),
    payload: { human: invitee.userId },
  });
  const accept = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
    headers: auth(invitee.token),
  });
  return accept.json().member.id as string;
}

describe('delivery receipts (received)', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  const open: SseClient[] = [];
  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  beforeEach(async () => {
    ts = await makeTestServer({ presenceGraceSeconds: 0.15 });
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  const send = (payload: Record<string, unknown>, token = owner.token) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/messages`, headers: auth(token), payload });

  const statusOf = async (msgId: string) =>
    (
      await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages/${msgId}/status`,
        headers: auth(owner.token),
      })
    ).json();

  it('send to an offline recipient → status unread, no message.received', async () => {
    // Owner watches for receipts; alice holds no stream.
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    const res = await send({ to: alice.userId, body: 'offline' });
    const msgId = res.json().message.id as string;

    await sleep(120);
    expect(ownerStream.events.some((e) => e.event === 'message.received')).toBe(false);
    const st = await statusOf(msgId);
    expect(st.recipients[0]).toMatchObject({ status: 'unread', receivedAt: null, readAt: null });
  });

  it('recipient with an open room /events stream at send → received + sender notified', async () => {
    const aliceStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, alice.token));
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    const res = await send({ to: alice.userId, body: 'live' });
    const msgId = res.json().message.id as string;

    await aliceStream.waitFor((e) => e.event === 'message.new');
    const recv = await ownerStream.waitFor((e) => e.event === 'message.received');
    const data = recv.data as { messageId: string; by: { displayName: string }; receivedAt: string };
    expect(data.messageId).toBe(msgId);
    expect(data.by.displayName).toBe('Alice');
    expect(data.receivedAt).toBeTruthy();

    const st = await statusOf(msgId);
    expect(st.recipients[0].status).toBe('received');
    expect(st.recipients[0].receivedAt).not.toBeNull();
    expect(st.recipients[0].readAt).toBeNull();
  });

  it('recipient online via /me/events at send → received + sender notified', async () => {
    const aliceStream = track(await openSse(base, '/api/v1/me/events', alice.token));
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    const res = await send({ to: alice.userId, body: 'via me/events' });
    const msgId = res.json().message.id as string;

    await aliceStream.waitFor((e) => e.event === 'message.new');
    const recv = await ownerStream.waitFor((e) => e.event === 'message.received');
    expect((recv.data as { messageId: string }).messageId).toBe(msgId);
    expect((await statusOf(msgId)).recipients[0].status).toBe('received');
  });

  it('inbox listing marks received; a second listing does NOT re-emit (set-once)', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    // Alice offline at send → not received yet.
    const res = await send({ to: alice.userId, body: 'listme' });
    const msgId = res.json().message.id as string;

    const inbox = async () =>
      ts.app.inject({ method: 'GET', url: `/api/v1/rooms/${roomId}/inbox`, headers: auth(alice.token) });

    const first = await inbox();
    expect(first.json().items[0].status).toBe('received');
    const recv = await ownerStream.waitFor((e) => e.event === 'message.received');
    expect((recv.data as { messageId: string }).messageId).toBe(msgId);

    await inbox(); // second listing — already received, must not re-emit.
    await sleep(120);
    expect(ownerStream.events.filter((e) => e.event === 'message.received')).toHaveLength(1);
  });

  it('/me/inbox listing marks received', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    const res = await send({ to: alice.userId, body: 'me-inbox' });
    const msgId = res.json().message.id as string;

    const inbox = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      headers: auth(alice.token),
    });
    expect(inbox.json().items[0].status).toBe('received');
    const recv = await ownerStream.waitFor((e) => e.event === 'message.received');
    expect((recv.data as { messageId: string }).messageId).toBe(msgId);
    expect((await statusOf(msgId)).recipients[0].status).toBe('received');
  });

  it('pop after received → read; receivedAt is preserved', async () => {
    const aliceStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, alice.token));
    await sleep(50);
    const res = await send({ to: alice.userId, body: 'pop me' });
    const msgId = res.json().message.id as string;
    await aliceStream.waitFor((e) => e.event === 'message.new');
    // received was set at send time.
    expect((await statusOf(msgId)).recipients[0].status).toBe('received');
    const receivedAt = (await statusOf(msgId)).recipients[0].receivedAt as string;
    expect(receivedAt).toBeTruthy();

    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
    });
    const st = await statusOf(msgId);
    expect(st.recipients[0].status).toBe('read');
    expect(st.recipients[0].readAt).not.toBeNull();
    expect(st.recipients[0].receivedAt).toBe(receivedAt);
  });

  it('read without ever being received → emits only message.read', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    // Alice offline; never lists inbox — reads the message by id directly.
    const res = await send({ to: alice.userId, body: 'read direct' });
    const msgId = res.json().message.id as string;

    await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}`,
      headers: auth(alice.token),
    });
    await ownerStream.waitFor((e) => e.event === 'message.read');
    await sleep(120);
    expect(ownerStream.events.some((e) => e.event === 'message.received')).toBe(false);
    const st = await statusOf(msgId);
    expect(st.recipients[0].status).toBe('read');
    expect(st.recipients[0].receivedAt).toBeNull();
    expect(st.recipients[0].readAt).not.toBeNull();
  });

  it('broadcast marks received per-recipient: online one received, offline one unread', async () => {
    const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    await addToRoom(ts, owner.token, roomId, bob);

    // Alice online, bob offline at send.
    const aliceStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, alice.token));
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    const res = await send({ to: 'all', body: 'everyone' });
    const msgId = res.json().message.id as string;
    expect(res.json().message.kind).toBe('broadcast');
    await aliceStream.waitFor((e) => e.event === 'message.new');

    const recv = await ownerStream.waitFor((e) => e.event === 'message.received');
    expect((recv.data as { by: { displayName: string } }).by.displayName).toBe('Alice');
    await sleep(120);
    // Exactly one receipt (alice); bob never received.
    expect(ownerStream.events.filter((e) => e.event === 'message.received')).toHaveLength(1);

    const st = await statusOf(msgId);
    const byName: Record<string, { status: string }> = {};
    for (const r of st.recipients) byName[r.displayName] = r;
    expect(byName['Alice']!.status).toBe('received');
    expect(byName['Bob']!.status).toBe('unread');
  });
});
