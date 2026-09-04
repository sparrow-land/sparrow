import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, auth, signup, firstOrgId, createInvite, type TestServer } from './test-helpers.js';

async function joinOrgAsAdmin(
  ts: TestServer,
  ownerToken: string,
  orgId: string,
  email: string,
): Promise<{ token: string; userId: string }> {
  const inv = await createInvite(ts.app, ownerToken, orgId);
  const member = await signup(ts.app, { email });
  // Redeeming a valid invite grants membership immediately.
  await ts.app.inject({
    method: 'POST',
    url: `/api/v1/invite/${inv.token}/enroll`,
    headers: auth(member.token),
    payload: {},
  });
  await ts.app.inject({
    method: 'PATCH',
    url: `/api/v1/orgs/${orgId}/humans/${member.userId}`,
    headers: auth(ownerToken),
    payload: { role: 'admin' },
  });
  return member;
}

describe('invites', () => {
  let ts: TestServer;
  let ownerToken: string;
  let orgId: string;
  beforeEach(async () => {
    ts = await makeTestServer();
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    ownerToken = owner.token;
    orgId = await firstOrgId(ts.app, ownerToken);
  });
  afterEach(async () => {
    await ts.close();
  });

  it('create returns the token once inside url; list never leaks it', async () => {
    const create = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: auth(ownerToken),
      payload: { note: 'come join' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.url).toContain('/invite/ivk_');
    expect(body.invite.note).toBe('come join');
    expect(body.invite).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(body.invite)).not.toContain('ivk_');

    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: auth(ownerToken),
    });
    expect(list.json().items).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain('ivk_');
  });

  it('GET /invite/:token/info returns landing metadata; unknown → 404, revoked → 410', async () => {
    const inv = await createInvite(ts.app, ownerToken, orgId, 'welcome');
    const info = await ts.app.inject({ method: 'GET', url: `/api/v1/invite/${inv.token}/info` });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({
      org: { name: "Owner's org" },
      inviter: { displayName: 'Owner', email: 'owner@example.com' },
      agentPolicy: 'approval',
    });
    // No ids / slug leak (inviter email IS surfaced next to the name).
    expect(JSON.stringify(info.json())).not.toContain('org_');

    // Reflects the org's agent policy.
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(ownerToken),
      payload: { settings: { enroll: { agents: 'open' } } },
    });
    const open = await ts.app.inject({ method: 'GET', url: `/api/v1/invite/${inv.token}/info` });
    expect(open.json().agentPolicy).toBe('open');

    // Bogus token → 404.
    const bogus = await ts.app.inject({ method: 'GET', url: '/api/v1/invite/ivk_bogus/info' });
    expect(bogus.statusCode).toBe(404);

    // Revoked token → 410 naming the revocation (it WAS a real door). Full
    // matrix — unknown / revoked / expired, on `/info` and `/enroll` — lives in
    // invite-dead.test.ts.
    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/invites/${inv.id}`,
      headers: auth(ownerToken),
    });
    const revoked = await ts.app.inject({ method: 'GET', url: `/api/v1/invite/${inv.token}/info` });
    expect(revoked.statusCode).toBe(410);
    expect(revoked.json().error.message).toMatch(/revoked/i);
  });

  it('revoke sets revokedAt and returns { ok: true }', async () => {
    const inv = await createInvite(ts.app, ownerToken, orgId);
    const revoke = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/invites/${inv.id}`,
      headers: auth(ownerToken),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true });
    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: auth(ownerToken),
    });
    expect(list.json().items[0].revokedAt).not.toBeNull();
  });

  it('invites.who=admins blocks a plain member from creating', async () => {
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(ownerToken),
      payload: { settings: { invites: { who: 'admins' } } },
    });
    // Add a plain member (redeeming a valid invite grants membership immediately).
    const inv = await createInvite(ts.app, ownerToken, orgId);
    const member = await signup(ts.app, { email: 'plain@example.com' });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      headers: auth(member.token),
      payload: {},
    });
    const blocked = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: auth(member.token),
      payload: {},
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('members see only their own invites; admins see all; non-inviter member cannot revoke', async () => {
    const admin = await joinOrgAsAdmin(ts, ownerToken, orgId, 'admin2@example.com');
    const ownerInvite = await createInvite(ts.app, ownerToken, orgId);
    const adminInvite = await createInvite(ts.app, admin.token, orgId);

    // Admin sees all (both).
    const adminList = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: auth(admin.token),
    });
    expect(adminList.json().items.length).toBeGreaterThanOrEqual(2);

    // Admin can revoke the owner's invite (org admin).
    const revoke = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/invites/${ownerInvite.id}`,
      headers: auth(admin.token),
    });
    expect(revoke.statusCode).toBe(200);
    void adminInvite;
  });
});
