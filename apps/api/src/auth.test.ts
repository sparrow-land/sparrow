import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { count } from 'drizzle-orm';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createRoom,
  makeAgent,
  type TestServer,
} from './test-helpers.js';
import { openDb, type DbHandle } from './db/index.js';
import { humans, orgs as orgsTable, orgMemberships } from './db/schema.js';
import { ConfigStore } from './config-store.js';
import { createOwnerlessOrg, membershipOf } from './org-helpers.js';
import { AuthService } from './auth.js';

describe('accounts & sessions', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('GET /auth/config advertises the password provider', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/auth/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers.map((p: { id: string }) => p.id)).toContain('password');
    expect(body.allowSignup).toBe(true);
    // Default password provider carries no `primary` marker.
    const pw = body.providers.find((p: { id: string }) => p.id === 'password');
    expect(pw.primary).toBeUndefined();
  });

  it('GET /auth/config surfaces `primary: true` for a provider marked primary', async () => {
    const primaryTs = await makeTestServer({
      providers: [
        {
          id: 'sso',
          label: 'Example SSO',
          kind: 'oauth-redirect',
          primary: true,
          loginUrl: (origin) => `${origin}/api/v1/auth/sso`,
          register() {},
        },
      ],
    });
    try {
      const res = await primaryTs.app.inject({ method: 'GET', url: '/api/v1/auth/config' });
      expect(res.statusCode).toBe(200);
      const sso = res.json().providers.find((p: { id: string }) => p.id === 'sso');
      expect(sso).toMatchObject({ id: 'sso', kind: 'oauth-redirect', primary: true });
    } finally {
      await primaryTs.close();
    }
  });

  it('signup returns 201 { user, token } and bootstraps the first org', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'jake@example.com', password: 'password123', displayName: 'Jake' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('jake@example.com');
    expect(body.user.provider).toBe('password');
    expect(body.user).not.toHaveProperty('role');
    expect(typeof body.token).toBe('string');
    expect(body.token.startsWith('ses_')).toBe(true);

    const orgs = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/orgs',
      headers: auth(body.token),
    });
    const items = orgs.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('owner');
    expect(items[0].org.name).toBe("Jake's org");
    expect(items[0].org.slug).toMatch(/^[a-z0-9-]+$/);
  });

  /**
   * Signup used to STRIP unknown keys (zod's default), so the near-miss
   * `{ name: "Jake" }` silently created an account whose display name was the
   * email address — with a `201` and no signal anywhere that the field had been
   * thrown away. Every auth request body is strict: an unknown key is a `400`
   * that names it.
   */
  it('signup rejects unknown body keys instead of silently dropping them', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'typo@example.com', password: 'password123', name: 'Jake' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toMatch(/name/);
    // Nothing was created — the near-miss did not half-succeed.
    const login = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'typo@example.com', password: 'password123' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('login rejects unknown body keys too', async () => {
    await signup(ts.app, { email: 'strict@example.com', displayName: 'Strict' });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'strict@example.com', password: 'password123', remember: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('PATCH /me rejects unknown body keys (human and agent branches alike)', async () => {
    const human = await signup(ts.app, { email: 'patch@example.com', displayName: 'Patch' });
    const res = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(human.token),
      payload: { displayName: 'Patched', nickname: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('the SECOND human gets no org', async () => {
    await signup(ts.app, { email: 'one@example.com', displayName: 'One' });
    const two = await signup(ts.app, { email: 'two@example.com', displayName: 'Two' });
    const orgs = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/orgs',
      headers: auth(two.token),
    });
    expect(orgs.json().items).toHaveLength(0);
  });

  it('duplicate email → 409; wrong login → 401 (no enumeration)', async () => {
    await signup(ts.app, { email: 'dup@example.com' });
    const dup = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'dup@example.com', password: 'password123' },
    });
    expect(dup.statusCode).toBe(409);

    const wrong = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'dup@example.com', password: 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const nouser = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ghost@example.com', password: 'whatever' },
    });
    expect(nouser.statusCode).toBe(401);
  });

  it('login returns 200 { user, token }', async () => {
    await signup(ts.app, { email: 'log@example.com', password: 'password123' });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'log@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token.startsWith('ses_')).toBe(true);
  });

  it('session works as a Bearer token AND the cookie; logout kills it', async () => {
    const { token } = await signup(ts.app, { email: 'sess@example.com' });
    const bearer = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth(token),
    });
    expect(bearer.statusCode).toBe(200);

    const cookie = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `sparrow_session=${token}` },
    });
    expect(cookie.statusCode).toBe(200);

    const out = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: auth(token),
    });
    expect(out.statusCode).toBe(200);
    const after = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth(token),
    });
    expect(after.statusCode).toBe(401);
  });

  it('GET /me returns the human principal for a session', async () => {
    const { token } = await signup(ts.app, { email: 'me@example.com', displayName: 'Mee' });
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    // A fresh account has no stored theme → defaults to `auto`.
    expect(res.json().principal).toMatchObject({ type: 'human', email: 'me@example.com', displayName: 'Mee', theme: 'auto' });
  });

  it('GET /me returns the agent principal for an agent key', async () => {
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const created = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'deploy-bot' },
    });
    const key = created.json().key as string;
    expect(key.startsWith('agk_')).toBe(true);
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(key) });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toMatchObject({
      type: 'agent',
      name: 'deploy-bot',
      orgId,
      owner: { id: owner.userId, displayName: 'Owner' },
    });
  });

  it('signup disabled → 403', async () => {
    const noSignup = await makeTestServer();
    // Turn signup off via the admin config surface.
    await noSignup.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { 'x-admin-token': 'test-admin-token' },
      payload: { values: { 'auth.allowSignup': false } },
    });
    // First human already blocked (no bootstrap either).
    const res = await noSignup.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'blocked@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(403);
    await noSignup.close();
  });

});

