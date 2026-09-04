/**
 * SPEC "Canonical public homes": the instance SERVES neither the docs nor the
 * installer — `GET /docs`, `GET /docs/*`, `GET /install.sh` and `GET /install/*`
 * answer `302` to the corresponding URL under `DOCS_URL` / `INSTALL_URL`, so old
 * links and old clients keep working while every reader is taught the one
 * canonical form.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, type TestServer } from './test-helpers.js';

const AGENT = { 'user-agent': 'curl/8.4.0', accept: '*/*' };
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' };

describe('canonical homes: /install.sh and /install/* redirect', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts.close();
  });

  it('302s /install.sh to INSTALL_URL/install.sh by default', async () => {
    ts = await makeTestServer();
    const res = await ts.app.inject({ method: 'GET', url: '/install.sh', headers: AGENT });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://sparrow.land/install.sh');
    // The instance no longer renders the script at all.
    expect(res.body).not.toContain('SPARROW_BIN_DIR');
  });

  it('302s the CLI and MCP bundles to the install home', async () => {
    ts = await makeTestServer();
    const cli = await ts.app.inject({ method: 'GET', url: '/install/sparrow.js', headers: AGENT });
    expect(cli.statusCode).toBe(302);
    expect(cli.headers.location).toBe('https://sparrow.land/install/sparrow.js');
    const mcp = await ts.app.inject({
      method: 'GET',
      url: '/install/sparrow-mcp.js',
      headers: AGENT,
    });
    expect(mcp.statusCode).toBe(302);
    expect(mcp.headers.location).toBe('https://sparrow.land/install/sparrow-mcp.js');
  });

  it('honours an INSTALL_URL override (a self-hoster who mirrors both)', async () => {
    ts = await makeTestServer({ installUrl: 'https://mirror.example.com/sparrow/' });
    const res = await ts.app.inject({ method: 'GET', url: '/install.sh', headers: AGENT });
    expect(res.headers.location).toBe('https://mirror.example.com/sparrow/install.sh');
    const cli = await ts.app.inject({ method: 'GET', url: '/install/sparrow.js', headers: AGENT });
    expect(cli.headers.location).toBe('https://mirror.example.com/sparrow/install/sparrow.js');
  });

  it('ignores the request Host — the installer is NOT host-aware any more', async () => {
    ts = await makeTestServer({ baseUrl: 'https://example.com', orgHostSuffix: '.example.com' });
    const res = await ts.app.inject({
      method: 'GET',
      url: '/install.sh',
      headers: { ...AGENT, host: 'acme.example.com' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://sparrow.land/install.sh');
  });

  it('redirects a browser the same way (no content negotiation on install)', async () => {
    ts = await makeTestServer();
    const res = await ts.app.inject({ method: 'GET', url: '/install.sh', headers: BROWSER });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://sparrow.land/install.sh');
  });

  /**
   * `sparrow upgrade` and the published installer cache-bust the bundle URLs
   * (`?v=<stamp>`) so a CDN in front of the install home can never hand back the
   * previous release. If this redirect dropped the query, an instance-mirrored
   * upgrade would land on the cacheable bare URL and lose that guarantee.
   */
  it('carries the cache-busting query through to the install home', async () => {
    ts = await makeTestServer();
    const cli = await ts.app.inject({
      method: 'GET',
      url: '/install/sparrow.js?v=0.1.9%2B20260904.abc1234',
      headers: AGENT,
    });
    expect(cli.statusCode).toBe(302);
    expect(cli.headers.location).toBe('https://sparrow.land/install/sparrow.js?v=0.1.9%2B20260904.abc1234');
    const sh = await ts.app.inject({ method: 'GET', url: '/install.sh?v=123', headers: AGENT });
    expect(sh.headers.location).toBe('https://sparrow.land/install.sh?v=123');
  });

  it('never caches the redirect (the home may move; the artifacts change per deploy)', async () => {
    ts = await makeTestServer();
    for (const url of ['/install.sh', '/install/sparrow.js']) {
      const res = await ts.app.inject({ method: 'GET', url, headers: AGENT });
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
  });
});

describe('canonical homes: /docs and /docs/* redirect', () => {
  let ts: TestServer;
  let root: string;
  beforeEach(async () => {
    // A real SPA root on disk: the point is that /docs* does NOT fall through to it.
    root = mkdtempSync(path.join(tmpdir(), 'sparrow-redirects-'));
    mkdirSync(path.join(root, 'data'));
    mkdirSync(path.join(root, 'public'));
    writeFileSync(path.join(root, 'public', 'index.html'), '<!doctype html><html></html>');
    ts = await makeTestServer({ dataDir: path.join(root, 'data') });
  });
  afterEach(async () => {
    await ts.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('302s /docs to the docs home root', async () => {
    for (const headers of [AGENT, BROWSER]) {
      const res = await ts.app.inject({ method: 'GET', url: '/docs', headers });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://sparrow.land/docs/');
    }
  });

  it('302s each getting-started page to DOCS_URL/<page>/', async () => {
    for (const page of ['concepts', 'cli', 'mcp', 'self-hosting', 'anything/else']) {
      const res = await ts.app.inject({ method: 'GET', url: `/docs/${page}`, headers: BROWSER });
      expect(res.statusCode, page).toBe(302);
      expect(res.headers.location, page).toBe(`https://sparrow.land/docs/${page}/`);
    }
  });

  it('tolerates a trailing slash', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/docs/cli/', headers: BROWSER });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://sparrow.land/docs/cli/');
  });

  it('negotiates the API docs index: .md for a machine, the page for a browser', async () => {
    const agent = await ts.app.inject({ method: 'GET', url: '/docs/api', headers: AGENT });
    expect(agent.statusCode).toBe(302);
    expect(agent.headers.location).toBe('https://sparrow.land/docs/api/index.md');
    const browser = await ts.app.inject({ method: 'GET', url: '/docs/api', headers: BROWSER });
    expect(browser.statusCode).toBe(302);
    expect(browser.headers.location).toBe('https://sparrow.land/docs/api/');
  });

  it('negotiates an API docs page: the .md for a machine, the ONE reference page for a browser', async () => {
    const agent = await ts.app.inject({
      method: 'GET',
      url: '/docs/api/rooms/status',
      headers: AGENT,
    });
    expect(agent.statusCode).toBe(302);
    expect(agent.headers.location).toBe('https://sparrow.land/docs/api/rooms/status.md');
    // There are no per-segment HTML pages: the human REST reference is one page.
    for (const segment of ['rooms/status', 'me/inbox', 'versioning']) {
      const browser = await ts.app.inject({
        method: 'GET',
        url: `/docs/api/${segment}`,
        headers: BROWSER,
      });
      expect(browser.statusCode, segment).toBe(302);
      expect(browser.headers.location, segment).toBe('https://sparrow.land/docs/api/');
    }
  });

  it('?format=md forces the markdown target even for a browser', async () => {
    const page = await ts.app.inject({
      method: 'GET',
      url: '/docs/api/rooms/status?format=md',
      headers: BROWSER,
    });
    expect(page.headers.location).toBe('https://sparrow.land/docs/api/rooms/status.md');
    const index = await ts.app.inject({ method: 'GET', url: '/docs/api?format=md', headers: BROWSER });
    expect(index.headers.location).toBe('https://sparrow.land/docs/api/index.md');
  });

  it('redirects an UNKNOWN /docs/api page too — the home decides what exists', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/docs/api/does/not/exist',
      headers: AGENT,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://sparrow.land/docs/api/does/not/exist.md');
  });

  it('honours a DOCS_URL override', async () => {
    await ts.close();
    ts = await makeTestServer({
      dataDir: path.join(root, 'data'),
      docsUrl: 'https://mirror.example.com/handbook/',
    });
    expect(
      (await ts.app.inject({ method: 'GET', url: '/docs', headers: BROWSER })).headers.location,
    ).toBe('https://mirror.example.com/handbook/');
    expect(
      (await ts.app.inject({ method: 'GET', url: '/docs/api/me/inbox', headers: AGENT })).headers
        .location,
    ).toBe('https://mirror.example.com/handbook/api/me/inbox.md');
  });

  it('ignores the request Host — the docs are NOT host-aware any more', async () => {
    await ts.close();
    ts = await makeTestServer({
      dataDir: path.join(root, 'data'),
      baseUrl: 'https://example.com',
      orgHostSuffix: '.example.com',
    });
    const res = await ts.app.inject({
      method: 'GET',
      url: '/docs/api/me/inbox',
      headers: { ...AGENT, host: 'acme.example.com' },
    });
    expect(res.headers.location).toBe('https://sparrow.land/docs/api/me/inbox.md');
  });

  it('never answers /docs* with the SPA shell', async () => {
    for (const url of ['/docs', '/docs/cli', '/docs/api', '/docs/api/me/inbox']) {
      const res = await ts.app.inject({ method: 'GET', url, headers: BROWSER });
      expect(res.statusCode, url).toBe(302);
      expect(res.body, url).not.toContain('<!doctype html>');
    }
  });
});
