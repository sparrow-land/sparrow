import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, auth, signup, firstOrgId, type TestServer } from './test-helpers.js';

/** Add a second human to `orgId` via an invite + auto-approve by the owner. */
async function joinOrg(
  ts: TestServer,
  ownerToken: string,
  orgId: string,
  human: { email: string; displayName?: string },
): Promise<{ token: string; userId: string }> {
  const invite = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${orgId}/invites`,
    headers: auth(ownerToken),
    payload: {},
  });
  const ivk = (invite.json().url as string).split('/invite/')[1]!;
  const member = await signup(ts.app, human);
  // Redeeming a valid invite grants membership immediately.
  await ts.app.inject({
    method: 'POST',
    url: `/api/v1/invite/${ivk}/enroll`,
    headers: auth(member.token),
    payload: {},
  });
  return member;
}

describe('orgs', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('POST /orgs creates an org (caller owner); GET/PATCH round-trip', async () => {
    const { token } = await signup(ts.app, { email: 'a@example.com', displayName: 'A' });
    const create = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(token),
      payload: { name: 'Acme' },
    });
    expect(create.statusCode).toBe(201);
    const orgId = create.json().org.id as string;
    expect(create.json().org.settings.invites.who).toBe('members');

    const get = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(token),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().org.name).toBe('Acme');

    const patch = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(token),
      payload: { name: 'Acme Inc', settings: { invites: { who: 'admins' } } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().org.name).toBe('Acme Inc');
    expect(patch.json().org.settings.invites.who).toBe('admins');
    // merged with defaults:
    expect(patch.json().org.settings.enroll.agents).toBe('approval');
  });

  it('POST /orgs blocked when orgs.openCreation is false', async () => {
    const closed = await makeTestServer({ openOrgCreation: false });
    const { token } = await signup(closed.app, { email: 'b@example.com' });
    const res = await closed.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(token),
      payload: { name: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
    await closed.close();
  });

  it('slug collision → 409', async () => {
    const { token } = await signup(ts.app, { email: 'c@example.com' });
    const first = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(token),
      payload: { name: 'One', slug: 'shared' },
    });
    expect(first.statusCode).toBe(201);
    const dup = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(token),
      payload: { name: 'Two', slug: 'shared' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('reserved slug → 409', async () => {
    const { token } = await signup(ts.app, { email: 'res@example.com' });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(token),
      payload: { name: 'Admin', slug: 'admin' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('non-member sees 404 for an org they are not in', async () => {
    const owner = await signup(ts.app, { email: 'own@example.com' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const outsider = await signup(ts.app, { email: 'out@example.com' });
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(outsider.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('roster + role changes: last-owner demotion 409; admin cannot touch owners', async () => {
    const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const bob = await joinOrg(ts, owner.token, orgId, { email: 'bob@example.com', displayName: 'Bob' });

    const roster = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/humans`,
      headers: auth(owner.token),
    });
    expect(roster.json().items).toHaveLength(2);

    // Demote the sole owner → 409.
    const demote = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/humans/${owner.userId}`,
      headers: auth(owner.token),
      payload: { role: 'member' },
    });
    expect(demote.statusCode).toBe(409);

    // Promote Bob to admin.
    const promote = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/humans/${bob.userId}`,
      headers: auth(owner.token),
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);

    // Admin Bob may not promote anyone to owner.
    const bobPromotesSelf = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/humans/${bob.userId}`,
      headers: auth(bob.token),
      payload: { role: 'owner' },
    });
    expect(bobPromotesSelf.statusCode).toBe(403);
  });

  it('removal: owns-agents 409; last-owner leave 409; member self-leave ok', async () => {
    const owner = await signup(ts.app, { email: 'o2@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);

    // Owner owns an agent → cannot be removed / leave.
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'bot' },
    });
    const ownsAgents = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/humans/${owner.userId}`,
      headers: auth(owner.token),
    });
    expect(ownsAgents.statusCode).toBe(409);

    // A plain member can self-leave.
    const bob = await joinOrg(ts, owner.token, orgId, { email: 'bob2@example.com' });
    const leave = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/humans/${bob.userId}`,
      headers: auth(bob.token),
    });
    expect(leave.statusCode).toBe(200);
    const roster = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/humans`,
      headers: auth(owner.token),
    });
    expect(roster.json().items).toHaveLength(1);
  });

  it('directory prefix search (capped, member-only)', async () => {
    const owner = await signup(ts.app, { email: 'dir@example.com', displayName: 'Diana' });
    const orgId = await firstOrgId(ts.app, owner.token);
    await joinOrg(ts, owner.token, orgId, { email: 'zoe@example.com', displayName: 'Zoe' });
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/directory?q=zo`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].displayName).toBe('Zoe');
  });

  it('governance agent list (owner/admin only)', async () => {
    const owner = await signup(ts.app, { email: 'g@example.com', displayName: 'Gov' });
    const orgId = await firstOrgId(ts.app, owner.token);
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'gizmo' },
    });
    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({
      agent: { name: 'gizmo' },
      owner: { id: owner.userId, displayName: 'Gov' },
    });

    // A plain member is forbidden from the governance list.
    const bob = await joinOrg(ts, owner.token, orgId, { email: 'gb@example.com' });
    const forbidden = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents`,
      headers: auth(bob.token),
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
