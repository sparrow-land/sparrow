import { describe, expect, it, afterEach } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createRoom,
  makeAgent,
  type TestServer,
} from './test-helpers.js';
import { DOC_PAGES, renderDocPage, renderDocsIndex } from './routes/docs-content.js';

/**
 * The docs SOURCE (SPEC "Docs by convention"). The instance no longer serves any
 * of this — `/docs/api/*` `302`s to the canonical home (see
 * `public-redirects.test.ts`) — so the pages are exercised through the render
 * functions the `dump-docs` build step calls to publish them.
 *
 * Two URL families, deliberately independent: `origin` is the EXAMPLE SERVER a
 * curl line names, `docsUrl` is the docs home a cross-link names.
 */
const ORIGIN = 'https://sparrow.example.com';
const md = (segment: string, opts?: Parameters<typeof renderDocPage>[2]) =>
  renderDocPage(ORIGIN, segment, opts) ?? '';

describe('docs by convention: the rendered pages', () => {
  it('the index lists every page as a .md URL under the docs home', () => {
    const index = renderDocsIndex(ORIGIN);
    for (const page of DOC_PAGES) {
      expect(index).toContain(`https://sparrow.land/docs/api/${page.segment}.md`);
    }
  });

  it('a per-endpoint page carries its route, a curl example against the example server, and related links', () => {
    const body = md('rooms/status');
    expect(body).toContain('/api/v1/rooms/:roomId/status');
    expect(body).toContain('## Example');
    expect(body).toContain('curl');
    expect(body).toContain('## Related');
    // Requests target the example server…
    expect(body).toContain(`${ORIGIN}/api/v1/`);
    // …while cross-links point at the ONE docs home, as .md.
    expect(body).toContain('https://sparrow.land/docs/api/');
    expect(body).toContain('.md)');
    // Never an instance-local docs path.
    expect(body).not.toContain(`${ORIGIN}/docs`);
  });

  it('cross-links and the example server follow their own overrides', () => {
    const body = renderDocPage('https://acme.internal', 'rooms/status', {
      docsUrl: 'https://mirror.example.com/handbook/',
    })!;
    expect(body).toContain('https://acme.internal/api/v1/');
    expect(body).toContain('https://mirror.example.com/handbook/api/');
    expect(body).not.toContain('sparrow.land');
  });

  it('the versioning page names the canonical install one-liner, not the instance', () => {
    const body = md('versioning');
    expect(body).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
    expect(body).not.toContain(`${ORIGIN}/install.sh`);
    expect(
      renderDocPage(ORIGIN, 'versioning', { installUrl: 'https://mirror.example.com' })!,
    ).toContain('curl -fsSL https://mirror.example.com/install.sh | sh');
  });

  it('the me/events page documents the REAL /events/log contract (latest/gap/more/limit, not nextSince)', () => {
    const body = md('me/events');
    // The real response fields…
    expect(body).toContain('`{ events, latest, gap?, more? }`');
    expect(body).toContain('latest');
    expect(body).toContain('gap');
    expect(body).toContain('more');
    // …the documented ?limit= bound…
    expect(body).toContain('?limit=');
    expect(body).toContain('1–500');
    expect(body).toContain('`latest` is the newest cursor');
    // …and NOT the old, wrong field name.
    expect(body).not.toContain('nextSince');
  });

  it('the me/events page forks by runtime type: a listener is online, not attentive', () => {
    const body = md('me/events');
    // Holding the stream is only half the answer — a turn-based caller needs a
    // WAKE mechanism, and the page must say so where the stream is documented.
    expect(body).toMatch(/online.*not.*attentive/i);
    expect(body).toMatch(/turn-based/i);
    expect(body).toContain('sparrow await');
  });

  it('the me/presence page warns that a heartbeat without a wake path is the worst state', () => {
    const body = md('me/presence');
    expect(body).toMatch(/worst/i);
    expect(body).toContain('sparrow await');
  });

  it('the me/inbox page states ack:true is the switch and note/ttl without it is a 400', () => {
    const body = md('me/inbox');
    expect(body).toContain('`ack: true` is the switch');
    expect(body).toContain('WITHOUT `ack: true` is a `400`');
  });

  it('has an orgs owner-surface page covering the org-admin operations', () => {
    const body = md('orgs');
    // The web-UI-first note for the API-only operator.
    expect(body).toContain('web UI');
    // One entry per owner-surface operation.
    expect(body).toContain('POST /api/v1/orgs'); // create org
    expect(body).toContain('/api/v1/orgs/:orgId/invites'); // invites create/list
    expect(body).toContain('/enrollments/:eid/approve'); // approve
    expect(body).toContain('/enrollments/:eid/deny'); // deny
    expect(body).toContain('/api/v1/orgs/:orgId/rooms'); // create room
    expect(body).toContain('/api/v1/rooms/:roomId/members'); // add agent
    expect(body).toContain('/api/v1/rooms/:roomId/invitations'); // invite human
    expect(body).toContain('PATCH /api/v1/orgs/:orgId'); // settings
    expect(body).toContain('enroll'); // settings policy key
  });

  it('the orgs page describes settings as a MERGE, not a replacement (QA I-5)', () => {
    const body = md('orgs');
    // The old copy said the body "fully replaces the stored policy", which sent
    // readers to paste a {invites,enroll,rooms} body that wiped their email policy.
    expect(body).not.toContain('fully replaces');
    expect(body).toContain('merges into the stored policy');
    expect(body).toContain('left untouched');
    expect(body).toContain('`400`');
    // `email` is part of the documented policy and of the merge.
    expect(body).toContain('email');
    expect(body).toContain('trustedPatterns');
  });

  it('the orgs page describes per-route gating, not blanket owner/admin (QA I-18)', () => {
    const body = md('orgs');
    // The old copy said "the org-scoped routes require an owner/admin role in that
    // org" — false: creating invites and rooms is member-level by default
    // (`invites.who` / `rooms.create`), and an inviter can review their own
    // enrollments. Only the org PATCH and the role routes are owner/admin.
    expect(body).not.toContain('the org-scoped routes require an owner/admin role');
    expect(body).toContain('per route, not blanket owner/admin');
    expect(body).toContain('invites.who');
    expect(body).toContain('rooms.create');
  });

  it('the orgs page is listed on the index', () => {
    expect(renderDocsIndex(ORIGIN)).toContain('https://sparrow.land/docs/api/orgs.md');
  });

  it('renders nothing for an unknown page', () => {
    expect(renderDocPage(ORIGIN, 'does/not/exist')).toBeUndefined();
  });
});

