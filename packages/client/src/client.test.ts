import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SparrowClient, ApiError, clientBuildVersion, type SparrowEvent, type PrincipalEvent } from './index.js';
import type { MessageReceivedEvent, MessageNewEvent } from '@sparrow/common-types';
import { startServer, sleep, type Harness } from './harness.js';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

let emailSeq = 0;
const email = (name = 'user') => `${name}-${Date.now()}-${emailSeq++}@example.com`;

/** A signed-up client. The FIRST human on a fresh instance bootstraps an org. */
async function signUp(h: Harness, displayName: string): Promise<SparrowClient> {
  const c = new SparrowClient({ server: h.url, adminToken: h.adminToken });
  await c.signup({ email: email(displayName), password: 'password123', displayName });
  return c;
}

/** Enroll + approve a fresh human into `orgId`; returns their authed client + id. */
async function joinHuman(
  h: Harness,
  owner: SparrowClient,
  orgId: string,
  displayName: string,
): Promise<{ client: SparrowClient; userId: string }> {
  const invite = await owner.createInvite(orgId);
  const token = invite.url.split('/invite/')[1]!;
  const client = new SparrowClient({ server: h.url });
  const user = await client.signup({ email: email(displayName), password: 'password123', displayName });
  const res = await client.enrollHuman(token);
  if (res.status === 'pending') await owner.approveEnrollment(orgId, res.enrollment.id);
  return { client, userId: user.user.id };
}

/** Create an agent owned by `owner`; returns an agent-key client + the agent. */
async function makeAgent(h: Harness, owner: SparrowClient, orgId: string, name: string) {
  const r = await owner.createAgent({ orgId, name });
  return { client: new SparrowClient({ server: h.url, token: r.key }), agent: r.agent, key: r.key };
}

async function firstOrgId(c: SparrowClient): Promise<string> {
  return (await c.meOrgs())[0]!.org.id;
}

/* ================================================================== *
 * Client self-identification (X-Sparrow-Client)
 * ================================================================== */

