import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  TEST_ADMIN_TOKEN,
  type TestServer,
} from './test-helpers.js';

const adminHeader = { 'x-admin-token': TEST_ADMIN_TOKEN };

describe('config (admin-token only)', () => {
  it('404 when ADMIN_TOKEN unset; 401 on wrong token; get/put with the token', async () => {
    const noToken = await makeTestServer({ adminToken: undefined });
    const hidden = await noToken.app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(hidden.statusCode).toBe(404);
    await noToken.close();

    const ts = await makeTestServer();
    const wrong = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { 'x-admin-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const get = await ts.app.inject({ method: 'GET', url: '/api/v1/config', headers: adminHeader });
    expect(get.statusCode).toBe(200);
    const keys = get.json().entries.map((e: { descriptor: { key: string } }) => e.descriptor.key);
    expect(keys).toEqual(
      expect.arrayContaining(['auth.allowSignup', 'auth.allowedEmailPatterns', 'orgs.openCreation']),
    );

    const put = await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: adminHeader,
      payload: { values: { 'auth.allowSignup': false } },
    });
    expect(put.statusCode).toBe(200);
    const entry = put.json().entries.find((e: { descriptor: { key: string } }) => e.descriptor.key === 'auth.allowSignup');
    expect(entry.value).toBe(false);
    expect(entry.source).toBe('db');
    await ts.close();
  });

  it('a plain session cannot reach /config (admin token only)', async () => {
    const ts = await makeTestServer();
    const { token } = await signup(ts.app, { email: 'plain@example.com' });
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/config', headers: auth(token) });
    expect(res.statusCode).toBe(401);
    await ts.close();
  });
});

describe('admin routes', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('GET /admin/orgs lists orgs with counts', async () => {
    const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'O' });
    const orgId = await firstOrgId(ts.app, owner.token);
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'bot' },
    });
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/admin/orgs', headers: adminHeader });
    expect(res.statusCode).toBe(200);
    const org = res.json().items.find((o: { id: string }) => o.id === orgId);
    expect(org).toMatchObject({ humanCount: 1, agentCount: 1 });
  });

  it('DELETE /admin/orgs/:id cascades', async () => {
    const owner = await signup(ts.app, { email: 'del@example.com' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const res = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/orgs/${orgId}`,
      headers: adminHeader,
    });
    expect(res.json()).toEqual({ ok: true });
    const list = await ts.app.inject({ method: 'GET', url: '/api/v1/admin/orgs', headers: adminHeader });
    expect(list.json().items.find((o: { id: string }) => o.id === orgId)).toBeUndefined();
  });

  it('DELETE /admin/agents/:id removes an agent', async () => {
    const owner = await signup(ts.app, { email: 'oa@example.com' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const agent = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'doomed' },
    });
    const agentId = agent.json().agent.id as string;
    const key = agent.json().key as string;
    const del = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: adminHeader,
    });
    expect(del.json()).toEqual({ ok: true });
    const dead = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(key) });
    expect(dead.statusCode).toBe(401);
  });

  it('DELETE /admin/humans/:id refuses while they own agents (409)', async () => {
    const owner = await signup(ts.app, { email: 'oh@example.com' });
    const orgId = await firstOrgId(ts.app, owner.token);
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'held' },
    });
    const refused = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/humans/${owner.userId}`,
      headers: adminHeader,
    });
    expect(refused.statusCode).toBe(409);
  });
});
