import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createRoom,
  makeAgent,
  type TestServer,
} from './test-helpers.js';
import { DOC_PAGES } from './routes/docs-content.js';

describe('docs-by-convention: /docs/api', () => {
  let ts: TestServer;
  let root: string;
  beforeEach(async () => {
    // Hermetic SPA stub so the browser branch has an index.html to fall through to.
    root = mkdtempSync(path.join(tmpdir(), 'sparrow-docs-'));
    mkdirSync(path.join(root, 'data'));
    mkdirSync(path.join(root, 'public'));
    writeFileSync(
      path.join(root, 'public', 'index.html'),
      '<!doctype html><html><head><title>sparrow</title></head><body></body></html>',
    );
    ts = await makeTestServer({ dataDir: path.join(root, 'data') });
  });
  afterEach(async () => {
    await ts.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a markdown index listing every page to a non-browser', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/docs/api',
      headers: { 'user-agent': 'curl/8', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    for (const page of DOC_PAGES) {
      expect(res.body).toContain(`/docs/api/${page.segment}`);
    }
  });

  it('serves a per-endpoint markdown page with its route, a curl example, and related links', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/docs/api/rooms/status',
      headers: { 'user-agent': 'curl/8', accept: 'text/markdown' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('/api/v1/rooms/:roomId/status');
    expect(res.body).toContain('## Example');
    expect(res.body).toContain('curl');
    expect(res.body).toContain('## Related');
    // Origin-anchored links (default baseUrl in tests).
    expect(res.body).toContain('http://localhost:8722/docs/api/');
  });

  const getMd = (url: string) =>
    ts.app.inject({ method: 'GET', url, headers: { 'user-agent': 'curl/8', accept: 'text/markdown' } });

  it('the me/events page documents the REAL /events/log contract (latest/gap/more/limit, not nextSince)', async () => {
    const res = await getMd('/docs/api/me/events');
    expect(res.statusCode).toBe(200);
    // The real response fields…
    expect(res.body).toContain('`{ events, latest, gap?, more? }`');
    expect(res.body).toContain('latest');
    expect(res.body).toContain('gap');
    expect(res.body).toContain('more');
    // …the documented ?limit= bound…
    expect(res.body).toContain('?limit=');
    expect(res.body).toContain('1–500');
    expect(res.body).toContain('`latest` is the newest cursor');
    // …and NOT the old, wrong field name.
    expect(res.body).not.toContain('nextSince');
  });

  it('the me/events page forks by runtime type: a listener is online, not attentive', async () => {
    const res = await getMd('/docs/api/me/events');
    expect(res.statusCode).toBe(200);
    // Holding the stream is only half the answer — a turn-based caller needs a
    // WAKE mechanism, and the page must say so where the stream is documented.
    expect(res.body).toMatch(/online.*not.*attentive/i);
    expect(res.body).toMatch(/turn-based/i);
    expect(res.body).toContain('sparrow await');
  });

  it('the me/presence page warns that a heartbeat without a wake path is the worst state', async () => {
    const res = await getMd('/docs/api/me/presence');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/worst/i);
    expect(res.body).toContain('sparrow await');
  });

  it('the me/inbox page states ack:true is the switch and note/ttl without it is a 400', async () => {
    const res = await getMd('/docs/api/me/inbox');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('`ack: true` is the switch');
    expect(res.body).toContain('WITHOUT `ack: true` is a `400`');
  });

  it('serves an orgs owner-surface page covering the org-admin operations', async () => {
    const res = await getMd('/docs/api/orgs');
    expect(res.statusCode).toBe(200);
    // The web-UI-first note for the API-only operator.
    expect(res.body).toContain('web UI');
    // One entry per owner-surface operation.
    expect(res.body).toContain('POST /api/v1/orgs'); // create org
    expect(res.body).toContain('/api/v1/orgs/:orgId/invites'); // invites create/list
    expect(res.body).toContain('/enrollments/:eid/approve'); // approve
    expect(res.body).toContain('/enrollments/:eid/deny'); // deny
    expect(res.body).toContain('/api/v1/orgs/:orgId/rooms'); // create room
    expect(res.body).toContain('/api/v1/rooms/:roomId/members'); // add agent
    expect(res.body).toContain('/api/v1/rooms/:roomId/invitations'); // invite human
    expect(res.body).toContain('PATCH /api/v1/orgs/:orgId'); // settings
    expect(res.body).toContain('enroll'); // settings policy key
  });

  it('the orgs page describes settings as a MERGE, not a replacement (QA I-5)', async () => {
    const res = await getMd('/docs/api/orgs');
    expect(res.statusCode).toBe(200);
    // The old copy said the body "fully replaces the stored policy", which sent
    // readers to paste a {invites,enroll,rooms} body that wiped their email policy.
    expect(res.body).not.toContain('fully replaces');
    expect(res.body).toContain('merges into the stored policy');
    expect(res.body).toContain('left untouched');
    expect(res.body).toContain('`400`');
    // `email` is part of the documented policy and of the merge.
    expect(res.body).toContain('email');
    expect(res.body).toContain('trustedPatterns');
  });

  it('the orgs page describes per-route gating, not blanket owner/admin (QA I-18)', async () => {
    const res = await getMd('/docs/api/orgs');
    expect(res.statusCode).toBe(200);
    // The old copy said "the org-scoped routes require an owner/admin role in that
    // org" — false: creating invites and rooms is member-level by default
    // (`invites.who` / `rooms.create`), and an inviter can review their own
    // enrollments. Only the org PATCH and the role routes are owner/admin.
    expect(res.body).not.toContain('the org-scoped routes require an owner/admin role');
    expect(res.body).toContain('per route, not blanket owner/admin');
    expect(res.body).toContain('invites.who');
    expect(res.body).toContain('rooms.create');
  });

  it('the orgs page is listed on the index', async () => {
    const res = await getMd('/docs/api');
    expect(res.body).toContain('/docs/api/orgs');
  });

  it('404s cleanly for an unknown docs path', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/docs/api/does/not/exist',
      headers: { 'user-agent': 'curl/8' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('a browser (Accept text/html + browser UA) falls through to the SPA', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/docs/api/rooms/status',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('?format=md forces markdown even for a browser', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/docs/api?format=md',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
  });
});

describe('error envelope carries a docs URL on documented routes', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts.close();
  });

  it('a 4xx on a documented endpoint includes error.docs with the request origin', async () => {
    ts = await makeTestServer();
    const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Olive' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const roomId = await createRoom(ts.app, owner.token, orgId, 'ops');
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bot');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    // Member agent posts an INVALID status body → 400 on a documented route.
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/status`,
      headers: auth(agent.key),
      payload: { state: 'nonsense' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.docs).toBe('http://localhost:8722/docs/api/rooms/status');
  });

  it('an undocumented route keeps the bare { code, message } envelope', async () => {
    ts = await makeTestServer();
    // Unknown org → 401/404 style on an undocumented route; no docs field.
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/me/orgs' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.docs).toBeUndefined();
  });
});

/**
 * The email surfaces are documented ONLY when the medium is configured (SPEC
 * "Hints & docs by convention": *…and — when the medium is configured — the
 * email surfaces…*). With the medium off they are absent from the index and
 * `404` like any unknown page, so a client never discovers a medium from docs.
 */
describe('docs-by-convention: the email pages', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts.close();
  });

  const md = (app: TestServer['app'], url: string) =>
    app.inject({ method: 'GET', url, headers: { 'user-agent': 'curl/8', accept: 'text/markdown' } });

  it('are absent with the medium off', async () => {
    ts = await makeTestServer();
    expect((await md(ts.app, '/docs/api/me/email/threads')).statusCode).toBe(404);
    expect((await md(ts.app, '/docs/api/orgs/email/approvals')).statusCode).toBe(404);
    const index = await md(ts.app, '/docs/api');
    expect(index.body).not.toContain('/docs/api/me/email/threads');
  });

  it('are served with the medium on, and listed on the index', async () => {
    ts = await makeTestServer({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const threads = await md(ts.app, '/docs/api/me/email/threads');
    expect(threads.statusCode).toBe(200);
    expect(threads.body).toContain('/api/v1/me/email/threads');
    expect(threads.body).toContain('/api/v1/me/email/send');
    expect(threads.body).toContain('## Example');
    const approvals = await md(ts.app, '/docs/api/orgs/email/approvals');
    expect(approvals.statusCode).toBe(200);
    expect(approvals.body).toContain('/api/v1/orgs/:orgId/email/approvals');
    expect(approvals.body).toContain('/approve');
    expect(approvals.body).toContain('/deny');
    const index = await md(ts.app, '/docs/api');
    expect(index.body).toContain('/docs/api/me/email/threads');
    expect(index.body).toContain('/docs/api/orgs/email/approvals');
  });

  it('a 4xx on an email route carries its docs URL', async () => {
    ts = await makeTestServer({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const owner = await signup(ts.app, { email: 'o@example.com', displayName: 'Olive' });
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/threads',
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.docs).toBe('http://localhost:8722/docs/api/me/email/threads');
  });
});
