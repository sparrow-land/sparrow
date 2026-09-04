import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Hint } from '@sparrow/common-types';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createRoom,
  makeAgent,
  type TestServer,
} from './test-helpers.js';

const CLI = (v: string) => ({ 'x-sparrow-client': `sparrow-cli/${v}` });

let ts: TestServer;
afterEach(async () => {
  if (ts) await ts.close();
});

/* ================================================================== *
 * GET /api/v1/meta — client policy advertisement
 * ================================================================== */

describe('meta client-version policy', () => {
  it('advertises server.version and null client policy by default', async () => {
    ts = await makeTestServer();
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.server.version).toBe('string');
    expect(body.client).toEqual({ minimum: null, recommended: null });
  });

  it('advertises the configured minimum + recommended versions', async () => {
    ts = await makeTestServer({ clientMinVersion: '0.2.0', clientRecommendedVersion: '0.3.0' });
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/meta' });
    const body = res.json();
    expect(body.client).toEqual({ minimum: '0.2.0', recommended: '0.3.0' });
  });
});

/* ================================================================== *
 * Hard tier — 426 on requests below the minimum
 * ================================================================== */

describe('426 client-upgrade gate', () => {
  it('is off when no minimum is configured (old client passes)', async () => {
    ts = await makeTestServer();
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/meta', headers: CLI('0.0.1') });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a known client below the minimum with 426 + code + docs', async () => {
    ts = await makeTestServer({ clientMinVersion: '0.2.0' });
    // /healthz is a normal (non-escape-hatch) route.
    const res = await ts.app.inject({ method: 'GET', url: '/healthz', headers: CLI('0.1.0') });
    expect(res.statusCode).toBe(426);
    const body = res.json();
    expect(body.error.code).toBe('client_upgrade_required');
    expect(body.error.message).toContain('0.1.0');
    expect(body.error.message).toContain('0.2.0');
    expect(body.error.docs).toBe('https://sparrow.land/docs/api/versioning.md');
  });

  it('passes a client AT or ABOVE the minimum', async () => {
    ts = await makeTestServer({ clientMinVersion: '0.2.0' });
    const at = await ts.app.inject({ method: 'GET', url: '/healthz', headers: CLI('0.2.0') });
    expect(at.statusCode).toBe(200);
    const above = await ts.app.inject({ method: 'GET', url: '/healthz', headers: CLI('0.9.0') });
    expect(above.statusCode).toBe(200);
  });

  it('ignores build metadata when comparing (0.2.0+build passes 0.2.0 floor)', async () => {
    ts = await makeTestServer({ clientMinVersion: '0.2.0' });
    const res = await ts.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: CLI('0.2.0+20260101.deadbee'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('leaves absent and unparseable client headers ungated', async () => {
    ts = await makeTestServer({ clientMinVersion: '0.2.0' });
    const absent = await ts.app.inject({ method: 'GET', url: '/healthz' });
    expect(absent.statusCode).toBe(200);
    const garbage = await ts.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-sparrow-client': 'not-a-valid-ident' },
    });
    expect(garbage.statusCode).toBe(200);
  });

  it('never gates the escape hatches (meta, docs, install) even for an old client', async () => {
    ts = await makeTestServer({ clientMinVersion: '0.2.0' });
    const old = CLI('0.0.1');
    const meta = await ts.app.inject({ method: 'GET', url: '/api/v1/meta', headers: old });
    expect(meta.statusCode).toBe(200);
    // Docs and install are 302s to the canonical homes — the point is that an old
    // client is redirected onward rather than rejected with a 426 it cannot clear.
    const docs = await ts.app.inject({ method: 'GET', url: '/docs/api/versioning', headers: old });
    expect(docs.statusCode).toBe(302);
    expect(docs.headers.location).toBe('https://sparrow.land/docs/api/versioning.md');
    const installScript = await ts.app.inject({ method: 'GET', url: '/install.sh', headers: old });
    expect(installScript.statusCode).toBe(302);
    expect(installScript.headers.location).toBe('https://sparrow.land/install.sh');
    const installBundle = await ts.app.inject({
      method: 'GET',
      url: '/install/sparrow.js',
      headers: old,
    });
    expect(installBundle.statusCode).toBe(302);
    expect(installBundle.headers.location).toBe('https://sparrow.land/install/sparrow.js');
  });
});

/* ================================================================== *
 * Soft tier — the `upgrade-your-cli` hint
 * ================================================================== */

interface Fixture {
  ts: TestServer;
  agentKey: string;
  roomId: string;
}

async function setupAgentInRoom(overrides = {}): Promise<Fixture> {
  const server = await makeTestServer(overrides);
  const owner = await signup(server.app, { email: 'owner@example.com', displayName: 'Olive' });
  const orgId = await firstOrgId(server.app, owner.token);
  const roomId = await createRoom(server.app, owner.token, orgId, 'ops');
  const agent = await makeAgent(server.app, owner.token, orgId, 'deploy-bot');
  const add = await server.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/members`,
    headers: auth(owner.token),
    payload: { principal: agent.id },
  });
  if (add.statusCode !== 201) throw new Error(`add agent failed: ${add.body}`);
  // Mark the agent online so the higher-priority `start-listening` trigger (which
  // fires for an offline principal) is suppressed and the upgrade hint can surface.
  const presence = await server.app.inject({
    method: 'POST',
    url: '/api/v1/me/presence',
    headers: auth(agent.key),
    payload: { ttlSeconds: 120 },
  });
  if (presence.statusCode !== 200) throw new Error(`presence failed: ${presence.body}`);
  // …and hold a working status so `set-a-status` (an online, recently active
  // agent advertising none) doesn't preempt the upgrade hint under test.
  const status = await server.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/status`,
    headers: auth(agent.key),
    payload: { state: 'working', note: 'busy' },
  });
  if (status.statusCode !== 200) throw new Error(`status failed: ${status.body}`);
  return { ts: server, agentKey: agent.key, roomId };
}

