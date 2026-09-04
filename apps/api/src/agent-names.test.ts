/**
 * The v4 agent-name rule (SPEC "Identity & addressing → Agent names &
 * addresses"). An agent's name IS the local part of its email address, so it is
 * lowercase and email-safe. The rule is enforced at all four points a name enters
 * the system — mint, enroll, self-rename, owner-rename — with the same outcome
 * everywhere: malformed → `400`, reserved → `409`, taken → `409` (never
 * auto-suffixed). The ONE exception is approval-time collision resolution, which
 * keeps v3's `-2`/`-3` suffixing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createInvite,
  makeAgent,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

/** Names the shape rule rejects (400) — the message names the rule. */
const MALFORMED = ['Ops-Bot', 'ops..bot', '-ops', 'ops-', '.ops', 'ops bot', 'ops@bot', 'OPS'];

describe('agent name rule (v4)', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;

  async function mint(name: string) {
    return ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name },
    });
  }

  async function enroll(name: string) {
    const inv = await createInvite(ts.app, owner.token, orgId);
    return ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name },
    });
  }

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  describe('mint — POST /me/agents', () => {
    it('accepts an email-safe name', async () => {
      const ok = await mint('ops.bot_1-x');
      expect(ok.statusCode).toBe(201);
      expect(ok.json().agent.name).toBe('ops.bot_1-x');
    });

    it('rejects a malformed name with 400 naming the rule', async () => {
      for (const name of MALFORMED) {
        const res = await mint(name);
        expect(res.statusCode, name).toBe(400);
        expect(res.json().error.code).toBe('bad_request');
        expect(res.json().error.message).toContain('lowercase');
      }
    });

    it('rejects a reserved local part with 409 — the same outcome as a taken name', async () => {
      for (const name of ['postmaster', 'admin', 'no-reply', 'mailer-daemon']) {
        const res = await mint(name);
        expect(res.statusCode, name).toBe(409);
        expect(res.json().error.code).toBe('conflict');
      }
      await mint('taken');
      expect((await mint('taken')).statusCode).toBe(409);
    });
  });

  describe('enroll — POST /invite/:token/enroll (the proposed name)', () => {
    it('validates at the knock: malformed → 400, reserved → 409, valid → 202', async () => {
      expect((await enroll('Ops-Bot')).statusCode).toBe(400);
      expect((await enroll('ops..bot')).statusCode).toBe(400);
      const reserved = await enroll('webmaster');
      expect(reserved.statusCode).toBe(409);
      expect(reserved.json().error.code).toBe('conflict');
      const ok = await enroll('helper');
      expect(ok.statusCode).toBe(202);
    });

    it('approval-time collision keeps the -2 suffix (the one exception to 409)', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const knock = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${inv.token}/enroll`,
        payload: { name: 'buddy' },
      });
      expect(knock.statusCode).toBe(202);
      // The name is taken in the interim.
      await makeAgent(ts.app, owner.token, orgId, 'buddy');
      const list = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/enrollments`,
        headers: auth(owner.token),
      });
      const eid = (list.json().items as { id: string }[])[0]!.id;
      const approve = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
        headers: auth(owner.token),
      });
      expect(approve.statusCode).toBe(200);
      const poll = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
        headers: auth(knock.json().enrollmentToken as string),
      });
      expect(poll.json().agent.name).toBe('buddy-2');
    });
  });

  describe('rename — PATCH /me (self) and PATCH /me/agents/:id (owner)', () => {
    it('self-rename: malformed → 400, reserved → 409, taken → 409, valid → 200', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      await makeAgent(ts.app, owner.token, orgId, 'occupied');
      const self = async (name: string) =>
        ts.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: auth(bot.key), payload: { name } });

      expect((await self('New-Name')).statusCode).toBe(400);
      expect((await self('a..b')).statusCode).toBe(400);
      const reserved = await self('root');
      expect(reserved.statusCode).toBe(409);
      expect((await self('occupied')).statusCode).toBe(409);
      const ok = await self('renamed.bot');
      expect(ok.statusCode).toBe(200);
      expect(ok.json().principal.name).toBe('renamed.bot');
    });

    it('owner rename: same outcomes', async () => {
      const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
      await makeAgent(ts.app, owner.token, orgId, 'occupied');
      const byOwner = async (name: string) =>
        ts.app.inject({
          method: 'PATCH',
          url: `/api/v1/me/agents/${bot.id}`,
          headers: auth(owner.token),
          payload: { name },
        });

      expect((await byOwner('Nope')).statusCode).toBe(400);
      expect((await byOwner('security')).statusCode).toBe(409);
      expect((await byOwner('occupied')).statusCode).toBe(409);
      expect((await byOwner('fine-name')).statusCode).toBe(200);
    });
  });
});
