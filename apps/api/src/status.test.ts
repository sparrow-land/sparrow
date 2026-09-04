import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  sleep,
  listen,
  openSse,
  type TestServer,
  type SignedUpHuman,
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

describe('working status', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let bob: SignedUpHuman;
  let orgId: string;
  let roomId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
    await addToRoom(ts, owner.token, roomId, bob);
  });
  afterEach(async () => {
    await ts.close();
  });

  const setStatus = (token: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/status`, headers: auth(token), payload });
  const listStatus = (token: string) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/rooms/${roomId}/status`, headers: auth(token) });

  it('working upserts + is listed; idle clears', async () => {
    const set = await setStatus(owner.token, { state: 'working', note: 'thinking' });
    expect(set.statusCode).toBe(200);
    expect(set.json().status).toMatchObject({ state: 'working', note: 'thinking', to: null });

    const list = await listStatus(alice.token);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().presence.online).toEqual([]);

    const idle = await setStatus(owner.token, { state: 'idle' });
    expect(idle.json().status).toBeNull();
    const after = await listStatus(alice.token);
    expect(after.json().items).toHaveLength(0);
  });

  it('scoped status: only setter + recipient see it; unknown to → 404', async () => {
    const set = await setStatus(owner.token, { state: 'working', note: 'reply', to: alice.userId });
    expect(set.json().status.to).toMatchObject({ id: expect.any(String), kind: 'human' });

    const aliceSees = await listStatus(alice.token);
    expect(aliceSees.json().items).toHaveLength(1);
    const ownerSees = await listStatus(owner.token);
    expect(ownerSees.json().items).toHaveLength(1);
    const bobSees = await listStatus(bob.token);
    expect(bobSees.json().items).toHaveLength(0);

    const unknown = await setStatus(owner.token, { state: 'working', to: 'usr_nope00000000' });
    expect(unknown.statusCode).toBe(404);
  });

  it('pop --ack sets working scoped to the sender', async () => {
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'question' },
    });
    const pop = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
      payload: { ack: true },
    });
    expect(pop.json().message).not.toBeNull();
    // Alice now has a working status scoped to owner.
    const ownerSees = await listStatus(owner.token);
    expect(ownerSees.json().items).toHaveLength(1);
    expect(ownerSees.json().items[0]).toMatchObject({ state: 'working', note: 'reading your message' });
    // Bob (not the sender) does not see it.
    const bobSees = await listStatus(bob.token);
    expect(bobSees.json().items).toHaveLength(0);
  });

  it('empty-inbox ack sets nothing', async () => {
    const pop = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
      payload: { ack: true },
    });
    expect(pop.json().message).toBeNull();
    const list = await listStatus(alice.token);
    expect(list.json().items).toHaveLength(0);
  });

  it('pop with note/ttlSeconds but no ack → 400 (silent no-op is a trap)', async () => {
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'question' },
    });
    // note without ack:true
    const noteOnly = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
      payload: { note: 'on it' },
    });
    expect(noteOnly.statusCode).toBe(400);
    expect(noteOnly.json().error.code).toBe('bad_request');
    expect(noteOnly.json().error.message).toContain('note/ttlSeconds require ack: true');
    // Documented route → the 400 carries a docs link.
    expect(noteOnly.json().error.docs).toBe('https://sparrow.land/docs/api/me/inbox.md');
    // ttlSeconds without ack:true
    const ttlOnly = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
      payload: { ttlSeconds: 120 },
    });
    expect(ttlOnly.statusCode).toBe(400);
    // The message was NOT consumed by either rejected call.
    const pop = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
      payload: {},
    });
    expect(pop.json().message?.body).toBe('question');
  });

  it('pop with ack:true + note refines the status (note/ttl honored)', async () => {
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'question' },
    });
    const pop = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
      payload: { ack: true, note: 'digging in', ttlSeconds: 120 },
    });
    expect(pop.statusCode).toBe(200);
    const ownerSees = await listStatus(owner.token);
    expect(ownerSees.json().items[0]).toMatchObject({ state: 'working', note: 'digging in' });
  });

  it('short-TTL status expires', async () => {
    await setStatus(owner.token, { state: 'working', ttlSeconds: 1 });
    expect((await listStatus(owner.token)).json().items).toHaveLength(1);
    await sleep(1100);
    expect((await listStatus(owner.token)).json().items).toHaveLength(0);
  });

  it('setting status on an archived room → 410', async () => {
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { archived: true },
    });
    const res = await setStatus(owner.token, { state: 'working' });
    expect(res.statusCode).toBe(410);
  });

  it('working status carries sinceAt; a same-note re-up preserves it, a new note resets it', async () => {
    const first = await setStatus(owner.token, { state: 'working', note: 'building' });
    const since1 = first.json().status.sinceAt as string;
    expect(since1).toEqual(expect.any(String));

    await sleep(10);
    // Same note → sinceAt preserved (the text hasn't changed).
    const reup = await setStatus(owner.token, { state: 'working', note: 'building', ttlSeconds: 120 });
    expect(reup.json().status.sinceAt).toBe(since1);

    await sleep(10);
    // New note → sinceAt advances.
    const changed = await setStatus(owner.token, { state: 'working', note: 'testing' });
    expect(changed.json().status.sinceAt).not.toBe(since1);
  });

  it('rejects sticky + ttlSeconds together (400)', async () => {
    const res = await setStatus(owner.token, { state: 'working', sticky: true, ttlSeconds: 60 });
    expect(res.statusCode).toBe(400);
  });
});

