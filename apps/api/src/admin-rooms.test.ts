import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createRoom,
  makeAgent,
  TEST_ADMIN_TOKEN,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

const adminHeader = { 'x-admin-token': TEST_ADMIN_TOKEN };

describe('admin rooms', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  it('GET /admin/rooms lists rooms (incl DM) with counts + kind; ?org filters', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: bot.id },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: bot.id },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: bot.id, body: 'hi' },
    });

    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/admin/rooms', headers: adminHeader });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; kind: string; memberCount: number; messageCount: number }[];
    expect(items.map((i) => i.kind).sort()).toEqual(['dm', 'project']);
    const project = items.find((i) => i.id === roomId)!;
    expect(project.memberCount).toBe(2);
    expect(project.messageCount).toBe(1);

    const filtered = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/admin/rooms?org=${orgId}`,
      headers: adminHeader,
    });
    expect(filtered.json().items.length).toBe(2);
    const none = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/admin/rooms?org=org_nope0000000',
      headers: adminHeader,
    });
    expect(none.json().items).toHaveLength(0);
  });

  it('DELETE /admin/rooms/:id hard-deletes + cascades', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    const del = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/rooms/${roomId}`,
      headers: adminHeader,
    });
    expect(del.statusCode).toBe(200);
    const get = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
    });
    expect(get.statusCode).toBe(404);
    const missing = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/rooms/${roomId}`,
      headers: adminHeader,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('admin auth: wrong token → 401; unset ADMIN_TOKEN → 404', async () => {
    const wrong = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/admin/rooms',
      headers: { 'x-admin-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const noAdmin = await makeTestServer({ adminToken: undefined });
    const hidden = await noAdmin.app.inject({ method: 'GET', url: '/api/v1/admin/rooms' });
    expect(hidden.statusCode).toBe(404);
    await noAdmin.close();
  });
});
