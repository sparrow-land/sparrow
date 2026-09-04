/**
 * The email medium is OFF in this build (SPEC "Identity & addressing →
 * Addresses" and "Misc → GET /capabilities"). The v4 wire shapes exist anyway:
 * every agent-bearing response carries `emailAddress: null`, and the
 * unauthenticated capability advertisement reports `email: false` — a client
 * gates its render on that, and never discovers a medium by taking a `404`.
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

describe('email medium off — additive v4 fields', () => {
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

  it('GET /capabilities reports email: false', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(false);
  });

  it('every agent-bearing response carries emailAddress: null', async () => {
    const created = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'bot' },
    });
    expect(created.json().agent.emailAddress).toBeNull();
    const agentId = created.json().agent.id as string;
    const agentKey = created.json().key as string;

    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/agents?org=${orgId}`,
      headers: auth(owner.token),
    });
    expect(list.json().items[0].agent.emailAddress).toBeNull();

    const me = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(agentKey) });
    expect(me.json().principal.emailAddress).toBeNull();

    const patched = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/me/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { sharing: 'org' },
    });
    expect(patched.json().agent.emailAddress).toBeNull();

    const rotated = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${agentId}/rotate`,
      headers: auth(owner.token),
    });
    expect(rotated.json().agent.emailAddress).toBeNull();

    const governance = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents`,
      headers: auth(owner.token),
    });
    expect(governance.json().items[0].agent.emailAddress).toBeNull();
  });

  it('the enrollment key delivery carries emailAddress: null (instant + approved poll)', async () => {
    // `open` policy → instant mint.
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { enroll: { agents: 'open' } } },
    });
    const openInvite = await createInvite(ts.app, owner.token, orgId);
    const instant = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${openInvite.token}/enroll`,
      payload: { name: 'instant' },
    });
    expect(instant.statusCode).toBe(201);
    expect(instant.json().emailAddress).toBeNull();
    expect(instant.json().agent.emailAddress).toBeNull();

    // `approval` policy → the key (and the address) arrive on the first poll.
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { enroll: { agents: 'approval' } } },
    });
    const inv = await createInvite(ts.app, owner.token, orgId);
    const knock = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name: 'pending' },
    });
    const eid = knock.json().enrollment.id as string;
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
      headers: auth(owner.token),
    });
    const poll = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
      headers: auth(knock.json().enrollmentToken as string),
    });
    expect(poll.json().status).toBe('approved');
    expect(poll.json().key).toBeDefined();
    expect(poll.json().emailAddress).toBeNull();
    expect(poll.json().agent.emailAddress).toBeNull();
  });

  it('makeAgent-minted agents still round-trip through the visibility list', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'helper');
    const list = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
    });
    const entry = (list.json().items as { agent: { id: string; emailAddress: unknown } }[]).find(
      (i) => i.agent.id === bot.id,
    )!;
    expect(entry.agent.emailAddress).toBeNull();
  });
});