describe('sticky working status', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;

  // A short offline horizon so the sticky-clear rule is exercised without a wait.
  beforeEach(async () => {
    ts = await makeTestServer({ stickyOfflineHorizonSeconds: 0.3, presenceGraceSeconds: 0.1 });
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
  });
  afterEach(async () => {
    await ts.close();
  });

  const setStatus = (token: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/status`, headers: auth(token), payload });
  const listStatus = (token: string) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/rooms/${roomId}/status`, headers: auth(token) });

  it('a sticky status has no TTL (expiresAt null) and outlives the old TTL cap', async () => {
    // Hold owner online so the offline horizon never arms — this isolates the
    // "no TTL" property from the offline-clear rule (covered separately).
    const base = await listen(ts);
    const stream = await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token);
    try {
      const set = await setStatus(owner.token, { state: 'working', note: 'long task', sticky: true });
      expect(set.json().status).toMatchObject({ state: 'working', sticky: true, expiresAt: null });

      // A normal 1s TTL would have lapsed by now; the sticky one persists.
      await sleep(1100);
      const list = await listStatus(alice.token);
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0]).toMatchObject({ sticky: true, expiresAt: null });
    } finally {
      stream.close();
    }
  });

  it('an explicit idle clears a sticky status', async () => {
    await setStatus(owner.token, { state: 'working', note: 'long task', sticky: true });
    const idle = await setStatus(owner.token, { state: 'idle' });
    expect(idle.json().status).toBeNull();
    expect((await listStatus(alice.token)).json().items).toHaveLength(0);
  });

  it('a sticky status set by an offline member clears once the offline horizon passes', async () => {
    // Owner holds no events stream → offline → the horizon countdown is armed now.
    await setStatus(owner.token, { state: 'working', note: 'long task', sticky: true });
    expect((await listStatus(alice.token)).json().items).toHaveLength(1);

    await sleep(450); // > 300ms horizon
    expect((await listStatus(alice.token)).json().items).toHaveLength(0);
  });

  it('a sticky status survives the horizon while its member stays online', async () => {
    const base = await listen(ts);
    const stream = await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token);
    try {
      await setStatus(owner.token, { state: 'working', note: 'long task', sticky: true });
      // Owner is stream-online, so the offline countdown never arms.
      await sleep(450); // > 300ms horizon
      expect((await listStatus(alice.token)).json().items).toHaveLength(1);
    } finally {
      stream.close();
    }
  });
});

/**
 * Interplay: a zombie stream (a proxy swallowed its client's disconnect) would
 * pin its member online forever, so the sticky-status offline horizon could never
 * fire. The server-side max-lifetime reap breaks that — the stream is force-closed,
 * presence drops, and the horizon then lapses the sticky status in bounded time.
 */
describe('sticky status × stream max-lifetime reap', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;

  beforeEach(async () => {
    ts = await makeTestServer({
      stickyOfflineHorizonSeconds: 0.3,
      presenceGraceSeconds: 0.1,
      streamMaxLifetimeSeconds: 0.3,
    });
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
  });
  afterEach(async () => {
    await ts.close();
  });

  const setStatus = (token: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/status`, headers: auth(token), payload });
  const listStatus = (token: string) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/rooms/${roomId}/status`, headers: auth(token) });

  it("reaps a member's zombie stream so their sticky status finally clears", async () => {
    const base = await listen(ts);
    // Owner holds a stream and sets a sticky status — while connected the horizon
    // cannot arm. We never close this from the client side (it is a "zombie"); only
    // the server's lifetime cap can end it.
    await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token);
    await setStatus(owner.token, { state: 'working', note: 'long task', sticky: true });
    expect((await listStatus(alice.token)).json().items).toHaveLength(1);

    // The stream is reaped (~0.3s) → grace (0.1s) → offline → horizon (0.3s) → clear.
    await sleep(900);
    expect((await listStatus(alice.token)).json().items).toHaveLength(0);
  });
});
