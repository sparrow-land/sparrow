import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  TEST_ADMIN_TOKEN,
  type TestServer,
} from './test-helpers.js';

/**
 * The managed-hosting seam (SPEC "Org resolution is a seam"): slug→org
 * resolution, the `ORG_HOST_SUFFIX` capability advertisement, and admin-token
 * org provisioning with an owner-pending invite.
 */
describe('org scoping seam', () => {
  let ts: TestServer;
  afterEach(async () => {
    if (ts) await ts.close();
  });

  describe('GET /orgs/resolve/:slug', () => {
    beforeEach(async () => {
      ts = await makeTestServer();
    });

    it('resolves a member`s org by slug (id, name, slug, role)', async () => {
      const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
      const created = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: auth(owner.token),
        payload: { name: 'Acme', slug: 'acme' },
      });
      const org = created.json().org as { id: string; name: string; slug: string };

      const res = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/orgs/resolve/acme',
        headers: auth(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        org: { id: org.id, name: 'Acme', slug: 'acme' },
        role: 'owner',
      });
    });

    it('404s for a non-member (does not leak existence)', async () => {
      const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
      await ts.app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: auth(owner.token),
        payload: { name: 'Acme', slug: 'acme' },
      });
      const outsider = await signup(ts.app, { email: 'x@example.com', displayName: 'X' });
      const res = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/orgs/resolve/acme',
        headers: auth(outsider.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s for an unknown slug (same as a non-member)', async () => {
      const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
      const res = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/orgs/resolve/nope',
        headers: auth(owner.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('401s without a session', async () => {
      await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
      const res = await ts.app.inject({ method: 'GET', url: '/api/v1/orgs/resolve/anything' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /capabilities orgHostSuffix', () => {
    it('is null when unconfigured', async () => {
      ts = await makeTestServer();
      const res = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
      expect(res.statusCode).toBe(200);
      expect(res.json().orgHostSuffix).toBeNull();
    });

    it('advertises the configured suffix', async () => {
      ts = await makeTestServer({ orgHostSuffix: '.sparrow.example' });
      const res = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
      expect(res.json().orgHostSuffix).toBe('.sparrow.example');
    });
  });

  describe('POST /admin/orgs (owner-pending provisioning)', () => {
    beforeEach(async () => {
      ts = await makeTestServer();
    });

    it('404s when ADMIN_TOKEN is unset', async () => {
      await ts.close();
      ts = await makeTestServer({ adminToken: undefined });
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        payload: { name: 'Tenant', slug: 'tenant' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('401s on a wrong admin token', async () => {
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': 'wrong' },
        payload: { name: 'Tenant', slug: 'tenant' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates an owner-pending org + owner invite; redeemer becomes owner', async () => {
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
        payload: { name: 'Tenant', slug: 'tenant' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { org: { id: string; slug: string }; url: string };
      expect(body.org.slug).toBe('tenant');
      expect(body.url).toContain('/invite/');

      // No members yet: admin org list shows zero humans.
      const adminOrgs = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
      });
      const row = (adminOrgs.json().items as { id: string; humanCount: number }[]).find(
        (o) => o.id === body.org.id,
      );
      expect(row?.humanCount).toBe(0);

      // A signed-in human redeems the owner invite → becomes owner instantly.
      const token = body.url.split('/invite/')[1]!;
      const human = await signup(ts.app, { email: 'first@example.com', displayName: 'First' });
      const enroll = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${token}/enroll`,
        headers: auth(human.token),
        payload: {},
      });
      expect(enroll.statusCode).toBe(201);
      expect(enroll.json()).toMatchObject({ role: 'owner', org: { slug: 'tenant' } });

      // They can now resolve the org and are its owner.
      const resolve = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/orgs/resolve/tenant',
        headers: auth(human.token),
      });
      expect(resolve.statusCode).toBe(200);
      expect(resolve.json().role).toBe('owner');
    });

    it('rejects a reserved slug (409) and a taken slug (409)', async () => {
      const reserved = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
        payload: { name: 'Bad', slug: 'admin' },
      });
      expect(reserved.statusCode).toBe(409);

      const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'O' });
      await ts.app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: auth(owner.token),
        payload: { name: 'Acme', slug: 'acme' },
      });
      const taken = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
        payload: { name: 'Acme2', slug: 'acme' },
      });
      expect(taken.statusCode).toBe(409);
    });

    it('rejects an invalid slug (400)', async () => {
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
        payload: { name: 'Bad', slug: 'Not A Slug' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('an anonymous (agent) knock on an owner invite 404s (no owner to own it)', async () => {
      const created = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
        payload: { name: 'Tenant', slug: 'tenant' },
      });
      const token = (created.json().url as string).split('/invite/')[1]!;
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${token}/enroll`,
        payload: { name: 'bot' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('effective-origin: host-aware absolute URLs', () => {
    it('member-invite URL uses the org-scoped Host when it matches ORG_HOST_SUFFIX', async () => {
      ts = await makeTestServer({
        baseUrl: 'https://example.com',
        orgHostSuffix: '.example.com',
      });
      const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
      const orgId = await firstOrgId(ts.app, owner.token);

      // Request arriving on the org subdomain → invite URL keeps that host.
      const scoped = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/invites`,
        headers: { ...auth(owner.token), host: 'acme.example.com' },
        payload: {},
      });
      expect(scoped.json().url).toMatch(/^https:\/\/acme\.example\.com\/invite\//);

      // Request on the apex (no slug) → static BASE_URL.
      const apex = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/invites`,
        headers: { ...auth(owner.token), host: 'example.com' },
        payload: {},
      });
      expect(apex.json().url).toMatch(/^https:\/\/example\.com\/invite\//);

      // Reserved label host → static BASE_URL (never treated as a slug).
      const reserved = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/invites`,
        headers: { ...auth(owner.token), host: 'www.example.com' },
        payload: {},
      });
      expect(reserved.json().url).toMatch(/^https:\/\/example\.com\/invite\//);
    });

    it('stays on BASE_URL when ORG_HOST_SUFFIX is unset', async () => {
      ts = await makeTestServer({ baseUrl: 'https://example.com' });
      const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
      const orgId = await firstOrgId(ts.app, owner.token);
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/invites`,
        headers: { ...auth(owner.token), host: 'acme.example.com' },
        payload: {},
      });
      expect(res.json().url).toMatch(/^https:\/\/example\.com\/invite\//);
    });

    it('admin owner-invite URL is host-aware too', async () => {
      ts = await makeTestServer({
        baseUrl: 'https://example.com',
        orgHostSuffix: '.example.com',
      });
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs',
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN, host: 'tenant.example.com' },
        payload: { name: 'Tenant', slug: 'tenant' },
      });
      expect(res.json().url).toMatch(/^https:\/\/tenant\.example\.com\/invite\//);
    });

    it('GET /auth/config loginUrl rides the effective origin per request', async () => {
      // Inject a provider exposing loginUrl (password has none); its URL must
      // reflect the request host on an org-scoped Host, else the static BASE_URL.
      ts = await makeTestServer({
        baseUrl: 'https://example.com',
        orgHostSuffix: '.example.com',
        providers: [
          {
            id: 'demo',
            label: 'Demo',
            kind: 'oauth-redirect',
            loginUrl: (origin) => `${origin}/api/v1/auth/demo`,
            register: () => {},
          },
        ],
      });

      const scoped = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/auth/config',
        headers: { host: 'acme.example.com' },
      });
      const demoScoped = (scoped.json().providers as { id: string; loginUrl?: string }[]).find(
        (p) => p.id === 'demo',
      );
      expect(demoScoped?.loginUrl).toBe('https://acme.example.com/api/v1/auth/demo');

      const apex = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/auth/config',
        headers: { host: 'example.com' },
      });
      const demoApex = (apex.json().providers as { id: string; loginUrl?: string }[]).find(
        (p) => p.id === 'demo',
      );
      expect(demoApex?.loginUrl).toBe('https://example.com/api/v1/auth/demo');
    });

    it('install.sh reflects the org-scoped Host', async () => {
      ts = await makeTestServer({
        baseUrl: 'https://example.com',
        orgHostSuffix: '.example.com',
      });
      const res = await ts.app.inject({
        method: 'GET',
        url: '/install.sh',
        headers: { host: 'acme.example.com' },
      });
      expect(res.body).toContain('BASE_URL="https://acme.example.com"');
    });
  });

  describe('normal invites still carry a real inviter', () => {
    beforeEach(async () => {
      ts = await makeTestServer();
    });

    it('a member-created invite lists with its inviter and admits as member', async () => {
      const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Owner' });
      const orgId = await firstOrgId(ts.app, owner.token);
      const member = await joinOrg(ts.app, owner.token, orgId, 'm@example.com', 'Mem');
      const meOrgs = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/me/orgs',
        headers: auth(member.token),
      });
      const roles = (meOrgs.json().items as { org: { id: string }; role: string }[]).find(
        (o) => o.org.id === orgId,
      );
      expect(roles?.role).toBe('member');
    });
  });
});
