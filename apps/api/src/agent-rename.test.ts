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
  type TestServer,
  type SignedUpHuman,
  type SseClient,
} from './test-helpers.js';

/** Add an owned agent (owner holds visibility) straight into a room. */
async function addAgentToRoom(
  ts: TestServer,
  ownerToken: string,
  roomId: string,
  agentId: string,
): Promise<void> {
  const res = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/members`,
    headers: auth(ownerToken),
    payload: { principal: agentId },
  });
  if (res.statusCode !== 201) throw new Error(`addAgentToRoom failed (${res.statusCode}): ${res.body}`);
}

describe('agent rename — self (PATCH /me) & owner (PATCH /me/agents/:id)', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let orgId: string;
  const open: SseClient[] = [];

  beforeEach(async () => {
    ts = await makeTestServer();
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  const patchMe = (key: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: auth(key), payload });

  const patchAgent = (token: string, id: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'PATCH', url: `/api/v1/me/agents/${id}`, headers: auth(token), payload });

  it('self-rename: trims, bounds, round-trips on GET /me, live in the room member list', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);

    // Trims and succeeds.
    const ok = await patchMe(bot.key, { name: '  deploy-bot  ' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().principal).toMatchObject({ type: 'agent', id: bot.id, name: 'deploy-bot' });

    // Round-trips on a fresh GET /me.
    const me = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(bot.key) });
    expect(me.json().principal.name).toBe('deploy-bot');

    // Live in the room member list (names render from the agent row).
    const members = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
    });
    const names = (members.json().items as { displayName: string }[]).map((m) => m.displayName);
    expect(names).toContain('deploy-bot');

    // Length bounds: empty (after trim) and > 60 → 400.
    expect((await patchMe(bot.key, { name: '   ' })).statusCode).toBe(400);
    expect((await patchMe(bot.key, { name: 'x'.repeat(61) })).statusCode).toBe(400);
    expect((await patchMe(bot.key, { name: 'x'.repeat(60) })).statusCode).toBe(200);
  });

  it('self-rename: collision is 409, never auto-suffixed', async () => {
    await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const bot = await makeAgent(ts.app, owner.token, orgId, 'beta');

    // The collision is 409 — and the caller keeps its name.
    const res = await patchMe(bot.key, { name: 'alpha' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
    const me = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(bot.key) });
    expect(me.json().principal.name).toBe('beta');

    // v4: names are lowercase (an agent name IS an email local part), so a
    // case-variant is a malformed name (400), not a collision. Org-uniqueness
    // stays case-insensitive — trivially, since every stored name is lowercase.
    for (const name of ['Alpha', 'ALPHA', 'BETA']) {
      expect((await patchMe(bot.key, { name })).statusCode, name).toBe(400);
    }
  });

  it('self-rename ripples member.updated to every room the agent inhabits', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const roomA = await createRoom(ts.app, owner.token, orgId, 'room-a');
    const roomB = await createRoom(ts.app, owner.token, orgId, 'room-b');
    await addAgentToRoom(ts, owner.token, roomA, bot.id);
    await addAgentToRoom(ts, owner.token, roomB, bot.id);

    const streamA = track(await openSse(base, `/api/v1/rooms/${roomA}/events`, owner.token));
    const streamB = track(await openSse(base, `/api/v1/rooms/${roomB}/events`, owner.token));

    expect((await patchMe(bot.key, { name: 'scout' })).statusCode).toBe(200);

    for (const s of [streamA, streamB]) {
      const evt = await s.waitFor(
        (e) =>
          e.event === 'member.updated' &&
          (e.data as { member: { principalId: string } }).member.principalId === bot.id,
      );
      expect((evt.data as { member: { displayName: string } }).member.displayName).toBe('scout');
    }
  });

  it('old messages show the new name on refetch (names render live)', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);

    // The agent posts under its old name.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(bot.key),
      payload: { to: owner.userId, body: 'first' },
    });

    await patchMe(bot.key, { name: 'renamed-bot' });

    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
    });
    const froms = (list.json().items as { from: { displayName: string } }[]).map((m) => m.from.displayName);
    expect(froms).toContain('renamed-bot');
    expect(froms).not.toContain('bot');
  });

  it('owner rename (PATCH /me/agents/:id { name }): same semantics + 403 for non-owner', async () => {
    const other = await joinOrg(ts.app, owner.token, orgId, 'other@example.com', 'Other');
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    await makeAgent(ts.app, owner.token, orgId, 'taken');
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);

    const ownerStream = track(await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token));

    // Owner renames; trims; ripples member.updated.
    const ok = await patchAgent(owner.token, bot.id, { name: '  helper  ' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().agent.name).toBe('helper');
    const evt = await ownerStream.waitFor(
      (e) =>
        e.event === 'member.updated' &&
        (e.data as { member: { principalId: string } }).member.principalId === bot.id,
    );
    expect((evt.data as { member: { displayName: string } }).member.displayName).toBe('helper');

    // Collision → 409, never auto-suffixed; a case variant is malformed (400).
    expect((await patchAgent(owner.token, bot.id, { name: 'taken' })).statusCode).toBe(409);
    expect((await patchAgent(owner.token, bot.id, { name: 'TAKEN' })).statusCode).toBe(400);

    // Bounds still enforced.
    expect((await patchAgent(owner.token, bot.id, { name: 'x'.repeat(61) })).statusCode).toBe(400);

    // A non-owner org member → 403 (existence not leaked as 404).
    expect((await patchAgent(other.token, bot.id, { name: 'nope' })).statusCode).toBe(403);
  });

  it('owner PATCH /me/agents/:id updates sharing and name together, and requires ≥1 field', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const both = await patchAgent(owner.token, bot.id, { name: 'combined', sharing: 'org' });
    expect(both.statusCode).toBe(200);
    expect(both.json().agent).toMatchObject({ name: 'combined', sharing: 'org' });

    // Empty body → 400 (at least one of sharing / name).
    expect((await patchAgent(owner.token, bot.id, {})).statusCode).toBe(400);
  });
});