describe('client identification', () => {
  /** A fake fetch that records the headers of the last request and returns `{}`. */
  function recordingFetch(): { fetch: typeof fetch; last: () => Headers | undefined } {
    let last: Headers | undefined;
    const f = (async (_url: string | URL, init?: RequestInit) => {
      last = new Headers(init?.headers);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fetch: f, last: () => last };
  }

  it('sends X-Sparrow-Client on requests when clientIdent is set', async () => {
    const rec = recordingFetch();
    const c = new SparrowClient({
      server: 'http://x',
      token: 'agk_test',
      clientIdent: 'sparrow-cli/9.9.9+test',
      fetch: rec.fetch,
    });
    await c.me().catch(() => undefined); // schema may reject `{}`; we only care about the header
    expect(rec.last()?.get('x-sparrow-client')).toBe('sparrow-cli/9.9.9+test');
    // And the bearer still rides along.
    expect(rec.last()?.get('authorization')).toBe('Bearer agk_test');
  });

  it('sends NO X-Sparrow-Client header by default (web / third-party callers)', async () => {
    const rec = recordingFetch();
    const c = new SparrowClient({ server: 'http://x', token: 'agk_test', fetch: rec.fetch });
    await c.me().catch(() => undefined);
    expect(rec.last()?.has('x-sparrow-client')).toBe(false);
  });

  it('clientBuildVersion reports <pkg>+dev in non-bundled runs', () => {
    expect(clientBuildVersion()).toMatch(/^\d+\.\d+\.\d+\+/);
    expect(clientBuildVersion()).toContain('+dev');
  });
});

/* ================================================================== *
 * Accounts & sessions
 * ================================================================== */

describe('accounts & sessions', () => {
  let h: Harness;
  beforeAll(async () => (h = await startServer()));
  afterAll(() => h.close());

  it('authConfig advertises the password provider with no auth', async () => {
    const c = new SparrowClient({ server: h.url });
    const cfg = await c.authConfig();
    expect(cfg.providers.some((p) => p.id === 'password')).toBe(true);
    expect(typeof cfg.allowSignup).toBe('boolean');
  });

  it('signup bootstraps an org, adopts the token, and authMe/me work', async () => {
    const c = new SparrowClient({ server: h.url });
    const res = await c.signup({ email: email('boot'), password: 'password123', displayName: 'Boot' });
    expect(res.token).toMatch(/^ses_/);
    expect(c.token).toBe(res.token);
    const me = await c.authMe();
    expect(me?.displayName).toBe('Boot');
    const principal = await c.me();
    expect(principal.type).toBe('human');
    // First human on the instance auto-gets an org.
    expect((await c.meOrgs()).length).toBe(1);
  });

  it('duplicate email → 409 conflict', async () => {
    const dup = email('dup');
    const a = new SparrowClient({ server: h.url });
    await a.signup({ email: dup, password: 'password123' });
    const b = new SparrowClient({ server: h.url });
    await expect(b.signup({ email: dup, password: 'password123' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  it('login round-trips; wrong password → 401 (no enumeration)', async () => {
    const addr = email('login');
    const c = new SparrowClient({ server: h.url });
    await c.signup({ email: addr, password: 'password123', displayName: 'Log' });
    const fresh = new SparrowClient({ server: h.url });
    const res = await fresh.login({ email: addr, password: 'password123' });
    expect(res.user.email).toBe(addr.toLowerCase());
    await expect(fresh.login({ email: addr, password: 'wrong-pass' })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('logout clears the session', async () => {
    const c = await signUp(h, 'Out');
    expect(await c.logout()).toEqual({ ok: true });
    expect(c.token).toBeUndefined();
    // #53: with the token dropped the client presents NO credential, so
    // `/auth/me` answers the question rather than raising — `null` = signed out.
    expect(await c.authMe()).toBeNull();
  });

  // A credential that is present but dead is still a 401 — the caller has stale
  // state to clear, which `null` would hide.
  it('authMe: null with no token, ApiError(401) with a dead one', async () => {
    const anon = new SparrowClient({ server: h.url });
    expect(await anon.authMe()).toBeNull();

    const stale = new SparrowClient({ server: h.url, token: 'ses_00000000000000000000000000' });
    await expect(stale.authMe()).rejects.toBeInstanceOf(ApiError);
    await expect(stale.authMe()).rejects.toMatchObject({ status: 401 });
  });

  it('updateMe renames the account (round-trips via GET /me); empty → 400', async () => {
    const c = await signUp(h, 'Before');
    const renamed = await c.updateMe({ displayName: 'After' });
    expect(renamed.type).toBe('human');
    if (renamed.type !== 'human') throw new Error('expected human');
    expect(renamed.displayName).toBe('After');
    const me = await c.me();
    expect(me.type === 'human' && me.displayName).toBe('After');
    await expect(c.updateMe({ displayName: '   ' })).rejects.toMatchObject({ status: 400 });
  });

  it('updateMe({ name }) renames an agent (self); a collision → 409', async () => {
    const owner = await signUp(h, 'Owner');
    const orgId = (await owner.createOrg({ name: 'Acme' })).id;
    await makeAgent(h, owner, orgId, 'taken');
    const { client: bot } = await makeAgent(h, owner, orgId, 'bot');

    const renamed = await bot.updateMe({ name: 'scout' });
    expect(renamed.type).toBe('agent');
    if (renamed.type !== 'agent') throw new Error('expected agent');
    expect(renamed.name).toBe('scout');
    const me = await bot.me();
    expect(me.type === 'agent' && me.name).toBe('scout');

    // A name already taken by another agent in the org → 409 (never auto-suffixed).
    // v4 names are email-safe (lowercase `[a-z0-9._-]`), so the collision check is
    // case-insensitive on an already-valid name — `TAKEN` is now a 400, not a 409.
    await expect(bot.updateMe({ name: 'taken' })).rejects.toMatchObject({ status: 409 });

    // v4: every agent shape carries `emailAddress` — null until the medium exists.
    const meAgain = await bot.me();
    expect(meAgain.type === 'agent' && meAgain.emailAddress).toBeNull();
  });

  it('me() passes the self-presence block through (offline → mark)', async () => {
    const owner = await signUp(h, 'Owner');
    const orgId = (await owner.createOrg({ name: 'Acme' })).id;
    const { client: bot } = await makeAgent(h, owner, orgId, 'bot');

    // No stream, no mark — plainly offline.
    expect((await bot.me()).presence).toEqual({ online: false, via: null, onlineUntil: null });

    // A heartbeat mark makes the agent online without any socket, and `/me`
    // reports which of the two carries it plus when the mark lapses.
    const { onlineUntil } = await bot.setPresence(60);
    expect((await bot.me()).presence).toEqual({ online: true, via: 'mark', onlineUntil });
  });

  it('updateMe sets the agent role (self); GET /me carries both halves', async () => {
    const owner = await signUp(h, 'Owner');
    const orgId = (await owner.createOrg({ name: 'Acme' })).id;
    const { client: bot } = await makeAgent(h, owner, orgId, 'bot');
    const updated = await bot.updateMe({ roleTitle: 'Ops', roleInstructions: 'be terse' });
    if (updated.type !== 'agent') throw new Error('expected agent');
    expect(updated.roleTitle).toBe('Ops');
    expect(updated.roleInstructions).toBe('be terse');
    const me = await bot.me();
    expect(me.type === 'agent' && me.roleUpdatedAt).toBeTruthy();
    // Owner sets the role via PATCH /me/agents/:id (setAgentRole).
    const agentId = updated.id;
    const res = await owner.setAgentRole(agentId, { roleTitle: 'Lead' });
    expect(res.agent.roleTitle).toBe('Lead');
  });
});

/* ================================================================== *
 * Orgs
 * ================================================================== */

describe('orgs', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
  });
  afterAll(() => h.close());

  it('getOrg + updateOrg (name/settings)', async () => {
    const got = await owner.getOrg(orgId);
    expect(got.id).toBe(orgId);
    const updated = await owner.updateOrg(orgId, { name: 'Renamed Org' });
    expect(updated.name).toBe('Renamed Org');
    const withPolicy = await owner.updateOrg(orgId, {
      settings: { ...got.settings, enroll: { ...got.settings.enroll, agents: 'open' } },
    });
    expect(withPolicy.settings.enroll.agents).toBe('open');
  });

  it('roster, directory, role change and governance list', async () => {
    const { client: alice, userId } = await joinHuman(h, owner, orgId, 'Alice');
    const roster = await owner.listOrgHumans(orgId);
    expect(roster.items.some((m) => m.human.id === userId)).toBe(true);
    const dir = await owner.directory(orgId, 'Ali');
    expect(dir.some((d) => d.id === userId)).toBe(true);
    expect(await owner.setOrgRole(orgId, userId, 'admin')).toEqual({ ok: true });
    // Alice owns an agent → she cannot be removed until it's gone.
    await alice.createAgent({ orgId, name: 'alice-bot' });
    const gov = await owner.listOrgAgents(orgId);
    expect(gov.some((g) => g.agent.name === 'alice-bot')).toBe(true);
    await expect(owner.removeOrgHuman(orgId, userId)).rejects.toMatchObject({ status: 409 });
  });

  it('addOrgMember adds a person by email; re-adding → 409', async () => {
    const added = await owner.addOrgMember(orgId, { email: 'direct-add@example.com', role: 'admin' });
    expect(added.member.human.email).toBe('direct-add@example.com');
    expect(added.member.role).toBe('admin');
    const roster = await owner.listOrgHumans(orgId);
    expect(roster.items.some((m) => m.human.email === 'direct-add@example.com')).toBe(true);
    await expect(owner.addOrgMember(orgId, { email: 'direct-add@example.com' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('createOrg is refused when open creation is off (403)', async () => {
    const closed = await startServer({ openOrgCreation: false });
    try {
      const second = new SparrowClient({ server: closed.url });
      await second.signup({ email: email('nobody'), password: 'password123' }); // not first → no org
      // A non-first human with open creation off cannot create an org.
      await expect(second.createOrg({ name: 'Nope' })).rejects.toMatchObject({ status: 403 });
    } finally {
      await closed.close();
    }
  });
});

/* ================================================================== *
 * Invites & enrollment
 * ================================================================== */

describe('invites & enrollment', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
  });
  afterAll(() => h.close());

  it('create/list/revoke invites; revoked token → 410 on enroll', async () => {
    const created = await owner.createInvite(orgId, { note: 'come in' });
    expect(created.url).toContain('/invite/ivk_');
    const token = created.url.split('/invite/')[1]!;
    expect((await owner.listInvites(orgId)).some((i) => i.id === created.invite.id)).toBe(true);
    expect(await owner.revokeInvite(orgId, created.invite.id)).toEqual({ ok: true });
    const anon = new SparrowClient({ server: h.url });
    // A revoked token is a REAL door that was closed — `410 gone`, with a
    // message the caller can print. Unknown tokens stay `404`.
    await expect(anon.enrollAgent(token, { name: 'x' })).rejects.toMatchObject({
      status: 410,
      code: 'gone',
    });
    await expect(anon.enrollAgent('ivk_never-existed', { name: 'x' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('inviteInfo returns landing metadata for a valid invite; 404 unknown / 410 revoked', async () => {
    await owner.updateOrg(orgId, { name: 'Acme' });
    const created = await owner.createInvite(orgId);
    const token = created.url.split('/invite/')[1]!;
    const anon = new SparrowClient({ server: h.url });
    const info = await anon.inviteInfo(token);
    expect(info.org.name).toBe('Acme');
    expect(info.inviter.displayName).toBe('Owner');
    expect(info.inviter.email).toBe((await owner.authMe())?.email);
    expect(info.agentPolicy).toBe('approval');
    // Unknown token → 404 (the only existence oracle we give).
    await expect(anon.inviteInfo('ivk_totally-bogus-token')).rejects.toMatchObject({ status: 404 });
    // Revoked token → 410 naming the revocation, so the invite page can say
    // WHICH way the link died. Still names neither the org nor the inviter.
    await owner.revokeInvite(orgId, created.invite.id);
    await expect(anon.inviteInfo(token)).rejects.toMatchObject({
      status: 410,
      code: 'gone',
      message: expect.stringMatching(/revoked/i) as unknown as string,
    });
    await expect(anon.inviteInfo(token)).rejects.not.toMatchObject({
      message: expect.stringContaining('Acme') as unknown as string,
    });
  });

  it('agent enrollment: pending → approve → poll delivers key once', async () => {
    const invite = await owner.createInvite(orgId);
    const token = invite.url.split('/invite/')[1]!;
    const anon = new SparrowClient({ server: h.url });
    const res = await anon.enrollAgent(token, { name: 'deploy-bot', note: 'hi' });
    expect(res.status).toBe('pending');
    if (res.status !== 'pending') throw new Error('unreachable');
    const enrToken = res.enrollmentToken;
    // Approver sees it in the list.
    const pending = await owner.listEnrollments(orgId);
    expect(pending.some((e) => e.id === res.enrollment.id && e.kind === 'agent')).toBe(true);
    // Still pending before approval.
    const p1 = await anon.pollEnrollment(token, res.enrollment.id, { enrollmentToken: enrToken });
    expect(p1.status).toBe('pending');
    // Approval is strictly yes/no — the agent keeps its proposed name.
    await owner.approveEnrollment(orgId, res.enrollment.id);
    const p2 = await anon.pollEnrollment(token, res.enrollment.id, { enrollmentToken: enrToken });
    expect(p2.status).toBe('approved');
    if (p2.status !== 'approved' || !('key' in p2)) throw new Error('expected agent approval');
    expect(p2.key).toMatch(/^agk_/);
    expect(p2.agent.name).toBe('deploy-bot');
    expect(p2.dmRoomId).toMatch(/^room_/);
    // The key is delivered exactly once: a re-poll still parses (key optional),
    // now returns approved WITHOUT a key.
    const p3 = await anon.pollEnrollment(token, res.enrollment.id, { enrollmentToken: enrToken });
    expect(p3.status).toBe('approved');
    expect('key' in p3 && p3.key).toBeFalsy();
  });

  it('listEnrollments honors mine (admin sees all vs own invites)', async () => {
    // A second inviter (plain member) issues their own invite.
    const { client: inviter2 } = await joinHuman(h, owner, orgId, 'Inviter2');
    const invA = await owner.createInvite(orgId);
    const invB = await inviter2.createInvite(orgId);
    const anon = new SparrowClient({ server: h.url });
    const eA = await anon.enrollAgent(invA.url.split('/invite/')[1]!, { name: 'from-owner' });
    const eB = await anon.enrollAgent(invB.url.split('/invite/')[1]!, { name: 'from-inviter2' });
    if (eA.status !== 'pending' || eB.status !== 'pending') throw new Error('expected pending');
    // Owner is an org owner → sees ALL pending (both inviters').
    const all = await owner.listEnrollments(orgId);
    expect(all.some((e) => e.id === eA.enrollment.id)).toBe(true);
    expect(all.some((e) => e.id === eB.enrollment.id)).toBe(true);
    // mine restricts to the owner's own invites' enrollments.
    const mine = await owner.listEnrollments(orgId, { mine: true });
    expect(mine.some((e) => e.id === eA.enrollment.id)).toBe(true);
    expect(mine.some((e) => e.id === eB.enrollment.id)).toBe(false);
  });

  it('agent enrollment under open policy is admitted instantly', async () => {
    const g = await owner.getOrg(orgId);
    await owner.updateOrg(orgId, {
      settings: { ...g.settings, enroll: { ...g.settings.enroll, agents: 'open' } },
    });
    const invite = await owner.createInvite(orgId);
    const token = invite.url.split('/invite/')[1]!;
    const anon = new SparrowClient({ server: h.url });
    const res = await anon.enrollAgent(token, { name: 'insta' });
    expect(res.status).toBe('admitted');
    if (res.status !== 'admitted') throw new Error('unreachable');
    expect(res.key).toMatch(/^agk_/);
    expect(res.org.id).toBe(orgId);
  });

  it('human enrollment via a valid invite is immediate (token IS the approval)', async () => {
    // Contract change 2026-08-26: a signed-in human redeeming a valid invite
    // becomes a member instantly, regardless of the org's approval policy —
    // pending/approve/deny applies only to agent enrollment.
    const invite = await owner.createInvite(orgId);
    const token = invite.url.split('/invite/')[1]!;
    const member = new SparrowClient({ server: h.url });
    await member.signup({ email: email('hum'), password: 'password123', displayName: 'Hum' });
    const res = await member.enrollHuman(token, { note: 'let me in' });
    expect(res.status).toBe('member');
    if (res.status !== 'member') throw new Error('unreachable');
    expect(res.org.id).toBe(orgId);
    expect(res.role).toBe('member');
    const orgs = await member.meOrgs();
    expect(orgs.map((o) => o.org.id)).toContain(orgId);
  });

  it('an already-member session enroll is idempotent (member status)', async () => {
    const invite = await owner.createInvite(orgId);
    const token = invite.url.split('/invite/')[1]!;
    // Owner is already a member of the org → 200 { org, role }.
    const res = await owner.enrollHuman(token);
    expect(res.status).toBe('member');
    if (res.status !== 'member') throw new Error('unreachable');
    expect(res.org.id).toBe(orgId);
  });
});

/* ================================================================== *
 * Agents, visibility & sharing
 * ================================================================== */

describe('agents & sharing', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
  });
  afterAll(() => h.close());

  it('create/list/rotate/share/unshare/delete', async () => {
    const created = await owner.createAgent({ orgId, name: 'helper' });
    expect(created.key).toMatch(/^agk_/);
    const agentId = created.agent.id;
    // Visibility list (owned) + sidebar source.
    expect((await owner.listAgents({ org: orgId })).some((a) => a.agent.id === agentId)).toBe(true);
    expect((await owner.orgMeAgents(orgId)).some((a) => a.agent.id === agentId)).toBe(true);
    // Rotate → a new key.
    const rot = await owner.rotateAgent(agentId);
    expect(rot.key).not.toBe(created.key);
    // Share with a co-member.
    const { client: grantee, userId } = await joinHuman(h, owner, orgId, 'Grantee');
    expect(await owner.shareAgent(agentId, userId)).toEqual({ ok: true });
    expect((await grantee.listAgents({ org: orgId })).some((a) => a.agent.id === agentId)).toBe(true);
    expect(await owner.unshareAgent(agentId, userId)).toEqual({ ok: true });
    expect((await grantee.listAgents({ org: orgId })).some((a) => a.agent.id === agentId)).toBe(false);
    // Name collision → 409.
    await expect(owner.createAgent({ orgId, name: 'helper' })).rejects.toMatchObject({ status: 409 });
    // Delete.
    expect(await owner.deleteAgent(agentId)).toEqual({ ok: true });
    expect((await owner.listAgents({ org: orgId })).some((a) => a.agent.id === agentId)).toBe(false);
  });

  it('setAgentSharing (owner-only) switches to org mode so co-members see it', async () => {
    const created = await owner.createAgent({ orgId, name: 'shareable' });
    const agentId = created.agent.id;
    // Fresh agents default to `selected`.
    expect(created.agent.sharing).toBe('room-members');
    const { client: peer } = await joinHuman(h, owner, orgId, 'Peer');
    expect((await peer.listAgents({ org: orgId })).some((a) => a.agent.id === agentId)).toBe(false);
    // Owner flips to `org` — now every org member sees it (no explicit grant).
    const updated = await owner.setAgentSharing(agentId, 'org');
    expect(updated.agent.sharing).toBe('org');
    expect((await peer.listAgents({ org: orgId })).some((a) => a.agent.id === agentId)).toBe(true);
    // A non-owner cannot change the mode → 403.
    await expect(peer.setAgentSharing(agentId, 'selected')).rejects.toMatchObject({ status: 403 });
  });

  it('renameAgent (owner-only) renames; collision → 409; non-owner → 403', async () => {
    await owner.createAgent({ orgId, name: 'existing' });
    const created = await owner.createAgent({ orgId, name: 'renameable' });
    const agentId = created.agent.id;

    const updated = await owner.renameAgent(agentId, 'renamed');
    expect(updated.agent.name).toBe('renamed');

    // v4 agent shapes carry the (still null) email address everywhere.
    expect(updated.agent.emailAddress).toBeNull();
    expect(created.agent.emailAddress).toBeNull();

    // Collision with another org agent → 409 (`EXISTING` is no longer a legal
    // v4 name — email-safe names are lowercase — so the probe uses the slug).
    await expect(owner.renameAgent(agentId, 'existing')).rejects.toMatchObject({ status: 409 });

    // A non-owner org member → 403.
    const { client: peer } = await joinHuman(h, owner, orgId, 'Peer2');
    await expect(peer.renameAgent(agentId, 'nope')).rejects.toMatchObject({ status: 403 });
  });

  it('owned agent surfaces sharedWith + rooms[].memberId through listAgents', async () => {
    const created = await owner.createAgent({ orgId, name: 'surfaced' });
    const agentId = created.agent.id;
    // Share it with a co-member and attach it to a room.
    const { userId } = await joinHuman(h, owner, orgId, 'Peer');
    await owner.shareAgent(agentId, userId);
    const room = await owner.createRoom(orgId, { name: 'attach-room' });
    const roomMember = await owner.addMember(room.id, agentId);

    const mine = (await owner.listAgents({ org: orgId })).find((a) => a.agent.id === agentId)!;
    // rooms[].memberId (backs detach via RemoveMember) round-trips.
    const roomEntry = mine.rooms?.find((r) => r.id === room.id);
    expect(roomEntry?.name).toBe('attach-room');
    expect(roomEntry?.memberId).toBe(roomMember.id);
    // sharedWith names the grantee.
    expect(mine.sharedWith?.some((s) => s.id === userId)).toBe(true);
    // sharedBy is null for an owned agent.
    expect(mine.sharedBy).toBeNull();
  });
});

/* ================================================================== *
 * Rooms, members & invitations
 * ================================================================== */

describe('rooms, members & invitations', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
  });
  afterAll(() => h.close());

  it('create/get/update a room; add an agent member; roles', async () => {
    const room = await owner.createRoom(orgId, { name: 'general' });
    expect(room.kind).toBe('project');
    expect((await owner.getRoom(room.id)).name).toBe('general');
    const renamed = await owner.updateRoom(room.id, {
      name: 'general-2',
      settings: { description: 'the main room' },
    });
    expect(renamed.name).toBe('general-2');
    expect(renamed.settings.description).toBe('the main room');

    // Attach an owned agent (owner holds visibility).
    const { agent } = await makeAgent(h, owner, orgId, 'room-bot');
    const member = await owner.addMember(room.id, agent.id);
    expect(member.kind).toBe('agent');
    // Already present → 409.
    await expect(owner.addMember(room.id, agent.id)).rejects.toMatchObject({ status: 409 });
    // List + get member (by member id and principal id).
    expect((await owner.listMembers(room.id)).items.length).toBe(2);
    expect((await owner.getMember(room.id, agent.id)).principalId).toBe(agent.id);
    // Agents cannot hold a room role above member → 400.
    await expect(owner.setMemberRole(room.id, member.id, 'admin')).rejects.toMatchObject({
      status: 400,
    });
    // Remove the agent member.
    expect(await owner.removeMember(room.id, member.id)).toEqual({ ok: true });
  });

  it('invite a human to a room; invitee accepts; meRooms + leave', async () => {
    const room = await owner.createRoom(orgId, { name: 'project-x' });
    const { client: bob, userId } = await joinHuman(h, owner, orgId, 'Bob');
    const inv = await owner.inviteHuman(room.id, userId);
    expect(inv.created).toBe(true);
    expect((await owner.listRoomInvitations(room.id)).length).toBe(1);
    // Duplicate invite dedups → created false.
    expect((await owner.inviteHuman(room.id, userId)).created).toBe(false);
    // Invitee sees + accepts.
    const pending = await bob.meRoomInvitations();
    expect(pending.length).toBe(1);
    const accepted = await bob.acceptRoomInvitation(pending[0]!.id);
    expect(accepted.room.id).toBe(room.id);
    expect((await bob.meRooms({ org: orgId })).some((r) => r.room.id === room.id)).toBe(true);
    // Bob (a member, not owner) can leave.
    expect(await bob.leaveRoom(room.id)).toEqual({ ok: true });
    // Sole owner cannot leave → 409.
    await expect(owner.leaveRoom(room.id)).rejects.toMatchObject({ status: 409 });
  });

  it('decline + revoke invitation paths', async () => {
    const room = await owner.createRoom(orgId, { name: 'project-y' });
    const { client: carol, userId } = await joinHuman(h, owner, orgId, 'Carol');
    const inv = await owner.inviteHuman(room.id, userId);
    const list = await carol.meRoomInvitations();
    expect(await carol.declineRoomInvitation(list[0]!.id)).toEqual({ ok: true });
    // A fresh invite we revoke from the admin side.
    const inv2 = await owner.inviteHuman(room.id, userId);
    expect(await owner.revokeRoomInvitation(room.id, inv2.invitation.id)).toEqual({ ok: true });
    void inv;
  });

  it('cross-org room access is 404 (rooms never leak across orgs)', async () => {
    const room = await owner.createRoom(orgId, { name: 'secret' });
    // A human in a DIFFERENT org (not a member of this room's org).
    const outsider = new SparrowClient({ server: h.url });
    await outsider.signup({ email: email('out'), password: 'password123', displayName: 'Out' });
    await outsider.createOrg({ name: 'Other Org' });
    await expect(outsider.getRoom(room.id)).rejects.toMatchObject({ status: 404 });
  });
});

/* ================================================================== *
 * DMs & messages
 * ================================================================== */

describe('DMs & messages', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  let agent: { client: SparrowClient; agent: { id: string; name: string } };
  let dmRoomId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
    agent = await makeAgent(h, owner, orgId, 'chat-bot');
  });
  afterAll(() => h.close());

  it('ensureDm is idempotent (201 then 200); self-DM 400', async () => {
    const first = await owner.ensureDm({ principal: agent.agent.id });
    expect(first.created).toBe(true);
    expect(first.room.kind).toBe('dm');
    dmRoomId = first.room.id;
    const second = await owner.ensureDm({ principal: agent.agent.id });
    expect(second.created).toBe(false);
    expect(second.room.id).toBe(dmRoomId);
    // Self-DM → 400. (Use the owner's own user id.)
    const meId = (await owner.me());
    if (meId.type !== 'human') throw new Error('expected human');
    await expect(owner.ensureDm({ principal: meId.id })).rejects.toMatchObject({ status: 400 });
  });

  it('send/inbox/pop/read/outbox/status/whoami/attachment', async () => {
    // Agent sends a DM to the owner in the DM room.
    const ownerMember = await owner.whoami(dmRoomId);
    const sent = await agent.client.sendMessage(dmRoomId, {
      to: ownerMember.id,
      subject: 'hello',
      body: 'first message with an attachment',
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', dataBase64: Buffer.from('hi bytes').toString('base64') },
      ],
      suggestedReplies: [{ label: 'Ship it', value: 'ship' }],
    });
    expect(sent.message.subject).toBe('hello');
    expect(typeof sent.unreadCount).toBe('number');

    // Owner's inbox shows the preview; listing is server-observed delivery, so
    // the item is now marked `received` (not yet read).
    const inbox = await owner.listInbox(dmRoomId);
    expect(inbox.items.length).toBe(1);
    expect(inbox.items[0]!.status).toBe('received');
    // Whoami for the agent.
    expect((await agent.client.whoami(dmRoomId)).kind).toBe('agent');

    // Pop drains it (marks read).
    const popped = await owner.popNextMessage(dmRoomId, { ack: true, note: 'reading' });
    expect(popped?.id).toBe(sent.message.id);
    const attId = popped!.attachments[0]!.id;
    // Read (peek) is idempotent; attachment bytes round-trip.
    const peeked = await owner.readMessage(dmRoomId, sent.message.id, { peek: true });
    expect(peeked.body).toBe('first message with an attachment');
    const dl = await owner.getAttachment(dmRoomId, attId);
    expect(Buffer.from(dl.bytes).toString('utf8')).toBe('hi bytes');
    expect(dl.filename).toBe('a.txt');

    // Sender's outbox + per-recipient status.
    const outbox = await agent.client.listOutbox(dmRoomId);
    expect(outbox.items.some((m) => m.id === sent.message.id)).toBe(true);
    const status = await agent.client.getMessageStatus(dmRoomId, sent.message.id);
    expect(status.recipients[0]!.status).toBe('read');

    // `to` is accepted-and-ignored: even a self-targeted send in a DM room just
    // reaches the one counterpart (kind stays `dm`). Drain it to keep this
    // shared DM room's inbox clean for later tests.
    const selfish = await agent.client.sendMessage(dmRoomId, {
      to: (await agent.client.whoami(dmRoomId)).id,
      body: 'x',
    });
    expect(selfish.message.kind).toBe('dm');
    expect(selfish.message.to.map((t) => t.id)).toEqual([ownerMember.id]);
    await owner.readMessage(dmRoomId, selfish.message.id);
  });

  it('uploadAttachment → ref → send → recipient downloads identical bytes', async () => {
    // The agent (an agent-key principal) uploads binary bytes and sends them to
    // the owner — the exact path a production agent needs. `bytes` round-trip
    // byte-for-byte via the existing download machinery.
    const original = new Uint8Array([0, 1, 2, 250, 128, 64, 33, 255]);
    const ownerMember = await owner.whoami(dmRoomId);
    const ref = await agent.client.uploadAttachment(dmRoomId, {
      filename: 'shot.png',
      contentType: 'image/png',
      bytes: original,
    });
    expect(ref).toMatchObject({ filename: 'shot.png', contentType: 'image/png' });
    expect(typeof ref.dataBase64).toBe('string');

    const sent = await agent.client.sendMessage(dmRoomId, {
      to: ownerMember.id,
      body: 'screenshot attached',
      attachments: [ref],
    });
    const attId = sent.message.attachments[0]!.id;
    expect(sent.message.attachments[0]!.filename).toBe('shot.png');

    const dl = await owner.getAttachment(dmRoomId, attId);
    expect(dl.filename).toBe('shot.png');
    expect(dl.contentType).toBe('image/png');
    expect(Buffer.compare(Buffer.from(dl.bytes), Buffer.from(original))).toBe(0);
    // Drain it so this shared-state DM room's inbox is clean for later tests.
    await owner.readMessage(dmRoomId, sent.message.id);

    // Oversize files fail fast, before any upload.
    await expect(
      agent.client.uploadAttachment(dmRoomId, {
        filename: 'huge.bin',
        contentType: 'application/octet-stream',
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(/limit is 5 MB/i);
  });

  it('working status + presence snapshot', async () => {
    const working = await agent.client.setStatus(dmRoomId, { state: 'working', note: 'thinking', ttlSeconds: 60 });
    expect(working?.state).toBe('working');
    expect(working?.note).toBe('thinking');
    const snap = await owner.listStatuses(dmRoomId);
    expect(snap.items.some((s) => s.note === 'thinking')).toBe(true);
    expect(Array.isArray(snap.presence.online)).toBe(true);
    const cleared = await agent.client.setStatus(dmRoomId, { state: 'idle' });
    expect(cleared).toBeNull();
  });

  it('sticky status has no TTL (expiresAt null, sticky true) + carries sinceAt', async () => {
    const sticky = await agent.client.setStatus(dmRoomId, { state: 'working', note: 'long task', sticky: true });
    expect(sticky?.sticky).toBe(true);
    expect(sticky?.expiresAt).toBeNull();
    expect(sticky?.sinceAt).toEqual(expect.any(String));
    await agent.client.setStatus(dmRoomId, { state: 'idle' });
  });

  it('setPresence marks a socketless agent online, then clears it', async () => {
    // Nobody holds a stream, so the room starts with an empty online set.
    expect((await owner.listStatuses(dmRoomId)).presence.online).toHaveLength(0);

    const marked = await agent.client.setPresence(60);
    expect(marked.onlineUntil).toEqual(expect.any(String));
    expect((await owner.listStatuses(dmRoomId)).presence.online.length).toBeGreaterThan(0);

    const cleared = await agent.client.setPresence(0);
    expect(cleared.onlineUntil).toBeNull();
    expect((await owner.listStatuses(dmRoomId)).presence.online).toHaveLength(0);
  });

  it('listRoomMessages: newest-first, before-cursor paging, visibility, peek', async () => {
    // A project room with owner + two humans.
    const room = await owner.createRoom(orgId, { name: 'history' });
    const { client: alice, userId: aliceId } = await joinHuman(h, owner, orgId, 'Alice');
    const { client: bob, userId: bobId } = await joinHuman(h, owner, orgId, 'Bob');
    for (const [c, uid] of [[alice, aliceId], [bob, bobId]] as const) {
      const inv = await owner.inviteHuman(room.id, uid);
      await c.acceptRoomInvitation(inv.invitation.id);
    }
    // Four room messages (the `to` on the last is ignored — still reaches all).
    for (const body of ['one', 'two', 'three']) await owner.sendMessage(room.id, { to: 'all', body });
    const last = await owner.sendMessage(room.id, { to: aliceId, body: 'secret' });

    // Newest-first; every message is visible to the room.
    const ownerList = await owner.listRoomMessages(room.id);
    expect(ownerList.items[0]!.body).toBe('secret');
    expect(ownerList.items.map((m) => m.body)).toContain('three');

    // before-cursor paging over the visible history.
    const page1 = await alice.listRoomMessages(room.id, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextBefore).toBeTruthy();
    const page2 = await alice.listRoomMessages(room.id, { limit: 2, before: page1.nextBefore! });
    expect(page2.items.length).toBeGreaterThan(0);

    // Flat visibility: Bob — every member — sees the whole room, including the
    // message whose (ignored) `to` named only Alice.
    const bobList = await bob.listRoomMessages(room.id);
    expect(bobList.items.some((m) => m.id === last.message.id)).toBe(true);
    expect(bobList.items.map((m) => m.body)).toContain('three');

    // Peek: listing never observes delivery, so the message is still unread for
    // its recipients (find Alice's row — recipients are the whole room).
    const status = await owner.getMessageStatus(room.id, last.message.id);
    expect(status.recipients.every((r) => r.status === 'unread')).toBe(true);
  });

  it('principal inbox spans memberships; orgMeHumans sidebar', async () => {
    // Agent DMs owner again; owner drains via the principal inbox.
    const ownerMember = await owner.whoami(dmRoomId);
    await agent.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'across-inbox' });
    const meInbox = await owner.meInbox();
    expect(
      meInbox.items.some((i) => i.type === 'chat.message' && i.room.id === dmRoomId),
    ).toBe(true);
    // v4: pop hands back a typed WORK ITEM, not a bare message.
    const pop = await owner.meInboxPop();
    expect(pop.item?.type).toBe('chat.message');
    if (pop.item?.type !== 'chat.message') throw new Error('expected a chat work item');
    expect(pop.item.message.body).toBe('across-inbox');
    expect(pop.item.room.id).toBe(dmRoomId);
    // Sidebar humans (room-derived): owner shares a room with a human co-member.
    await joinHuman(h, owner, orgId, 'Dana');
    const humans = await owner.orgMeHumans(orgId);
    expect(Array.isArray(humans)).toBe(true);
  });

  it('markRead + getMessage: ack a specific id without racing the oldest unread', async () => {
    const ownerMember = await owner.whoami(dmRoomId);
    const first = await agent.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'older one' });
    const second = await agent.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'the one I saw' });

    // getMessage fetches the newer one by id WITHOUT consuming it.
    const fetched = await owner.getMessage(second.message.id);
    expect(fetched.message.body).toBe('the one I saw');
    expect(fetched.room.id).toBe(dmRoomId);
    expect((await agent.client.getMessageStatus(dmRoomId, second.message.id)).recipients[0]!.status)
      .not.toBe('read');

    // markRead acks EXACTLY the newer id; the older one is left unread.
    const acked = await owner.markRead(second.message.id);
    expect(acked.message.id).toBe(second.message.id);
    expect((await agent.client.getMessageStatus(dmRoomId, second.message.id)).recipients[0]!.status).toBe('read');
    expect((await agent.client.getMessageStatus(dmRoomId, first.message.id)).recipients[0]!.status).not.toBe('read');

    // Idempotent, and unknown/foreign ids 404.
    expect((await owner.markRead(second.message.id)).message.id).toBe(second.message.id);
    await expect(owner.markRead('msg_nope')).rejects.toMatchObject({ status: 404 });
    await expect(owner.getMessage('msg_nope')).rejects.toMatchObject({ status: 404 });
  });

  it('clawbackMessage retracts an unread send (body comes back); a read one → 409', async () => {
    const sent = await owner.sendMessage(dmRoomId, { body: 'oops — wrong chat' });
    const clawed = await owner.clawbackMessage(dmRoomId, sent.message.id);
    // The full message returns so a client can restore it into the composer …
    expect(clawed.message.id).toBe(sent.message.id);
    expect(clawed.message.body).toBe('oops — wrong chat');
    // … and the row is dead everywhere else: history drops it, by-id 404s.
    const hist = await owner.listRoomMessages(dmRoomId);
    expect(hist.items.some((m) => m.id === sent.message.id)).toBe(false);
    await expect(owner.getMessage(sent.message.id)).rejects.toMatchObject({ status: 404 });

    // Once ANY recipient has READ it, the clawback is refused with 409.
    const late = await owner.sendMessage(dmRoomId, { body: 'seen already' });
    await agent.client.markRead(late.message.id);
    await expect(owner.clawbackMessage(dmRoomId, late.message.id)).rejects.toMatchObject({
      status: 409,
      message: 'message_read',
    });
  });

  it('ensureDm to an ineligible principal → 403', async () => {
    const g = await owner.getOrg(orgId);
    void g;
    // A human with no visibility on the agent, sharing no room, cannot DM it.
    const { client: eve } = await joinHuman(h, owner, orgId, 'Eve');
    await expect(eve.ensureDm({ principal: agent.agent.id })).rejects.toMatchObject({ status: 403 });
  });

  it('agent↔agent DM: eligible when a human sees both; owner watches the box read-only', async () => {
    const a = await makeAgent(h, owner, orgId, 'dm-a');
    const b = await makeAgent(h, owner, orgId, 'dm-b');
    // Agents must have MET before they may DM (a raw agt_ id is no wider a door
    // than a name), and the owner owns both → the owner can oversee the pair.
    const met = await owner.createRoom(orgId, { name: 'dm-ops' });
    await owner.addMember(met.id, a.agent.id);
    await owner.addMember(met.id, b.agent.id);
    const dm = await a.client.ensureDm({ principal: b.agent.id });
    expect(dm.room.kind).toBe('dm');
    await a.client.sendMessage(dm.room.id, { body: 'from a' });

    const boxes = await owner.agentDms(orgId);
    const box = boxes.items.find((x) => x.roomId === dm.room.id);
    expect(box).toBeDefined();
    expect(box!.agents.map((g) => g.id).sort()).toEqual([a.agent.id, b.agent.id].sort());
    expect(box!.lastMessage?.preview).toBe('from a');

    const msgs = await owner.agentDmMessages(orgId, dm.room.id);
    expect(msgs.items.some((m) => m.body === 'from a')).toBe(true);

    // An org member who can see neither agent gets no box and a 404 on read.
    const { client: eve } = await joinHuman(h, owner, orgId, 'Eve2');
    expect((await eve.agentDms(orgId)).items.find((x) => x.roomId === dm.room.id)).toBeUndefined();
    await expect(eve.agentDmMessages(orgId, dm.room.id)).rejects.toMatchObject({ status: 404 });
  });
});

