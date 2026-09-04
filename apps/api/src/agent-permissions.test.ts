import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

/**
 * Agent-permission boundary (owner directive): a human controls their agents
 * freely, but an AGENT credential may only ever mutate ITSELF — its own
 * identity (`PATCH /me`), its own status/presence/hint-preferences, and its own
 * messages. It must NEVER change settings on another agent, another member, a
 * room, or the org. This pins the whole mutation surface against an agent caller.
 *
 * The two owned agents mirror the field report (an older `cos` + a newer one):
 * the point is that an agent token cannot reach across to the sibling agent.
 */
describe('agent permissions — an agent token affects only itself', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;
  let cos: { id: string; key: string }; // older agent (the field-report victim)
  let bolide: { id: string; key: string }; // newer sibling
  let roomId: string;
  let cosMemberId: string;
  let bolideMemberId: string;

  const addAgent = async (agentId: string): Promise<string> => {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agentId },
    });
    if (res.statusCode !== 201) throw new Error(`addAgent ${res.statusCode}: ${res.body}`);
    return res.json().member.id as string;
  };

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    cos = await makeAgent(ts.app, owner.token, orgId, 'cos');
    bolide = await makeAgent(ts.app, owner.token, orgId, 'newbie');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    cosMemberId = await addAgent(cos.id);
    bolideMemberId = await addAgent(bolide.id);
  });
  afterEach(async () => {
    await ts.close();
  });

  const inject = (method: string, url: string, key: string, payload?: unknown) =>
    ts.app.inject({ method: method as 'GET', url, headers: auth(key), payload: payload as object });

  /* ---- owner-only agent routes: an agent token is rejected outright ---- */
  describe('owner-only /me/agents routes reject an agent credential', () => {
    it('cannot rename a sibling agent (PATCH /me/agents/:id { name })', async () => {
      const res = await inject('PATCH', `/api/v1/me/agents/${bolide.id}`, cos.key, { name: 'bolide' });
      expect(res.statusCode).toBe(401);
      // And the sibling is untouched.
      const me = await inject('GET', '/api/v1/me', bolide.key);
      expect(me.json().principal.name).toBe('newbie');
    });
    it('cannot rename ITSELF through the owner route either (self-rename is PATCH /me)', async () => {
      const res = await inject('PATCH', `/api/v1/me/agents/${cos.id}`, cos.key, { name: 'x' });
      expect(res.statusCode).toBe(401);
    });
    it('cannot change a sibling’s sharing mode', async () => {
      const res = await inject('PATCH', `/api/v1/me/agents/${bolide.id}`, cos.key, { sharing: 'org' });
      expect(res.statusCode).toBe(401);
    });
    it('cannot set a sibling’s role (owner-only route rejects an agent credential)', async () => {
      const res = await inject('PATCH', `/api/v1/me/agents/${bolide.id}`, cos.key, { roleTitle: 'pwned' });
      expect(res.statusCode).toBe(401);
      // And the sibling’s role is untouched.
      expect((await inject('GET', '/api/v1/me', bolide.key)).json().principal.roleTitle).toBeNull();
    });
    it('cannot delete a sibling agent', async () => {
      expect((await inject('DELETE', `/api/v1/me/agents/${bolide.id}`, cos.key)).statusCode).toBe(401);
    });
    it('cannot rotate a sibling’s key', async () => {
      expect((await inject('POST', `/api/v1/me/agents/${bolide.id}/rotate`, cos.key)).statusCode).toBe(401);
    });
    it('cannot share/unshare a sibling', async () => {
      expect(
        (await inject('POST', `/api/v1/me/agents/${bolide.id}/share`, cos.key, { human: owner.userId })).statusCode,
      ).toBe(401);
      expect(
        (await inject('DELETE', `/api/v1/me/agents/${bolide.id}/share/${owner.userId}`, cos.key)).statusCode,
      ).toBe(401);
    });
    it('cannot mint a new agent', async () => {
      expect(
        (await inject('POST', '/api/v1/me/agents', cos.key, { orgId, name: 'spawn' })).statusCode,
      ).toBe(401);
    });
  });

  /* ---- room mutations: an agent member is capped at `member` rank ---- */
  describe('room mutations reject an agent member (rank-capped at member)', () => {
    it('cannot remove a sibling agent from the room', async () => {
      const res = await inject('DELETE', `/api/v1/rooms/${roomId}/members/${bolideMemberId}`, cos.key);
      expect(res.statusCode).toBe(403);
      // Sibling is still a member.
      const members = await inject('GET', `/api/v1/rooms/${roomId}/members`, owner.token);
      expect((members.json().items as { id: string }[]).some((m) => m.id === bolideMemberId)).toBe(true);
    });
    it('cannot remove the owner (a human owner-role member)', async () => {
      // Resolve the owner's member id.
      const members = await inject('GET', `/api/v1/rooms/${roomId}/members`, owner.token);
      const ownerMember = (members.json().items as { id: string; kind: string }[]).find(
        (m) => m.kind === 'human',
      )!;
      const res = await inject('DELETE', `/api/v1/rooms/${roomId}/members/${ownerMember.id}`, cos.key);
      expect(res.statusCode).toBe(403);
    });
    it('cannot promote the owner or any member’s room role', async () => {
      const members = await inject('GET', `/api/v1/rooms/${roomId}/members`, owner.token);
      const ownerMember = (members.json().items as { id: string; kind: string }[]).find(
        (m) => m.kind === 'human',
      )!;
      const res = await inject('PATCH', `/api/v1/rooms/${roomId}/members/${ownerMember.id}`, cos.key, {
        roomRole: 'member',
      });
      expect(res.statusCode).toBe(403);
    });
    it('cannot change room settings (name)', async () => {
      const res = await inject('PATCH', `/api/v1/rooms/${roomId}`, cos.key, { name: 'hijacked' });
      expect(res.statusCode).toBe(403);
    });
    it('cannot archive the room', async () => {
      const res = await inject('PATCH', `/api/v1/rooms/${roomId}`, cos.key, { archived: true });
      expect(res.statusCode).toBe(403);
    });
    it('cannot add another agent to the room (adding members is a human action)', async () => {
      const res = await inject('POST', `/api/v1/rooms/${roomId}/members`, cos.key, { principal: bolide.id });
      expect(res.statusCode).toBe(403);
    });
    it('cannot invite a human to the room', async () => {
      const res = await inject('POST', `/api/v1/rooms/${roomId}/invitations`, cos.key, {
        human: owner.userId,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  /* ---- org & account mutations: agent credential is rejected ---- */
  describe('org / account mutations reject an agent credential', () => {
    it('cannot change org settings', async () => {
      expect((await inject('PATCH', `/api/v1/orgs/${orgId}`, cos.key, { name: 'Pwned' })).statusCode).toBe(401);
    });
    it('cannot add an org member', async () => {
      expect(
        (await inject('POST', `/api/v1/orgs/${orgId}/members`, cos.key, { email: 'x@y.com' })).statusCode,
      ).toBe(401);
    });
    it('cannot set another human’s org role', async () => {
      expect(
        (await inject('PATCH', `/api/v1/orgs/${orgId}/humans/${owner.userId}`, cos.key, { role: 'member' }))
          .statusCode,
      ).toBe(401);
    });
    it('cannot set an avatar', async () => {
      expect(
        (await inject('PUT', '/api/v1/me/avatar', cos.key, { dataBase64: 'x', contentType: 'image/png' }))
          .statusCode,
      ).toBe(401);
    });
  });

  /* ---- the allowed self-surface still works for an agent ---- */
  describe('an agent may still act on ITSELF', () => {
    it('renames itself via PATCH /me', async () => {
      const res = await inject('PATCH', '/api/v1/me', cos.key, { name: 'cos-prime' });
      expect(res.statusCode).toBe(200);
      expect(res.json().principal.name).toBe('cos-prime');
    });
    it('sets its own role via PATCH /me', async () => {
      const res = await inject('PATCH', '/api/v1/me', cos.key, { roleTitle: 'Chief of staff' });
      expect(res.statusCode).toBe(200);
      expect(res.json().principal.roleTitle).toBe('Chief of staff');
    });
    it('sets its own working status', async () => {
      const res = await inject('POST', `/api/v1/rooms/${roomId}/status`, cos.key, { state: 'working' });
      expect(res.statusCode).toBe(200);
    });
    it('heartbeats its own presence', async () => {
      const res = await inject('POST', '/api/v1/me/presence', cos.key, { ttlSeconds: 60 });
      expect(res.statusCode).toBe(200);
    });
    it('sets its own hint preferences', async () => {
      const res = await inject('PUT', '/api/v1/me/hint-preferences', cos.key, { level: 'off' });
      expect(res.statusCode).toBe(200);
    });
    it('leaves the room itself (self-scoped)', async () => {
      const res = await inject('DELETE', `/api/v1/me/rooms/${roomId}`, bolide.key);
      expect([200, 204]).toContain(res.statusCode);
      void cosMemberId; // (cos stays; bolide left)
    });
  });
});
