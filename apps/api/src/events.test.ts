import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  shareAgent,
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
): Promise<void> {
  const inv = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/invitations`,
    headers: auth(ownerToken),
    payload: { human: invitee.userId },
  });
  await ts.app.inject({
    method: 'POST',
    url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
    headers: auth(invitee.token),
  });
}

describe('SSE events & presence', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  const open: SseClient[] = [];

  beforeEach(async () => {
    ts = await makeTestServer({ presenceGraceSeconds: 0.15 });
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  it('room stream delivers message.new to a recipient', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);

    const aliceStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, alice.token));
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'live!' },
    });
    const evt = await aliceStream.waitFor((e) => e.event === 'message.new');
    expect((evt.data as { preview: string }).preview).toBe('live!');
  });

  it('presence: online on connect, offline after grace', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);

    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));
    const aliceStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, alice.token));

    const online = await ownerStream.waitFor(
      (e) =>
        e.event === 'presence.changed' &&
        (e.data as { state: string; member: { displayName: string } }).state === 'online' &&
        (e.data as { member: { displayName: string } }).member.displayName === 'Alice',
    );
    expect((online.data as { member: { displayName: string } }).member.displayName).toBe('Alice');

    // Status snapshot shows alice online.
    const status = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/status`,
      headers: auth(owner.token),
    });
    expect(status.json().presence.online.length).toBe(2);

    // Alice disconnects → offline after the grace window.
    aliceStream.close();
    const offline = await ownerStream.waitFor(
      (e) => e.event === 'presence.changed' && (e.data as { state: string }).state === 'offline',
      2000,
    );
    expect((offline.data as { member: { displayName: string } }).member.displayName).toBe('Alice');
  });

  it('/me/events wraps room events with room context + delivers principal events', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);

    const meStream = track(await openSse(base, '/api/v1/me/events', alice.token));

    // Room event arrives wrapped with { room }.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'wrapped' },
    });
    const wrapped = await meStream.waitFor((e) => e.event === 'message.new');
    expect((wrapped.data as { room: { id: string; kind: string } }).room.id).toBe(roomId);

    // Principal-level event: agent.shared arrives unwrapped.
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    await shareAgent(ts.app, owner.token, bot.id, alice.userId);
    const shared = await meStream.waitFor((e) => e.event === 'agent.shared');
    expect((shared.data as { agent: { id: string } }).agent.id).toBe(bot.id);
  });

  it('real socket: GET /me/events flushes headers + the `: open` preamble immediately (no connect hang)', async () => {
    // Guard for the prod-reported "live stream dead at connect". The other SSE
    // tests use undici `fetch` (which resolves on headers, then reads the body);
    // this one reads RAW bytes straight off the socket — the exact view a
    // `curl -N -D -` gets — to assert the server writes the 200 headers AND the
    // `: open\n\n` comment right away, within a hard 2s budget. A handler that
    // stalled before `writeHead`/`hijack` would time out here.
    const url = `${base}/api/v1/me/events?token=${alice.token}`;
    const preamble = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('no headers/preamble within 2s — connect hang'));
      }, 2000);
      const req = http.get(url, (res) => {
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['content-type'])).toContain('text/event-stream');
        res.setEncoding('utf8');
        res.once('data', (chunk: string) => {
          clearTimeout(timer);
          req.destroy();
          resolve(chunk);
        });
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    expect(preamble).toContain(': open');
  });

  it('agent holding /me/events reads online on GET /me/agents', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    let list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/agents?org=${orgId}`,
      headers: auth(owner.token),
    });
    expect(list.json().items[0].agent.online).toBe(false);

    track(await openSse(base, '/api/v1/me/events', bot.key));
    await sleep(50);
    list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/agents?org=${orgId}`,
      headers: auth(owner.token),
    });
    expect(list.json().items[0].agent.online).toBe(true);
  });

  it('membership-gain: counterpart /me/events gets wrapped member.joined on a fresh DM', async () => {
    // alice + bob were both invited by owner (no prior alice↔bob DM).
    const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    const bobStream = track(await openSse(base, '/api/v1/me/events', bob.token));

    // Alice ensures a brand-new DM with Bob while Bob holds an open stream.
    const dm = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(alice.token),
      payload: { principal: bob.userId },
    });
    expect(dm.statusCode).toBe(201);
    const roomId = dm.json().room.id as string;

    // Bob's stream receives the wrapped member.joined for the new DM — no reconnect.
    const joined = await bobStream.waitFor(
      (e) =>
        e.event === 'member.joined' &&
        (e.data as { room?: { id: string } }).room?.id === roomId,
    );
    expect((joined.data as { room: { kind: string } }).room.kind).toBe('dm');
  });

  it('SSE without a valid credential → 401', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    const res = await fetch(`${base}/api/v1/rooms/${roomId}/events?token=ses_bogus`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
});

/**
 * Belt-and-suspenders reaping: even if an intermediary swallows a client
 * disconnect (so `request close` never fires), the server force-closes a stream
 * past its max lifetime so its presence contribution is bounded and zombies are
 * reaped in bounded time. Well-behaved clients reconnect and resume via replay.
 */
