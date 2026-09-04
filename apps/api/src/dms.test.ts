import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  makeAgent,
  shareAgent,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

describe('direct conversations (DMs)', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
  });
  afterEach(async () => {
    await ts.close();
  });

  const ensure = (token: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'POST', url: '/api/v1/me/dms', headers: auth(token), payload });

  it('human → agent: 201 then 200 idempotent; counterpart shape', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const first = await ensure(owner.token, { principal: bot.id });
    expect(first.statusCode).toBe(201);
    expect(first.json().room.kind).toBe('dm');
    expect(first.json().counterpart).toMatchObject({ type: 'agent', id: bot.id, displayName: 'bot' });
    const again = await ensure(owner.token, { principal: bot.id });
    expect(again.statusCode).toBe(200);
    expect(again.json().room.id).toBe(first.json().room.id);
  });

  it('agent → its owner: always allowed (agent key)', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const res = await ensure(bot.key, { principal: owner.userId });
    expect(res.statusCode).toBe(201);
    expect(res.json().counterpart).toMatchObject({ type: 'human', id: owner.userId });
  });

  it('human → human: allowed when both in the org', async () => {
    // owner↔alice already share a DM (owner invited alice → auto-ensured), so use
    // alice↔bob (neither invited the other) to exercise the fresh-create path.
    const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    const res = await ensure(alice.token, { principal: bob.userId });
    expect(res.statusCode).toBe(201);
    expect(res.json().counterpart.id).toBe(bob.userId);
  });

  it('self-DM 400; no-visibility DM 403', async () => {
    const self = await ensure(owner.token, { principal: owner.userId });
    expect(self.statusCode).toBe(400);

    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    // alice has no visibility on owner's bot → 403.
    const res = await ensure(alice.token, { principal: bot.id });
    expect(res.statusCode).toBe(403);

    // After a share, alice may DM the bot.
    await shareAgent(ts.app, owner.token, bot.id, alice.userId);
    const ok = await ensure(alice.token, { principal: bot.id });
    expect(ok.statusCode).toBe(201);
  });

  it('member-verbs + PATCH on a DM room → 400; leave + re-ensure re-joins', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const dm = await ensure(owner.token, { principal: bot.id });
    const roomId = dm.json().room.id as string;

    const addMember = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: bot.id },
    });
    expect(addMember.statusCode).toBe(400);

    const patch = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { name: 'nope' },
    });
    expect(patch.statusCode).toBe(400);

    // Leave, then re-ensure re-joins.
    const leave = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/rooms/${roomId}`,
      headers: auth(owner.token),
    });
    expect(leave.statusCode).toBe(200);
    const reEnsure = await ensure(owner.token, { principal: bot.id });
    expect(reEnsure.statusCode).toBe(200);
    const whoami = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/whoami`,
      headers: auth(owner.token),
    });
    expect(whoami.statusCode).toBe(200);
  });

  it('org disambiguation: orgId required only when the pair shares >1 org', async () => {
    // owner creates a second org and alice joins it too.
    const org2Res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(owner.token),
      payload: { name: 'Second' },
    });
    const org2 = org2Res.json().org.id as string;
    // Add the EXISTING alice account to org2 (invite → enroll with her session;
    // redeeming a valid invite grants membership immediately).
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${org2}/invites`,
      headers: auth(owner.token),
      payload: {},
    });
    const ivk = (inv.json().url as string).split('/invite/')[1];
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${ivk}/enroll`,
      headers: auth(alice.token),
      payload: {},
    });

    const ambiguous = await ensure(owner.token, { principal: alice.userId });
    expect(ambiguous.statusCode).toBe(400);

    // owner↔alice DMs were auto-ensured in both orgs at enrollment; orgId picks
    // org2's room (200, already exists).
    const disambiguated = await ensure(owner.token, { principal: alice.userId, orgId: org2 });
    expect(disambiguated.statusCode).toBe(200);
    expect(disambiguated.json().room.orgId).toBe(org2);
  });
});
