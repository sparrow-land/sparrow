/**
 * `GET /me` self-presence (SPEC "Presence" → self-view). Any principal can ask
 * "am I actually online?" in one call: `presence` reports effective online — an
 * open events stream OR an unexpired self-reported mark — plus WHICH of the two
 * carries it right now, and when a mark lapses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createRoom,
  makeAgent,
  listen,
  openSse,
  type TestServer,
  type SignedUpHuman,
  type SseClient,
} from './test-helpers.js';

describe('GET /me — self-presence', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  let agent: { id: string; key: string };
  const open: SseClient[] = [];

  beforeEach(async () => {
    // A long grace would keep a closed stream "online"; these tests never rely
    // on the grace, but keep it short so nothing bleeds between cases.
    ts = await makeTestServer({ presenceGraceSeconds: 0.15 });
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    agent = await makeAgent(ts.app, owner.token, orgId, 'turnbot');
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  /** `GET /me` → the caller's `presence` block. */
  const myPresence = async (token: string) => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return res.json().principal.presence as {
      online: boolean;
      via: 'stream' | 'mark' | null;
      onlineUntil: string | null;
    };
  };

  const setPresence = async (token: string, ttlSeconds: number): Promise<string | null> => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/presence',
      headers: auth(token),
      payload: { ttlSeconds },
    });
    expect(res.statusCode).toBe(200);
    return res.json().onlineUntil as string | null;
  };

  /**
   * THE pinned case: a turn-based agent mid-turn, holding NO socket, self-checks
   * after planting a heartbeat mark. It must read itself as online via the mark,
   * with the mark's own expiry echoed back.
   */
  it('mid-turn self-check: no stream, unexpired mark → online via mark, onlineUntil = the mark expiry', async () => {
    const onlineUntil = await setPresence(agent.key, 60);
    expect(onlineUntil).not.toBeNull();

    expect(await myPresence(agent.key)).toEqual({
      online: true,
      via: 'mark',
      onlineUntil,
    });
  });

  it("stream wins: an open stream reports via 'stream' even with a live mark", async () => {
    await setPresence(agent.key, 60);
    track(await openSse(base, '/api/v1/me/events', agent.key));

    expect(await myPresence(agent.key)).toEqual({
      online: true,
      via: 'stream',
      onlineUntil: null,
    });
  });

  it("a room stream (not just /me/events) also reports via 'stream'", async () => {
    track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));

    expect(await myPresence(owner.token)).toEqual({
      online: true,
      via: 'stream',
      onlineUntil: null,
    });
  });

  it('neither stream nor mark → offline, via null, onlineUntil null', async () => {
    expect(await myPresence(agent.key)).toEqual({
      online: false,
      via: null,
      onlineUntil: null,
    });
  });

  it('a human session gets the same shape', async () => {
    expect(await myPresence(owner.token)).toEqual({
      online: false,
      via: null,
      onlineUntil: null,
    });

    const onlineUntil = await setPresence(owner.token, 60);
    expect(await myPresence(owner.token)).toEqual({ online: true, via: 'mark', onlineUntil });
  });

  it('clearing the mark (ttlSeconds 0) drops the caller back to offline', async () => {
    await setPresence(agent.key, 60);
    expect((await myPresence(agent.key)).via).toBe('mark');

    expect(await setPresence(agent.key, 0)).toBeNull();
    expect(await myPresence(agent.key)).toEqual({
      online: false,
      via: null,
      onlineUntil: null,
    });
  });

  it('an expired mark reads offline (never pins the caller online past its TTL)', async () => {
    await setPresence(agent.key, 1);
    expect((await myPresence(agent.key)).via).toBe('mark');

    // Advance past the 1s TTL without holding any socket.
    await new Promise((r) => setTimeout(r, 1100));

    expect(await myPresence(agent.key)).toEqual({
      online: false,
      via: null,
      onlineUntil: null,
    });
  });
});
