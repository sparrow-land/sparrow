import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentAnalyticsResponseSchema,
  AgentSchema,
  GrantListResponseSchema,
  GrantSchema,
  MeResponseSchema,
  ListOrgAgentsResponseSchema,
} from '@sparrow-land/sdk/types';
import {
  auth,
  createInvite,
  createRoom,
  firstOrgId,
  joinOrg,
  makeAgent,
  makeEmailServer,
  makeTestServer,
  recordStatements,
  shareAgent,
  TEST_ADMIN_TOKEN,
  signup,
  type SignedUpHuman,
  type TestServer,
} from './test-helpers.js';

/**
 * Agent visibility (SPEC "Agent visibility"): tags, the per-agent messaging
 * policy, delegated grants, and always-on message analytics.
 */
describe('agent visibility', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@ex.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  const putTags = (token: string, agentId: string, tags: unknown, org = orgId) =>
    ts.app.inject({
      method: 'PUT',
      url: `/api/v1/orgs/${org}/agents/${agentId}/tags`,
      headers: auth(token),
      payload: { tags },
    });
  const putMessaging = (token: string, agentId: string, messaging: unknown) =>
    ts.app.inject({
      method: 'PUT',
      url: `/api/v1/orgs/${orgId}/agents/${agentId}/messaging`,
      headers: auth(token),
      payload: { messaging },
    });
  const grant = (token: string, principalId: string, scope: string) =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/grants`,
      headers: auth(token),
      payload: { principalId, scope },
    });
  const listGrants = (token: string) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/grants`, headers: auth(token) });
  const deleteGrant = (token: string, grantId: string) =>
    ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/grants/${grantId}`,
      headers: auth(token),
    });
  const analytics = (token: string, agentId: string, window = '7d') =>
    ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents/${agentId}/analytics?window=${window}`,
      headers: auth(token),
    });
  const promote = (humanId: string, role = 'admin') =>
    ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/humans/${humanId}`,
      headers: auth(owner.token),
      payload: { role },
    });
  const ensureDm = (token: string, principal: string) =>
    ts.app.inject({ method: 'POST', url: '/api/v1/me/dms', headers: auth(token), payload: { principal } });
  const send = (token: string, roomId: string, body = 'hi') =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(token),
      payload: { body },
    });
  const addToRoom = (token: string, roomId: string, principal: string) =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(token),
      payload: { principal },
    });
  async function coRoom(...agentIds: string[]): Promise<string> {
    const room = await createRoom(ts.app, owner.token, orgId, `shared-${agentIds.join('-').slice(0, 40)}`);
    for (const id of agentIds) {
      const res = await addToRoom(owner.token, room, id);
      if (res.statusCode !== 201) throw new Error(`addToRoom failed: ${res.body}`);
    }
    return room;
  }
  const expectForbidden = (res: { statusCode: number; json: () => any }, reason: string) => {
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'forbidden', reason });
    expect(typeof res.json().error.message).toBe('string');
  };

  /* ----------------------------- the agent resource ------------------- */

  describe('every agent resource carries tags (sorted) and messaging', () => {
    it('a fresh agent reads tags [] and messaging any', async () => {
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/me/agents',
        headers: auth(owner.token),
        payload: { orgId, name: 'fresh' },
      });
      expect(res.json().agent).toMatchObject({ tags: [], messaging: 'any' });
    });

    it('a tagged agent shows its tags in each place an agent is returned', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const put = await putTags(owner.token, bot.id, ['zeta', 'alpha', 'mid']);
      expect(put.statusCode).toBe(200);
      const sorted = ['alpha', 'mid', 'zeta'];
      expect(AgentSchema.parse(put.json().agent)).toMatchObject({ tags: sorted, messaging: 'any' });
      expect((await putMessaging(owner.token, bot.id, 'tags')).statusCode).toBe(200);
      const want = { id: bot.id, tags: sorted, messaging: 'tags' };

      // Visibility lists (both).
      const vis = await ts.app.inject({ method: 'GET', url: '/api/v1/me/agents', headers: auth(owner.token) });
      expect(vis.json().items[0].agent).toMatchObject(want);
      const orgVis = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/me/agents`,
        headers: auth(owner.token),
      });
      expect(orgVis.json().items[0].agent).toMatchObject(want);

      // GET /me and PATCH /me as the agent.
      const me = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(bot.key) });
      expect(MeResponseSchema.parse(me.json()).principal).toMatchObject(want);
      expect(me.json().principal).toMatchObject(want);
      const patchMe = await ts.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: auth(bot.key),
        payload: { roleTitle: 'Builder' },
      });
      expect(patchMe.json().principal).toMatchObject(want);

      // Owner PATCH and rotate.
      const patch = await ts.app.inject({
        method: 'PATCH',
        url: `/api/v1/me/agents/${bot.id}`,
        headers: auth(owner.token),
        payload: { roleTitle: 'Builder 2' },
      });
      expect(patch.json().agent).toMatchObject(want);
      const rotate = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/me/agents/${bot.id}/rotate`,
        headers: auth(owner.token),
      });
      expect(rotate.json().agent).toMatchObject(want);

      // Governance list.
      const gov = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/agents`,
        headers: auth(owner.token),
      });
      expect(ListOrgAgentsResponseSchema.parse(gov.json()).items[0]!.agent).toMatchObject(want);
      expect(gov.json().items[0].agent).toMatchObject(want);

      // agent.shared event (journaled on the grantee's stream).
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com', 'Bob');
      await shareAgent(ts.app, owner.token, bot.id, bob.userId);
      const log = await ts.app.inject({
        method: 'GET',
        url: '/api/v1/me/events/log?since=0',
        headers: auth(bob.token),
      });
      const shared = (log.json().events as { event: string; data: any }[]).find((e) => e.event === 'agent.shared');
      expect(shared?.data.agent).toMatchObject(want);
    });

    it('lists read tags in ONE query, not one per agent', async () => {
      for (const n of ['a1', 'a2', 'a3', 'a4']) {
        const a = await makeAgent(ts.app, owner.token, orgId, n);
        await putTags(owner.token, a.id, ['t']);
      }
      const log = recordStatements();
      try {
        const vis = await ts.app.inject({ method: 'GET', url: '/api/v1/me/agents', headers: auth(owner.token) });
        expect(vis.json().items.every((i: { agent: { tags: string[] } }) => i.agent.tags[0] === 't')).toBe(true);
        expect(log.count('from "agent_tags"')).toBe(1);
        log.reset();
        const gov = await ts.app.inject({
          method: 'GET',
          url: `/api/v1/orgs/${orgId}/agents`,
          headers: auth(owner.token),
        });
        expect(gov.json().items).toHaveLength(4);
        expect(log.count('from "agent_tags"')).toBe(1);
      } finally {
        log.restore();
      }
    });

    it('the enrollment poll returns the agent with tags and messaging', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const enroll = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${inv.token}/enroll`,
        payload: { name: 'enrolled-bot' },
      });
      const eid = enroll.json().enrollment.id as string;
      const enr = enroll.json().enrollmentToken as string;
      await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
        headers: auth(owner.token),
        payload: {},
      });
      const gov = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/agents`,
        headers: auth(owner.token),
      });
      const agentId = (gov.json().items as { agent: { id: string; name: string } }[]).find(
        (i) => i.agent.name === 'enrolled-bot',
      )!.agent.id;
      expect((await putTags(owner.token, agentId, ['ops'])).statusCode).toBe(200);
      const poll = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
        headers: auth(enr),
      });
      expect(poll.json().agent).toMatchObject({ id: agentId, tags: ['ops'], messaging: 'any' });
    });

    it('the open-policy enrollment response carries tags and messaging', async () => {
      await ts.app.inject({
        method: 'PATCH',
        url: `/api/v1/orgs/${orgId}`,
        headers: auth(owner.token),
        payload: { settings: { enroll: { agents: 'open' } } },
      });
      const inv = await createInvite(ts.app, owner.token, orgId);
      const enroll = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${inv.token}/enroll`,
        payload: { name: 'open-bot' },
      });
      expect(enroll.statusCode).toBe(201);
      expect(enroll.json().agent).toMatchObject({ tags: [], messaging: 'any' });
    });
  });

  /* ----------------------------- GET one org agent ------------------- */

  describe('GET /orgs/:orgId/agents/:agentId', () => {
    it('any org member (human or agent) reads the org-visible agent + owner; outsiders 404', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const peer = await makeAgent(ts.app, owner.token, orgId, 'peer');
      await ts.app.inject({
        method: 'PATCH',
        url: `/api/v1/me/agents/${bot.id}`,
        headers: auth(owner.token),
        payload: { roleTitle: 'Builder', roleInstructions: 'secret brief' },
      });
      await putTags(owner.token, bot.id, ['ops', 'cubes']);
      await putMessaging(owner.token, bot.id, 'tags');
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com', 'Bob');
      const get = (token: string, org = orgId, id = bot.id) =>
        ts.app.inject({ method: 'GET', url: `/api/v1/orgs/${org}/agents/${id}`, headers: auth(token) });

      for (const token of [bob.token, peer.key, owner.token, bot.key]) {
        const res = await get(token);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(AgentSchema.parse(body.agent)).toMatchObject({
          id: bot.id,
          name: 'bot',
          orgId,
          roleTitle: 'Builder',
          tags: ['cubes', 'ops'],
          messaging: 'tags',
        });
        expect(body.owner).toEqual({ id: owner.userId, displayName: 'Owner' });
        expect(JSON.stringify(body)).not.toContain('secret brief');
      }

      const stranger = await signup(ts.app, { email: 'x@elsewhere.com' });
      expect((await get(stranger.token)).statusCode).toBe(404);
      expect((await get(owner.token, orgId, 'agt_nope')).statusCode).toBe(404);
    });
  });

  describe('GET /orgs/:orgId/agents/:agentId — presence and address privacy', () => {
    it('full view for those who can access the agent; redacted presence/address for everyone else', async () => {
      await ts.close();
      ts = await makeEmailServer();
      owner = await signup(ts.app, { email: 'owner@ex.com', displayName: 'Owner' });
      orgId = await firstOrgId(ts.app, owner.token);
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const peer = await makeAgent(ts.app, owner.token, orgId, 'peer');
      // The bot calls in (stamps lastSeenAt) and marks itself present.
      await ts.app.inject({ method: 'POST', url: '/api/v1/me/presence', headers: auth(bot.key), payload: { ttlSeconds: 300 } });
      await putTags(owner.token, bot.id, ['ops']);
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com', 'Bob');
      const carol = await joinOrg(ts.app, owner.token, orgId, 'carol@ex.com', 'Carol');
      const admin = await joinOrg(ts.app, owner.token, orgId, 'adm@ex.com', 'Adm');
      await promote(admin.userId);
      await shareAgent(ts.app, owner.token, bot.id, carol.userId);
      const get = (token: string) =>
        ts.app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/agents/${bot.id}`, headers: auth(token) });

      for (const token of [owner.token, admin.token, carol.token, bot.key]) {
        const agent = (await get(token)).json().agent;
        expect(agent.online).toBe(true);
        expect(agent.lastSeenAt).not.toBeNull();
        expect(agent.emailAddress).toMatch(/^bot@/);
      }
      for (const token of [bob.token, peer.key]) {
        const res = await get(token);
        expect(res.statusCode).toBe(200);
        const agent = AgentSchema.parse(res.json().agent);
        expect(agent).toMatchObject({
          id: bot.id,
          name: 'bot',
          tags: ['ops'],
          messaging: 'any',
          online: false,
          lastSeenAt: null,
          emailAddress: null,
        });
        expect(res.json().owner).toEqual({ id: owner.userId, displayName: 'Owner' });
      }
    });
  });

  /* ----------------------------- PUT tags ----------------------------- */

  describe('PUT /orgs/:orgId/agents/:agentId/tags', () => {
    it('replaces the set; [] clears', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      expect((await putTags(owner.token, bot.id, ['a', 'b'])).json().agent.tags).toEqual(['a', 'b']);
      expect((await putTags(owner.token, bot.id, ['c'])).json().agent.tags).toEqual(['c']);
      expect((await putTags(owner.token, bot.id, [])).json().agent.tags).toEqual([]);
    });

    it('400s a bad slug, a duplicate, or more than 10', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      expect((await putTags(owner.token, bot.id, ['Bad'])).statusCode).toBe(400);
      expect((await putTags(owner.token, bot.id, ['a', 'a'])).statusCode).toBe(400);
      const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`);
      expect((await putTags(owner.token, bot.id, eleven)).statusCode).toBe(400);
    });

    it('404s an agent in another org and a non-member caller', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const stranger = await signup(ts.app, { email: 'x@elsewhere.com' });
      const created = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: auth(stranger.token),
        payload: { name: 'Elsewhere' },
      });
      const strangerOrg = created.json().org.id as string;
      expect((await putTags(stranger.token, bot.id, ['a'])).statusCode).toBe(404);
      expect((await putTags(stranger.token, bot.id, ['a'], strangerOrg)).statusCode).toBe(404);
      expect((await putTags(owner.token, 'agt_nope', ['a'])).statusCode).toBe(404);
    });

    it('a plain member is refused grant_required; an org admin may', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com');
      expectForbidden(await putTags(bob.token, bot.id, ['a']), 'grant_required');
      await promote(bob.userId);
      expect((await putTags(bob.token, bot.id, ['a'])).statusCode).toBe(200);
    });

    it('an agent never changes its own tags (self)', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      expectForbidden(await putTags(bot.key, bot.id, ['a']), 'self');
    });

    it('a tag:cubes agent manages agents already carrying cubes, but cannot recruit new ones', async () => {
      const mgr = await makeAgent(ts.app, owner.token, orgId, 'mgr');
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const opsBot = await makeAgent(ts.app, owner.token, orgId, 'ops-bot');
      expect((await grant(owner.token, mgr.id, 'tag:cubes')).statusCode).toBe(201);
      expect((await putTags(owner.token, bot.id, ['cubes', 'ops'])).statusCode).toBe(200);
      expect((await putTags(owner.token, opsBot.id, ['ops'])).statusCode).toBe(200);
      // Recruiting an agent that does not carry cubes is refused.
      expectForbidden(await putTags(mgr.key, opsBot.id, ['ops', 'cubes']), 'grant_required');
      // Removing ops from a cubes agent is outside the grant.
      expectForbidden(await putTags(mgr.key, bot.id, ['cubes']), 'grant_required');
      // Removing cubes (keeping ops, unchanged) is fine.
      const rm = await putTags(mgr.key, bot.id, ['ops']);
      expect(rm.statusCode).toBe(200);
      expect(rm.json().agent.tags).toEqual(['ops']);
      // …and once it is gone the agent is out of reach again.
      expectForbidden(await putTags(mgr.key, bot.id, ['cubes', 'ops']), 'grant_required');
    });

    it('tag capture: a tag:cubes agent cannot tag its way past its own policy', async () => {
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com', 'Bob');
      const x = await makeAgent(ts.app, owner.token, orgId, 'x-agent');
      const y = await makeAgent(ts.app, bob.token, orgId, 'y-agent');
      await shareAgent(ts.app, bob.token, y.id, owner.userId);
      await coRoom(x.id, y.id);
      expect((await putTags(owner.token, x.id, ['cubes'])).statusCode).toBe(200);
      expect((await putMessaging(owner.token, x.id, 'tags')).statusCode).toBe(200);
      expect((await grant(owner.token, x.id, 'tag:cubes')).statusCode).toBe(201);
      expectForbidden(await ensureDm(x.key, y.id), 'messaging_policy');
      expectForbidden(await putTags(x.key, y.id, ['cubes']), 'grant_required');
      expectForbidden(await ensureDm(x.key, y.id), 'messaging_policy');
    });

    it('an agent whose policy is not any never adds a tag it carries, even with tags:*', async () => {
      const x = await makeAgent(ts.app, owner.token, orgId, 'x-agent');
      const y = await makeAgent(ts.app, owner.token, orgId, 'y-agent');
      expect((await putTags(owner.token, x.id, ['cubes'])).statusCode).toBe(200);
      expect((await grant(owner.token, x.id, 'tags:*')).statusCode).toBe(201);
      expect((await putMessaging(owner.token, x.id, 'tags')).statusCode).toBe(200);
      expectForbidden(await putTags(x.key, y.id, ['cubes']), 'self');
      // A tag it does not carry is fine; so is the same tag once its policy is any.
      expect((await putTags(x.key, y.id, ['ops'])).statusCode).toBe(200);
      expect((await putMessaging(owner.token, x.id, 'any')).statusCode).toBe(200);
      expect((await putTags(x.key, y.id, ['cubes', 'ops'])).statusCode).toBe(200);
    });

    it('a tag:cubes human cannot tag an untagged agent to read its analytics', async () => {
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com', 'Bob');
      const spy = await joinOrg(ts.app, owner.token, orgId, 'spy@ex.com', 'Spy');
      const y = await makeAgent(ts.app, bob.token, orgId, 'y-agent');
      expect((await grant(owner.token, spy.userId, 'tag:cubes')).statusCode).toBe(201);
      expectForbidden(await putTags(spy.token, y.id, ['cubes']), 'grant_required');
      expectForbidden(await analytics(spy.token, y.id), 'grant_required');
    });

    it('a manager with tag:cubes can never touch the chief of staff (outranked)', async () => {
      const cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
      const mgr = await makeAgent(ts.app, owner.token, orgId, 'mgr');
      await grant(owner.token, cos.id, 'tags:*');
      await grant(owner.token, mgr.id, 'tag:cubes');
      await putTags(owner.token, cos.id, ['cubes']);
      expectForbidden(await putTags(mgr.key, cos.id, []), 'outranked');
      expectForbidden(await putMessaging(mgr.key, cos.id, 'none'), 'outranked');
      // …but the chief of staff can act on the manager.
      expect((await putTags(cos.key, mgr.id, ['cubes'])).statusCode).toBe(200);
    });
  });

  /* ----------------------------- PUT messaging ------------------------ */

  describe('PUT /orgs/:orgId/agents/:agentId/messaging', () => {
    it('owner sets it; bad value 400; self refused', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const res = await putMessaging(owner.token, bot.id, 'none');
      expect(res.statusCode).toBe(200);
      expect(res.json().agent.messaging).toBe('none');
      expect((await putMessaging(owner.token, bot.id, 'nobody')).statusCode).toBe(400);
      expectForbidden(await putMessaging(bot.key, bot.id, 'any'), 'self');
    });

    it('tag:x holders may change it only on agents carrying x', async () => {
      const mgr = await makeAgent(ts.app, owner.token, orgId, 'mgr');
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      await grant(owner.token, mgr.id, 'tag:cubes');
      expectForbidden(await putMessaging(mgr.key, bot.id, 'tags'), 'grant_required');
      await putTags(owner.token, bot.id, ['cubes']);
      expect((await putMessaging(mgr.key, bot.id, 'tags')).statusCode).toBe(200);
    });
  });

  /* ----------------------------- grants ------------------------------- */

  describe('grants', () => {
    it('admin creates, any member lists, admin deletes', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com');
      const g1 = await grant(owner.token, bot.id, 'tags:*');
      expect(g1.statusCode).toBe(201);
      const created = GrantSchema.parse(g1.json().grant);
      expect(created).toMatchObject({
        orgId,
        principalId: bot.id,
        principalKind: 'agent',
        scope: 'tags:*',
        grantedBy: owner.userId,
      });
      expect(created.id.startsWith('grt_')).toBe(true);
      const g2 = await grant(owner.token, bob.userId, 'tag:cubes');
      expect(g2.json().grant.principalKind).toBe('human');

      const list = await listGrants(bob.token);
      expect(list.statusCode).toBe(200);
      expect(GrantListResponseSchema.parse(list.json()).items.map((g) => g.scope).sort()).toEqual([
        'tag:cubes',
        'tags:*',
      ]);
      // An agent in the org can list too.
      expect((await listGrants(bot.key)).statusCode).toBe(200);

      expect((await deleteGrant(owner.token, created.id)).json()).toEqual({ ok: true });
      expect((await listGrants(owner.token)).json().items).toHaveLength(1);
      expect((await deleteGrant(owner.token, created.id)).statusCode).toBe(404);
    });

    it('a duplicate grant returns the existing one', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      const a = await grant(owner.token, bot.id, 'tag:x');
      const b = await grant(owner.token, bot.id, 'tag:x');
      expect(b.statusCode).toBe(200);
      expect(b.json().grant.id).toBe(a.json().grant.id);
    });

    it('400s a bad scope or principal; 404s a principal outside the org', async () => {
      const stranger = await signup(ts.app, { email: 'x@elsewhere.com' });
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      expect((await grant(owner.token, bot.id, 'tags:x')).statusCode).toBe(400);
      expect((await grant(owner.token, 'room_1', 'tag:x')).statusCode).toBe(400);
      expect((await grant(owner.token, stranger.userId, 'tag:x')).statusCode).toBe(404);
      expect((await grant(owner.token, 'agt_nope', 'tag:x')).statusCode).toBe(404);
    });

    it('a tags:* agent grants tag:<slug> but not tags:*; tag:x holders grant nothing', async () => {
      const cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
      const mgr = await makeAgent(ts.app, owner.token, orgId, 'mgr');
      const sub = await makeAgent(ts.app, owner.token, orgId, 'sub');
      await grant(owner.token, cos.id, 'tags:*');
      const g = await grant(cos.key, mgr.id, 'tag:cubes');
      expect(g.statusCode).toBe(201);
      expect(g.json().grant.grantedBy).toBe(cos.id);
      expectForbidden(await grant(cos.key, mgr.id, 'tags:*'), 'grant_required');
      expectForbidden(await grant(mgr.key, sub.id, 'tag:cubes'), 'grant_required');
      expectForbidden(await grant(cos.key, cos.id, 'tag:cubes'), 'self');
      // A plain member cannot grant; the agent's owner has no grant authority either.
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com');
      expectForbidden(await grant(bob.token, sub.id, 'tag:x'), 'grant_required');
    });

    it('deletion: the creator may; another tags:* holder may not; the holder may give it up', async () => {
      const cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
      const cos2 = await makeAgent(ts.app, owner.token, orgId, 'cos2');
      const mgr = await makeAgent(ts.app, owner.token, orgId, 'mgr');
      await grant(owner.token, cos.id, 'tags:*');
      await grant(owner.token, cos2.id, 'tags:*');
      const g = (await grant(cos.key, mgr.id, 'tag:cubes')).json().grant.id as string;
      expectForbidden(await deleteGrant(cos2.key, g), 'grant_required');
      expect((await deleteGrant(cos.key, g)).statusCode).toBe(200);
      // The holder may always give up a grant it holds.
      const g2 = (await grant(cos.key, mgr.id, 'tag:cubes')).json().grant.id as string;
      expect((await deleteGrant(mgr.key, g2)).statusCode).toBe(200);
      expect((await listGrants(owner.token)).json().items.map((x: { id: string }) => x.id)).not.toContain(g2);
    });

    it('revoking a chief of staff removes the grants it created', async () => {
      const cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
      const pal = await makeAgent(ts.app, owner.token, orgId, 'pal');
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      await putTags(owner.token, bot.id, ['ops']);
      const cosGrant = (await grant(owner.token, cos.id, 'tags:*')).json().grant.id as string;
      const palGrant = await grant(cos.key, pal.id, 'tag:ops');
      expect(palGrant.statusCode).toBe(201);
      expect((await putTags(pal.key, bot.id, [])).statusCode).toBe(200);
      await putTags(owner.token, bot.id, ['ops']);
      // An admin-created grant to pal is untouched by the cascade.
      const adminGrant = (await grant(owner.token, pal.id, 'tag:x')).json().grant.id as string;
      expect((await deleteGrant(owner.token, cosGrant)).statusCode).toBe(200);
      const ids = (await listGrants(owner.token)).json().items.map((g: { id: string }) => g.id);
      expect(ids).toEqual([adminGrant]);
      expectForbidden(await putTags(pal.key, bot.id, []), 'grant_required');
    });

    it('a chief of staff giving up tags:* also drops the grants it created', async () => {
      const cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
      const pal = await makeAgent(ts.app, owner.token, orgId, 'pal');
      const cosGrant = (await grant(owner.token, cos.id, 'tags:*')).json().grant.id as string;
      await grant(cos.key, pal.id, 'tag:ops');
      expect((await deleteGrant(cos.key, cosGrant)).statusCode).toBe(200);
      expect((await listGrants(owner.token)).json().items).toEqual([]);
    });

    it('revoking a grant its holder does not need to justify its own grants leaves them', async () => {
      const cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
      const pal = await makeAgent(ts.app, owner.token, orgId, 'pal');
      await grant(owner.token, cos.id, 'tags:*');
      const cosTag = (await grant(owner.token, cos.id, 'tag:x')).json().grant.id as string;
      const palGrant = (await grant(cos.key, pal.id, 'tag:ops')).json().grant.id as string;
      expect((await deleteGrant(owner.token, cosTag)).statusCode).toBe(200);
      expect((await listGrants(owner.token)).json().items.map((g: { id: string }) => g.id)).toContain(palGrant);
    });

    it('deleting a chief-of-staff agent removes the grants it created', async () => {
      const cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
      const pal = await makeAgent(ts.app, owner.token, orgId, 'pal');
      await grant(owner.token, cos.id, 'tags:*');
      await grant(cos.key, pal.id, 'tag:ops');
      await ts.app.inject({ method: 'DELETE', url: `/api/v1/me/agents/${cos.id}`, headers: auth(owner.token) });
      expect((await listGrants(owner.token)).json().items).toEqual([]);
    });

    it('a non-admin chief of staff leaving the org takes its delegated grants; an admin leaving does not', async () => {
      const cosHuman = await joinOrg(ts.app, owner.token, orgId, 'cos@ex.com', 'Cos');
      const adm = await joinOrg(ts.app, owner.token, orgId, 'adm@ex.com', 'Adm');
      await promote(adm.userId);
      const pal = await makeAgent(ts.app, owner.token, orgId, 'pal');
      await grant(owner.token, cosHuman.userId, 'tags:*');
      await grant(cosHuman.token, pal.id, 'tag:ops');
      const admGrant = (await grant(adm.token, pal.id, 'tag:x')).json().grant.id as string;
      for (const who of [cosHuman.userId, adm.userId]) {
        const res = await ts.app.inject({
          method: 'DELETE',
          url: `/api/v1/orgs/${orgId}/humans/${who}`,
          headers: auth(owner.token),
        });
        expect(res.statusCode).toBe(200);
      }
      // The delegated tag:ops grant went with its creator; the admin's is the org's decision.
      expect((await listGrants(owner.token)).json().items.map((g: { id: string }) => g.id)).toEqual([admGrant]);
    });

    it('an operator-deleted non-admin chief of staff takes its delegated grants', async () => {
      const cosHuman = await joinOrg(ts.app, owner.token, orgId, 'cos@ex.com', 'Cos');
      const pal = await makeAgent(ts.app, owner.token, orgId, 'pal');
      await grant(owner.token, cosHuman.userId, 'tags:*');
      await grant(cosHuman.token, pal.id, 'tag:ops');
      const del = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/humans/${cosHuman.userId}`,
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
      });
      expect(del.statusCode).toBe(200);
      expect((await listGrants(owner.token)).json().items).toEqual([]);
    });

    it('a human removed from the org, or deleted by the operator, loses their grants', async () => {
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com');
      const carol = await joinOrg(ts.app, owner.token, orgId, 'carol@ex.com');
      await grant(owner.token, bob.userId, 'tag:x');
      await grant(owner.token, carol.userId, 'tags:*');
      await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/orgs/${orgId}/humans/${bob.userId}`,
        headers: auth(owner.token),
      });
      expect((await listGrants(owner.token)).json().items.map((g: { principalId: string }) => g.principalId)).toEqual([
        carol.userId,
      ]);
      const del = await ts.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/humans/${carol.userId}`,
        headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
      });
      expect(del.statusCode).toBe(200);
      expect((await listGrants(owner.token)).json().items).toEqual([]);
    });

    it('deleting an agent removes its tags and grants', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      await grant(owner.token, bot.id, 'tags:*');
      await putTags(owner.token, bot.id, ['a']);
      await ts.app.inject({ method: 'DELETE', url: `/api/v1/me/agents/${bot.id}`, headers: auth(owner.token) });
      expect((await listGrants(owner.token)).json().items).toEqual([]);
    });
  });

  /* ----------------------------- messaging enforcement ---------------- */

  describe('messaging policy enforcement on agent↔agent DMs', () => {
    it('default any: DM works as before', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
      await coRoom(a.id, b.id);
      expect((await ensureDm(a.key, b.id)).statusCode).toBe(201);
    });

    it('none on either side refuses the ensure, naming whose setting blocks it', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
      await coRoom(a.id, b.id);
      await putMessaging(owner.token, b.id, 'none');
      const res = await ensureDm(a.key, b.id);
      expectForbidden(res, 'messaging_policy');
      expect(res.json().error.message).toContain('beta');
      expect(res.json().error.message).not.toContain('alpha');
    });

    it('tags: allowed only when the pair shares a tag (both sides checked)', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
      await coRoom(a.id, b.id);
      await putMessaging(owner.token, a.id, 'tags');
      await putTags(owner.token, a.id, ['cubes']);
      const refused = await ensureDm(b.key, a.id);
      expectForbidden(refused, 'messaging_policy');
      expect(refused.json().error.message).toContain('alpha');
      await putTags(owner.token, b.id, ['cubes', 'ops']);
      expect((await ensureDm(b.key, a.id)).statusCode).toBe(201);
    });

    it('an unmet pair still gets the uninformative refusal (no policy oracle)', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
      await putMessaging(owner.token, b.id, 'none');
      const res = await ensureDm(a.key, b.id);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBeUndefined();
    });

    it('a policy change after the DM exists refuses new posts; history stays readable', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
      await coRoom(a.id, b.id);
      const roomId = (await ensureDm(a.key, b.id)).json().room.id as string;
      expect((await send(a.key, roomId, 'before')).statusCode).toBe(201);
      await putMessaging(owner.token, a.id, 'none');
      const refused = await send(b.key, roomId, 'after');
      expectForbidden(refused, 'messaging_policy');
      expect(refused.json().error.message).toContain('alpha');
      const history = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages`,
        headers: auth(b.key),
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().items.map((m: { body: string }) => m.body)).toContain('before');
    });

    it('none never restricts DMs with humans or room posts', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const room = await coRoom(a.id);
      await putMessaging(owner.token, a.id, 'none');
      expect((await send(a.key, room)).statusCode).toBe(201);
      const dm = await ensureDm(a.key, owner.userId);
      expect(dm.statusCode).toBeLessThan(300);
      expect((await send(a.key, dm.json().room.id)).statusCode).toBe(201);
    });
  });

  /* ----------------------------- analytics ---------------------------- */

  describe('analytics', () => {
    it('counts sent/received per counterpart and room, with tokens = ceil(chars/4)', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const b = await makeAgent(ts.app, owner.token, orgId, 'beta');
      const room = await coRoom(a.id, b.id);
      const dm = (await ensureDm(a.key, b.id)).json().room.id as string;
      const ownerDm = (await ensureDm(owner.token, a.id)).json().room.id as string;

      await send(a.key, dm, 'x'.repeat(10)); // a sent 3 tokens to b; b received 3
      await send(b.key, dm, 'y'.repeat(4)); // b sent 1; a received 1
      await send(a.key, room, 'z'.repeat(5)); // a sent 2 to room; b received 2 in room
      await send(owner.token, ownerDm, 'h'.repeat(8)); // a received 2 from owner (human)
      await send(owner.token, room, 'r'); // both agents receive 1 from the room

      const res = await analytics(owner.token, a.id, '24h');
      expect(res.statusCode).toBe(200);
      const body = AgentAnalyticsResponseSchema.parse(res.json());
      expect(body.window).toBe('24h');
      expect(body.totals).toEqual({ sent: 2, received: 3, tokensSent: 5, tokensReceived: 4 });
      expect(body.withAgents).toEqual({ messages: 2, tokens: 4 });
      expect(body.withHumans).toEqual({ messages: 1, tokens: 2 });
      expect(body.inDms).toEqual({ messages: 3, tokens: 6 });
      expect(body.inRooms).toEqual({ messages: 2, tokens: 3 });
      expect(body.counterparts).toEqual([
        { kind: 'agent', id: b.id, name: 'beta', messages: 2, tokens: 4 },
        { kind: 'human', id: owner.userId, name: 'Owner', messages: 1, tokens: 2 },
      ]);
      expect(body.rooms).toEqual([
        { roomId: room, name: expect.any(String), messages: 2, tokens: 3 },
      ]);
      // Hourly series over the last 24 h; every message lands in it.
      expect(body.series.length).toBeGreaterThanOrEqual(24);
      expect(body.series.reduce((n, p) => n + p.messages, 0)).toBe(5);
      expect(body.series.reduce((n, p) => n + p.tokens, 0)).toBe(9);

      const bBody = (await analytics(owner.token, b.id, '24h')).json();
      expect(bBody.totals).toEqual({ sent: 1, received: 3, tokensSent: 1, tokensReceived: 6 });
    });

    it('windows: daily series otherwise; all starts at the agent creation; old buckets drop out', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const room = await coRoom(a.id);
      await send(a.key, room, 'abcd');
      // An old bucket, 10 days back, written straight to the store.
      const sqlite = new Database(path.join(ts.dataDir, 'sparrow.db'));
      const old = new Date(Date.now() - 10 * 86_400_000);
      old.setUTCMinutes(0, 0, 0);
      sqlite
        .prepare(
          `INSERT INTO message_stats (agent_id, hour_start, direction, counterpart_kind, counterpart_id, messages, tokens)
           VALUES (?, ?, 'sent', 'room', ?, 7, 70)`,
        )
        .run(a.id, old.toISOString(), room);
      sqlite.close();

      const week = AgentAnalyticsResponseSchema.parse((await analytics(owner.token, a.id, '7d')).json());
      expect(week.totals.sent).toBe(1);
      expect(week.series.length).toBeGreaterThanOrEqual(7);
      expect(week.series.length).toBeLessThanOrEqual(8);
      expect(new Date(week.series[0]!.start).getUTCHours()).toBe(0);
      const month = AgentAnalyticsResponseSchema.parse((await analytics(owner.token, a.id, '30d')).json());
      expect(month.totals.sent).toBe(8);
      expect(month.totals.tokensSent).toBe(71);
      const all = (await analytics(owner.token, a.id, 'all')).json();
      const agent = (await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(a.key) })).json();
      expect(agent.principal.id).toBe(a.id);
      const created = (
        await ts.app.inject({ method: 'GET', url: '/api/v1/me/agents', headers: auth(owner.token) })
      ).json().items[0].agent.createdAt as string;
      expect(all.from).toBe(created);
      expect((await analytics(owner.token, a.id, 'bogus')).statusCode).toBe(400);
    });

    it('readable by owner, admins, the agent itself and tag grant holders; others 403', async () => {
      const a = await makeAgent(ts.app, owner.token, orgId, 'alpha');
      const mgr = await makeAgent(ts.app, owner.token, orgId, 'mgr');
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@ex.com');
      expect((await analytics(a.key, a.id)).statusCode).toBe(200);
      expectForbidden(await analytics(bob.token, a.id), 'grant_required');
      expectForbidden(await analytics(mgr.key, a.id), 'grant_required');
      await grant(owner.token, mgr.id, 'tag:cubes');
      await putTags(owner.token, a.id, ['cubes']);
      expect((await analytics(mgr.key, a.id)).statusCode).toBe(200);
      await promote(bob.userId);
      expect((await analytics(bob.token, a.id)).statusCode).toBe(200);
    });

    it('reads use the outranked guard: a sub-agent never reads its manager', async () => {
      const mgr = await makeAgent(ts.app, owner.token, orgId, 'mgr');
      const sub = await makeAgent(ts.app, owner.token, orgId, 'sub');
      await grant(owner.token, mgr.id, 'tags:*');
      await putTags(owner.token, mgr.id, ['cubes']);
      await grant(mgr.key, sub.id, 'tag:cubes');
      expectForbidden(await analytics(sub.key, mgr.id), 'outranked');
      // The manager reads the sub (untagged: tags:* is org-wide); the owner reads both.
      expect((await analytics(mgr.key, sub.id)).statusCode).toBe(200);
      expect((await analytics(owner.token, mgr.id)).statusCode).toBe(200);
    });
  });
});