/* ================================================================== *
 * Drafts (personal, room-scoped)
 * ================================================================== */

/* ================================================================== *
 * Hints — the PAUSE is the only hinted surface
 *
 * The right time to teach an agent is BETWEEN tasks. A hint rides the
 * `{ item: null }` pop and nothing else: not a send, not a pop that hands
 * back work. `sparrow tips` (`GET /me/hints`) is the on-demand read of the
 * same engine, and it costs the agent nothing.
 * ================================================================== */

describe('hints (the API teaches agents at the pause)', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
  });
  afterAll(() => h.close());

  it('a send is NEVER hinted — the agent is mid-task', async () => {
    const room = await owner.createRoom(orgId, { name: 'hint-room' });
    const { client: agent, agent: a } = await makeAgent(h, owner, orgId, 'hint-bot');
    await owner.addMember(room.id, a.id);
    // This agent holds no stream and no presence mark — `start-listening`
    // applies to it — and its send still comes back clean.
    const sent = await agent.sendMessage(room.id, { to: 'all', body: 'hello' });
    expect(sent.hints).toBeUndefined();
  });

  it('the EMPTY pop carries the hint; a pop that returns work does not', async () => {
    const room = await owner.createRoom(orgId, { name: 'pause-room' });
    const { client: agent, agent: a } = await makeAgent(h, owner, orgId, 'pause-bot');
    await owner.addMember(room.id, a.id);
    await owner.sendMessage(room.id, { to: 'all', body: 'work for you' });

    // The pop that HANDS BACK WORK is silent — never interrupt a task starting.
    const work = await agent.meInboxPop();
    expect(work.item?.type).toBe('chat.message');
    expect(work.hints).toBeUndefined();

    // The next pop drains to empty: that is the pause, and that is where the
    // typed client surfaces the hint.
    const pause = await agent.meInboxPop();
    expect(pause.item).toBeNull();
    expect(pause.hints?.[0]?.id).toBe('start-listening');
    expect(pause.hints?.[0]?.docs).toContain('/docs/api/me/events');
  });

  it('a quiet pause omits hints entirely (old-shape compatible)', async () => {
    // A human is never hinted, at the pause or anywhere else.
    let pause = await owner.meInboxPop();
    while (pause.item !== null) pause = await owner.meInboxPop(); // drain to the pause
    expect(pause.hints).toBeUndefined();
  });

  it('meHints() reads the engine on demand and never burns a delivery', async () => {
    const room = await owner.createRoom(orgId, { name: 'tips-room' });
    const { client: agent, agent: a } = await makeAgent(h, owner, orgId, 'tips-bot');
    await owner.addMember(room.id, a.id);

    // `hints` is REQUIRED here and may be empty — the caller asked a question.
    const tips = await agent.meHints();
    expect(Array.isArray(tips.hints)).toBe(true);
    expect(tips.hints.some((x) => x.id === 'start-listening')).toBe(true);

    // Reading tips recorded no delivery, so the real pause still delivers it.
    await agent.meHints();
    const pause = await agent.meInboxPop();
    expect(pause.hints?.[0]?.id).toBe('start-listening');
  });

  it('meHints() is an agent surface — a human session gets 403', async () => {
    await expect(owner.meHints()).rejects.toMatchObject({ status: 403 });
  });
});