describe('error envelope carries a docs URL on documented routes', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts.close();
  });

  it('a 4xx on a documented endpoint includes error.docs — the canonical .md page', async () => {
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
    expect(res.json().error.docs).toBe('https://sparrow.land/docs/api/rooms/status.md');
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
/**
 * The email surfaces are documented ONLY when the medium is configured (SPEC
 * "Hints & docs by convention": *…and — when the medium is configured — the
 * email surfaces…*). With the medium off they render nothing and are absent from
 * the index, so a client never discovers a medium from docs.
 */
describe('docs by convention: the email pages', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts?.close();
  });

  const page = (segment: string, email: boolean) => renderDocPage(ORIGIN, segment, { email });

  it('are absent with the medium off', () => {
    expect(page('me/email/threads', false)).toBeUndefined();
    expect(page('orgs/email/approvals', false)).toBeUndefined();
    expect(renderDocsIndex(ORIGIN)).not.toContain('/docs/api/me/email/threads.md');
  });

  it('are rendered with the medium on, and listed on the index', () => {
    const threads = page('me/email/threads', true)!;
    expect(threads).toContain('/api/v1/me/email/threads');
    expect(threads).toContain('/api/v1/me/email/send');
    expect(threads).toContain('## Example');
    const approvals = page('orgs/email/approvals', true)!;
    expect(approvals).toContain('/api/v1/orgs/:orgId/email/approvals');
    expect(approvals).toContain('/approve');
    expect(approvals).toContain('/deny');
    const index = renderDocsIndex(ORIGIN, { email: true });
    expect(index).toContain('https://sparrow.land/docs/api/me/email/threads.md');
    expect(index).toContain('https://sparrow.land/docs/api/orgs/email/approvals.md');
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
    expect(res.json().error.docs).toBe('https://sparrow.land/docs/api/me/email/threads.md');
  });
});