/**
 * Hints ride the PAUSE, not the work: the one hinted response on this server is
 * an empty `POST /me/inbox/pop`. The agent in this fixture has an empty inbox, so
 * every pop here is that pause.
 */
async function pauseAndGetHints(
  app: FastifyInstance,
  key: string,
  headers: Record<string, string> = {},
): Promise<Hint[] | undefined> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/inbox/pop',
    headers: { ...auth(key), ...headers },
    payload: {},
  });
  if (res.statusCode !== 200) throw new Error(`pop failed (${res.statusCode}): ${res.body}`);
  const body = res.json();
  expect(body.item).toBeNull();
  return body.hints as Hint[] | undefined;
}

const hasUpgrade = (hints: Hint[] | undefined): Hint | undefined =>
  hints?.find((h) => h.id === 'upgrade-your-cli');

describe('upgrade-your-cli hint', () => {
  it('fires for a known client below the recommended version', async () => {
    const fx = await setupAgentInRoom({ clientRecommendedVersion: '0.3.0' });
    ts = fx.ts;
    const hints = await pauseAndGetHints(fx.ts.app, fx.agentKey, CLI('0.1.0'));
    const hint = hasUpgrade(hints);
    expect(hint).toBeDefined();
    expect(hint!.text).toContain('0.3.0');
    expect(hint!.docs).toBe('https://sparrow.land/docs/api/versioning.md');
  });

  it('does NOT fire at or above the recommended version', async () => {
    const fx = await setupAgentInRoom({ clientRecommendedVersion: '0.3.0' });
    ts = fx.ts;
    const hints = await pauseAndGetHints(fx.ts.app, fx.agentKey, CLI('0.3.0'));
    expect(hasUpgrade(hints)).toBeUndefined();
  });

  it('does NOT fire for unknown / header-less clients', async () => {
    const fx = await setupAgentInRoom({ clientRecommendedVersion: '0.3.0' });
    ts = fx.ts;
    const hints = await pauseAndGetHints(fx.ts.app, fx.agentKey); // no header
    expect(hasUpgrade(hints)).toBeUndefined();
  });

  it('does NOT fire when no recommended version is configured', async () => {
    const fx = await setupAgentInRoom();
    ts = fx.ts;
    const hints = await pauseAndGetHints(fx.ts.app, fx.agentKey, CLI('0.0.1'));
    expect(hasUpgrade(hints)).toBeUndefined();
  });
});
