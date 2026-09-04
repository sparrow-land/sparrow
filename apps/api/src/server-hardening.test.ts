import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSpaRoute, looksLikeStaticAsset, loggerOptions, wantsSpaShell } from './server.js';
import { envConfig } from './config.js';
import { API_VERSION, BUILD_STAMP } from './version.js';
import { createInvite, firstOrgId, makeTestServer, signup, type TestServer } from './test-helpers.js';

const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' };

/** The Accept a real Chrome/Firefox navigation sends. */
const BROWSER_NAV = {
  'user-agent': 'Mozilla/5.0 (Macintosh)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** curl / a probing agent: wildcard Accept, no HTML preference. */
const MACHINE = { 'user-agent': 'curl/8.4.0', accept: '*/*' };

/**
 * A server WITH a static web root: `<root>/public/index.html` next to the data
 * dir is the hermetic stand-in for the built SPA bundle.
 */
async function makeSpaServer(): Promise<{ ts: TestServer; root: string; invite: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'sparrow-spa-'));
  mkdirSync(path.join(root, 'data'));
  mkdirSync(path.join(root, 'public'));
  writeFileSync(
    path.join(root, 'public', 'index.html'),
    '<!doctype html><html><head><title>sparrow</title></head><body><div id="root"></div></body></html>',
  );
  const ts = await makeTestServer({ dataDir: path.join(root, 'data') });
  const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Olive' });
  const orgId = await firstOrgId(ts.app, owner.token);
  const invite = await createInvite(ts.app, owner.token, orgId);
  return { ts, root, invite: invite.token };
}

/* ------------------------------------------------------------------ *
 * I-6 — the SPA catch-all only answers for KNOWN client routes
 * ------------------------------------------------------------------ */

