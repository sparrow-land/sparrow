import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
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

/** Heartbeat presence (`POST /me/presence`) for turn-based agents — no socket. */
describe('heartbeat presence', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  let aliceMemberId: string;
  const open: SseClient[] = [];

  beforeEach(async () => {
    ts = await makeTestServer({ presenceGraceSeconds: 0.15 });
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    aliceMemberId = await addToRoom(ts, owner.token, roomId, alice);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };
  const setPresence = (token: string, ttlSeconds: number) =>
    ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/presence',
      headers: auth(token),
      payload: { ttlSeconds },
    });
  const roomOnline = async (): Promise<string[]> => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/status`,
      headers: auth(owner.token),
    });
    return res.json().presence.online as string[];
  };

  it('a mark (no socket) brings the principal online in the room snapshot + fires online', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));

    const res = await setPresence(alice.token, 60);
    expect(res.statusCode).toBe(200);
    expect(res.json().onlineUntil).toEqual(expect.any(String));

    const online = await ownerStream.waitFor(
      (e) =>
        e.event === 'presence.changed' &&
        (e.data as { state: string; member: { displayName: string } }).state === 'online' &&
        (e.data as { member: { displayName: string } }).member.displayName === 'Alice',
    );
    expect(online).toBeDefined();
    expect(await roomOnline()).toContain(aliceMemberId);
  });

  it('caps ttl at 300 (400 over) and rejects negative', async () => {
    expect((await setPresence(alice.token, 301)).statusCode).toBe(400);
    expect((await setPresence(alice.token, -1)).statusCode).toBe(400);
    expect((await setPresence(alice.token, 300)).statusCode).toBe(200);
  });

  it('an expiring mark flips the principal offline (+ presence.changed offline)', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await setPresence(alice.token, 1);
    await ownerStream.waitFor(
      (e) => e.event === 'presence.changed' && (e.data as { state: string }).state === 'online',
    );
    expect(await roomOnline()).toContain(aliceMemberId);

    const offline = await ownerStream.waitFor(
      (e) => e.event === 'presence.changed' && (e.data as { state: string }).state === 'offline',
      3000,
    );
    expect((offline.data as { member: { displayName: string } }).member.displayName).toBe('Alice');
    expect(await roomOnline()).not.toContain(aliceMemberId);
  });

  it('clearing a mark (ttl 0) flips offline immediately and returns onlineUntil null', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    await setPresence(alice.token, 60);
    await ownerStream.waitFor(
      (e) => e.event === 'presence.changed' && (e.data as { state: string }).state === 'online',
    );

    const cleared = await setPresence(alice.token, 0);
    expect(cleared.json().onlineUntil).toBeNull();
    const offline = await ownerStream.waitFor(
      (e) => e.event === 'presence.changed' && (e.data as { state: string }).state === 'offline',
    );
    expect(offline).toBeDefined();
    expect(await roomOnline()).not.toContain(aliceMemberId);
  });

  it('effective online = stream OR mark: a mark keeps you online after the socket drops', async () => {
    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    const aliceStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, alice.token));
    await ownerStream.waitFor(
      (e) =>
        e.event === 'presence.changed' &&
        (e.data as { state: string; member: { displayName: string } }).state === 'online' &&
        (e.data as { member: { displayName: string } }).member.displayName === 'Alice',
    );

    // Mark while already stream-online → no duplicate online event.
    await setPresence(alice.token, 60);
    // Drop the socket; the mark still covers her, so no offline after the grace.
    aliceStream.close();
    await sleep(500); // well past the 150ms grace window
    const offlines = ownerStream.events.filter(
      (e) => e.event === 'presence.changed' && (e.data as { state: string }).state === 'offline',
    );
    expect(offlines).toHaveLength(0);
    expect(await roomOnline()).toContain(aliceMemberId);
    const onlines = ownerStream.events.filter(
      (e) =>
        e.event === 'presence.changed' &&
        (e.data as { state: string; member: { displayName: string } }).state === 'online' &&
        (e.data as { member: { displayName: string } }).member.displayName === 'Alice',
    );
    expect(onlines).toHaveLength(1); // the single stream-open online, no mark duplicate
  });

  it('an agent marks itself online without holding a stream (GET /me/agents)', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    let list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/agents?org=${orgId}`,
      headers: auth(owner.token),
    });
    expect(list.json().items[0].agent.online).toBe(false);

    const res = await setPresence(bot.key, 60);
    expect(res.statusCode).toBe(200);

    list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/agents?org=${orgId}`,
      headers: auth(owner.token),
    });
    expect(list.json().items[0].agent.online).toBe(true);
  });
});
