import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, auth, signup, firstOrgId, type TestServer } from './test-helpers.js';

/**
 * Issue #27 — the bootstrap workspace has a NAME, and an auto-derived slug is not
 * a life sentence.
 *
 * Before this, the very first signup silently founded `alice@example.com's org`
 * with the slug `alice-example-coms-org`, and renaming the org left that mangled
 * identifier in every URL forever. Two halves:
 *
 * (a) `POST /auth/signup` accepts an optional `orgName`, used for the bootstrap
 *     org's name and its derived slug. Blank/absent = the old possessive default.
 *     `GET /auth/config` advertises `bootstrapOrg: true` while the next signup
 *     would be the founding one, so the web form can show the field.
 * (b) A slug that was DERIVED is regenerated when the org is renamed; a slug the
 *     operator SET is permanent. Uniqueness/reservation rules are the ones
 *     `availableSlug` already enforces at creation.
 */
describe('org bootstrap naming (signup orgName)', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  async function getOrg(token: string, orgId: string) {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(token),
    });
    return res.json().org as { id: string; name: string; slug: string };
  }

  it('signup with orgName names the bootstrap org and derives its slug from it', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: 'alice@example.com',
        password: 'password123',
        displayName: 'Alice',
        orgName: 'Acme Robotics',
      },
    });
    expect(res.statusCode).toBe(201);
    const token = res.json().token as string;
    const org = await getOrg(token, await firstOrgId(ts.app, token));
    expect(org.name).toBe('Acme Robotics');
    expect(org.slug).toBe('acme-robotics');
  });

  it('no orgName (or a blank one) keeps the possessive default — unchanged behavior', async () => {
    const plain = await signup(ts.app, { email: 'alice@example.com', displayName: 'Alice' });
    const org = await getOrg(plain.token, await firstOrgId(ts.app, plain.token));
    expect(org.name).toBe("Alice's org");
    expect(org.slug).toBe('alices-org');
  });

  it('a whitespace-only orgName falls back to the default too', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: 'bob@example.com',
        password: 'password123',
        displayName: 'Bob',
        orgName: '   ',
      },
    });
    expect(res.statusCode).toBe(201);
    const token = res.json().token as string;
    const org = await getOrg(token, await firstOrgId(ts.app, token));
    expect(org.name).toBe("Bob's org");
  });

  it('orgName is ignored for a NON-bootstrap signup (it founds nothing)', async () => {
    await signup(ts.app, { email: 'first@example.com', displayName: 'First' });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: 'second@example.com',
        password: 'password123',
        displayName: 'Second',
        orgName: 'Should Not Exist',
      },
    });
    expect(res.statusCode).toBe(201);
    const token = res.json().token as string;
    const orgs = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/orgs',
      headers: auth(token),
    });
    expect(orgs.json().items).toEqual([]);
  });
});

describe('GET /auth/config bootstrap signal', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  const config = () => ts.app.inject({ method: 'GET', url: '/api/v1/auth/config' });

  it('advertises bootstrapOrg: true on a fresh instance, and drops it after the first signup', async () => {
    const fresh = await config();
    expect(fresh.json().allowSignup).toBe(true);
    expect(fresh.json().bootstrapOrg).toBe(true);
    await signup(ts.app, { email: 'alice@example.com', displayName: 'Alice' });
    const after = await config();
    expect(after.json().bootstrapOrg).toBeUndefined();
  });

  it('stays quiet when signup is closed — a stranger learns nothing they could not learn by signing up', async () => {
    const closed = await makeTestServer();
    try {
      await closed.app.inject({
        method: 'PUT',
        url: '/api/v1/config',
        headers: { 'x-admin-token': 'test-admin-token' },
        payload: { values: { 'auth.allowSignup': false } },
      });
      const res = await closed.app.inject({ method: 'GET', url: '/api/v1/auth/config' });
      expect(res.json().allowSignup).toBe(false);
      expect(res.json().bootstrapOrg).toBeUndefined();
    } finally {
      await closed.close();
    }
  });

  it('stays quiet when bootstrapFirstOrg is off (a signup would found nothing)', async () => {
    const managed = await makeTestServer();
    try {
      await managed.app.inject({
        method: 'PUT',
        url: '/api/v1/config',
        headers: { 'x-admin-token': 'test-admin-token' },
        payload: { values: { 'auth.bootstrapFirstOrg': false } },
      });
      const res = await managed.app.inject({ method: 'GET', url: '/api/v1/auth/config' });
      expect(res.json().bootstrapOrg).toBeUndefined();
    } finally {
      await managed.close();
    }
  });
});