describe('drafts', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  let roomId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
    roomId = (await owner.createRoom(orgId, { name: 'drafts-room' })).id;
  });
  afterAll(() => h.close());

  it('create (trimmed) → list oldest-first → delete', async () => {
    expect(await owner.listDrafts(roomId)).toEqual([]);
    const a = await owner.createDraft(roomId, '  first  ');
    expect(a.id).toMatch(/^drf_/);
    expect(a.text).toBe('first'); // server trims
    expect(typeof a.createdAt).toBe('string');
    await owner.createDraft(roomId, 'second');
    expect((await owner.listDrafts(roomId)).map((d) => d.text)).toEqual(['first', 'second']);
    // Delete the first; the remainder stays.
    expect(await owner.deleteDraft(roomId, a.id)).toEqual({ ok: true });
    expect((await owner.listDrafts(roomId)).map((d) => d.text)).toEqual(['second']);
  });

  it('empty text → 400; unknown draft delete → 404', async () => {
    await expect(owner.createDraft(roomId, '   ')).rejects.toMatchObject({ status: 400 });
    await expect(owner.deleteDraft(roomId, 'drf_nope')).rejects.toMatchObject({ status: 404 });
  });
});

/* ================================================================== *
 * Events (SSE)
 * ================================================================== */

describe('events (SSE)', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
  });
  afterAll(() => h.close());

  it('room events deliver message.new; url builders carry ?token=', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'evt-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;

    expect(owner.roomEventsUrl(roomId)).toContain(`/rooms/${roomId}/events?token=`);
    expect(owner.meEventsUrl()).toContain('/me/events?token=');

    const received: string[] = [];
    const stream = owner.events(roomId, (e) => received.push(e.type));
    // Give the stream a moment to establish.
    await sleep(150);
    const ownerMember = await owner.whoami(roomId);
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'ping via sse' });
    // Wait for the message.new event.
    for (let i = 0; i < 40 && !received.includes('message.new'); i++) await sleep(25);
    stream.close();
    await stream.closed;
    expect(received).toContain('message.new');
  });

  it('events onOpen fires once the stream is established (additive option)', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'open-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;
    void agent;

    let opened = 0;
    const stream = owner.events(roomId, () => {}, { onOpen: () => (opened += 1) });
    for (let i = 0; i < 40 && opened === 0; i++) await sleep(25);
    stream.close();
    await stream.closed;
    expect(opened).toBe(1);
  });

  it('meEvents onOpen fires once the fan-in stream is established (additive option)', async () => {
    let opened = 0;
    const stream = owner.meEvents(() => {}, { onOpen: () => (opened += 1) });
    for (let i = 0; i < 40 && opened === 0; i++) await sleep(25);
    stream.close();
    await stream.closed;
    expect(opened).toBe(1);
  });

  it('onActivity fires on raw bytes incl. the heartbeat preamble (liveness signal)', async () => {
    // The server writes a `: open` comment immediately, then heartbeats — none of
    // which surface as events. onActivity must still fire so a stale-stream
    // watchdog can tell a live-but-quiet stream from a dead one.
    let activity = 0;
    let events = 0;
    const stream = owner.meEvents(() => (events += 1), { onActivity: () => (activity += 1) });
    for (let i = 0; i < 40 && activity === 0; i++) await sleep(25);
    stream.close();
    await stream.closed;
    expect(activity).toBeGreaterThan(0);
    expect(events).toBe(0); // proves it fired on a comment/heartbeat, not an event
  });

  it('me/events fans in wrapped room events', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'fan-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;
    const wrapped: { type: string; roomId?: string }[] = [];
    const stream = owner.meEvents((e) => wrapped.push({ type: e.type, roomId: e.room?.id }));
    await sleep(150);
    const ownerMember = await owner.whoami(roomId);
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'fan-in' });
    for (let i = 0; i < 40 && !wrapped.some((w) => w.type === 'message.new'); i++) await sleep(25);
    stream.close();
    await stream.closed;
    const evt = wrapped.find((w) => w.type === 'message.new');
    expect(evt?.roomId).toBe(roomId);
  });

  it('meEventsUrl carries ?since= when a resume cursor is passed', () => {
    expect(owner.meEventsUrl(undefined, '42')).toContain('since=42');
    expect(owner.meEventsUrl()).not.toContain('since=');
  });

  it('meEvents surfaces each frame id and resumes from it via { since }', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'resume-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;
    const ownerMember = await owner.whoami(roomId);

    // First stream: capture the frame id of a live message.new.
    const first: PrincipalEvent[] = [];
    const s1 = owner.meEvents((e) => first.push(e));
    await sleep(150);
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'live-one' });
    for (let i = 0; i < 40 && !first.some((e) => e.type === 'message.new'); i++) await sleep(25);
    const seen = first.find((e) => e.type === 'message.new')!;
    expect(seen.id).toBeDefined();
    s1.close();
    await s1.closed;

    // A message arrives while disconnected — recoverable only via replay.
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'missed-one' });

    // Resume from the captured cursor: the missed message.new replays.
    const replayed: PrincipalEvent[] = [];
    const s2 = owner.meEvents((e) => replayed.push(e), { since: seen.id });
    for (
      let i = 0;
      i < 40 &&
      !replayed.some((e) => e.type === 'message.new' && (e.data as MessageNewEvent).preview === 'missed-one');
      i++
    ) {
      await sleep(25);
    }
    s2.close();
    await s2.closed;
    const missed = replayed.find(
      (e) => e.type === 'message.new' && (e.data as MessageNewEvent).preview === 'missed-one',
    );
    expect(missed).toBeTruthy();
    expect(Number(missed!.id)).toBeGreaterThan(Number(seen.id));
    // The already-seen frame is NOT replayed.
    expect(
      replayed.some(
        (e) => e.type === 'message.new' && (e.data as MessageNewEvent).preview === 'live-one',
      ),
    ).toBe(false);
  });

  it('meEventsLog reads the journal non-streaming, decoded like live frames', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'log-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;
    const ownerMember = await owner.whoami(roomId);

    // With no cursor: a cheap probe — no events, just the current latest.
    const probe = await owner.meEventsLog();
    expect(probe.events).toEqual([]);
    expect(typeof probe.latest).toBe('string');
    const startCursor = probe.latest;

    // Journal two messages with NO live stream (journaling is connection-independent).
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'log-one' });
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'log-two' });

    // Read everything after the starting cursor: decoded PrincipalEvents, room-wrapped.
    const res = await owner.meEventsLog(startCursor);
    const msgs = res.events.filter((e) => e.type === 'message.new');
    expect(msgs.map((e) => (e.data as MessageNewEvent).preview)).toEqual(['log-one', 'log-two']);
    // Each carries its journal cursor (string id) and the wrapped room ref.
    expect(msgs.every((e) => e.id !== undefined)).toBe(true);
    expect(msgs[0]!.room?.id).toBe(roomId);
    expect(res.gap).toBe(false);
    expect(res.more).toBe(false);
    expect(Number(res.latest)).toBeGreaterThan(Number(startCursor));

    // A cursor at the newest id returns nothing new.
    const tail = await owner.meEventsLog(res.latest);
    expect(tail.events.filter((e) => e.type === 'message.new')).toHaveLength(0);
  });

  /* ---------------- presence/status opt-in (`?quiet=`) ---------------- */
  // Presence and status churn is the loudest traffic on the fan-in and the least
  // actionable: a room of members flipping online/offline says nothing about work
  // waiting for you. A subscriber may quiet it for ITSELF; the journal keeps
  // every frame, so an unfiltered subscriber (the web) still sees them all.

  it('meEventsUrl carries ?quiet= as a comma list, and omits it when unfiltered', () => {
    expect(owner.meEventsUrl(undefined, undefined, ['presence', 'status'])).toContain(
      'quiet=presence%2Cstatus',
    );
    expect(owner.meEventsUrl()).not.toContain('quiet=');
    expect(owner.meEventsUrl(undefined, undefined, [])).not.toContain('quiet=');
  });

  it('a quieting subscriber never sees presence.changed; an unfiltered one still does', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'quiet-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;
    const ownerMember = await owner.whoami(roomId);

    const quiet: PrincipalEvent[] = [];
    const loud: PrincipalEvent[] = [];
    const qs = owner.meEvents((e) => quiet.push(e), { quiet: ['presence', 'status'] });
    const ls = owner.meEvents((e) => loud.push(e));
    await sleep(200);

    // The agent opening a stream flips presence in the shared DM room.
    const agentStream = agent.meEvents(() => {});
    for (let i = 0; i < 60 && !loud.some((e) => e.type === 'presence.changed'); i++) await sleep(25);
    // A message.new proves the quiet stream is alive and delivering everything else.
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'still listening' });
    for (let i = 0; i < 60 && !quiet.some((e) => e.type === 'message.new'); i++) await sleep(25);

    agentStream.close();
    qs.close();
    ls.close();
    await Promise.all([agentStream.closed, qs.closed, ls.closed]);

    expect(loud.some((e) => e.type === 'presence.changed')).toBe(true);
    expect(quiet.some((e) => e.type === 'presence.changed')).toBe(false);
    expect(quiet.some((e) => e.type === 'message.new')).toBe(true);
  });

  it('?since= replay honors the same filter, so a resume matches the live stream', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'replay-quiet-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;
    const ownerMember = await owner.whoami(roomId);

    const start = (await owner.meEventsLog()).latest;
    // Journal a presence flip AND a message while nobody is listening.
    const agentStream = agent.meEvents(() => {});
    await sleep(200);
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'replayed-quietly' });
    await sleep(150);
    agentStream.close();
    await agentStream.closed;

    const replayed: PrincipalEvent[] = [];
    const s = owner.meEvents((e) => replayed.push(e), {
      since: start,
      quiet: ['presence', 'status'],
    });
    for (
      let i = 0;
      i < 60 &&
      !replayed.some(
        (e) => e.type === 'message.new' && (e.data as MessageNewEvent).preview === 'replayed-quietly',
      );
      i++
    ) {
      await sleep(25);
    }
    s.close();
    await s.closed;
    expect(replayed.some((e) => e.type === 'presence.changed')).toBe(false);

    // The journal is UNTOUCHED: the unfiltered non-streaming read still has them.
    const log = await owner.meEventsLog(start);
    expect(log.events.some((e) => e.type === 'presence.changed')).toBe(true);
    // ...and the same read, quieted, drops exactly those (the CLI's reconcile
    // poll must not hand back what the stream filtered out).
    const quietLog = await owner.meEventsLog(start, { quiet: ['presence', 'status'] });
    expect(quietLog.events.some((e) => e.type === 'presence.changed')).toBe(false);
    expect(
      quietLog.events.some(
        (e) => e.type === 'message.new' && (e.data as MessageNewEvent).preview === 'replayed-quietly',
      ),
    ).toBe(true);
    // Cursors come from the unfiltered journal, so the two reads agree.
    expect(quietLog.latest).toBe(log.latest);
  });

  it('meEventsLog forwards an abort signal into the request (per-poll timeout plumbing)', async () => {
    // The reconcile poll bounds each journal read with an AbortController so one
    // request hung on a dead path can never wedge the loop. Proving the signal is
    // plumbed: an already-aborted signal makes the request reject rather than run.
    const ac = new AbortController();
    ac.abort();
    await expect(owner.meEventsLog(undefined, { signal: ac.signal })).rejects.toThrow();
  });

  it('message.received reaches the sender when a recipient streams at send time', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'recv-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;

    // The agent (sender) watches for receipts; the owner (recipient) holds an
    // open stream, so the message is marked received at send and the sender is
    // notified.
    const senderEvents: SparrowEvent[] = [];
    const senderStream = agent.events(roomId, (e) => senderEvents.push(e));
    const recipientStream = owner.events(roomId, () => {});
    await sleep(150);

    const ownerMember = await owner.whoami(roomId);
    await agent.sendMessage(roomId, { to: ownerMember.id, body: 'live receipt' });
    for (let i = 0; i < 60 && !senderEvents.some((e) => e.type === 'message.received'); i++) {
      await sleep(25);
    }
    senderStream.close();
    recipientStream.close();
    await Promise.all([senderStream.closed, recipientStream.closed]);

    const recv = senderEvents.find((e) => e.type === 'message.received');
    expect(recv).toBeTruthy();
    const data = recv!.data as MessageReceivedEvent;
    expect(data.by.displayName).toBe('Owner');
    expect(data.receivedAt).toBeTruthy();
  });

  it('getMessageStatus surfaces received (via inbox) then read (via pop), preserving receivedAt', async () => {
    const { client: agent, agent: agentRow } = await makeAgent(h, owner, orgId, 'status-bot');
    const dm = await owner.ensureDm({ principal: agentRow.id });
    const roomId = dm.room.id;
    const ownerMember = await owner.whoami(roomId);
    const sent = await agent.sendMessage(roomId, { to: ownerMember.id, body: 'track me' });

    // Recipient has not seen it yet: unread, no receivedAt.
    let st = await agent.getMessageStatus(roomId, sent.message.id);
    expect(st.recipients[0]!.status).toBe('unread');
    expect(st.recipients[0]!.receivedAt).toBeNull();

    // Listing the inbox is server-observed delivery → received (not read).
    await owner.listInbox(roomId);
    st = await agent.getMessageStatus(roomId, sent.message.id);
    expect(st.recipients[0]!.status).toBe('received');
    expect(st.recipients[0]!.receivedAt).not.toBeNull();
    expect(st.recipients[0]!.readAt).toBeNull();
    const receivedAt = st.recipients[0]!.receivedAt;

    // Popping reads it; receivedAt is preserved.
    await owner.popNextMessage(roomId);
    st = await agent.getMessageStatus(roomId, sent.message.id);
    expect(st.recipients[0]!.status).toBe('read');
    expect(st.recipients[0]!.receivedAt).toBe(receivedAt);
    expect(st.recipients[0]!.readAt).not.toBeNull();
  });
});