describe('SSE stream max-lifetime', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  const open: SseClient[] = [];
  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  beforeEach(async () => {
    // Short lifetime + short grace so the horizon fires in-test without a wait.
    ts = await makeTestServer({ presenceGraceSeconds: 0.15, streamMaxLifetimeSeconds: 0.3 });
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  it('force-closes a room stream past its lifetime: client sees a clean end and presence drops', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);

    const onlineCount = async (): Promise<number> => {
      const res = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/status`,
        headers: auth(owner.token),
      });
      return res.json().presence.online.length as number;
    };

    // Alice holds the only stream → she is the sole online member.
    const aliceStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, alice.token));
    await sleep(50);
    expect(await onlineCount()).toBe(1);

    // The server ends alice's stream itself (~0.3 s) — never touched from the
    // client side. Her reader completes cleanly.
    await Promise.race([
      aliceStream.closed,
      sleep(2000).then(() => Promise.reject(new Error('stream was not force-closed'))),
    ]);

    // Once the reaped stream's grace window lapses, presence drops to nobody —
    // the zombie is gone, so the sticky-status offline horizon can now fire.
    await sleep(250); // > presenceGraceSeconds (0.15 s)
    expect(await onlineCount()).toBe(0);
  });

  it('a reaped /me/events client resumes seamlessly via cursor replay', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);

    const meStream = track(await openSse(base, '/api/v1/me/events', alice.token));
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'before reap' },
    });
    const first = await meStream.waitFor((e) => e.event === 'message.new');
    const cursor = Number(first.id);
    expect(Number.isFinite(cursor)).toBe(true);

    // Server reaps the stream at its lifetime — clean end, client-visible.
    await Promise.race([
      meStream.closed,
      sleep(2000).then(() => Promise.reject(new Error('me stream was not force-closed'))),
    ]);

    // A message sent while the client is between connections is journaled…
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'after reap' },
    });

    // …and replayed on reconnect from the last cursor (no gap, no missed event).
    const resumed = track(await openSse(base, `/api/v1/me/events?since=${cursor}`, alice.token));
    const replayed = await resumed.waitFor(
      (e) => e.event === 'message.new' && (e.data as { preview: string }).preview === 'after reap',
    );
    expect((replayed.data as { room: { id: string } }).room.id).toBe(roomId);
  });

  /**
   * The multiplexed fan-in is the WEB CLIENT's only live connection (one stream
   * for every joined room), so its room-permission boundary is now load-bearing:
   * a member removed from a room must stop receiving that room's events on the
   * SAME open stream, without a reconnect. The hub recomputes the audience from
   * `members` on every emit, so removal takes effect on the next event — and the
   * journal is written per receiving principal, so a later `?since=` replay
   * cannot leak the room's post-removal traffic either.
   */
  it('removal mid-stream stops that room’s events on the multiplexed /me/events', async () => {
    const keptId = await createRoom(ts.app, owner.token, orgId, 'kept');
    const lostId = await createRoom(ts.app, owner.token, orgId, 'lost');
    await addToRoom(ts, owner.token, keptId, alice);
    await addToRoom(ts, owner.token, lostId, alice);

    const meStream = track(await openSse(base, '/api/v1/me/events', alice.token));

    // Baseline: both rooms are live on the ONE connection.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${lostId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'while a member' },
    });
    const before = await meStream.waitFor(
      (e) =>
        e.event === 'message.new' &&
        (e.data as { preview: string }).preview === 'while a member',
    );
    const cursor = Number(before.id);
    expect((before.data as { room: { id: string } }).room.id).toBe(lostId);

    // Kick Alice out of `lost` — the stream stays open.
    const roster = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${lostId}/members`,
      headers: auth(owner.token),
    });
    const aliceMember = (roster.json().items as { id: string; principalId: string }[]).find(
      (m) => m.principalId === alice.userId,
    )!;
    const kicked = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${lostId}/members/${aliceMember.id}`,
      headers: auth(owner.token),
    });
    expect(kicked.statusCode).toBe(200);

    // Traffic in BOTH rooms: the lost room's must never reach her again.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${lostId}/messages`,
      headers: auth(owner.token),
      payload: { body: 'after the kick' },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${keptId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'still mine' },
    });

    const after = await meStream.waitFor(
      (e) => e.event === 'message.new' && (e.data as { preview: string }).preview === 'still mine',
    );
    expect((after.data as { room: { id: string } }).room.id).toBe(keptId);
    // Everything the stream ever wrote, checked for the removed room's leak.
    expect(
      meStream.events.some(
        (e) => (e.data as { room?: { id: string } }).room?.id === lostId && e.event === 'message.new'
          && (e.data as { preview?: string }).preview === 'after the kick',
      ),
    ).toBe(false);

    // …and a cursor resume replays the same boundary (the journal was never written).
    const resumed = track(await openSse(base, `/api/v1/me/events?since=${cursor}`, alice.token));
    await resumed.waitFor(
      (e) => e.event === 'message.new' && (e.data as { preview: string }).preview === 'still mine',
    );
    expect(
      resumed.events.some((e) => (e.data as { preview?: string }).preview === 'after the kick'),
    ).toBe(false);
  });
});
