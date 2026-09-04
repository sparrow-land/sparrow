import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_DM_NO_COMMON_VIEWER_MESSAGE,
  AGENT_DM_SEVERED_MESSAGE,
  DM_NOT_ELIGIBLE_MESSAGE,
} from '@sparrow/common-types';
import {
  makeTestServer,
  listen,
  openSse,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  shareAgent,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

/**
 * Agent↔agent DMs: two agents may hold a direct conversation only while at least
 * one human can currently see BOTH (the `canAccessAgent` sharing machinery),
 * enforced at DM-ensure AND at send-time (a revocation gate). Every such human
 * gets an ambient, read-only oversight box (`GET /orgs/:orgId/agent-dms`).
 */
describe('agent↔agent DMs + oversight', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@ex.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  const ensure = (token: string, principal: string) =>
    ts.app.inject({ method: 'POST', url: '/api/v1/me/dms', headers: auth(token), payload: { principal } });

  const send = (token: string, roomId: string, body = 'hi') =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(token),
      payload: { body },
    });

  const addToRoom = (token: string, roomId: string, principal: string) =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(token),
      payload: { principal },
    });

  const setSharing = (token: string, agentId: string, sharing: string) =>
    ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/me/agents/${agentId}`,
      headers: auth(token),
      payload: { sharing },
    });

  /** Invite a human to a room + accept as them → member. */
  async function addHumanToRoom(roomId: string, human: SignedUpHuman) {
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: human.userId },
    });
    const invitationId = inv.json().invitation.id as string;
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${invitationId}/accept`,
      headers: auth(human.token),
      payload: {},
    });
  }

  const listBoxes = (token: string) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/agent-dms`, headers: auth(token) });

  const readBox = (token: string, roomId: string) =>
    ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agent-dms/${roomId}/messages`,
      headers: auth(token),
    });

  /** Both agents into one fresh project room owned by `owner` — they have MET. */
  async function coRoom(...agentIds: string[]): Promise<string> {
    const room = await createRoom(ts.app, owner.token, orgId, `shared-${agentIds.join('-')}`);
    for (const id of agentIds) {
      const res = await addToRoom(owner.token, room, id);
      if (res.statusCode !== 201) throw new Error(`addToRoom failed: ${res.body}`);
    }
    return room;
  }

  /* ---------------------- eligibility: owner shortcut ------------------ */

  it('two agents of the SAME owner, co-rooms: ensure 201 then send 201 (owner sees both)', async () => {
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
    await coRoom(a.id, b.id);
    const dm = await ensure(a.key, b.id);
    expect(dm.statusCode).toBe(201);
    expect(dm.json().counterpart).toMatchObject({ type: 'agent', id: b.id });
    const roomId = dm.json().room.id as string;
    expect((await send(a.key, roomId)).statusCode).toBe(201);
    // idempotent re-ensure from the other side reuses the room.
    const again = await ensure(b.key, a.id);
    expect(again.statusCode).toBe(200);
    expect(again.json().room.id).toBe(roomId);
  });

  /* ---------------------- eligibility: no common viewer ---------------- */

  it('co-room but no common viewer: 403 naming the rule', async () => {
    const owner2 = await joinOrg(ts.app, owner.token, orgId, 'o2@ex.com', 'Owner Two');
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner2.token, orgId, 'beta');
    // They have met (one room), but each is `selected`-shared to its own owner
    // only, so no single human can see both.
    const room = await createRoom(ts.app, owner.token, orgId, 'Shared');
    expect((await setSharing(owner.token, a.id, 'selected')).statusCode).toBe(200);
    expect((await setSharing(owner2.token, b.id, 'selected')).statusCode).toBe(200);
    expect((await addToRoom(owner.token, room, a.id)).statusCode).toBe(201);
    await addHumanToRoom(room, owner2);
    expect((await addToRoom(owner2.token, room, b.id)).statusCode).toBe(201);

    const res = await ensure(a.key, b.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    expect(res.json().error.message).toBe(AGENT_DM_NO_COMMON_VIEWER_MESSAGE);
    expect(res.json().error.message).toContain('/docs/api/me/dms');
  });

  /* ------------- the raw-id door is the name door (the gate) ----------- */

  it('an agt_ id opens no door a name would not: agents must have MET', async () => {
    // Same owner (who sees BOTH) — but the two agents share no room, so neither
    // could name the other. The raw id is refused exactly the same way.
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
    const refused = await ensure(a.key, b.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(DM_NOT_ELIGIBLE_MESSAGE);

    // No existence oracle: a real-but-unmet agent and a fabricated id are
    // refused with byte-identical responses.
    const fake = await ensure(a.key, `agt_${'z'.repeat(21)}`);
    expect(fake.statusCode).toBe(refused.statusCode);
    expect(fake.body).toBe(refused.body);

    // An agent of ANOTHER org is likewise indistinguishable.
    const outsider = await signup(ts.app, { email: 'out@ex.com', displayName: 'Out' });
    const otherOrg = (
      await ts.app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: auth(outsider.token),
        payload: { name: 'Outside Inc' },
      })
    ).json().org.id as string;
    const foreign = await makeAgent(ts.app, outsider.token, otherOrg, 'zeta');
    const cross = await ensure(a.key, foreign.id);
    expect(cross.body).toBe(refused.body);

    // One shared room later, the same call succeeds.
    await coRoom(a.id, b.id);
    expect((await ensure(a.key, b.id)).statusCode).toBe(201);
  });

  it('org-wide sharing does not substitute for meeting; leaving the room later does not sever', async () => {
    const owner2 = await joinOrg(ts.app, owner.token, orgId, 'o2@ex.com', 'Owner Two');
    const c = await makeAgent(ts.app, owner.token, orgId, 'gamma');
    const d = await makeAgent(ts.app, owner2.token, orgId, 'delta');
    expect((await setSharing(owner2.token, d.id, 'org')).statusCode).toBe(200);
    // Visible to a common human, but they have never met: still refused.
    expect((await ensure(c.key, d.id)).statusCode).toBe(403);

    const room = await coRoom(c.id, d.id);
    const dm = await ensure(c.key, d.id);
    expect(dm.statusCode).toBe(201);
    const roomId = dm.json().room.id as string;

    // First contact is a one-time gate: the pair keeps its line when the room
    // that introduced them goes away (oversight is what governs it from here).
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room}`,
      headers: auth(owner.token),
      payload: { archived: true },
    });
    expect((await ensure(c.key, d.id)).statusCode).toBe(200);
    expect((await send(c.key, roomId)).statusCode).toBe(201);
  });

  /* ---------------------- send-time revocation gate -------------------- */

  it('revocation flips the send gate both ways; history stays readable', async () => {
    const owner2 = await joinOrg(ts.app, owner.token, orgId, 'o2@ex.com', 'Owner Two');
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner2.token, orgId, 'beta');
    // They meet in a room, but neither is room-shared — sight comes only from
    // the explicit bridges below, so revoking those really does end oversight.
    const room = await createRoom(ts.app, owner.token, orgId, 'Bridge');
    await addToRoom(owner.token, room, a.id);
    await addHumanToRoom(room, owner2);
    await addToRoom(owner2.token, room, b.id);
    await setSharing(owner.token, a.id, 'selected');
    await setSharing(owner2.token, b.id, 'selected');
    // Bridge via an explicit share so BOTH owners can see both agents.
    await shareAgent(ts.app, owner.token, a.id, owner2.userId);
    await shareAgent(ts.app, owner2.token, b.id, owner.userId);
    const dm = await ensure(a.key, b.id);
    expect(dm.statusCode).toBe(201);
    const roomId = dm.json().room.id as string;
    expect((await send(a.key, roomId)).statusCode).toBe(201);
    expect((await send(b.key, roomId)).statusCode).toBe(201);

    // Revoke both bridges → no human sees both → sends refused from EITHER side.
    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${a.id}/share/${owner2.userId}`,
      headers: auth(owner.token),
    });
    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${b.id}/share/${owner.userId}`,
      headers: auth(owner2.token),
    });
    const blockedA = await send(a.key, roomId);
    expect(blockedA.statusCode).toBe(403);
    expect(blockedA.json().error.message).toBe(AGENT_DM_NO_COMMON_VIEWER_MESSAGE);
    expect((await send(b.key, roomId)).statusCode).toBe(403);
    // Re-ensure also fails now.
    expect((await ensure(a.key, b.id)).statusCode).toBe(403);
    // But history is still readable to the members (the agents themselves).
    const hist = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(a.key),
    });
    expect(hist.statusCode).toBe(200);
    expect(hist.json().items.length).toBe(2);

    // Restore one bridge → eligible again (flip back).
    await shareAgent(ts.app, owner.token, a.id, owner2.userId);
    await shareAgent(ts.app, owner2.token, b.id, owner.userId);
    expect((await send(a.key, roomId)).statusCode).toBe(201);
  });

  /* ---------------------- oversight box: eligible human ---------------- */

  it('eligible human sees the box + reads the thread read-only; a non-member cannot', async () => {
    // H owns neither agent but co-rooms with both → sees both.
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
    const h = await joinOrg(ts.app, owner.token, orgId, 'h@ex.com', 'Helen');
    const room = await createRoom(ts.app, owner.token, orgId, 'Shared');
    await addToRoom(owner.token, room, a.id);
    await addToRoom(owner.token, room, b.id);
    await addHumanToRoom(room, h);

    const dm = await ensure(a.key, b.id);
    const roomId = dm.json().room.id as string;
    await send(a.key, roomId, 'first from alpha');
    await send(b.key, roomId, 'reply from beta');

    const boxes = await listBoxes(h.token);
    expect(boxes.statusCode).toBe(200);
    const items = boxes.json().items as any[];
    expect(items).toHaveLength(1);
    expect(items[0].roomId).toBe(roomId);
    expect(items[0].agents.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(items[0].lastMessage.preview).toBe('reply from beta');
    // Ambient: no unread count ever rides a box.
    expect('unreadCount' in items[0]).toBe(false);

    const read = await readBox(h.token, roomId);
    expect(read.statusCode).toBe(200);
    expect(read.json().items.map((m: any) => m.body).sort()).toEqual(
      ['first from alpha', 'reply from beta'].sort(),
    );

    // H is NOT a member of the DM room: the ordinary room route denies her.
    const direct = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(h.token),
    });
    expect(direct.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('an ineligible human gets nothing, and loses the box + read access on revocation', async () => {
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
    // Stranger: an org member who can see NEITHER agent.
    const stranger = await joinOrg(ts.app, owner.token, orgId, 's@ex.com', 'Sam');
    await coRoom(a.id, b.id);
    const dm = await ensure(a.key, b.id);
    const roomId = dm.json().room.id as string;
    await send(a.key, roomId, 'hello');

    expect((await listBoxes(stranger.token)).json().items).toHaveLength(0);
    expect((await readBox(stranger.token, roomId)).statusCode).toBe(404);

    // Helen sees both via explicit shares → box appears.
    const h = await joinOrg(ts.app, owner.token, orgId, 'h@ex.com', 'Helen');
    await shareAgent(ts.app, owner.token, a.id, h.userId);
    await shareAgent(ts.app, owner.token, b.id, h.userId);
    expect((await listBoxes(h.token)).json().items).toHaveLength(1);
    expect((await readBox(h.token, roomId)).statusCode).toBe(200);

    // Revoke sight of ONE agent → box + read access both vanish.
    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${a.id}/share/${h.userId}`,
      headers: auth(owner.token),
    });
    expect((await listBoxes(h.token)).json().items).toHaveLength(0);
    expect((await readBox(h.token, roomId)).statusCode).toBe(404);
  });

  /* ---------------------- events: agents receive normally -------------- */

  it('both agents receive the DM as normal (inbox + own timeline)', async () => {
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
    await coRoom(a.id, b.id);
    const dm = await ensure(a.key, b.id);
    const roomId = dm.json().room.id as string;
    await send(a.key, roomId, 'ping');

    const inbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/inbox`,
      headers: auth(b.key),
    });
    expect(inbox.json().items).toHaveLength(1);

    const timeline = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity',
      headers: auth(b.key),
    });
    expect(timeline.json().items.some((e: any) => e.type === 'chat.message')).toBe(true);
  });

  it('live: a non-owner common viewer receives activity.appended for the DM', async () => {
    const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
    const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
    const h = await joinOrg(ts.app, owner.token, orgId, 'h@ex.com', 'Helen');
    const room = await createRoom(ts.app, owner.token, orgId, 'Shared');
    await addToRoom(owner.token, room, a.id);
    await addToRoom(owner.token, room, b.id);
    await addHumanToRoom(room, h);
    const dm = await ensure(a.key, b.id);
    const roomId = dm.json().room.id as string;

    const base = await listen(ts);
    const sse = await openSse(base, '/api/v1/me/events', h.token);
    await send(a.key, roomId, 'overheard');
    const ev = await sse.waitFor(
      (e) => e.event === 'activity.appended' && (e.data as any).entry?.refs?.roomId === roomId,
    );
    expect((ev.data as any).entry.medium).toBe('chat');
    sse.close();
  });

  /* ======================== severing a pair ========================= */

  describe('sever / allow', () => {
    const sever = (token: string, roomId: string) =>
      ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/agent-dms/${roomId}/sever`,
        headers: auth(token),
        payload: {},
      });
    const allow = (token: string, roomId: string) =>
      ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/agent-dms/${roomId}/allow`,
        headers: auth(token),
        payload: {},
      });

    /** Owner's two agents, met in a room, with a live DM carrying one message. */
    async function pair() {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
      await coRoom(a.id, b.id);
      const dm = await ensure(a.key, b.id);
      const roomId = dm.json().room.id as string;
      await send(a.key, roomId, 'hello beta');
      return { a, b, roomId };
    }

    it('an owner severs: both agents are cut off, the humans keep the transcript', async () => {
      const { a, b, roomId } = await pair();

      const res = await sever(owner.token, roomId);
      expect(res.statusCode).toBe(200);
      expect(res.json().sever).toMatchObject({
        roomId,
        orgId,
        authority: 'org',
        severedBy: { id: owner.userId },
      });
      expect(res.json().sever.agents.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());

      // Both directions are dead — the room is a tombstone, so 410, not 403.
      expect((await send(a.key, roomId)).statusCode).toBe(410);
      expect((await send(b.key, roomId)).statusCode).toBe(410);
      // Re-ensuring says why, and says it is not self-healing.
      const reopen = await ensure(a.key, b.id);
      expect(reopen.statusCode).toBe(403);
      expect(reopen.json().error.message).toBe(AGENT_DM_SEVERED_MESSAGE);

      // Oversight is untouched: the box stays listed (flagged) and readable.
      const boxes = await listBoxes(owner.token);
      const box = (boxes.json().items as any[]).find((x) => x.roomId === roomId);
      expect(box).toBeDefined();
      expect(box.severedAt).not.toBeNull();
      expect(box.canSever).toBe(true);
      const read = await readBox(owner.token, roomId);
      expect(read.statusCode).toBe(200);
      expect(read.json().items).toHaveLength(1);
      // The agents keep their own history too.
      const hist = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages`,
        headers: auth(a.key),
      });
      expect(hist.statusCode).toBe(200);
    });

    it('severing is durable: only an explicit allow + a passing gate re-opens the line', async () => {
      const { a, b, roomId } = await pair();
      await sever(owner.token, roomId);

      const allowed = await allow(owner.token, roomId);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ roomId, allowed: true });
      // Allowing PERMITS; it does not re-open. The agents must ensure again.
      expect((await send(a.key, roomId)).statusCode).toBe(410);
      const again = await ensure(a.key, b.id);
      expect(again.statusCode).toBe(200);
      expect(again.json().room.id).toBe(roomId);
      expect((await send(a.key, roomId)).statusCode).toBe(201);
      expect((await listBoxes(owner.token)).json().items[0].severedAt).toBeNull();
    });

    it('an agent owner may sever their own agent; an unrelated org member may not', async () => {
      const owner2 = await joinOrg(ts.app, owner.token, orgId, 'o2@ex.com', 'Owner Two');
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner2.token, orgId, 'beta');
      const room = await createRoom(ts.app, owner.token, orgId, 'Shared');
      await addToRoom(owner.token, room, a.id);
      await addHumanToRoom(room, owner2);
      await addToRoom(owner2.token, room, b.id);
      const dm = await ensure(a.key, b.id);
      const roomId = dm.json().room.id as string;
      await send(a.key, roomId, 'hi');

      // A member who owns neither agent and administers nothing: 404 — the
      // control never confirms the conversation exists for a stranger.
      const bystander = await joinOrg(ts.app, owner.token, orgId, 'by@ex.com', 'Bystander');
      expect((await sever(bystander.token, roomId)).statusCode).toBe(404);

      // owner2 owns `beta` → may sever, recorded as an agent-owner sever.
      const res = await sever(owner2.token, roomId);
      expect(res.statusCode).toBe(200);
      expect(res.json().sever.authority).toBe('agent-owner');
      expect((await send(a.key, roomId)).statusCode).toBe(410);

      // The OTHER agent's owner may lift an agent-owner sever.
      expect((await allow(owner.token, roomId)).statusCode).toBe(200);
      expect((await ensure(a.key, b.id)).statusCode).toBe(200);
    });

    it('an org sever outranks an agent owner: only an org owner/admin may lift it', async () => {
      const owner2 = await joinOrg(ts.app, owner.token, orgId, 'o2@ex.com', 'Owner Two');
      const a = await makeAgent(ts.app, owner2.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner2.token, orgId, 'beta');
      const room = await createRoom(ts.app, owner.token, orgId, 'Shared');
      await addHumanToRoom(room, owner2);
      await addToRoom(owner2.token, room, a.id);
      await addToRoom(owner2.token, room, b.id);
      const dm = await ensure(a.key, b.id);
      const roomId = dm.json().room.id as string;
      await send(a.key, roomId, 'hi');

      expect((await sever(owner.token, roomId)).json().sever.authority).toBe('org');
      // owner2 owns BOTH agents, and still cannot undo the org's decision.
      const denied = await allow(owner2.token, roomId);
      expect(denied.statusCode).toBe(403);
      expect((await ensure(a.key, b.id)).statusCode).toBe(403);
      expect((await allow(owner.token, roomId)).statusCode).toBe(200);
      expect((await ensure(a.key, b.id)).statusCode).toBe(200);
    });

    it('live: both agents and the overseeing human hear dm.severed', async () => {
      const { a, roomId } = await pair();
      const base = await listen(ts);
      const agentSse = await openSse(base, '/api/v1/me/events', a.key);
      const humanSse = await openSse(base, '/api/v1/me/events', owner.token);
      await sever(owner.token, roomId);
      for (const sse of [agentSse, humanSse]) {
        const ev = await sse.waitFor((e) => e.event === 'dm.severed');
        expect((ev.data as any).roomId).toBe(roomId);
        expect((ev.data as any).severedAt).not.toBeNull();
        expect((ev.data as any).by.id).toBe(owner.userId);
        sse.close();
      }
    });

    it('a severed pair is refused even when the id is guessed by a third agent', async () => {
      const { a, b, roomId } = await pair();
      await sever(owner.token, roomId);
      // A fresh agent that never met either one still gets the generic refusal:
      // the sever message is only ever shown to the pair itself.
      const c = await makeAgent(ts.app, owner.token, orgId, 'gamma');
      const res = await ensure(c.key, b.id);
      expect(res.json().error.message).toBe(DM_NOT_ELIGIBLE_MESSAGE);
      expect((await ensure(a.key, b.id)).json().error.message).toBe(AGENT_DM_SEVERED_MESSAGE);
      expect(roomId).toBeDefined();
    });
  });
});
