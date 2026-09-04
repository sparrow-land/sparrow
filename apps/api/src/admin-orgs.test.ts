import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import {
  makeTestServer,
  auth,
  TEST_ADMIN_TOKEN,
  type TestServer,
} from './test-helpers.js';
import { openDb, type DbHandle } from './db/index.js';
import { humans, invites, orgMemberships } from './db/schema.js';
import type { AuthProvider } from './auth.js';

const adminHeader = { 'x-admin-token': TEST_ADMIN_TOKEN };

/**
 * A minimal injected SSO provider: `POST /api/v1/auth/sso` runs
 * `loginOrCreateUser` for a presented email, exactly as a real oauth-redirect
 * provider does after verifying an upstream identity. Lets tests exercise an SSO
 * sign-in against a pre-provisioned account.
 */
const ssoProvider: AuthProvider = {
  id: 'sso',
  label: 'SSO',
  kind: 'oauth-redirect',
  register(app, ctx) {
    app.post('/api/v1/auth/sso', (request, reply) => {
      const { email } = request.body as { email: string };
      const { user, token } = ctx.auth.loginOrCreateUser({ email, provider: 'sso' }, reply);
      return reply.send({ user, token });
    });
  },
};

/** Open a second read-only handle on the server's DB (WAL allows concurrent reads). */
function readDb(ts: TestServer): DbHandle {
  return openDb(ts.dataDir);
}

describe('admin org creation with a pre-provisioned owner', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts.close();
  });

  it('owner path: creates org + human + owner membership, org-base url, owner in response, no invite', async () => {
    ts = await makeTestServer({ baseUrl: 'https://example.com', orgHostSuffix: '.example.com' });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orgs',
      headers: { ...adminHeader, host: 'acme.example.com' },
      payload: { name: 'Acme', slug: 'acme', owner: { email: 'Owner@Example.com', displayName: 'Owner' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.org.slug).toBe('acme');
    // Org base URL — effective-origin org host, no invite path.
    expect(body.url).toBe('https://acme.example.com');
    expect(body.url).not.toContain('/invite/');
    // Owner echoed back with normalized (trim+lowercase) email.
    expect(body.owner).toBeDefined();
    expect(body.owner.email).toBe('owner@example.com');
    expect(typeof body.owner.id).toBe('string');

    const handle = readDb(ts);
    try {
      // Human created (no password, provider 'admin').
      const human = handle.db.select().from(humans).where(eq(humans.id, body.owner.id)).get();
      expect(human).toBeDefined();
      expect(human!.email).toBe('owner@example.com');
      expect(human!.passwordHash).toBeNull();
      expect(human!.provider).toBe('admin');
      // Owner membership in the new org.
      const memberships = handle.db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.orgId, body.org.id))
        .all();
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ humanId: body.owner.id, role: 'owner' });
      // No invite row minted for this org.
      const inviteRows = handle.db
        .select()
        .from(invites)
        .where(eq(invites.orgId, body.org.id))
        .all();
      expect(inviteRows).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('reuses an existing human by email and does not touch their other memberships', async () => {
    ts = await makeTestServer();
    // Pre-existing human owning a first org.
    const first = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orgs',
      headers: adminHeader,
      payload: { name: 'First', slug: 'first', owner: { email: 'reuse@example.com', displayName: 'Reuse' } },
    });
    const firstBody = first.json();

    // Second org for the SAME email (different case + whitespace).
    const second = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orgs',
      headers: adminHeader,
      payload: { name: 'Second', slug: 'second', owner: { email: '  REUSE@example.com  ' } },
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json();
    // Same human reused (same id), not duplicated.
    expect(secondBody.owner.id).toBe(firstBody.owner.id);

    const handle = readDb(ts);
    try {
      const allHumans = handle.db.select().from(humans).where(eq(humans.email, 'reuse@example.com')).all();
      expect(allHumans).toHaveLength(1);
      // The human now owns BOTH orgs; the first org's membership is untouched.
      const firstM = handle.db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.orgId, firstBody.org.id))
        .all();
      expect(firstM).toHaveLength(1);
      expect(firstM[0]).toMatchObject({ humanId: firstBody.owner.id, role: 'owner' });
      const secondM = handle.db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.orgId, secondBody.org.id))
        .all();
      expect(secondM).toHaveLength(1);
      expect(secondM[0]).toMatchObject({ humanId: firstBody.owner.id, role: 'owner' });
    } finally {
      handle.close();
    }
  });

  it('no-owner path is byte-for-byte unchanged: owner-pending org + invite URL, no owner field', async () => {
    ts = await makeTestServer({ baseUrl: 'https://example.com', orgHostSuffix: '.example.com' });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orgs',
      headers: { ...adminHeader, host: 'tenant.example.com' },
      payload: { name: 'Tenant', slug: 'tenant' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.owner).toBeUndefined();
    expect(body.url).toMatch(/^https:\/\/tenant\.example\.com\/invite\//);

    const handle = readDb(ts);
    try {
      // Owner-pending: no memberships, one owner invite (null inviter).
      expect(handle.db.select().from(orgMemberships).where(eq(orgMemberships.orgId, body.org.id)).all()).toHaveLength(0);
      const inviteRows = handle.db.select().from(invites).where(eq(invites.orgId, body.org.id)).all();
      expect(inviteRows).toHaveLength(1);
      expect(inviteRows[0]!.inviterHumanId).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('invalid owner email → 400', async () => {
    ts = await makeTestServer();
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orgs',
      headers: adminHeader,
      payload: { name: 'Bad', slug: 'bad', owner: { email: 'not-an-email' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SSO sign-in of a pre-provisioned owner matches the existing human and does not bootstrap', async () => {
    ts = await makeTestServer({ providers: [ssoProvider] });
    // Managed-instance posture: no first-signup org bootstrap.
    await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: adminHeader,
      payload: { values: { 'auth.bootstrapFirstOrg': false } },
    });

    // Pre-provision the org + owner via the admin endpoint (creates the human).
    const created = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orgs',
      headers: adminHeader,
      payload: { name: 'Provisioned', slug: 'provisioned', owner: { email: 'owner@corp.com', displayName: 'Owner' } },
    });
    const createdBody = created.json();

    // A later SSO sign-in with the owner's email resolves the SAME human…
    const signIn = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso',
      payload: { email: 'owner@corp.com' },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().user.id).toBe(createdBody.owner.id);

    // …and did NOT create a second human or any extra org (no first-user bootstrap).
    const handle = readDb(ts);
    try {
      expect(handle.db.select().from(humans).where(eq(humans.email, 'owner@corp.com')).all()).toHaveLength(1);
      // Only the one pre-provisioned membership exists — sign-in founded nothing.
      const allMemberships = handle.db.select().from(orgMemberships).all();
      expect(allMemberships).toHaveLength(1);
      expect(allMemberships[0]).toMatchObject({ humanId: createdBody.owner.id, role: 'owner' });
    } finally {
      handle.close();
    }

    // The owner sees exactly the provisioned org, as owner.
    const meOrgs = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/orgs',
      headers: auth(signIn.json().token),
    });
    const items = meOrgs.json().items as { org: { id: string }; role: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ org: { id: createdBody.org.id }, role: 'owner' });
  });
});
