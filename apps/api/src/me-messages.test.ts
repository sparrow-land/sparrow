/**
 * Principal-scoped single-message routes (Agent-DX ack-by-id): the
 * non-consuming fetch `GET /me/messages/:messageId` and the ack-by-id
 * `POST /me/messages/:messageId/read`. These let a watcher-driven agent handle
 * one SPECIFIC message (list ids → fetch its body → ack that id) instead of
 * blind-popping the oldest unread, which can consume a different message unseen.
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

describe('/me/messages ack-by-id + non-consuming fetch', () => {
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
    ts = await makeTestServer();
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

  const ackById = (msgId: string, token = alice.token) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/me/messages/${msgId}/read`, headers: auth(token) });

  const fetchById = (msgId: string, token = alice.token) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/me/messages/${msgId}`, headers: auth(token) });

  it('acks ONLY the target — an older unread message is untouched', async () => {
    const first = (await send({ to: alice.userId, body: 'first' })).json().message.id as string;
    const second = (await send({ to: alice.userId, body: 'second' })).json().message.id as string;

    const res = await ackById(second);
    expect(res.statusCode).toBe(200);
    expect(res.json().message.id).toBe(second);
    expect(res.json().message.body).toBe('second');
    expect(res.json().room.id).toBe(roomId);

    // The target is read; the OLDER message stays unread (no blind-pop race).
    expect((await statusOf(second)).recipients[0].status).toBe('read');
    expect((await statusOf(first)).recipients[0].status).toBe('unread');
  });

  it('ack fires message.read to the sender (same receipt semantics as pop)', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    const msgId = (await send({ to: alice.userId, body: 'notify me' })).json().message.id as string;

    await ackById(msgId);
    const read = await ownerStream.waitFor((e) => e.event === 'message.read');
    const data = read.data as { messageId: string; by: { displayName: string }; readAt: string };
    expect(data.messageId).toBe(msgId);
    expect(data.by.displayName).toBe('Alice');
    expect(data.readAt).toBeTruthy();
  });

  it('ack is idempotent: a second ack is 200 and does NOT re-emit message.read', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await sleep(50);
    const msgId = (await send({ to: alice.userId, body: 'once' })).json().message.id as string;

    expect((await ackById(msgId)).statusCode).toBe(200);
    await ownerStream.waitFor((e) => e.event === 'message.read');

    const again = await ackById(msgId);
    expect(again.statusCode).toBe(200);
    expect(again.json().message.id).toBe(msgId);
    await sleep(120);
    expect(ownerStream.events.filter((e) => e.event === 'message.read')).toHaveLength(1);
  });

  it('404s: unknown id, and a message in a room the caller is not a member of (foreign)', async () => {
    expect((await ackById('msg_doesnotexist')).statusCode).toBe(404);
    expect((await fetchById('msg_doesnotexist')).statusCode).toBe(404);

    // The `/me/messages` inbox routes are delivery-scoped (a message the caller
    // received). A message in a DIFFERENT room that Alice is not in is foreign to
    // her — neither fetch nor ack sees it. (Within a shared room every message
    // now reaches every member, so cross-room is where foreignness lives.)
    const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    const otherRoom = await createRoom(ts.app, owner.token, orgId, 'owner-and-bob');
    await addToRoom(ts, owner.token, otherRoom, bob);
    const forBob = (
      await ts.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${otherRoom}/messages`,
        headers: auth(owner.token),
        payload: { body: 'for bob' },
      })
    ).json().message.id as string;
    expect((await fetchById(forBob, alice.token)).statusCode).toBe(404);
    expect((await ackById(forBob, alice.token)).statusCode).toBe(404);
    // Bob, a member of that room and a recipient, can ack it.
    expect((await ackById(forBob, bob.token)).statusCode).toBe(200);
  });

  it('list → fetch → ack triangle: fetch never consumes; ack marks read', async () => {
    const msgId = (await send({ to: alice.userId, body: 'handle this specific one' })).json().message
      .id as string;

    // LIST: /me/inbox exposes the id prominently.
    const inbox = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      headers: auth(alice.token),
    });
    const item = inbox.json().items.find((i: { id: string }) => i.id === msgId);
    expect(item).toBeDefined();
    expect(item.id).toBe(msgId);

    // FETCH: full body without consuming. /me/inbox already marked it `received`;
    // fetching writes no read state, so it stays `received` (never `read`).
    const fetched = await fetchById(msgId);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().message.body).toBe('handle this specific one');
    expect(fetched.json().room.id).toBe(roomId);
    expect((await statusOf(msgId)).recipients[0].status).toBe('received');

    // ACK: now marks read.
    expect((await ackById(msgId)).statusCode).toBe(200);
    expect((await statusOf(msgId)).recipients[0].status).toBe('read');
  });

  it('fetch on a never-listed message is a pure peek (stays unread)', async () => {
    const msgId = (await send({ to: alice.userId, body: 'peek only' })).json().message.id as string;
    expect((await fetchById(msgId)).statusCode).toBe(200);
    // No inbox listing happened, so fetch must not have observed delivery either.
    const rec = (await statusOf(msgId)).recipients[0];
    expect(rec.status).toBe('unread');
    expect(rec.receivedAt).toBeNull();
    expect(rec.readAt).toBeNull();
  });
});