/* ================================================================== *
 * Admin, config & misc
 * ================================================================== */

describe('admin, config & misc', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
  });
  afterAll(() => h.close());

  it('healthz needs no auth', async () => {
    const c = new SparrowClient({ server: h.url });
    const hz = await c.healthz();
    expect(hz.ok).toBe(true);
    expect(typeof hz.version).toBe('string');
  });

  it('config read/write requires the admin token', async () => {
    const admin = new SparrowClient({ server: h.url, adminToken: h.adminToken });
    const before = await admin.getConfig();
    expect(before.entries.some((e) => e.descriptor.key === 'auth.allowSignup')).toBe(true);
    const after = await admin.putConfig({ 'auth.allowSignup': false });
    const entry = after.entries.find((e) => e.descriptor.key === 'auth.allowSignup')!;
    expect(entry.value).toBe(false);
    // Wrong/absent admin token → 401.
    const noAdmin = new SparrowClient({ server: h.url });
    await expect(noAdmin.getConfig()).rejects.toMatchObject({ status: 401 });
  });

  it('admin org/room/agent/human surfaces', async () => {
    const room = await owner.createRoom(orgId, { name: 'admin-room' });
    const { agent } = await makeAgent(h, owner, orgId, 'admin-bot');
    const admin = new SparrowClient({ server: h.url, adminToken: h.adminToken });

    expect((await admin.adminListOrgs()).some((o) => o.id === orgId)).toBe(true);
    const rooms = await admin.adminListRooms({ org: orgId });
    expect(rooms.some((r) => r.id === room.id)).toBe(true);
    expect(await admin.adminDeleteAgent(agent.id)).toEqual({ ok: true });
    expect(await admin.adminDeleteRoom(room.id)).toEqual({ ok: true });

    // Delete an org (with a member human) end-to-end.
    const scratch = await startServer();
    try {
      const so = new SparrowClient({ server: scratch.url });
      await so.signup({ email: email('scratch'), password: 'password123', displayName: 'S' });
      const sOrg = await firstOrgId(so);
      const sAdmin = new SparrowClient({ server: scratch.url, adminToken: scratch.adminToken });
      expect(await sAdmin.adminDeleteOrg(sOrg)).toEqual({ ok: true });
      expect((await sAdmin.adminListOrgs()).some((o) => o.id === sOrg)).toBe(false);
    } finally {
      await scratch.close();
    }
  });
});

