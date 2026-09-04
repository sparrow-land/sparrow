import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  TEST_ADMIN_TOKEN,
  type TestServer,
} from './test-helpers.js';
import { openDb, type DbHandle } from './db/index.js';
import { humans, orgMemberships } from './db/schema.js';
import type { AuthProvider } from './auth.js';

const adminHeader = { 'x-admin-token': TEST_ADMIN_TOKEN };

/**
 * A minimal injected SSO provider: `POST /api/v1/auth/sso` runs
 * `loginOrCreateUser` for a presented email (+ optional secondary `emails`),
 * exactly as a real oauth-redirect provider does after verifying an upstream
 * identity. Lets tests exercise an SSO sign-in against a pre-provisioned account.
 */
const ssoProvider: AuthProvider = {
  id: 'sso',
  label: 'SSO',
  kind: 'oauth-redirect',
  register(app, ctx) {
    app.post('/api/v1/auth/sso', (request, reply) => {
      const { email, emails } = request.body as { email: string; emails?: string[] };
      const { user, token } = ctx.auth.loginOrCreateUser({ email, emails, provider: 'sso' }, reply);
      return reply.send({ user, token });
    });
  },
};

function readDb(ts: TestServer): DbHandle {
  return openDb(ts.dataDir);
}

async function addMember(
  ts: TestServer,
  token: string,
  orgId: string,
  body: { email: string; role?: string },
) {
  return ts.app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${orgId}/members`,
    headers: auth(token),
    payload: body,
  });
}

describe('POST /orgs/:orgId/members — add a member directly by email', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('happy path: creates a human + membership; appears in the roster', async () => {
    const owner = await signup(ts.app, { email: 'owner@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);

    const res = await addMember(ts, owner.token, orgId, { email: 'New.Person@Acme.com' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Email normalized; default role is member; roster human shape.
    expect(body.member.role).toBe('member');
    expect(body.member.human.email).toBe('new.person@acme.com');
    expect(typeof body.member.human.id).toBe('string');
    expect(body.member.human.displayName).toBe('new.person@acme.com');

    const handle = readDb(ts);
    try {
      const human = handle.db.select().from(humans).where(eq(humans.id, body.member.human.id)).get();
      expect(human).toBeDefined();
      expect(human!.passwordHash).toBeNull();
      expect(human!.provider).toBe('admin');
    } finally {
      handle.close();
    }

    // Shows up in the org roster like anyone else.
    const roster = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/humans`,
      headers: auth(owner.token),
    });
    const emails = (roster.json().items as { human: { email: string } }[]).map((m) => m.human.email);
    expect(emails).toContain('new.person@acme.com');
  });

  it('reuses an existing human (no duplicate account)', async () => {
    const owner = await signup(ts.app, { email: 'owner2@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    // An existing human on the instance, not in this org.
    const existing = await signup(ts.app, { email: 'existing@acme.com', displayName: 'Ex' });

    const res = await addMember(ts, owner.token, orgId, { email: 'existing@acme.com' });
    expect(res.statusCode).toBe(201);
    expect(res.json().member.human.id).toBe(existing.userId);
    // Existing display name preserved (not overwritten with the email).
    expect(res.json().member.human.displayName).toBe('Ex');

    const handle = readDb(ts);
    try {
      expect(handle.db.select().from(humans).where(eq(humans.email, 'existing@acme.com')).all()).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('adding someone already in the org → 409', async () => {
    const owner = await signup(ts.app, { email: 'owner3@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@acme.com', 'Bob');
    void bob;

    const res = await addMember(ts, owner.token, orgId, { email: 'bob@acme.com' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('invalid email → 400', async () => {
    const owner = await signup(ts.app, { email: 'owner4@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const res = await addMember(ts, owner.token, orgId, { email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
  });

  it('can add with an elevated (non-owner) role', async () => {
    const owner = await signup(ts.app, { email: 'owner5@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const res = await addMember(ts, owner.token, orgId, { email: 'lead@acme.com', role: 'admin' });
    expect(res.statusCode).toBe(201);
    expect(res.json().member.role).toBe('admin');
  });

  it('role=owner is rejected (400 — ownership goes through role management)', async () => {
    const owner = await signup(ts.app, { email: 'owner5b@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const res = await addMember(ts, owner.token, orgId, { email: 'x@acme.com', role: 'owner' });
    expect(res.statusCode).toBe(400);
  });

  it('a plain member is forbidden (403)', async () => {
    const owner = await signup(ts.app, { email: 'owner6@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const bob = await joinOrg(ts.app, owner.token, orgId, 'bob6@acme.com', 'Bob');
    const res = await addMember(ts, bob.token, orgId, { email: 'nope@acme.com' });
    expect(res.statusCode).toBe(403);
  });

  it('a non-member caller sees 404 (orgs never leak)', async () => {
    const owner = await signup(ts.app, { email: 'owner7@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const outsider = await signup(ts.app, { email: 'out7@acme.com' });
    const res = await addMember(ts, outsider.token, orgId, { email: 'nope@acme.com' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /orgs/:orgId/members — later SSO sign-in matches the pre-provisioned human', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts.close();
  });

  it('added human signs in via SSO (email among emails[]) → same human, no duplicate, no bootstrap', async () => {
    ts = await makeTestServer({ providers: [ssoProvider] });
    // Managed-instance posture: no first-signup org bootstrap.
    await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: adminHeader,
      payload: { values: { 'auth.bootstrapFirstOrg': false } },
    });

    // Provision an org + owner via admin; sign that owner in via SSO to act.
    const created = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orgs',
      headers: adminHeader,
      payload: { name: 'Provisioned', slug: 'provisioned', owner: { email: 'boss@corp.com', displayName: 'Boss' } },
    });
    const orgId = created.json().org.id as string;
    const ownerSignIn = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso',
      payload: { email: 'boss@corp.com' },
    });
    const ownerToken = ownerSignIn.json().token as string;

    // Owner adds a person by email — pre-provisioning a human + membership.
    const added = await addMember(ts, ownerToken, orgId, { email: 'added@corp.com' });
    expect(added.statusCode).toBe(201);
    const addedId = added.json().member.human.id as string;

    // A later SSO sign-in presenting the added address as a SECONDARY email
    // (primary differs) resolves the SAME human via multi-email matching.
    const signIn = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso',
      payload: { email: 'added.personal@gmail.com', emails: ['added.personal@gmail.com', 'added@corp.com'] },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().user.id).toBe(addedId);

    const handle = readDb(ts);
    try {
      // No duplicate human minted; matching a secondary left the stored email intact.
      expect(handle.db.select().from(humans).where(eq(humans.email, 'added@corp.com')).all()).toHaveLength(1);
      expect(handle.db.select().from(humans).where(eq(humans.email, 'added.personal@gmail.com')).all()).toHaveLength(0);
      // Only the two pre-provisioned memberships (owner + added); no bootstrap org.
      const all = handle.db.select().from(orgMemberships).all();
      expect(all).toHaveLength(2);
    } finally {
      handle.close();
    }

    // The added person sees exactly the one org, as a member.
    const meOrgs = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/orgs',
      headers: auth(signIn.json().token),
    });
    const items = meOrgs.json().items as { org: { id: string }; role: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ org: { id: orgId }, role: 'member' });
  });
});
