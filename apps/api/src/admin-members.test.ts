import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  makeAgent,
  TEST_ADMIN_TOKEN,
  type TestServer,
} from './test-helpers.js';
import { openDb, type DbHandle } from './db/index.js';
import { humans, invites, orgMemberships } from './db/schema.js';

const adminHeader = { 'x-admin-token': TEST_ADMIN_TOKEN };

function readDb(ts: TestServer): DbHandle {
  return openDb(ts.dataDir);
}

/** Provision an org + owner via the admin endpoint; returns ids. */
async function provisionOrg(
  ts: TestServer,
  slug: string,
  ownerEmail: string,
): Promise<{ orgId: string; ownerId: string }> {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/v1/admin/orgs',
    headers: adminHeader,
    payload: { name: slug, slug, owner: { email: ownerEmail, displayName: 'Owner' } },
  });
  if (res.statusCode !== 201) throw new Error(`provisionOrg failed (${res.statusCode}): ${res.body}`);
  const body = res.json();
  return { orgId: body.org.id as string, ownerId: body.owner.id as string };
}

describe('admin org-member management (X-Admin-Token)', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  /* ------------------------------- auth ------------------------------ */
  describe('auth', () => {
    it('a wrong/absent admin token → 401 on all three verbs', async () => {
      const { orgId, ownerId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const bad = { 'x-admin-token': 'nope' };

      const list = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: bad,
      });
      expect(list.statusCode).toBe(401);

      const add = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: bad,
        payload: { email: 'x@acme.com' },
      });
      expect(add.statusCode).toBe(401);

      const del = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/orgs/${orgId}/members/${ownerId}`,
        headers: bad,
      });
      expect(del.statusCode).toBe(401);
    });
  });

  /* ------------------------------- GET ------------------------------- */
  describe('GET /admin/orgs/:orgId/members', () => {
    it('returns the roster as { members: [{ human:{id,email,displayName}, role }] }', async () => {
      const { orgId, ownerId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'dev@acme.com', role: 'admin' },
      });

      const res = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
      });
      expect(res.statusCode).toBe(200);
      const members = res.json().members as { human: { id: string; email: string; displayName: string }; role: string }[];
      expect(members).toHaveLength(2);
      const byId = new Map(members.map((m) => [m.human.id, m]));
      expect(byId.get(ownerId)!.role).toBe('owner');
      expect(byId.get(ownerId)!.human.email).toBe('owner@acme.com');
      const dev = members.find((m) => m.human.email === 'dev@acme.com')!;
      expect(dev.role).toBe('admin');
      expect(typeof dev.human.id).toBe('string');
      expect(typeof dev.human.displayName).toBe('string');
    });

    it('unknown org → 404', async () => {
      const res = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/admin/orgs/org_missing/members',
        headers: adminHeader,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  /* ------------------------------- POST ------------------------------ */
  describe('POST /admin/orgs/:orgId/members', () => {
    it('happy path: adds a member (default role member), 201 { member }, no invite minted', async () => {
      const { orgId } = await provisionOrg(ts, 'acme', 'owner@acme.com');

      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'New.Person@Acme.com' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.member.role).toBe('member');
      expect(body.member.human.email).toBe('new.person@acme.com');
      expect(typeof body.member.human.id).toBe('string');
      // No invite/email surface on the admin (control-plane) add.
      expect(body.inviteUrl).toBeUndefined();
      expect(body.emailSent).toBeUndefined();

      const handle = readDb(ts);
      try {
        // No invite row was created by the admin add.
        const inviteRows = handle.db.select().from(invites).where(eq(invites.orgId, orgId)).all();
        expect(inviteRows).toHaveLength(0);
        // Membership persisted.
        const m = handle.db
          .select()
          .from(orgMemberships)
          .where(eq(orgMemberships.humanId, body.member.human.id))
          .get();
        expect(m).toBeDefined();
        expect(m!.role).toBe('member');
      } finally {
        handle.close();
      }
    });

    it('provisions a human when absent (no password, provider admin)', async () => {
      const { orgId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'fresh@acme.com' },
      });
      expect(res.statusCode).toBe(201);
      const id = res.json().member.human.id as string;
      const handle = readDb(ts);
      try {
        const human = handle.db.select().from(humans).where(eq(humans.id, id)).get();
        expect(human).toBeDefined();
        expect(human!.passwordHash).toBeNull();
        expect(human!.provider).toBe('admin');
      } finally {
        handle.close();
      }
    });

    it('can add with an elevated (admin) role', async () => {
      const { orgId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'lead@acme.com', role: 'admin' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().member.role).toBe('admin');
    });

    it('already a member → 409', async () => {
      const { orgId, ownerId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      void ownerId;
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'owner@acme.com' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
    });

    it('invalid email → 400', async () => {
      const { orgId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('role=owner is rejected → 400', async () => {
      const { orgId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'x@acme.com', role: 'owner' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('unknown org → 404', async () => {
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/admin/orgs/org_missing/members',
        headers: adminHeader,
        payload: { email: 'x@acme.com' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  /* ------------------------------ DELETE ----------------------------- */
  describe('DELETE /admin/orgs/:orgId/members/:humanId', () => {
    it('happy path: removes a plain member → 200 { removed:true }', async () => {
      const { orgId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const add = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/admin/orgs/${orgId}/members`,
        headers: adminHeader,
        payload: { email: 'dev@acme.com' },
      });
      const devId = add.json().member.human.id as string;

      const res = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/orgs/${orgId}/members/${devId}`,
        headers: adminHeader,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });

      const handle = readDb(ts);
      try {
        const m = handle.db
          .select()
          .from(orgMemberships)
          .where(eq(orgMemberships.humanId, devId))
          .get();
        expect(m).toBeUndefined();
      } finally {
        handle.close();
      }
    });

    it('unknown org → 404', async () => {
      const { ownerId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const res = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/orgs/org_missing/members/${ownerId}`,
        headers: adminHeader,
      });
      expect(res.statusCode).toBe(404);
    });

    it('unknown human (no membership) → 404', async () => {
      const { orgId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const res = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/orgs/${orgId}/members/human_missing`,
        headers: adminHeader,
      });
      expect(res.statusCode).toBe(404);
    });

    it('sole owner cannot be removed → 409 (conflict)', async () => {
      const { orgId, ownerId } = await provisionOrg(ts, 'acme', 'owner@acme.com');
      const res = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/orgs/${orgId}/members/${ownerId}`,
        headers: adminHeader,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
    });

    it('a member who owns agents in the org → 409 (conflict), same as the session path', async () => {
      // Session setup so the target actually owns an agent in the org.
      const owner = await signup(ts.app, { email: 'boss@corp.com', displayName: 'Boss' });
      const orgId = await firstOrgId(ts.app, owner.token);
      const dev = await joinOrg(ts.app, owner.token, orgId, 'dev@corp.com', 'Dev');
      await makeAgent(ts.app, dev.token, orgId, 'helper');

      const res = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/orgs/${orgId}/members/${dev.userId}`,
        headers: adminHeader,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
    });
  });
});