/* ================================================================== *
 * Voice (STT & TTS) — fake provider registered
 * ================================================================== */

describe('voice (STT & TTS)', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  let agent: { client: SparrowClient; agent: { id: string; name: string } };
  let dmRoomId: string;
  beforeAll(async () => {
    h = await startServer({ voiceProvider: 'fake' });
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
    agent = await makeAgent(h, owner, orgId, 'voice-bot');
    dmRoomId = (await owner.ensureDm({ principal: agent.agent.id })).room.id;
  });
  afterAll(() => h.close());

  it('capabilities report the fake provider (no auth required)', async () => {
    const anon = new SparrowClient({ server: h.url });
    const caps = await anon.getCapabilities();
    expect(caps.voice.stt).toBe(true);
    expect(caps.voice.tts).toBe(true);
  });

  it('transcribe returns the deterministic transcript', async () => {
    const res = await owner.transcribe({
      audioBase64: Buffer.from('audio').toString('base64'),
      contentType: 'audio/webm',
    });
    expect(res.text).toBe('fake transcript');
  });

  it('speech bytes are non-empty audio/mpeg, identical across two fetches', async () => {
    const ownerMember = await owner.whoami(dmRoomId);
    const sent = await agent.client.sendMessage(dmRoomId, {
      to: ownerMember.id,
      subject: 'hi',
      body: 'speak me',
    });
    const first = await owner.getMessageSpeech(dmRoomId, sent.message.id);
    expect(first.contentType).toBe('audio/mpeg');
    expect(first.bytes.length).toBeGreaterThan(0);
    const second = await owner.getMessageSpeech(dmRoomId, sent.message.id);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
  });

  it('sendMessage threads origin: voice → echoed, omitted → null', async () => {
    const ownerMember = await owner.whoami(dmRoomId);
    const dictated = await agent.client.sendMessage(dmRoomId, {
      to: ownerMember.id,
      body: 'dictated aloud',
      origin: 'voice',
    });
    expect(dictated.message.origin).toBe('voice');
    const typed = await agent.client.sendMessage(dmRoomId, {
      to: ownerMember.id,
      body: 'typed by hand',
    });
    expect(typed.message.origin).toBeNull();
  });
});