describe('org rename regenerates an AUTO-DERIVED slug', () => {
  let ts: TestServer;
  let token: string;
  beforeEach(async () => {
    ts = await makeTestServer();
    token = (await signup(ts.app, { email: 'alice@example.com', displayName: 'Alice' })).token;
  });
  afterEach(async () => {
    await ts.close();
  });

  const patch = (orgId: string, payload: Record<string, unknown>) =>
    ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(token),
      payload,
    });

  const createOrg = async (payload: Record<string, unknown>) => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(token),
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json().org as { id: string; name: string; slug: string };
  };

  it('renaming the bootstrap org replaces its derived slug', async () => {
    const orgId = await firstOrgId(ts.app, token);
    const before = await patch(orgId, { name: 'Acme Robotics' });
    expect(before.statusCode).toBe(200);
    expect(before.json().org.name).toBe('Acme Robotics');
    expect(before.json().org.slug).toBe('acme-robotics');
  });

  it('a MANUALLY SET slug is permanent — renaming never touches it', async () => {
    const org = await createOrg({ name: 'Acme', slug: 'my-address' });
    const res = await patch(org.id, { name: 'Totally Different' });
    expect(res.statusCode).toBe(200);
    expect(res.json().org.slug).toBe('my-address');
  });

  it('setting a slug explicitly on a rename marks it manual — later renames leave it alone', async () => {
    const org = await createOrg({ name: 'Acme' });
    expect(org.slug).toBe('acme');
    const set = await patch(org.id, { slug: 'chosen' });
    expect(set.json().org.slug).toBe('chosen');
    const rename = await patch(org.id, { name: 'Something Else' });
    expect(rename.json().org.slug).toBe('chosen');
  });

  it('an explicit slug in the SAME patch as a rename wins over regeneration', async () => {
    const org = await createOrg({ name: 'Acme' });
    const res = await patch(org.id, { name: 'Beta Corp', slug: 'explicit' });
    expect(res.json().org.slug).toBe('explicit');
  });

  it('regeneration respects uniqueness — a taken slug is suffixed, never stolen', async () => {
    await createOrg({ name: 'Taken Name' });
    const mine = await createOrg({ name: 'Mine' });
    const res = await patch(mine.id, { name: 'Taken Name' });
    expect(res.statusCode).toBe(200);
    expect(res.json().org.slug).toBe('taken-name-2');
  });

  it('regeneration respects reserved slugs', async () => {
    const org = await createOrg({ name: 'Acme' });
    const res = await patch(org.id, { name: 'admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().org.slug).toBe('admin-org');
  });

  it('a rename that derives the SAME slug is a no-op, not a `-2` bump', async () => {
    const org = await createOrg({ name: 'Acme' });
    expect(org.slug).toBe('acme');
    const res = await patch(org.id, { name: 'ACME!' });
    expect(res.json().org.slug).toBe('acme');
  });

  it('a settings-only patch never touches the slug', async () => {
    const org = await createOrg({ name: 'Acme' });
    const res = await patch(org.id, { settings: { invites: { who: 'admins' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().org.slug).toBe('acme');
  });

  it('an explicit slug cannot move onto a reserved name — PATCH matches POST', async () => {
    const org = await createOrg({ name: 'Acme' });
    const res = await patch(org.id, { slug: 'admin' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/reserved/i);
    // and nothing was applied
    const after = await patch(org.id, { settings: {} });
    expect(after.json().org.slug).toBe('acme');
  });
});