/* ------------------------------------------------------------------ *
 * loginOrCreateUser: multi-email identity resolution
 * ------------------------------------------------------------------ */

describe('loginOrCreateUser (multi-email accounts)', () => {
  let handle: DbHandle;
  let dataDir: string;
  let authService: AuthService;
  let configStore: ConfigStore;

  /** A minimal FastifyReply — loginOrCreateUser only calls `reply.header`. */
  const reply = { header: () => reply } as unknown as FastifyReply;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-auth-multi-'));
    handle = openDb(dataDir);
    configStore = new ConfigStore(handle.db);
    authService = new AuthService(handle.db, configStore);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const humanCount = (): number =>
    handle.db.select({ n: count() }).from(humans).get()?.n ?? 0;

  it('matches an existing human by a SECONDARY email without altering their stored email', () => {
    const created = authService.loginOrCreateUser(
      { email: 'work@corp.com', displayName: 'Worker', provider: 'platform' },
      reply,
    );
    expect(humanCount()).toBe(1);

    // Platform now presents the personal address as primary + work as secondary.
    const again = authService.loginOrCreateUser(
      { email: 'personal@home.com', emails: ['work@corp.com'], provider: 'platform' },
      reply,
    );
    expect(again.user.id).toBe(created.user.id);
    expect(again.user.email).toBe('work@corp.com'); // stored email unchanged
    expect(humanCount()).toBe(1); // no duplicate created
  });

  it('prefers the primary email over secondaries when both match distinct humans', () => {
    const primary = authService.loginOrCreateUser(
      { email: 'a@x.com', provider: 'platform' },
      reply,
    );
    const secondary = authService.loginOrCreateUser(
      { email: 'b@x.com', provider: 'platform' },
      reply,
    );
    expect(primary.user.id).not.toBe(secondary.user.id);

    const resolved = authService.loginOrCreateUser(
      { email: 'a@x.com', emails: ['b@x.com'], provider: 'platform' },
      reply,
    );
    expect(resolved.user.id).toBe(primary.user.id);
  });

  it('normalizes (trim + lowercase) and dedupes the candidate emails', () => {
    const created = authService.loginOrCreateUser(
      { email: 'foo@x.com', provider: 'platform' },
      reply,
    );
    const resolved = authService.loginOrCreateUser(
      { email: '  BAR@x.com ', emails: ['Foo@X.COM', 'foo@x.com', ' FOO@x.com '], provider: 'platform' },
      reply,
    );
    expect(resolved.user.id).toBe(created.user.id);
    expect(humanCount()).toBe(1);
  });

  it('allows signup when a SECONDARY email satisfies the email-pattern policy', () => {
    configStore.put({ 'auth.allowedEmailPatterns': ['*@corp.com'] });
    const created = authService.loginOrCreateUser(
      { email: 'me@personal.com', emails: ['me@corp.com'], displayName: 'Me', provider: 'platform' },
      reply,
    );
    // Created under the PRIMARY email, even though only the secondary matched.
    expect(created.user.email).toBe('me@personal.com');
    expect(humanCount()).toBe(1);
  });

  it('rejects signup when NO candidate email matches the pattern policy', () => {
    configStore.put({ 'auth.allowedEmailPatterns': ['*@corp.com'] });
    expect(() =>
      authService.loginOrCreateUser(
        { email: 'me@personal.com', emails: ['me@other.com'], provider: 'platform' },
        reply,
      ),
    ).toThrow();
    expect(humanCount()).toBe(0);
  });

  it('creates the account using the PRIMARY email when no candidate matches', () => {
    const created = authService.loginOrCreateUser(
      { email: 'primary@x.com', emails: ['secondary@x.com'], provider: 'platform' },
      reply,
    );
    expect(created.user.email).toBe('primary@x.com');
    // A later handshake keyed by the secondary finds the same human.
    expect(authService.humanByEmail('secondary@x.com')).toBeUndefined();
    expect(authService.humanByEmail('primary@x.com')?.id).toBe(created.user.id);
  });

  it('behaves identically to today when no emails field is provided', () => {
    const created = authService.loginOrCreateUser(
      { email: 'solo@x.com', displayName: 'Solo', provider: 'platform' },
      reply,
    );
    expect(created.user.email).toBe('solo@x.com');
    const again = authService.loginOrCreateUser(
      { email: 'solo@x.com', provider: 'platform' },
      reply,
    );
    expect(again.user.id).toBe(created.user.id);
    expect(humanCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * loginOrCreateUser: first-org bootstrap flag (auth.bootstrapFirstOrg)
 * ------------------------------------------------------------------ */

describe('loginOrCreateUser (first-org bootstrap flag)', () => {
  let handle: DbHandle;
  let dataDir: string;
  let authService: AuthService;
  let configStore: ConfigStore;

  const reply = { header: () => reply } as unknown as FastifyReply;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-auth-bootstrap-'));
    handle = openDb(dataDir);
    configStore = new ConfigStore(handle.db);
    authService = new AuthService(handle.db, configStore);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('defaults to true: the first human founds an owner workspace (behavior unchanged)', () => {
    expect(configStore.getBoolean('auth.bootstrapFirstOrg')).toBe(true);
    const created = authService.loginOrCreateUser(
      { email: 'first@x.com', displayName: 'First', provider: 'password' },
      reply,
    );
    const orgRows = handle.db.select().from(orgsTable).all();
    expect(orgRows).toHaveLength(1);
    const memberships = handle.db.select().from(orgMemberships).all();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ humanId: created.user.id, role: 'owner' });
  });

  it('when false: the first human is created with NO org and NO membership', () => {
    configStore.put({ 'auth.bootstrapFirstOrg': false });
    const created = authService.loginOrCreateUser(
      { email: 'first@x.com', displayName: 'First', provider: 'password' },
      reply,
    );
    // Human exists…
    expect(authService.humanByEmail('first@x.com')?.id).toBe(created.user.id);
    // …but nothing was founded.
    expect(handle.db.select().from(orgsTable).all()).toHaveLength(0);
    expect(handle.db.select().from(orgMemberships).all()).toHaveLength(0);
  });

  it('when false: the org-free first human can still redeem a provisioned membership later', () => {
    configStore.put({ 'auth.bootstrapFirstOrg': false });
    const created = authService.loginOrCreateUser(
      { email: 'first@x.com', displayName: 'First', provider: 'password' },
      reply,
    );
    // A control plane provisions an owner-pending org; redemption grants membership.
    const org = createOwnerlessOrg(handle.db, { name: 'Provisioned' });
    handle.db
      .insert(orgMemberships)
      .values({
        orgId: org.id,
        humanId: created.user.id,
        role: 'owner',
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(membershipOf(handle.db, org.id, created.user.id)?.role).toBe('owner');
  });
});

describe('accounts & sessions (rename)', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await makeTestServer();
  });
  afterEach(async () => {
    await ts.close();
  });

  it('PATCH /me renames the account (live in rooms); validation + agent 401', async () => {
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');

    const patch = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(owner.token),
      payload: { displayName: '  Renamed  ' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().principal).toMatchObject({
      type: 'human',
      id: owner.userId,
      displayName: 'Renamed',
    });

    // The rename is live in the caller's room Member view.
    const whoami = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/whoami`,
      headers: auth(owner.token),
    });
    expect(whoami.json().displayName).toBe('Renamed');

    // Validation: empty (after trim) and > 80 → 400.
    for (const displayName of ['   ', 'x'.repeat(81)]) {
      const bad = await ts.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: auth(owner.token),
        payload: { displayName },
      });
      expect(bad.statusCode).toBe(400);
    }

    // An agent key renames the AGENT via PATCH /me with `{ name }` (not
    // `displayName`), and the change round-trips on GET /me. See agent-rename.test.ts
    // for the full semantics (collisions, ripple, owner rename).
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const agentRename = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(bot.key),
      payload: { name: '  scout  ' },
    });
    expect(agentRename.statusCode).toBe(200);
    expect(agentRename.json().principal).toMatchObject({ type: 'agent', id: bot.id, name: 'scout' });

    // An agent passing `{ displayName }` (the human field) has no `name` → 400.
    const agentBad = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(bot.key),
      payload: { displayName: 'Nope' },
    });
    expect(agentBad.statusCode).toBe(400);
  });

  // #53: every anonymous page load hit `GET /auth/me` and got a `401`, which the
  // BROWSER logs to its own network console before any JS can swallow it. "Nobody
  // is signed in" is an answer, so an anonymous caller now gets `200 { user: null }`.
  // A caller who DID present a credential that no longer works still gets `401` —
  // that is a different fact ("your session died; clear your state").
  it('GET /auth/me: 200 { user: null } with no credential, 401 with a dead one', async () => {
    // No Authorization header, no cookie.
    const anon = await ts.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toEqual({ user: null });

    // An empty cookie header is still "no credential".
    const emptyCookie = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'sparrow_session=' },
    });
    expect(emptyCookie.statusCode).toBe(200);
    expect(emptyCookie.json()).toEqual({ user: null });

    // A bearer token that resolves to nothing → 401 (stale client state).
    const staleBearer = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth('ses_00000000000000000000000000'),
    });
    expect(staleBearer.statusCode).toBe(401);

    // A stale COOKIE is the browser case: the client must clear it, not be told
    // it is anonymous while the dead cookie keeps riding along.
    const staleCookie = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'sparrow_session=ses_00000000000000000000000000' },
    });
    expect(staleCookie.statusCode).toBe(401);

    // An agent key is a credential too — it is just the wrong KIND for this
    // human-only route, so it is a 401 rather than a cheerful `user: null`.
    const { token } = await signup(ts.app, { email: 'keys@example.com', displayName: 'Keys' });
    const bot = await makeAgent(ts.app, token, await firstOrgId(ts.app, token), 'bot');
    const agentCall = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth(bot.key),
    });
    expect(agentCall.statusCode).toBe(401);

    // A live session still answers with the user.
    const live = await ts.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(token) });
    expect(live.statusCode).toBe(200);
    expect(live.json().user.email).toBe('keys@example.com');

    // After logout the token is dead — a presented-but-dead credential → 401.
    await ts.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth(token) });
    const afterLogout = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth(token),
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('PATCH /me persists a theme preference and round-trips it on /me + /auth/me', async () => {
    const { token } = await signup(ts.app, { email: 'theme@example.com', displayName: 'Thea' });

    // Theme-only update (no displayName) is accepted and echoed back.
    const patch = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(token),
      payload: { theme: 'dark' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().principal).toMatchObject({ type: 'human', displayName: 'Thea', theme: 'dark' });

    // Persisted: a fresh GET /me and GET /auth/me both reflect the stored theme.
    const me = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) });
    expect(me.json().principal.theme).toBe('dark');
    const authMe = await ts.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(token) });
    expect(authMe.json().user.theme).toBe('dark');

    // A later name-only update leaves the stored theme untouched.
    const rename = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(token),
      payload: { displayName: 'Theodora' },
    });
    expect(rename.json().principal).toMatchObject({ displayName: 'Theodora', theme: 'dark' });

    // An invalid theme value is rejected.
    const bad = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(token),
      payload: { theme: 'system' },
    });
    expect(bad.statusCode).toBe(400);

    // An empty body (neither field) is rejected.
    const empty = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(token),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });
});