/* ================================================================== *
 * Voice — no provider registered (keyless dev stack)
 * ================================================================== */

describe('voice (no provider registered)', () => {
  let h: Harness;
  let owner: SparrowClient;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
  });
  afterAll(() => h.close());

  it('capabilities report voice off', async () => {
    const caps = await owner.getCapabilities();
    expect(caps.voice.stt).toBe(false);
    expect(caps.voice.tts).toBe(false);
  });

  it('transcribe → ApiError 404 when keyless', async () => {
    const req = {
      audioBase64: Buffer.from('x').toString('base64'),
      contentType: 'audio/webm',
    };
    await expect(owner.transcribe(req)).rejects.toBeInstanceOf(ApiError);
    await expect(owner.transcribe(req)).rejects.toMatchObject({ status: 404 });
  });
});

/* ================================================================== *
 * Unified attention (layer 3) — the work queue + the activity timeline
 * ================================================================== */

describe('unified attention (layer 3)', () => {
  let h: Harness;
  let owner: SparrowClient;
  let orgId: string;
  let bot: { client: SparrowClient; agent: { id: string; name: string } };
  let dmRoomId: string;
  beforeAll(async () => {
    h = await startServer();
    owner = await signUp(h, 'Owner');
    orgId = await firstOrgId(owner);
    bot = await makeAgent(h, owner, orgId, 'attention-bot');
    dmRoomId = (await owner.ensureDm({ principal: bot.agent.id })).room.id;
  });
  afterAll(() => h.close());

  it('meInboxPop returns a typed chat.message work item; empty queue → item null', async () => {
    const ownerMember = await owner.whoami(dmRoomId);
    await bot.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'work please' });

    const popped = await owner.meInboxPop();
    expect(popped.item).not.toBeNull();
    if (popped.item?.type !== 'chat.message') throw new Error('expected a chat work item');
    expect(popped.item.message.body).toBe('work please');
    expect(popped.item.room.id).toBe(dmRoomId);
    expect(popped.item.room.kind).toBe('dm');
    // A popped item is never returned again; an empty queue is `null`, not a 404.
    expect((await owner.meInboxPop()).item).toBeNull();
  });

  it('meInbox is a discriminated union across mediums and honors ?medium=', async () => {
    const ownerMember = await owner.whoami(dmRoomId);
    await bot.client.sendMessage(dmRoomId, { to: ownerMember.id, subject: 'subj', body: 'preview me' });

    const inbox = await owner.meInbox();
    const entry = inbox.items.find((i) => i.type === 'chat.message');
    if (entry?.type !== 'chat.message') throw new Error('expected a chat inbox entry');
    expect(entry.room.id).toBe(dmRoomId);
    expect(entry.preview).toContain('preview me');

    // The chat medium narrows to the same items; the email medium has none in v4.
    expect((await owner.meInbox({ medium: 'chat' })).items.length).toBe(inbox.items.length);
    expect((await owner.meInbox({ medium: 'email' })).items).toHaveLength(0);
    await expect(owner.meInbox({ medium: 'nope' as 'chat' })).rejects.toMatchObject({ status: 400 });
    await owner.meInboxPop(); // drain what this test seeded
  });

  it('an unknown work-item type passes through as unknownItem — never an error', async () => {
    // The forward-compat rule: a v4 client that meets a v5 medium leaves the item
    // for a newer client instead of throwing. Driven through a stub fetch, since a
    // real server can only produce the types this version knows.
    const stub = new SparrowClient({
      server: 'http://stub.invalid',
      token: 'agk_stub',
      fetch: async () =>
        new Response(
          JSON.stringify({ item: { type: 'fax', fax: { id: 'fax_1' }, line: { id: 'lin_1' } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const res = await stub.meInboxPop();
    expect(res.item).toBeNull();
    expect(res.unknownItem?.type).toBe('fax');
  });

  it('meActivity: the owner sees entries on agents they own; the agent sees its own', async () => {
    const ownerMember = await owner.whoami(dmRoomId);
    const sent = await bot.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'journal me' });

    const mine = await owner.meActivity();
    const entry = mine.items.find((e) => e.refs.messageId === sent.message.id);
    expect(entry).toBeDefined();
    expect(entry!.medium).toBe('chat');
    expect(entry!.type).toBe('chat.message');
    expect(entry!.agent?.id).toBe(bot.agent.id);
    expect(entry!.actor.displayName).toBe(bot.agent.name);
    expect(entry!.refs.roomId).toBe(dmRoomId);
    expect(mine.nextBefore === null || typeof mine.nextBefore === 'string').toBe(true);
    // A transcript reads backward from now: the wire itself descends. The send
    // may also have journaled a `hint.delivered` (medium `system`) on top, so
    // "newest" is asserted within the chat medium.
    const times = mine.items.map((e) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(mine.items.find((e) => e.medium === 'chat')!.refs.messageId).toBe(sent.message.id);

    // The agent's own timeline carries the same entry.
    const theirs = await bot.client.meActivity({ org: orgId });
    expect(theirs.items.some((e) => e.refs.messageId === sent.message.id)).toBe(true);

    // Filters: `?medium=` narrows; an unknown value is a bad_request.
    expect((await owner.meActivity({ medium: 'chat', limit: 1 })).items).toHaveLength(1);
    expect((await owner.meActivity({ medium: 'email' })).items).toHaveLength(0);
    await expect(owner.meActivity({ medium: 'fax' as 'chat' })).rejects.toMatchObject({ status: 400 });
  });

  it('agentActivity: the owner may read one agent timeline; an outsider gets 404', async () => {
    // Two entries at minimum, so the backward walk below has somewhere to go.
    const ownerMember = await owner.whoami(dmRoomId);
    await bot.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'older' });
    await bot.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'newer' });

    const res = await owner.agentActivity(orgId, bot.agent.id, { limit: 100 });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((e) => e.agent?.id === bot.agent.id)).toBe(true);

    // Newest-first, walked backward: one row at a time, `nextBefore` is the
    // oldest id returned, and an unknown `before` is a bad_request.
    const head = await owner.agentActivity(orgId, bot.agent.id, { limit: 1 });
    expect(head.items[0]!.id).toBe(res.items[0]!.id);
    expect(head.nextBefore).toBe(head.items[0]!.id);
    const next = await owner.agentActivity(orgId, bot.agent.id, { limit: 1, before: head.nextBefore! });
    expect(next.items[0]!.id).toBe(res.items[1]!.id);
    await expect(
      owner.agentActivity(orgId, bot.agent.id, { before: 'act_nope' }),
    ).rejects.toMatchObject({ status: 400 });

    // A colleague who merely shares the org is not admitted (correspondence, not
    // room data) — and existence never leaks, so it is a 404.
    const { client: peer } = await joinHuman(h, owner, orgId, 'Peer');
    await expect(peer.agentActivity(orgId, bot.agent.id)).rejects.toMatchObject({ status: 404 });
  });

  it('activity entries of an unrecognized type or medium are ignored, never thrown', async () => {
    const stub = new SparrowClient({
      server: 'http://stub.invalid',
      token: 'ses_stub',
      fetch: async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'act_1',
                orgId: 'org_1',
                medium: 'chat',
                type: 'chat.message',
                agent: { id: 'agt_1', name: 'bot' },
                actor: { kind: 'agent', id: 'agt_1', displayName: 'bot' },
                summary: 'kept',
                refs: { roomId: 'room_1', messageId: 'msg_1' },
                createdAt: '2026-08-31T17:00:00.000Z',
              },
              { id: 'act_2', orgId: 'org_1', medium: 'fax', type: 'fax.received', agent: null,
                actor: { kind: 'system', id: null, displayName: 'sparrow' }, summary: 'dropped',
                refs: {}, createdAt: '2026-08-31T17:00:01.000Z' },
            ],
            nextBefore: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const res = await stub.meActivity();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.summary).toBe('kept');
  });

  it('/me/events delivers activity.appended (unwrapped) to the agent owner', async () => {
    const ownerMember = await owner.whoami(dmRoomId);
    const seen: PrincipalEvent[] = [];
    const stream = owner.meEvents((e) => seen.push(e));
    await sleep(150);
    await bot.client.sendMessage(dmRoomId, { to: ownerMember.id, body: 'streamed entry' });
    for (let i = 0; i < 60 && !seen.some((e) => e.type === 'activity.appended'); i++) await sleep(25);
    stream.close();
    await stream.closed;

    const appended = seen.find((e) => e.type === 'activity.appended');
    expect(appended).toBeDefined();
    // Principal-level events are UNWRAPPED — no `room` envelope.
    expect(appended!.room).toBeUndefined();
    const data = appended!.data as { entry: { type: string; medium: string; agent: { id: string } | null } };
    expect(data.entry.type).toBe('chat.message');
    expect(data.entry.medium).toBe('chat');
    expect(data.entry.agent?.id).toBe(bot.agent.id);
  });
});
