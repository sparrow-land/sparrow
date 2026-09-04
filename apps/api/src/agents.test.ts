import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, auth, signup, firstOrgId, createInvite, type TestServer } from './test-helpers.js';

/** Add `email` to `orgId` as a plain member. Returns the member. */
async function joinOrg(
  ts: TestServer,
  ownerToken: string,
  orgId: string,
  email: string,
  displayName?: string,
): Promise<{ token: string; userId: string }> {
  const inv = await createInvite(ts.app, ownerToken, orgId);
  const member = await signup(ts.app, { email, displayName });
  // Redeeming a valid invite grants membership immediately.
  await ts.app.inject({
    method: 'POST',
    url: `/api/v1/invite/${inv.token}/enroll`,
    headers: auth(member.token),
    payload: {},
  });
  return member;
}

describe('agents & visibility', () => {
  let ts: TestServer;
  let owner: { token: string; userId: string };
  let orgId: string;
  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  async function makeAgent(name: string): Promise<{ id: string; key: string }> {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name },
    });
    return { id: res.json().agent.id as string, key: res.json().key as string };
  }

  it('create → 201 { agent, key }; duplicate name → 409', async () => {
    const create = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'solo' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().key.startsWith('agk_')).toBe(true);
    expect(create.json().agent).toMatchObject({ name: 'solo', orgId, online: false });
    expect(create.json().agent.lastSeenAt).toBeNull();

    const dup = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'solo' },
    });
    expect(dup.statusCode).toBe(409);

    // v4: names are the local part of an email address, so they are lowercase —
    // the case-variant that used to probe case-insensitive uniqueness is now a
    // shape violation (400), not a collision (409).
    const shouty = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'SOLO' },
    });
    expect(shouty.statusCode).toBe(400);
  });

  it('rotate kills the old key', async () => {
    const agent = await makeAgent('rot');
    const rotate = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${agent.id}/rotate`,
      headers: auth(owner.token),
    });
    expect(rotate.statusCode).toBe(200);
    const newKey = rotate.json().key as string;
    expect(newKey).not.toBe(agent.key);

    const oldDead = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(agent.key) });
    expect(oldDead.statusCode).toBe(401);
    const newWorks = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(newKey) });
    expect(newWorks.statusCode).toBe(200);
  });

  it('delete removes the agent (key dies)', async () => {
    const agent = await makeAgent('gone');
    const del = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${agent.id}`,
      headers: auth(owner.token),
    });
    expect(del.json()).toEqual({ ok: true });
    const dead = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(agent.key) });
    expect(dead.statusCode).toBe(401);
  });

  it('share → grantee sees it (sharedBy set); owner row irrevocable; grantee cannot re-share', async () => {
    const agent = await makeAgent('shared-bot');
    const bob = await joinOrg(ts, owner.token, orgId, 'bob@example.com');

    // Share by email.
    const share = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${agent.id}/share`,
      headers: auth(owner.token),
      payload: { human: 'bob@example.com' },
    });
    expect(share.statusCode).toBe(201);
    // Idempotent second share → 200.
    const again = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${agent.id}/share`,
      headers: auth(owner.token),
      payload: { human: bob.userId },
    });
    expect(again.statusCode).toBe(200);

    // Bob sees the agent with sharedBy = the owner, no rooms (not owned).
    const bobList = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/agents',
      headers: auth(bob.token),
    });
    const entry = bobList.json().items.find((a: { agent: { name: string } }) => a.agent.name === 'shared-bot');
    expect(entry.sharedBy).toMatchObject({ id: owner.userId });
    expect(entry.rooms).toBeUndefined();

    // Bob (grantee) cannot re-share.
    const carol = await joinOrg(ts, owner.token, orgId, 'carol@example.com');
    const reshare = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${agent.id}/share`,
      headers: auth(bob.token),
      payload: { human: carol.userId },
    });
    expect(reshare.statusCode).toBe(404);

    // Owner's own row cannot be revoked.
    const revokeOwner = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${agent.id}/share/${owner.userId}`,
      headers: auth(owner.token),
    });
    expect(revokeOwner.statusCode).toBe(400);

    // Unshare Bob → he no longer sees it.
    const unshare = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${agent.id}/share/${bob.userId}`,
      headers: auth(owner.token),
    });
    expect(unshare.json()).toEqual({ ok: true });
    const after = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/agents',
      headers: auth(bob.token),
    });
    expect(after.json().items.find((a: { agent: { name: string } }) => a.agent.name === 'shared-bot')).toBeUndefined();
  });

  it('share target must be a member of the agent’s org → 403', async () => {
    const agent = await makeAgent('picky');
    const outsider = await signup(ts.app, { email: 'out@example.com' });
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${agent.id}/share`,
      headers: auth(owner.token),
      payload: { human: outsider.userId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('owned-agent list carries rooms; org-scoped /orgs/:orgId/me/agents matches', async () => {
    await makeAgent('roomy');
    const list = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
    });
    const entry = list.json().items.find((a: { agent: { name: string } }) => a.agent.name === 'roomy');
    // Owned → rooms present (the owner↔agent DM is NOT auto-created for direct
    // creation, so this is an empty array).
    expect(Array.isArray(entry.rooms)).toBe(true);

    const orgScoped = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/agents`,
      headers: auth(owner.token),
    });
    expect(orgScoped.json().items.some((a: { agent: { name: string } }) => a.agent.name === 'roomy')).toBe(true);
  });

  it('owned agent: rooms carry memberId + sharedWith reflects grants (both absent on shared-to-you)', async () => {
    const agent = await makeAgent('detachable');
    const bob = await joinOrg(ts, owner.token, orgId, 'bob@example.com', 'Bob');

    // Attach the agent to a room the owner created.
    const room = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/rooms`,
      headers: auth(owner.token),
      payload: { name: 'ops' },
    });
    const roomId = room.json().room.id as string;
    const add = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    const agentMemberId = add.json().member.id as string;

    // Share with Bob.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${agent.id}/share`,
      headers: auth(owner.token),
      payload: { human: bob.userId },
    });

    const ownerList = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/agents?org=${orgId}`,
      headers: auth(owner.token),
    });
    const owned = ownerList.json().items.find((a: { agent: { name: string } }) => a.agent.name === 'detachable');
    expect(owned.rooms).toEqual([{ id: roomId, name: 'ops', memberId: agentMemberId }]);
    // With the email medium off there is nothing to count — for anyone, owner
    // included. `null` folds into the AGENTS badge as nothing.
    expect(owned.emailUnreadCount).toBeNull();
    expect(owned.sharedWith).toEqual([
      { id: bob.userId, displayName: 'Bob', createdAt: expect.any(String) },
    ]);

    // Bob sees it shared-to-him: no rooms, no sharedWith.
    const bobList = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/agents?org=${orgId}`,
      headers: auth(bob.token),
    });
    const shared = bobList.json().items.find((a: { agent: { name: string } }) => a.agent.name === 'detachable');
    expect(shared.rooms).toBeUndefined();
    expect(shared.sharedWith).toBeUndefined();
  });
});
