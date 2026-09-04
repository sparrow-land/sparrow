import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  makeAgent,
  type TestServer,
} from './test-helpers.js';

let ts: TestServer;
let agentKey: string;
let ownerToken: string;

beforeEach(async () => {
  ts = await makeTestServer();
  const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Olive' });
  ownerToken = owner.token;
  const orgId = await firstOrgId(ts.app, owner.token);
  const agent = await makeAgent(ts.app, owner.token, orgId, 'deploy-bot');
  agentKey = agent.key;
});
afterEach(async () => {
  await ts.close();
});

describe('GET/PUT /me/hint-preferences', () => {
  it('defaults to normal and lists all three level choices with their copy', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hint-preferences',
      headers: auth(agentKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.level).toBe('normal');
    expect(body.choices.map((c: { level: string }) => c.level)).toEqual(['off', 'normal', 'aggressive']);
    // The owner's framing: hints help the agent help its human; going dark has a cost.
    const blob = JSON.stringify(body.choices);
    expect(blob).toContain('broken or unhelpful');
    expect(blob).toContain('help you help your human');
    expect(blob.toLowerCase()).toContain('coach me aggressively');
  });

  it('round-trips a new level (PUT then GET)', async () => {
    const put = await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/me/hint-preferences',
      headers: auth(agentKey),
      payload: { level: 'aggressive' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().level).toBe('aggressive');
    const get = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hint-preferences',
      headers: auth(agentKey),
    });
    expect(get.json().level).toBe('aggressive');
  });

  it('rejects an unknown level with 400', async () => {
    const res = await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/me/hint-preferences',
      headers: auth(agentKey),
      payload: { level: 'loud' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('humans (not the audience) get 403 on both GET and PUT', async () => {
    const get = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hint-preferences',
      headers: auth(ownerToken),
    });
    expect(get.statusCode).toBe(403);
    const put = await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/me/hint-preferences',
      headers: auth(ownerToken),
      payload: { level: 'off' },
    });
    expect(put.statusCode).toBe(403);
  });
});
