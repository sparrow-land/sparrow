/**
 * Onboarding mode — the first-run wizard's server half (SPEC "Onboarding mode").
 *
 * The web app asks `GET /api/v1/onboarding` on every load of the sign-in page,
 * so this suite pins the whole contract: the five reasons IN ORDER, the env
 * parsing, `no-store`, the idempotent dismiss, the flag surviving a rebuild on
 * the same database, and the cost (one count query, and only when it is the
 * question that remains).
 *
 * Not to be confused with `onboarding.test.ts` — that is the agent invite doc.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestServer, recordStatements, signup, type TestServer } from './test-helpers.js';
import { buildServer } from './server.js';
import { envConfig } from './config.js';
import { ONBOARDING_DISMISSED_KEY } from './routes/onboarding-mode.js';

async function status(app: FastifyInstance): Promise<{
  statusCode: number;
  cacheControl: string | undefined;
  body: { active: boolean; reason: string };
}> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/onboarding' });
  return {
    statusCode: res.statusCode,
    cacheControl: res.headers['cache-control'] as string | undefined,
    body: res.statusCode === 200 ? res.json() : { active: false, reason: String(res.statusCode) },
  };
}

async function dismiss(app: FastifyInstance): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/onboarding/dismiss' });
  return res.statusCode;
}

describe('GET /onboarding — the reasons, in order', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  it('empty: a fresh instance with no human account is the ONE active state', async () => {
    ts = await makeTestServer();
    const res = await status(ts.app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ active: true, reason: 'empty' });
  });

  it('never cached: the sign-in page must not read a stale answer', async () => {
    ts = await makeTestServer();
    const res = await status(ts.app);
    expect(res.cacheControl).toBe('no-store');
  });

  it('public: no session, no admin token, no 401', async () => {
    ts = await makeTestServer();
    expect((await status(ts.app)).statusCode).toBe(200);
    expect(await dismiss(ts.app)).toBe(204);
  });

  it('populated: one human account closes it', async () => {
    ts = await makeTestServer();
    await signup(ts.app, { email: 'olive@example.com', displayName: 'Olive' });
    expect((await status(ts.app)).body).toEqual({ active: false, reason: 'populated' });
  });

  it('dismissed beats populated', async () => {
    ts = await makeTestServer();
    await signup(ts.app, { email: 'olive@example.com', displayName: 'Olive' });
    expect(await dismiss(ts.app)).toBe(204);
    expect((await status(ts.app)).body).toEqual({ active: false, reason: 'dismissed' });
  });

  it('disabled beats dismissed and an empty instance', async () => {
    ts = await makeTestServer({ skipOnboarding: true });
    expect(await dismiss(ts.app)).toBe(204);
    expect((await status(ts.app)).body).toEqual({ active: false, reason: 'disabled' });
  });

  it('hosted beats everything: a host-scoped tenant never runs the wizard', async () => {
    ts = await makeTestServer({ orgHostSuffix: '.example.com', skipOnboarding: true });
    expect(await dismiss(ts.app)).toBe(204);
    expect((await status(ts.app)).body).toEqual({ active: false, reason: 'hosted' });
  });
});

describe('POST /onboarding/dismiss', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  it('is idempotent: 204 every time, and the reason stays dismissed', async () => {
    ts = await makeTestServer();
    expect(await dismiss(ts.app)).toBe(204);
    expect(await dismiss(ts.app)).toBe(204);
    expect(await dismiss(ts.app)).toBe(204);
    expect((await status(ts.app)).body).toEqual({ active: false, reason: 'dismissed' });
  });

  it('returns an empty body', async () => {
    ts = await makeTestServer();
    const res = await ts.app.inject({ method: 'POST', url: '/api/v1/onboarding/dismiss' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('records the flag even when onboarding was not active', async () => {
    // Cancel on a hosted instance is harmless — and still remembered, so the
    // answer does not change if the instance later stops being host-scoped.
    const dir = mkdtempSync(path.join(tmpdir(), 'sparrow-onboarding-mode-'));
    const hosted = buildServer({
      dataDir: dir,
      baseUrl: 'http://localhost:8722',
      orgHostSuffix: '.example.com',
    });
    await hosted.ready();
    expect(await dismiss(hosted)).toBe(204);
    await hosted.close();

    const plain = buildServer({ dataDir: dir, baseUrl: 'http://localhost:8722' });
    await plain.ready();
    expect((await status(plain)).body).toEqual({ active: false, reason: 'dismissed' });
    await plain.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a restart on the same database', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sparrow-onboarding-mode-'));
    const first = buildServer({ dataDir: dir, baseUrl: 'http://localhost:8722' });
    await first.ready();
    expect((await status(first)).body).toEqual({ active: true, reason: 'empty' });
    expect(await dismiss(first)).toBe(204);
    await first.close();

    const second = buildServer({ dataDir: dir, baseUrl: 'http://localhost:8722' });
    await second.ready();
    expect((await status(second)).body).toEqual({ active: false, reason: 'dismissed' });
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SPARROW_SKIP_ONBOARDING (env)', () => {
  it.each(['1', 'true', 'on', 'TRUE', ' On '])('%j disables onboarding', (raw) => {
    expect(envConfig({ SPARROW_SKIP_ONBOARDING: raw } as NodeJS.ProcessEnv).skipOnboarding).toBe(true);
  });

  it.each([undefined, '', '   ', '0', 'false', 'off', 'FALSE'])('%j reads as unset', (raw) => {
    const env = (raw === undefined ? {} : { SPARROW_SKIP_ONBOARDING: raw }) as NodeJS.ProcessEnv;
    expect(envConfig(env).skipOnboarding).toBe(false);
  });
});

describe('onboarding mode grants nothing', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  it('does not bypass auth.allowSignup: the wizard uses the normal signup route', async () => {
    ts = await makeTestServer();
    const put = await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { 'x-admin-token': 'test-admin-token' },
      payload: { values: { 'auth.allowSignup': false } },
    });
    expect(put.statusCode).toBe(200);
    // Still the one active state — the wizard is offered...
    expect((await status(ts.app)).body).toEqual({ active: true, reason: 'empty' });
    // ...and signup still refuses, exactly as it would with no wizard at all.
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'olive@example.com', password: 'password123', displayName: 'Olive' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('the dismissal latch is not a setting', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  it('stays out of GET /config and is refused by PUT /config', async () => {
    ts = await makeTestServer();
    await dismiss(ts.app);
    const admin = { 'x-admin-token': 'test-admin-token' };
    const entries = await ts.app.inject({ method: 'GET', url: '/api/v1/config', headers: admin });
    const keys = (entries.json().entries as { descriptor: { key: string } }[]).map(
      (e) => e.descriptor.key,
    );
    expect(keys).not.toContain(ONBOARDING_DISMISSED_KEY);
    const put = await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: admin,
      payload: { values: { [ONBOARDING_DISMISSED_KEY]: false } },
    });
    expect(put.statusCode).toBe(400);
    // ...and the latch it tried to flip is untouched.
    expect((await status(ts.app)).body).toEqual({ active: false, reason: 'dismissed' });
  });
});

describe('cost', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  it('counts humans once, and only when that is the question left', async () => {
    ts = await makeTestServer();
    const log = recordStatements();
    try {
      log.reset();
      await status(ts.app);
      expect(log.count('count(*)')).toBe(1);
      expect(log.count('from "humans"')).toBe(1);

      // Dismissed short-circuits ABOVE the count: no scan of humans at all.
      await dismiss(ts.app);
      log.reset();
      await status(ts.app);
      expect(log.count('from "humans"')).toBe(0);
    } finally {
      log.restore();
    }
  });
});
