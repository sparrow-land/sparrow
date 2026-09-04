/**
 * A DEAD invite must read dead on EVERY surface, not just the doc route.
 *
 * `GET /invite/:token` already told an unknown token (`404`) apart from a
 * revoked/expired one (`410` naming which). The two JSON routes the SPA and the
 * CLI actually call — `GET /api/v1/invite/:token/info` and
 * `POST /api/v1/invite/:token/enroll` — still answered a flat
 * `404 {"code":"not_found","message":"Not found"}` for all three, so a human on
 * the invite page and an agent on the CLI were both told "not found" for a link
 * that was real and had simply been revoked or had lapsed.
 *
 * Distinguishing revoked from expired on `/enroll` leaks nothing beyond what
 * `/info` already reveals (both are unauthenticated and both take the same
 * token), so the two routes mirror each other exactly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newInviteId, newInviteToken } from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import { makeTestServer, auth, signup, firstOrgId, createInvite, type TestServer } from './test-helpers.js';
import { openDb } from './db/index.js';
import { invites } from './db/schema.js';
import {
  INVITE_EXPIRED_MESSAGE,
  INVITE_REVOKED_MESSAGE,
  INVITE_UNKNOWN_MESSAGE,
} from './invite-helpers.js';

describe('dead invites read dead on the JSON routes', () => {
  let ts: TestServer;
  let owner: { token: string; userId: string };
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  /** Mint an invite that is already past its expiry (the API never issues one). */
  function forgeExpiredInvite(): string {
    const token = newInviteToken();
    const handle = openDb(ts.dataDir);
    try {
      handle.db
        .insert(invites)
        .values({
          id: newInviteId(),
          orgId,
          inviterHumanId: owner.userId,
          tokenHash: sha256Hex(token),
          note: null,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          revokedAt: null,
          createdAt: new Date(Date.now() - 2000).toISOString(),
        })
        .run();
    } finally {
      handle.close();
    }
    return token;
  }

  async function revokedToken(): Promise<string> {
    const inv = await createInvite(ts.app, owner.token, orgId);
    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/invites/${inv.id}`,
      headers: auth(owner.token),
    });
    return inv.token;
  }

  /* ------------------------------- /info ------------------------------- */

  it('GET …/info: unknown → 404 not_found with an actionable message', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/invite/ivk_nope/info' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.json().error.message).toBe(INVITE_UNKNOWN_MESSAGE);
    // Every 4xx on a documented route carries the docs pointer.
    expect(res.json().error.docs).toContain('/docs/api/invite');
  });

  it('GET …/info: revoked → 410 gone naming revocation', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${await revokedToken()}/info`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('gone');
    expect(res.json().error.message).toBe(INVITE_REVOKED_MESSAGE);
    expect(res.json().error.message).toContain('revoked');
    expect(res.json().error.docs).toContain('/docs/api/invite');
  });

  it('GET …/info: expired → 410 gone naming expiry (not revocation)', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${forgeExpiredInvite()}/info`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('gone');
    expect(res.json().error.message).toBe(INVITE_EXPIRED_MESSAGE);
    expect(res.json().error.message).toContain('expired');
    expect(res.json().error.message).not.toContain('revoked');
  });

  it('GET …/info: a dead invite never names the org or the inviter', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${await revokedToken()}/info`,
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("Owner's org");
    expect(body).not.toContain('owner@example.com');
    expect(body).not.toContain('org_');
  });

  /* ------------------------------ /enroll ------------------------------ */

  it('POST …/enroll: unknown → 404 not_found with the same message as /info', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/invite/ivk_nope/enroll',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.json().error.message).toBe(INVITE_UNKNOWN_MESSAGE);
    expect(res.json().error.docs).toContain('/docs/api/invite');
  });

  it('POST …/enroll: revoked → 410 gone naming revocation', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${await revokedToken()}/enroll`,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('gone');
    expect(res.json().error.message).toBe(INVITE_REVOKED_MESSAGE);
    expect(res.json().error.docs).toContain('/docs/api/invite');
  });

  it('POST …/enroll: expired → 410 gone naming expiry', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${forgeExpiredInvite()}/enroll`,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('gone');
    expect(res.json().error.message).toBe(INVITE_EXPIRED_MESSAGE);
  });

  it('POST …/enroll: a SIGNED-IN human on a revoked invite gets the same 410', async () => {
    const human = await signup(ts.app, { email: 'late@example.com', displayName: 'Late' });
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${await revokedToken()}/enroll`,
      headers: auth(human.token),
      payload: {},
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.message).toBe(INVITE_REVOKED_MESSAGE);
  });

  /* -------------------- the doc route stays in step -------------------- */

  it('GET /invite/:token (markdown) uses the same three messages', async () => {
    const unknown = await ts.app.inject({ method: 'GET', url: '/invite/ivk_nope' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe(INVITE_UNKNOWN_MESSAGE);

    const revoked = await ts.app.inject({ method: 'GET', url: `/invite/${await revokedToken()}` });
    expect(revoked.statusCode).toBe(410);
    expect(revoked.json().error.message).toBe(INVITE_REVOKED_MESSAGE);

    const expired = await ts.app.inject({
      method: 'GET',
      url: `/invite/${forgeExpiredInvite()}`,
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.message).toBe(INVITE_EXPIRED_MESSAGE);
  });
});