describe('isSpaRoute', () => {
  it.each([
    '/',
    '/welcome',
    '/login',
    '/me',
    '/me/approvals',
    '/me/settings',
    '/admin',
    '/invite/ivk_abc',
    '/org/org_123',
    '/org/org_123/rooms/rm_1',
    '/org/org_123/rooms/rm_1/settings',
    '/org/org_123/agents/ag_1',
    '/org/org_123/admin',
    '/orgs/acme',
    '/rooms/rm_1',
    '/rooms/rm_1/settings',
    '/agents/ag_1',
  ])('%s is a client route', (p) => {
    expect(isSpaRoute(p)).toBe(true);
  });

  it.each([
    '/healthzz',
    '/health',
    '/metrics',
    '/capabilities',
    '/totally/bogus',
    '/assets/missing-chunk.js',
    '/.env',
    '/wp-admin',
    '/api/v1/nope',
    '/invite', // the SPA route is /invite/:token; the bare path is not a route
    // Docs are NOT an SPA route: they have one canonical home and the explicit
    // /docs routes 302 there, so nothing under /docs may reach the shell.
    '/docs',
    '/docs/cli',
    '/docs/api/me/inbox',
  ])('%s is NOT a client route', (p) => {
    expect(isSpaRoute(p)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * #35 — a BROWSER navigating anywhere gets the shell (so the SPA renders
 * its own 404 page); a MACHINE still gets the JSON envelope.
 * ------------------------------------------------------------------ */

describe('looksLikeStaticAsset', () => {
  it.each([
    '/assets/index-abc123.js',
    '/assets/style.css',
    '/assets',
    '/vendor.mjs',
    '/app.js.map',
    '/favicon.ico',
    '/logo.svg',
    '/site.webmanifest',
    '/robots.txt',
    '/fonts/inter.woff2',
    '/manifest.json',
  ])('%s looks like a build artifact', (p) => {
    expect(looksLikeStaticAsset(p)).toBe(true);
  });

  it.each(['/', '/rooms/rm_1', '/totally-bogus', '/org/org_1/rooms/rm_1', '/me', '/.env'])(
    '%s does not',
    (p) => {
      expect(looksLikeStaticAsset(p)).toBe(false);
    },
  );
});

describe('wantsSpaShell', () => {
  const html = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  it('serves the shell to a browser navigating to an unknown path', () => {
    expect(wantsSpaShell('/totally-bogus', html)).toBe(true);
    expect(wantsSpaShell('/rooms', html)).toBe(true);
    expect(wantsSpaShell('/org', html)).toBe(true);
  });

  it('does NOT serve the shell to a machine caller', () => {
    expect(wantsSpaShell('/totally-bogus', '*/*')).toBe(false);
    expect(wantsSpaShell('/healthzz', '*/*')).toBe(false);
    expect(wantsSpaShell('/totally-bogus', 'application/json')).toBe(false);
    expect(wantsSpaShell('/totally-bogus', undefined)).toBe(false);
    expect(wantsSpaShell('/totally-bogus', '')).toBe(false);
  });

  it('never serves the shell under /api/, whatever the Accept', () => {
    expect(wantsSpaShell('/api/v1/nope', html)).toBe(false);
    expect(wantsSpaShell('/api/v1/meta', html)).toBe(false);
  });

  it('never serves the shell for an asset-looking path, whatever the Accept', () => {
    expect(wantsSpaShell('/assets/missing.js', html)).toBe(false);
    expect(wantsSpaShell('/assets/missing.css', html)).toBe(false);
    expect(wantsSpaShell('/missing-chunk.mjs', html)).toBe(false);
  });

  it('serves the shell for an enumerated client route with any Accept', () => {
    for (const accept of [html, '*/*', 'application/json', undefined]) {
      expect(wantsSpaShell('/', accept)).toBe(true);
      expect(wantsSpaShell('/rooms/rm_1', accept)).toBe(true);
      expect(wantsSpaShell('/me/approvals', accept)).toBe(true);
    }
  });
});

describe('SPA fallback (I-6)', () => {
  let ts: TestServer;
  let root: string;
  let invite: string;

  beforeEach(async () => {
    ({ ts, root, invite } = await makeSpaServer());
  });
  afterEach(async () => {
    await ts.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['/', '/welcome', '/login', '/me/approvals', '/org/org_1/rooms/rm_1', '/rooms/rm_1', '/agents/ag_1', '/admin'])(
    'serves the SPA shell for the known client route %s',
    async (url) => {
      const res = await ts.app.inject({ method: 'GET', url, headers: BROWSER });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    },
  );

  it.each(['/healthzz', '/health', '/metrics', '/capabilities', '/totally/bogus', '/assets/missing.js'])(
    '404s (JSON, never a 200 HTML shell) for a MACHINE caller on the unknown path %s',
    async (url) => {
      const res = await ts.app.inject({ method: 'GET', url, headers: MACHINE });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error.code).toBe('not_found');
    },
  );

  it.each(['/healthzz', '/health', '/metrics', '/capabilities', '/totally/bogus'])(
    'keeps the JSON 404 for %s when the caller sends no Accept at all',
    async (url) => {
      const res = await ts.app.inject({ method: 'GET', url, headers: { 'user-agent': 'probe/1' } });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    },
  );

  // #35: the SPA owns a `Route path="*"` NotFound page, and it was unreachable —
  // a browser typing /rooms or /totally-bogus got the raw JSON envelope as text.
  it.each(['/totally-bogus', '/rooms', '/org', '/healthzz', '/wp-admin'])(
    'serves the shell WITH a 404 status to a browser navigating to %s',
    async (url) => {
      const res = await ts.app.inject({ method: 'GET', url, headers: BROWSER_NAV });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<div id="root">');
    },
  );

  it.each(['/assets/missing.js', '/assets/missing.css', '/missing-chunk.mjs'])(
    'still 404s as JSON for the asset-looking path %s even with a browser Accept',
    async (url) => {
      const res = await ts.app.inject({ method: 'GET', url, headers: BROWSER_NAV });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error.code).toBe('not_found');
    },
  );

  it('never serves the shell under /api/, even to a browser', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/nope', headers: BROWSER_NAV });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('never serves the shell for a non-GET, even to a browser', async () => {
    const res = await ts.app.inject({ method: 'POST', url: '/totally-bogus', headers: BROWSER_NAV });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('keeps the unknown-/api/* JSON 404 with its meta pointer', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/nope', headers: BROWSER });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('/api/v1/meta');
  });

  it('still negotiates /invite/:token (browser → SPA, agent → markdown)', async () => {
    const browser = await ts.app.inject({ method: 'GET', url: `/invite/${invite}`, headers: BROWSER });
    expect(browser.statusCode).toBe(200);
    expect(browser.headers['content-type']).toContain('text/html');
    const agent = await ts.app.inject({
      method: 'GET',
      url: `/invite/${invite}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(agent.statusCode).toBe(200);
    expect(agent.headers['content-type']).toContain('text/markdown');
  });

  // Docs are no longer an SPA route at all: every /docs path 302s to the one
  // canonical home (SPEC "Canonical public homes"), browser or not.
  it('sends /docs to the canonical home instead of the SPA', async () => {
    const browser = await ts.app.inject({ method: 'GET', url: '/docs', headers: BROWSER });
    expect(browser.statusCode).toBe(302);
    expect(browser.headers.location).toBe('https://sparrow.land/docs/');
    const agent = await ts.app.inject({
      method: 'GET',
      url: '/docs/api',
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(agent.statusCode).toBe(302);
    expect(agent.headers.location).toBe('https://sparrow.land/docs/api/index.md');
  });
});

/* ------------------------------------------------------------------ *
 * I-15 — security headers on the SPA/HTML responses
 * ------------------------------------------------------------------ */

describe('security headers on HTML responses (I-15)', () => {
  let ts: TestServer;
  let root: string;
  let invite: string;

  beforeEach(async () => {
    ({ ts, root, invite } = await makeSpaServer());
  });
  afterEach(async () => {
    await ts.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('sets nosniff/DENY/referrer on every HTML response', async () => {
    for (const url of ['/', '/rooms/rm_1', `/invite/${invite}`]) {
      const res = await ts.app.inject({ method: 'GET', url, headers: BROWSER });
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    }
  });

  it('also hardens JSON API responses against sniffing', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

/* ------------------------------------------------------------------ *
 * I-15 — CORS scoped to /api/v1/*
 * ------------------------------------------------------------------ */

describe('CORS scoping (I-15)', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('reflects any origin on /api/v1/* with credentials', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { origin: 'https://elsewhere.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://elsewhere.example');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers a preflight for /api/v1/*', async () => {
    const res = await ts.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/orgs',
      headers: {
        origin: 'https://elsewhere.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://elsewhere.example');
  });

  // @fastify/cors defaults `methods` to GET,HEAD,POST — so a browser preflight
  // for the many documented PATCH/PUT/DELETE routes was answered "that verb is
  // not allowed here", and every cross-origin edit died before it was sent.
  it('advertises the whole documented verb surface on a preflight', async () => {
    const res = await ts.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/orgs/org_x',
      headers: {
        origin: 'https://elsewhere.example',
        'access-control-request-method': 'PATCH',
      },
    });
    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers['access-control-allow-methods'] ?? '');
    for (const verb of ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(allowed).toContain(verb);
    }
  });

  it.each(['/healthz', '/docs/api', '/install.sh'])(
    'does NOT put CORS headers on the non-API route %s',
    async (url) => {
      const res = await ts.app.inject({
        method: 'GET',
        url,
        headers: { origin: 'https://elsewhere.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    },
  );
});

describe('CORS_ALLOWED_ORIGINS allowlist (I-15)', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer({
      corsAllowedOrigins: ['https://app.example', 'https://admin.example'],
    });
  });
  afterEach(async () => {
    await ts.close();
  });

  it('allows a listed origin', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { origin: 'https://app.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example');
  });

  it('refuses an unlisted origin', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // The request itself still succeeds — CORS is a browser-side policy.
    expect(res.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * I-7 — healthz/meta report the product version + build
 * ------------------------------------------------------------------ */

describe('version + build reporting (I-7)', () => {
  let ts: TestServer;
  const rootVersion = (
    JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;

  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('GET /healthz reports the root product version and the build stamp', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(rootVersion);
    expect(body.version).not.toBe('0.1.0');
    expect(body).toHaveProperty('build');
    expect(body.build).toBe(BUILD_STAMP);
  });

  it('GET /api/v1/meta reports the same version + build, top level and under server', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/meta' });
    const body = res.json();
    expect(body.version).toBe(API_VERSION);
    expect(body.server.version).toBe(API_VERSION);
    expect(body.server.build).toBe(BUILD_STAMP);
    expect(body.build).toBe(BUILD_STAMP);
  });

  it('leaves the CLIENT_MIN_VERSION comparator untouched (server version is not the floor)', async () => {
    const gated = await makeTestServer({ clientMinVersion: '99.0.0' });
    const res = await gated.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-sparrow-client': 'sparrow-cli/0.1.0' },
    });
    expect(res.statusCode).toBe(426);
    await gated.close();
  });
});

/* ------------------------------------------------------------------ *
 * I-9 — LOG_LEVEL
 * ------------------------------------------------------------------ */

describe('loggerOptions (I-9)', () => {
  it('is off when LOG_LEVEL is unset or empty (embedded/test default)', () => {
    expect(loggerOptions(undefined)).toBe(false);
    expect(loggerOptions('')).toBe(false);
    expect(loggerOptions('   ')).toBe(false);
  });

  it('turns on at the requested level', () => {
    const opts = loggerOptions('debug');
    expect(opts).not.toBe(false);
    expect((opts as { level: string }).level).toBe('debug');
  });

  it('redacts the authorization header (and cookies)', () => {
    const opts = loggerOptions('info') as { redact: { paths: string[]; censor: string } };
    expect(opts.redact.paths).toContain('req.headers.authorization');
    expect(opts.redact.paths).toContain('req.headers.cookie');
    expect(opts.redact.censor).toBe('[redacted]');
  });

  it('falls back to info for a bogus level instead of crashing the boot', () => {
    expect((loggerOptions('verbose') as { level: string }).level).toBe('info');
  });

  it('treats off/false/none as silence', () => {
    expect(loggerOptions('off')).toBe(false);
    expect(loggerOptions('false')).toBe(false);
    expect(loggerOptions('none')).toBe(false);
  });

  it('wires through to the built server', async () => {
    const ts = await makeTestServer({ logLevel: 'warn' });
    expect(ts.app.log.level).toBe('warn');
    await ts.close();
  });

  // The entrypoint used to `console.log(banner)` as well as log it, so
  // `LOG_LEVEL=off` still wrote a startup line — the one thing "off" promises
  // not to do. The banner is a log record like any other now; only a FAILED
  // boot still writes to the console unconditionally.
  it('the startup banner is written through the logger, not console.log', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(src).toContain('app.log.info(');
    expect(src).not.toMatch(/console\.log\(\s*banner\s*\)/);
    // A boot failure still shouts on stderr regardless of level.
    expect(src).toContain('console.error(err)');
  });
});

/* ------------------------------------------------------------------ *
 * envConfig plumbing for the new knobs
 * ------------------------------------------------------------------ */

describe('envConfig (LOG_LEVEL / CORS_ALLOWED_ORIGINS)', () => {
  it('defaults LOG_LEVEL to info for the real entrypoint', () => {
    expect(envConfig({} as NodeJS.ProcessEnv).logLevel).toBe('info');
  });

  it('honors an explicit LOG_LEVEL', () => {
    expect(envConfig({ LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv).logLevel).toBe('debug');
  });

  it('treats an empty LOG_LEVEL (compose `${LOG_LEVEL:-}`) as unset → info', () => {
    expect(envConfig({ LOG_LEVEL: '' } as NodeJS.ProcessEnv).logLevel).toBe('info');
  });

  it('parses CORS_ALLOWED_ORIGINS as a comma-separated allowlist', () => {
    expect(
      envConfig({ CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example' } as NodeJS.ProcessEnv)
        .corsAllowedOrigins,
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it('leaves the allowlist undefined (reflect-any) when unset or empty', () => {
    expect(envConfig({} as NodeJS.ProcessEnv).corsAllowedOrigins).toBeUndefined();
    expect(
      envConfig({ CORS_ALLOWED_ORIGINS: '  ,  ' } as NodeJS.ProcessEnv).corsAllowedOrigins,
    ).toBeUndefined();
    // compose forwards `${CORS_ALLOWED_ORIGINS:-}`, which always DEFINES the var
    // — an empty value must read exactly like "unset", or the compose path would
    // ship an allowlist of nothing and block every browser origin.
    expect(
      envConfig({ CORS_ALLOWED_ORIGINS: '' } as NodeJS.ProcessEnv).corsAllowedOrigins,
    ).toBeUndefined();
  });
});
