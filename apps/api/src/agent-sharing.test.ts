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
  type TestServer,
} from './test-helpers.js';

/**
 * Agent-level sharing modes (`selected` | `room-members` | `org`). The default
 * `selected` preserves today's explicit-grant behavior; the two dynamic modes
 * widen access without minting explicit `agent_visibility` rows. Exercised
 * through the visibility list (GET /orgs/:orgId/me/agents), the DM-ensure gate
 * (POST /me/dms), the AddMember gate (POST /rooms/:roomId/members), and the
 * owner-only PATCH /me/agents/:id.
 */
describe('agent sharing modes', () => {
  let ts: TestServer;
  let owner: { token: string; userId: string };
  let orgId: string;
  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@ex.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  /** Add an agent to a room (caller must be a room member with agent visibility). */
  async function addAgentToRoom(token: string, roomId: string, agentId: string) {
    return ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(token),
      payload: { principal: agentId },
    });
  }

  /** Invite a human to a room and accept as that human → they become a member. */
  async function addHumanToRoom(roomId: string, human: { token: string; userId: string }) {
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: human.userId },
    });
    if (inv.statusCode >= 300) throw new Error(`invite failed: ${inv.statusCode} ${inv.body}`);
    const invitationId = inv.json().invitation.id as string;
    const accept = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${invitationId}/accept`,
      headers: auth(human.token),
      payload: {},
    });
    if (accept.statusCode >= 300) throw new Error(`accept failed: ${accept.statusCode} ${accept.body}`);
  }

  /** Whether an agent shows up in the caller's org-scoped visibility list. */
  async function seesAgent(token: string, agentId: string): Promise<boolean> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/agents`,
      headers: auth(token),
    });
    // A non-member gets 404 (no `items`) — treat that as "cannot see".
    const items = res.json().items as { agent: { id: string } }[] | undefined;
    return Array.isArray(items) && items.some((e) => e.agent.id === agentId);
  }

  /** Status of a DM-ensure between the caller and an agent. */
  async function ensureDmStatus(token: string, agentId: string): Promise<number> {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(token),
      payload: { principal: agentId },
    });
    return res.statusCode;
  }

  /** Open (ensure) the DM room with an agent and return its room id. */
  async function openDm(token: string, agentId: string): Promise<string> {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(token),
      payload: { principal: agentId },
    });
    if (res.statusCode >= 300) throw new Error(`openDm failed: ${res.statusCode} ${res.body}`);
    return res.json().room.id as string;
  }

  /** Send a message into a room; returns the HTTP status. */
  async function sendStatus(token: string, roomId: string, body = 'hi'): Promise<number> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(token),
      payload: { body },
    });
    return res.statusCode;
  }

  /** List a room's message history; returns the HTTP status. */
  async function historyStatus(token: string, roomId: string): Promise<number> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(token),
    });
    return res.statusCode;
  }

  async function setSharing(token: string, agentId: string, sharing: string) {
    return ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/me/agents/${agentId}`,
      headers: auth(token),
      payload: { sharing },
    });
  }

  /* ------------------------ default: room-members -------------------- */

  it('defaults to `room-members`; an org member with no shared room still has no access', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    // Wire shape carries the mode; new agents default to room-members.
    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/agents`,
      headers: auth(owner.token),
    });
    expect(list.json().items[0].agent.sharing).toBe('room-members');

    // Dynamic access needs an actual shared room — mere org co-membership is not enough.
    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    expect(await seesAgent(mira.token, agent.id)).toBe(false);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(403);
  });

  /* ------------------------------ selected ---------------------------- */

  it('selected: only explicitly granted humans see or DM it', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    expect((await setSharing(owner.token, agent.id, 'selected')).statusCode).toBe(200);

    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    expect(await seesAgent(mira.token, agent.id)).toBe(false);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(403);

    // An explicit grant still works under `selected`.
    await shareAgent(ts.app, owner.token, agent.id, mira.userId);
    expect(await seesAgent(mira.token, agent.id)).toBe(true);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(201);
  });

  /* ----------------------------- room-members ------------------------ */

  it('room-members: a co-member sees + DMs the agent, and loses access when it leaves the last shared room', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    await setSharing(owner.token, agent.id, 'room-members');
    const roomA = await createRoom(ts.app, owner.token, orgId, 'ops');
    const addRes = await addAgentToRoom(owner.token, roomA, agent.id);
    expect(addRes.statusCode).toBe(201);
    const agentMemberId = addRes.json().member.id as string;

    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    // Before sharing a room, no access.
    expect(await seesAgent(mira.token, agent.id)).toBe(false);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(403);

    // Co-membership in a non-DM room grants access.
    await addHumanToRoom(roomA, mira);
    expect(await seesAgent(mira.token, agent.id)).toBe(true);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(201);

    // The DM room (now their only shared room) does NOT itself confer access:
    // once the agent leaves the project room, access is gone.
    const del = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomA}/members/${agentMemberId}`,
      headers: auth(owner.token),
    });
    expect(del.statusCode).toBeLessThan(300);
    expect(await seesAgent(mira.token, agent.id)).toBe(false);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(403);
  });

  it('room-members: archiving the last shared room removes access', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    await setSharing(owner.token, agent.id, 'room-members');
    const roomA = await createRoom(ts.app, owner.token, orgId, 'ops');
    await addAgentToRoom(owner.token, roomA, agent.id);
    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    await addHumanToRoom(roomA, mira);
    expect(await seesAgent(mira.token, agent.id)).toBe(true);

    const archive = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomA}`,
      headers: auth(owner.token),
      payload: { archived: true },
    });
    expect(archive.statusCode).toBeLessThan(300);
    expect(await seesAgent(mira.token, agent.id)).toBe(false);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(403);
  });

  it('room-members: a co-member may add the agent to another room without an explicit grant', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    await setSharing(owner.token, agent.id, 'room-members');
    const roomA = await createRoom(ts.app, owner.token, orgId, 'ops');
    await addAgentToRoom(owner.token, roomA, agent.id);
    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    await addHumanToRoom(roomA, mira);

    // Mira owns roomB and can attach the agent (access via co-membership in roomA).
    const roomB = await createRoom(ts.app, mira.token, orgId, 'mira-room');
    expect((await addAgentToRoom(mira.token, roomB, agent.id)).statusCode).toBe(201);
  });

  /* -------------------------------- org ------------------------------ */

  it('org: every org member sees + DMs the agent; a non-org human never does', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    await setSharing(owner.token, agent.id, 'org');
    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    expect(await seesAgent(mira.token, agent.id)).toBe(true);
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(201);

    // A human in a different org (their own bootstrap org) can never reach it.
    const outsider = await signup(ts.app, { email: 'out@ex.com', displayName: 'Out' });
    expect(await seesAgent(outsider.token, agent.id)).toBe(false);
    expect(await ensureDmStatus(outsider.token, agent.id)).toBe(403);
  });

  it('org: a member may add the agent to a room without an explicit grant', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    await setSharing(owner.token, agent.id, 'org');
    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    const room = await createRoom(ts.app, mira.token, orgId, 'mira-room');
    expect((await addAgentToRoom(mira.token, room, agent.id)).statusCode).toBe(201);
  });

  /* ------------------------------- PATCH ----------------------------- */

  it('PATCH /me/agents/:id is owner-only and validates the mode', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');

    // Owner may change it.
    const ok = await setSharing(owner.token, agent.id, 'org');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().agent.sharing).toBe('org');

    // A non-owner (even an org member) may not — 403.
    expect((await setSharing(mira.token, agent.id, 'selected')).statusCode).toBe(403);
    // Unchanged by the forbidden attempt.
    const after = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/agents`,
      headers: auth(owner.token),
    });
    expect(after.json().items[0].agent.sharing).toBe('org');

    // Invalid mode → 400.
    expect((await setSharing(owner.token, agent.id, 'everyone')).statusCode).toBe(400);
  });

  /* ---------------- existing-DM send gate (revocation) --------------- */

  it('selected downgrade refuses sends into an existing human→agent DM, but leaves owner/agent/history intact', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    await setSharing(owner.token, agent.id, 'room-members');
    const roomA = await createRoom(ts.app, owner.token, orgId, 'ops');
    await addAgentToRoom(owner.token, roomA, agent.id);

    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    await addHumanToRoom(roomA, mira);

    // With access, Mira opens a DM and can send into it.
    const miraDm = await openDm(mira.token, agent.id);
    expect(await sendStatus(mira.token, miraDm)).toBe(201);

    // Owner's own DM with the agent (owner holds implicit mint-time visibility).
    const ownerDm = await openDm(owner.token, agent.id);
    expect(await sendStatus(owner.token, ownerDm)).toBe(201);

    // Downgrade to `selected` revokes Mira's dynamic access.
    expect((await setSharing(owner.token, agent.id, 'selected')).statusCode).toBe(200);

    // The existing private DM channel must no longer accept Mira's sends.
    expect(await sendStatus(mira.token, miraDm)).toBe(403);
    // New DM creation is also refused (unchanged behavior).
    expect(await ensureDmStatus(mira.token, agent.id)).toBe(403);

    // Owner is unaffected — owners always retain access.
    expect(await sendStatus(owner.token, ownerDm)).toBe(201);

    // The agent→human direction is never gated: the agent may still reply.
    expect(await sendStatus(agent.key, miraDm)).toBe(201);

    // History stays readable to Mira (membership-based reads survive revocation).
    expect(await historyStatus(mira.token, miraDm)).toBe(200);
  });

  it('room-members: removing the shared room refuses existing-DM sends; restoring it re-enables them', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    await setSharing(owner.token, agent.id, 'room-members');
    const roomA = await createRoom(ts.app, owner.token, orgId, 'ops');
    const addRes = await addAgentToRoom(owner.token, roomA, agent.id);
    const agentMemberId = addRes.json().member.id as string;

    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    await addHumanToRoom(roomA, mira);

    const miraDm = await openDm(mira.token, agent.id);
    expect(await sendStatus(mira.token, miraDm)).toBe(201);

    // Agent leaves the last shared room → Mira loses dynamic access.
    const del = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomA}/members/${agentMemberId}`,
      headers: auth(owner.token),
    });
    expect(del.statusCode).toBeLessThan(300);
    expect(await sendStatus(mira.token, miraDm)).toBe(403);
    // History remains readable.
    expect(await historyStatus(mira.token, miraDm)).toBe(200);

    // Re-add the agent to the shared room → access (and sends) return.
    expect((await addAgentToRoom(owner.token, roomA, agent.id)).statusCode).toBe(201);
    expect(await sendStatus(mira.token, miraDm)).toBe(201);
  });

  it('explicit grants still confer access under every mode', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bee');
    const mira = await joinOrg(ts.app, owner.token, orgId, 'mira@ex.com', 'Mira');
    await shareAgent(ts.app, owner.token, agent.id, mira.userId);
    for (const mode of ['selected', 'room-members', 'org']) {
      await setSharing(owner.token, agent.id, mode);
      expect(await seesAgent(mira.token, agent.id)).toBe(true);
      // DM-ensure is idempotent: 201 the first time, 200 once the room exists.
      expect(await ensureDmStatus(mira.token, agent.id)).toBeLessThan(300);
    }
  });
});
