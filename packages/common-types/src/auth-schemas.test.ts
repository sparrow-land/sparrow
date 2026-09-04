import { describe, it, expect } from 'vitest';
import {
  UserSchema,
  ThemePreferenceSchema,
  AuthProviderInfoSchema,
  AuthConfigResponseSchema,
  AuthMeResponseSchema,
  SignupRequestSchema,
  LoginRequestSchema,
  AuthSessionResponseSchema,
  MePrincipalSchema,
  MePresenceSchema,
  MeResponseSchema,
  UpdateMeRequestSchema,
  UpdateMeAgentRequestSchema,
  OrgRoleSchema,
  OrgSettingsSchema,
  OrgSummarySchema,
  OrgSchema,
  GetOrgResponseSchema,
  CreateOrgRequestSchema,
  CreateOrgResponseSchema,
  UpdateOrgRequestSchema,
  OrgNameSchema,
  OrgSlugSchema,
  MeOrgSchema,
  MeOrgsResponseSchema,
  OrgMembershipSchema,
  ListOrgHumansResponseSchema,
  SetOrgRoleRequestSchema,
  AddOrgMemberRequestSchema,
  AddOrgMemberResponseSchema,
  DirectoryResponseSchema,
  OrgAgentGovernanceSchema,
  ListOrgAgentsResponseSchema,
  SidebarHumanSchema,
  OrgMeHumansResponseSchema,
  InviteSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  ListInvitesResponseSchema,
  InviteInfoResponseSchema,
  EnrollmentKindSchema,
  EnrollmentStatusSchema,
  EnrollAgentRequestSchema,
  EnrollHumanRequestSchema,
  AgentSchema,
  EnrollAgentPendingResponseSchema,
  EnrollAgentAdmittedResponseSchema,
  EnrollHumanAdmittedResponseSchema,
  EnrollHumanPendingResponseSchema,
  PollApprovedAgentResponseSchema,
  PollEnrollmentResponseSchema,
  EnrollmentSummarySchema,
  ListEnrollmentsResponseSchema,
  ApproveEnrollmentRequestSchema,
  CreateAgentRequestSchema,
  CreateAgentResponseSchema,
  VisibilityAgentSchema,
  ListAgentsResponseSchema,
  ListAgentsQuerySchema,
  ShareAgentRequestSchema,
  UpdateAgentRequestSchema,
  UpdateAgentResponseSchema,
  InviteHumanRequestSchema,
  RoomInvitationAdminSchema,
  InviteHumanResponseSchema,
  ListRoomInvitationsResponseSchema,
  RoomInvitationSchema,
  ListMeRoomInvitationsResponseSchema,
  AcceptRoomInvitationResponseSchema,
  EnrollmentRequestedEventSchema,
  EnrollmentResolvedEventSchema,
  RoomInvitationEventSchema,
  AgentSharedEventSchema,
  RoleUpdatedEventSchema,
  RoleTitleSchema,
  RoleInstructionsSchema,
  AdminOrgSchema,
  ListAdminOrgsResponseSchema,
  AdminRoomSchema,
  ListAdminRoomsResponseSchema,
  ConfigDescriptorSchema,
  ConfigEntrySchema,
  GetConfigResponseSchema,
  PutConfigRequestSchema,
} from './schemas.js';

const user = { id: 'usr_dK3fA9qL2mNp', email: 'a@acme.com', displayName: 'Ada', provider: 'password', theme: 'auto' as const };
const inviter = { id: 'usr_dK3fA9qL2mNp', displayName: 'Ada' };
const agent = {
  id: 'agt_pQ9rT2vX5mLk', name: 'deploy-bot', orgId: 'org_V1StGXR8z5jd',
  emailAddress: 'deploy-bot@acme.example.com',
  online: false, lastSeenAt: null, createdAt: '2026-08-20T00:00:00Z',
};

describe('accounts & sessions', () => {
  it('UserSchema has no role (roles are per-org now)', () => {
    expect(UserSchema.parse(user)).toEqual(user);
    expect('role' in UserSchema.parse({ ...user, role: 'admin' })).toBe(false);
  });
  it('AuthConfigResponseSchema is providers + allowSignup (no roomsRequireAccount)', () => {
    const v = { providers: [{ id: 'password', label: 'Password', kind: 'credentials' as const }], allowSignup: true };
    expect(AuthConfigResponseSchema.parse(v)).toEqual(v);
  });
  it('AuthProviderInfoSchema allows optional loginUrl', () => {
    expect(AuthProviderInfoSchema.parse({ id: 'google', label: 'Google', kind: 'oauth-redirect', loginUrl: 'https://x' }).loginUrl)
      .toBe('https://x');
    expect(AuthProviderInfoSchema.safeParse({ id: 'x', label: 'X', kind: 'magic' }).success).toBe(false);
  });
  it('AuthMeResponseSchema wraps a user, or null for an anonymous caller', () => {
    expect(AuthMeResponseSchema.parse({ user })).toEqual({ user });
    // #53: a caller with no credential is answered `200 { user: null }` — being
    // signed out is the ANSWER, not an error, so the shape has to carry it.
    expect(AuthMeResponseSchema.parse({ user: null })).toEqual({ user: null });
    // `user` is still required: an omitted key is a malformed response.
    expect(AuthMeResponseSchema.safeParse({}).success).toBe(false);
  });
  it('Signup / Login request validation', () => {
    expect(SignupRequestSchema.parse({ email: 'a@acme.com', password: 'longenough', displayName: 'Ada' }).displayName).toBe('Ada');
    expect(SignupRequestSchema.safeParse({ email: 'a@acme.com', password: 'short' }).success).toBe(false);
    expect(SignupRequestSchema.safeParse({ email: 'nope', password: 'longenough' }).success).toBe(false);
    expect(LoginRequestSchema.parse({ email: 'a@acme.com', password: 'x' }).email).toBe('a@acme.com');
    expect(LoginRequestSchema.safeParse({ email: 'a@acme.com' }).success).toBe(false);
  });
  it('AuthSessionResponseSchema returns user + ses_ token', () => {
    expect(AuthSessionResponseSchema.parse({ user, token: 'ses_' + 'a'.repeat(32) }).token).toMatch(/^ses_/);
    expect(AuthSessionResponseSchema.safeParse({ user }).success).toBe(false);
  });
  it('GET /me principal union (human | agent)', () => {
    const human = MePrincipalSchema.parse({ type: 'human', id: 'usr_a', email: 'a@b.com', displayName: 'Ada' });
    expect(human.type).toBe('human');
    const ag = MePrincipalSchema.parse({ type: 'agent', id: 'agt_a', name: 'deploy-bot', orgId: 'org_a', owner: inviter });
    expect(ag.type === 'agent' && ag.owner.displayName).toBe('Ada');
    expect(MePrincipalSchema.safeParse({ type: 'guest', id: 'x' }).success).toBe(false);
    expect(MeResponseSchema.parse({ principal: human }).principal.type).toBe('human');
  });
  it('the agent principal carries its derived emailAddress (null with the medium off)', () => {
    const withAddr = MePrincipalSchema.parse({
      type: 'agent', id: 'agt_a', name: 'fable', orgId: 'org_a',
      emailAddress: 'fable@acme.example.com', owner: inviter,
    });
    expect(withAddr.type === 'agent' && withAddr.emailAddress).toBe('fable@acme.example.com');
    const off = MePrincipalSchema.parse({ type: 'agent', id: 'agt_a', name: 'fable', orgId: 'org_a', owner: inviter });
    expect(off.type === 'agent' && off.emailAddress).toBeNull();
  });
  it('the principal carries a self-presence block (both kinds, defaulted for old servers)', () => {
    // Additive: a server that predates self-presence sends no `presence`, and
    // the client must still parse — reading as plainly offline.
    const legacyHuman = MePrincipalSchema.parse({ type: 'human', id: 'usr_a', email: 'a@b.com', displayName: 'Ada' });
    expect(legacyHuman.presence).toEqual({ online: false, via: null, onlineUntil: null });
    const legacyAgent = MePrincipalSchema.parse({ type: 'agent', id: 'agt_a', name: 'fable', orgId: 'org_a', owner: inviter });
    expect(legacyAgent.presence).toEqual({ online: false, via: null, onlineUntil: null });

    // Held by a stream: no expiry to report.
    const streamed = MePrincipalSchema.parse({
      type: 'agent', id: 'agt_a', name: 'fable', orgId: 'org_a', owner: inviter,
      presence: { online: true, via: 'stream', onlineUntil: null },
    });
    expect(streamed.presence).toEqual({ online: true, via: 'stream', onlineUntil: null });

    // Held by a heartbeat mark: the mark's expiry rides along.
    const marked = MePresenceSchema.parse({ online: true, via: 'mark', onlineUntil: '2026-09-03T00:00:00Z' });
    expect(marked.via).toBe('mark');
    expect(marked.onlineUntil).toBe('2026-09-03T00:00:00Z');

    // `via` is only ever 'stream' | 'mark' | null.
    expect(MePresenceSchema.safeParse({ online: true, via: 'socket', onlineUntil: null }).success).toBe(false);
    expect(MePresenceSchema.safeParse({ online: false, via: null, onlineUntil: null }).success).toBe(true);
  });
  it('UpdateMeRequestSchema (PATCH /me): displayName trimmed, 1–80', () => {
    expect(UpdateMeRequestSchema.parse({ displayName: '  Ada  ' }).displayName).toBe('Ada');
    expect(UpdateMeRequestSchema.safeParse({ displayName: '   ' }).success).toBe(false);
    expect(UpdateMeRequestSchema.safeParse({ displayName: 'x'.repeat(81) }).success).toBe(false);
    expect(UpdateMeRequestSchema.parse({ displayName: 'x'.repeat(80) }).displayName).toHaveLength(80);
    expect(UpdateMeRequestSchema.safeParse({}).success).toBe(false);
    // response reuses MeResponse { principal }.
    expect(MeResponseSchema.parse({ principal: { type: 'human', id: 'usr_a', email: 'a@b.com', displayName: 'Ada' } }).principal.type)
      .toBe('human');
  });
  it('UpdateMeAgentRequestSchema (PATCH /me, agent): name trimmed, 1–60, required', () => {
    expect(UpdateMeAgentRequestSchema.parse({ name: '  deploy-bot  ' }).name).toBe('deploy-bot');
    expect(UpdateMeAgentRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(UpdateMeAgentRequestSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
    expect(UpdateMeAgentRequestSchema.parse({ name: 'x'.repeat(60) }).name).toHaveLength(60);
    expect(UpdateMeAgentRequestSchema.safeParse({}).success).toBe(false);
  });
  it('ThemePreferenceSchema is auto|dark|light', () => {
    for (const t of ['auto', 'dark', 'light'] as const) {
      expect(ThemePreferenceSchema.parse(t)).toBe(t);
    }
    expect(ThemePreferenceSchema.safeParse('system').success).toBe(false);
  });
  it('UserSchema.theme defaults to auto and round-trips an explicit value', () => {
    const { theme, ...noTheme } = user;
    expect(UserSchema.parse(noTheme).theme).toBe('auto');
    expect(UserSchema.parse({ ...noTheme, theme: 'dark' }).theme).toBe('dark');
    expect(UserSchema.safeParse({ ...noTheme, theme: 'nope' }).success).toBe(false);
  });
  it('MePrincipal human carries theme (defaults to auto)', () => {
    const human = MePrincipalSchema.parse({ type: 'human', id: 'usr_a', email: 'a@b.com', displayName: 'Ada' });
    expect(human.type === 'human' && human.theme).toBe('auto');
    const dark = MePrincipalSchema.parse({ type: 'human', id: 'usr_a', email: 'a@b.com', displayName: 'Ada', theme: 'dark' });
    expect(dark.type === 'human' && dark.theme).toBe('dark');
  });
  it('UpdateMeRequestSchema accepts a theme-only update and validates the enum', () => {
    expect(UpdateMeRequestSchema.parse({ theme: 'light' }).theme).toBe('light');
    expect(UpdateMeRequestSchema.parse({ displayName: 'Ada', theme: 'dark' })).toEqual({ displayName: 'Ada', theme: 'dark' });
    expect(UpdateMeRequestSchema.safeParse({ theme: 'system' }).success).toBe(false);
  });
});

describe('orgs', () => {
  it('OrgRoleSchema is owner|admin|member', () => {
    for (const r of ['owner', 'admin', 'member']) expect(OrgRoleSchema.parse(r)).toBe(r);
    expect(OrgRoleSchema.safeParse('root').success).toBe(false);
  });
  it('OrgSettingsSchema merges nested defaults and rejects unknown keys', () => {
    expect(OrgSettingsSchema.parse({})).toEqual({
      invites: { who: 'members' },
      enroll: { agents: 'approval' },
      rooms: { create: 'members' },
      email: {
        inboundUnrecognized: 'reject',
        outboundUnrecognized: 'reject',
        trustedPatterns: [],
        judgePrompt: null,
      },
    });
    // partial nested objects fill their own defaults.
    expect(OrgSettingsSchema.parse({ enroll: { agents: 'open' } }).enroll).toEqual({
      agents: 'open',
    });
    expect(OrgSettingsSchema.parse({ invites: { who: 'admins' }, rooms: { create: 'admins' } }).rooms.create).toBe('admins');
    // unknown keys at any level → reject (write path is strict).
    expect(OrgSettingsSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(OrgSettingsSchema.safeParse({ enroll: { nope: 1 } }).success).toBe(false);
    expect(OrgSettingsSchema.safeParse({ invites: { who: 'everyone' } }).success).toBe(false);
    expect(OrgSettingsSchema.safeParse({ enroll: { agents: 'auto-email' } }).success).toBe(false);
    // The retired human-admission knobs are no longer accepted on the write path.
    expect(OrgSettingsSchema.safeParse({ enroll: { agents: 'open', humans: 'approval' } }).success).toBe(false);
    expect(OrgSettingsSchema.safeParse({ enroll: { autoApproveEmailPatterns: ['*@acme.com'] } }).success).toBe(false);
  });
  it('OrgName / OrgSlug validators', () => {
    expect(OrgNameSchema.parse('  Acme  ')).toBe('Acme');
    expect(OrgNameSchema.safeParse('x'.repeat(81)).success).toBe(false);
    expect(OrgSlugSchema.parse('acme-hq')).toBe('acme-hq');
    expect(OrgSlugSchema.safeParse('Acme_HQ').success).toBe(false);
    expect(OrgSlugSchema.safeParse('x'.repeat(41)).success).toBe(false);
  });
  it('Org resource + GetOrg wrap', () => {
    const org = { id: 'org_a', name: 'Acme', slug: 'acme', settings: {}, createdAt: '2026-08-20T00:00:00Z' };
    expect(OrgSchema.parse(org).settings.invites.who).toBe('members');
    expect(GetOrgResponseSchema.parse({ org }).org.slug).toBe('acme');
  });
  it('CreateOrg request/response', () => {
    expect(CreateOrgRequestSchema.parse({ name: 'Acme' }).slug).toBeUndefined();
    expect(CreateOrgRequestSchema.parse({ name: 'Acme', slug: 'acme' }).slug).toBe('acme');
    // CreateOrg returns the full GetOrg shape (settings merged, createdAt).
    const created = CreateOrgResponseSchema.parse({
      org: { id: 'org_a', name: 'Acme', slug: 'acme', settings: {}, createdAt: '2026-08-20T00:00:00Z' },
    });
    expect(created.org.id).toBe('org_a');
    expect(created.org.settings.invites.who).toBe('members');
    // a bare summary (no settings/createdAt) is now rejected.
    expect(CreateOrgResponseSchema.safeParse({ org: { id: 'org_a', name: 'Acme', slug: 'acme' } }).success).toBe(false);
  });
  it('UpdateOrg requires at least one key', () => {
    expect(UpdateOrgRequestSchema.parse({ name: 'Acme' }).name).toBe('Acme');
    expect(UpdateOrgRequestSchema.safeParse({ settings: {} }).success).toBe(true);
    expect(UpdateOrgRequestSchema.safeParse({}).success).toBe(false);
  });
  it('UpdateOrg is strict at the ROOT too — a misspelled key is not a silent no-op', () => {
    // `settings` was strict inside while the root swallowed anything, so
    // `{"nme":…}` / `{"setings":…}` returned 200 and changed nothing.
    const typo = UpdateOrgRequestSchema.safeParse({ nme: 'Typo' });
    expect(typo.success).toBe(false);
    expect(JSON.stringify(typo.error?.issues)).toContain('nme');
    expect(
      UpdateOrgRequestSchema.safeParse({ name: 'Acme', setings: { rooms: {} } }).success,
    ).toBe(false);
    // …and the "at least one field" refinement still fires on an empty body.
    const empty = UpdateOrgRequestSchema.safeParse({});
    expect(empty.success).toBe(false);
    expect(JSON.stringify(empty.error?.issues)).toContain('At least one field');
  });
  it('/me/orgs items', () => {
    const summary = { id: 'org_a', name: 'Acme', slug: 'acme' };
    expect(MeOrgSchema.parse({ org: summary, role: 'owner' }).role).toBe('owner');
    expect(MeOrgsResponseSchema.parse({ items: [{ org: summary, role: 'member' }] }).items).toHaveLength(1);
    void OrgSummarySchema;
  });
  it('org humans roster (paged) + role change', () => {
    const row = { human: { id: 'usr_a', displayName: 'Ada', email: 'a@b.com', avatarUrl: null }, role: 'admin', joinedAt: '2026-08-20T00:00:00Z' };
    expect(OrgMembershipSchema.parse(row).role).toBe('admin');
    expect(ListOrgHumansResponseSchema.parse({ items: [row], nextCursor: null }).items).toHaveLength(1);
    expect(SetOrgRoleRequestSchema.parse({ role: 'member' }).role).toBe('member');
    expect(SetOrgRoleRequestSchema.safeParse({ role: 'root' }).success).toBe(false);
  });
  it('add-member request: email required + normalized, role optional (non-owner only)', () => {
    expect(AddOrgMemberRequestSchema.parse({ email: '  Ada@B.com  ' }).email).toBe('Ada@B.com');
    expect(AddOrgMemberRequestSchema.parse({ email: 'a@b.com' }).role).toBeUndefined();
    expect(AddOrgMemberRequestSchema.parse({ email: 'a@b.com', role: 'admin' }).role).toBe('admin');
    expect(AddOrgMemberRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(AddOrgMemberRequestSchema.safeParse({}).success).toBe(false);
    // Ownership transfers go through role management, never direct add.
    expect(AddOrgMemberRequestSchema.safeParse({ email: 'a@b.com', role: 'owner' }).success).toBe(false);
  });
  it('add-member response wraps the added member + carries the fused invite (url + emailSent)', () => {
    const member = { human: { id: 'usr_a', displayName: 'Ada', email: 'a@b.com', avatarUrl: null }, role: 'member' };
    const full = { member, inviteUrl: 'https://h/invite/ivk_x', emailSent: true };
    expect(AddOrgMemberResponseSchema.parse(full).member.role).toBe('member');
    expect(AddOrgMemberResponseSchema.parse(full).inviteUrl).toContain('/invite/');
    expect(AddOrgMemberResponseSchema.parse(full).emailSent).toBe(true);
    // inviteUrl + emailSent are required (the server always returns them).
    expect(AddOrgMemberResponseSchema.safeParse({ member }).success).toBe(false);
    expect(
      AddOrgMemberResponseSchema.safeParse({ member: { human: { id: 'x' }, role: 'member' }, inviteUrl: 'u', emailSent: false }).success,
    ).toBe(false);
  });
  it('directory returns human contacts', () => {
    expect(DirectoryResponseSchema.parse({ items: [{ id: 'usr_a', displayName: 'Ada', email: 'a@b.com', avatarUrl: null }] }).items[0]!.email)
      .toBe('a@b.com');
  });
  it('governance agent list is agent + owner (no visibility fields)', () => {
    const row = {
      agent: { id: 'agt_a', name: 'deploy-bot', emailAddress: 'deploy-bot@acme.example.com', createdAt: '2026-08-20T00:00:00Z' },
      owner: inviter,
    };
    expect(OrgAgentGovernanceSchema.parse(row).owner.displayName).toBe('Ada');
    expect(OrgAgentGovernanceSchema.parse(row).agent.emailAddress).toBe('deploy-bot@acme.example.com');
    // null with the email medium off
    expect(OrgAgentGovernanceSchema.parse({ ...row, agent: { ...row.agent, emailAddress: null } }).agent.emailAddress)
      .toBeNull();
    expect(ListOrgAgentsResponseSchema.parse({ items: [row] }).items).toHaveLength(1);
  });
  it('sidebar HUMANS source (GET /orgs/:orgId/me/humans)', () => {
    const row = { human: { id: 'usr_a', displayName: 'Ada', avatarUrl: null }, online: true, lastSeenAt: null };
    expect(SidebarHumanSchema.parse(row).online).toBe(true);
    expect(SidebarHumanSchema.parse({ ...row, lastSeenAt: '2026-08-20T00:00:00Z' }).lastSeenAt).toBeTruthy();
    // human is a HumanRef ({ id, displayName }) + avatarUrl — no email on this list.
    expect(SidebarHumanSchema.safeParse({ human: { id: 'usr_a' }, online: true, lastSeenAt: null }).success).toBe(false);
    expect(OrgMeHumansResponseSchema.parse({ items: [row] }).items).toHaveLength(1);
  });
});

describe('invites', () => {
  const invite = {
    id: 'inv_a', inviter, note: 'join us', expiresAt: '2026-08-27T00:00:00Z',
    revokedAt: null, createdAt: '2026-08-20T00:00:00Z',
  };
  it('InviteSchema never carries a token; note/revokedAt nullable', () => {
    expect(InviteSchema.parse(invite).inviter.id).toBe('usr_dK3fA9qL2mNp');
    expect('token' in InviteSchema.parse(invite)).toBe(false);
    expect(InviteSchema.parse({ ...invite, note: null, revokedAt: '2026-08-21T00:00:00Z' }).revokedAt).toBeTruthy();
  });
  it('CreateInvite request bounds expiresInDays 1..30', () => {
    expect(CreateInviteRequestSchema.parse({}).note).toBeUndefined();
    expect(CreateInviteRequestSchema.parse({ note: 'hi', expiresInDays: 30 }).expiresInDays).toBe(30);
    expect(CreateInviteRequestSchema.safeParse({ expiresInDays: 0 }).success).toBe(false);
    expect(CreateInviteRequestSchema.safeParse({ expiresInDays: 31 }).success).toBe(false);
    expect(CreateInviteRequestSchema.safeParse({ note: 'x'.repeat(241) }).success).toBe(false);
  });
  it('CreateInvite response carries the url (token appears once); list wraps items', () => {
    expect(CreateInviteResponseSchema.parse({ invite, url: 'https://h/invite/ivk_x' }).url).toContain('/invite/');
    expect(ListInvitesResponseSchema.parse({ items: [invite] }).items).toHaveLength(1);
  });
  it('InviteInfo (GET /invite/:token/info) landing metadata', () => {
    const info = { org: { name: 'Acme' }, inviter: { displayName: 'Ada', email: 'ada@acme.com' }, agentPolicy: 'approval' };
    expect(InviteInfoResponseSchema.parse(info)).toEqual(info);
    expect(InviteInfoResponseSchema.parse({ ...info, agentPolicy: 'open' }).agentPolicy).toBe('open');
    expect(InviteInfoResponseSchema.safeParse({ ...info, agentPolicy: 'closed' }).success).toBe(false);
    // inviter email is deliberately exposed on the landing page; it is required.
    expect(InviteInfoResponseSchema.parse(info).inviter.email).toBe('ada@acme.com');
    expect(InviteInfoResponseSchema.safeParse({ ...info, inviter: { displayName: 'Ada' } }).success).toBe(false);
    // ids/slug still are NOT surfaced (stripped).
    expect('id' in InviteInfoResponseSchema.parse({ ...info, org: { name: 'Acme', id: 'org_a' } }).org).toBe(false);
    expect('id' in InviteInfoResponseSchema.parse({ ...info, inviter: { displayName: 'Ada', email: 'ada@acme.com', id: 'usr_a' } }).inviter).toBe(false);
  });
});

describe('enrollment', () => {
  it('kind + status enums', () => {
    expect(EnrollmentKindSchema.parse('agent')).toBe('agent');
    expect(EnrollmentStatusSchema.parse('denied')).toBe('denied');
    expect(EnrollmentStatusSchema.safeParse('expired').success).toBe(false);
  });
  it('enroll bodies: agent requires name, human note-only', () => {
    expect(EnrollAgentRequestSchema.parse({ name: '  deploy-bot ' }).name).toBe('deploy-bot');
    expect(EnrollAgentRequestSchema.safeParse({ note: 'hi' }).success).toBe(false);
    expect(EnrollAgentRequestSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
    expect(EnrollHumanRequestSchema.parse({ note: 'let me in' }).note).toBe('let me in');
    expect(EnrollHumanRequestSchema.parse({}).note).toBeUndefined();
  });
  it('agent enroll responses (pending token once / open mint with dm)', () => {
    expect(EnrollAgentPendingResponseSchema.parse({ enrollment: { id: 'enl_a', status: 'pending' }, enrollmentToken: 'enr_x' }).enrollmentToken)
      .toBe('enr_x');
    const admitted = EnrollAgentAdmittedResponseSchema.parse({
      agent, key: 'agk_x', org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm',
      emailAddress: 'deploy-bot@acme.example.com',
    });
    expect(admitted.key).toBe('agk_x');
    expect(admitted.dmRoomId).toBe('room_dm');
    // the instant mint delivers the address alongside the key; null with the medium off
    expect(admitted.emailAddress).toBe('deploy-bot@acme.example.com');
    expect(
      EnrollAgentAdmittedResponseSchema.parse({
        agent, key: 'agk_x', org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm',
      }).emailAddress,
    ).toBeNull();
  });
  it('human enroll responses (admitted { org, role } / pending)', () => {
    const org = { id: 'org_a', name: 'Acme', slug: 'acme' };
    expect(EnrollHumanAdmittedResponseSchema.parse({ org, role: 'member' }).role).toBe('member');
    expect(EnrollHumanPendingResponseSchema.parse({ enrollment: { id: 'enl_a', status: 'pending' } }).enrollment.status)
      .toBe('pending');
    // human pending never carries an enrollmentToken (session polls with its own credential).
    expect('enrollmentToken' in EnrollHumanPendingResponseSchema.parse({ enrollment: { id: 'enl_a', status: 'pending' } })).toBe(false);
  });
  it('PollEnrollmentResponseSchema unions pending/approved-agent/approved-human/denied', () => {
    expect(PollEnrollmentResponseSchema.parse({ status: 'pending', retryAfterSeconds: 5 }).status).toBe('pending');
    expect(PollEnrollmentResponseSchema.parse({ status: 'approved', agent, key: 'agk_x', org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm' }).status)
      .toBe('approved');
    expect(PollEnrollmentResponseSchema.parse({ status: 'approved', org: { id: 'org_a', name: 'Acme', slug: 'acme' }, role: 'member' }).status)
      .toBe('approved');
    expect(PollEnrollmentResponseSchema.parse({ status: 'denied' }).status).toBe('denied');
  });
  it('the approved-agent poll delivers emailAddress with the key (null with the medium off)', () => {
    const withAddr = PollApprovedAgentResponseSchema.parse({
      status: 'approved', agent, key: 'agk_x', org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm',
      emailAddress: 'deploy-bot@acme.example.com',
    });
    expect(withAddr.emailAddress).toBe('deploy-bot@acme.example.com');
    const off = PollApprovedAgentResponseSchema.parse({
      status: 'approved', agent, key: 'agk_x', org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm',
    });
    expect(off.emailAddress).toBeNull();
  });
  it('approved-agent key is optional — a re-poll returns the same shape WITHOUT the key', () => {
    const firstPoll = PollApprovedAgentResponseSchema.parse({ status: 'approved', agent, key: 'agk_x', org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm' });
    expect(firstPoll.key).toBe('agk_x');
    const rePoll = PollApprovedAgentResponseSchema.parse({ status: 'approved', agent, org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm' });
    expect(rePoll.key).toBeUndefined();
    // the union still resolves the keyless re-poll to the approved-agent variant.
    expect(PollEnrollmentResponseSchema.parse({ status: 'approved', agent, org: { id: 'org_a', name: 'Acme' }, dmRoomId: 'room_dm' }).status)
      .toBe('approved');
  });
  it('EnrollmentSummary carries kind-specific fields; approve body is empty (yes/no)', () => {
    const agentSummary = {
      id: 'enl_a', kind: 'agent', proposedName: 'deploy-bot', note: null, inviter, createdAt: '2026-08-20T00:00:00Z',
    };
    expect(EnrollmentSummarySchema.parse(agentSummary).proposedName).toBe('deploy-bot');
    const humanSummary = {
      id: 'enl_b', kind: 'human', proposedName: null, note: 'hi', email: 'a@b.com', displayName: 'Ada',
      inviter, createdAt: '2026-08-20T00:00:00Z',
    };
    expect(EnrollmentSummarySchema.parse(humanSummary).email).toBe('a@b.com');
    expect(ListEnrollmentsResponseSchema.parse({ items: [agentSummary, humanSummary] }).items).toHaveLength(2);
    // Approval is strictly yes/no: the body is empty and any stray name is stripped.
    expect(ApproveEnrollmentRequestSchema.parse({})).toEqual({});
    expect(ApproveEnrollmentRequestSchema.parse({ name: 'renamed' })).toEqual({});
  });
  it('enrollment events', () => {
    const summary = { id: 'enl_a', kind: 'agent', proposedName: 'deploy-bot', note: null, inviter, createdAt: '2026-08-20T00:00:00Z' };
    expect(EnrollmentRequestedEventSchema.parse({ enrollment: summary }).enrollment.id).toBe('enl_a');
    expect(EnrollmentResolvedEventSchema.parse({ enrollmentId: 'enl_a', status: 'approved' }).status).toBe('approved');
    expect(EnrollmentResolvedEventSchema.safeParse({ enrollmentId: 'enl_a', status: 'pending' }).success).toBe(false);
  });
});

describe('agents, visibility & sharing', () => {
  it('AgentSchema resource', () => {
    expect(AgentSchema.parse(agent).online).toBe(false);
    expect(AgentSchema.parse({ ...agent, lastSeenAt: '2026-08-20T00:00:00Z' }).lastSeenAt).toBeTruthy();
    expect(AgentSchema.safeParse({ ...agent, online: 'yes' }).success).toBe(false);
  });
  it('AgentSchema carries the derived emailAddress (public routing info, null when off)', () => {
    expect(AgentSchema.parse(agent).emailAddress).toBe('deploy-bot@acme.example.com');
    const { emailAddress: _drop, ...noAddr } = agent;
    expect(AgentSchema.parse(noAddr).emailAddress).toBeNull();
    expect(AgentSchema.parse({ ...agent, emailAddress: null }).emailAddress).toBeNull();
    expect(AgentSchema.safeParse({ ...agent, emailAddress: 42 }).success).toBe(false);
  });
  it('AgentSchema.sharing defaults to room-members; rejects unknown modes', () => {
    // Absent → default (older payloads predate the field).
    expect(AgentSchema.parse(agent).sharing).toBe('room-members');
    expect(AgentSchema.parse({ ...agent, sharing: 'selected' }).sharing).toBe('selected');
    expect(AgentSchema.parse({ ...agent, sharing: 'org' }).sharing).toBe('org');
    expect(AgentSchema.safeParse({ ...agent, sharing: 'everyone' }).success).toBe(false);
  });
  it('UpdateAgent request/response carry sharing and/or name (≥1)', () => {
    expect(UpdateAgentRequestSchema.parse({ sharing: 'org' }).sharing).toBe('org');
    expect(UpdateAgentRequestSchema.safeParse({ sharing: 'nope' }).success).toBe(false);
    // name-only is valid (owner rename); trimmed + length-bounded like AgentName.
    expect(UpdateAgentRequestSchema.parse({ name: '  deploy-bot ' }).name).toBe('deploy-bot');
    expect(UpdateAgentRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(UpdateAgentRequestSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
    // both together is fine; neither → 400 (at least one required).
    expect(UpdateAgentRequestSchema.parse({ sharing: 'org', name: 'bot' })).toEqual({ sharing: 'org', name: 'bot' });
    expect(UpdateAgentRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateAgentResponseSchema.parse({ agent }).agent.id).toBe(agent.id);
  });
  it('CreateAgent request/response (one-time key)', () => {
    expect(CreateAgentRequestSchema.parse({ orgId: 'org_a', name: '  deploy-bot ' }).name).toBe('deploy-bot');
    expect(CreateAgentRequestSchema.safeParse({ name: 'deploy-bot' }).success).toBe(false);
    expect(CreateAgentResponseSchema.parse({ agent, key: 'agk_x' }).key).toBe('agk_x');
  });
  it('VisibilityAgent: owned carries rooms[{id,name,memberId}] + sharedWith; shared omits both', () => {
    const owned = VisibilityAgentSchema.parse({
      agent, owner: inviter, sharedBy: null,
      rooms: [{ id: 'room_a', name: 'ops', memberId: 'mem_a' }],
      sharedWith: [{ id: 'usr_b', displayName: 'Bo', createdAt: '2026-08-20T00:00:00Z' }],
    });
    expect(owned.sharedBy).toBeNull();
    expect(owned.rooms?.[0]!.memberId).toBe('mem_a');
    expect(owned.sharedWith?.[0]!.displayName).toBe('Bo');
    // rooms entries now require memberId (detach via RemoveMember).
    expect(VisibilityAgentSchema.safeParse({ agent, owner: inviter, sharedBy: null, rooms: [{ id: 'room_a', name: 'ops' }] }).success)
      .toBe(false);
    const shared = VisibilityAgentSchema.parse({ agent, owner: inviter, sharedBy: { id: 'usr_b', displayName: 'Bo' } });
    expect(shared.sharedBy?.displayName).toBe('Bo');
    expect(shared.rooms).toBeUndefined();
    expect(shared.sharedWith).toBeUndefined();
    expect(ListAgentsResponseSchema.parse({ items: [owned] }).items).toHaveLength(1);
    expect(ListAgentsQuerySchema.parse({ org: 'org_a' }).org).toBe('org_a');
    expect(ListAgentsQuerySchema.parse({}).org).toBeUndefined();
  });
  it('emailUnreadCount is the owner-only mail badge: a count, or null', () => {
    const owned = VisibilityAgentSchema.parse({
      agent, owner: inviter, sharedBy: null, rooms: [], sharedWith: [], emailUnreadCount: 2,
    });
    expect(owned.emailUnreadCount).toBe(2);
    // null on an agent the caller does not own, and with the medium off
    const shared = VisibilityAgentSchema.parse({
      agent, owner: inviter, sharedBy: { id: 'usr_b', displayName: 'Bo' }, emailUnreadCount: null,
    });
    expect(shared.emailUnreadCount).toBeNull();
    // defaulted so a pre-count server still parses
    expect(VisibilityAgentSchema.parse({ agent, owner: inviter, sharedBy: null }).emailUnreadCount).toBeNull();
    expect(VisibilityAgentSchema.safeParse({ agent, owner: inviter, sharedBy: null, emailUnreadCount: -1 }).success)
      .toBe(false);
  });
  it('ShareAgent request + share events', () => {
    expect(ShareAgentRequestSchema.parse({ human: 'a@b.com' }).human).toBe('a@b.com');
    expect(ShareAgentRequestSchema.safeParse({ human: '' }).success).toBe(false);
    expect(AgentSharedEventSchema.parse({ agent }).agent.id).toBe(agent.id);
  });
});

describe('agent roles', () => {
  it('AgentSchema carries an org-visible roleTitle (null by default)', () => {
    expect(AgentSchema.parse(agent).roleTitle).toBeNull();
    expect(AgentSchema.parse({ ...agent, roleTitle: 'Support triage' }).roleTitle).toBe('Support triage');
    // The wire Agent shape NEVER carries instructions — only the title.
    expect('roleInstructions' in AgentSchema.parse({ ...agent, roleTitle: 'x' })).toBe(false);
  });
  it('agent.shared payload carries roleTitle but never instructions', () => {
    const parsed = AgentSharedEventSchema.parse({ agent: { ...agent, roleTitle: 'Ops' } });
    expect(parsed.agent.roleTitle).toBe('Ops');
    expect('roleInstructions' in parsed.agent).toBe(false);
  });
  it('RoleTitleSchema trims, bounds ≤60, allows null to clear', () => {
    expect(RoleTitleSchema.parse('  Support triage  ')).toBe('Support triage');
    expect(RoleTitleSchema.parse(null)).toBeNull();
    expect(RoleTitleSchema.safeParse('x'.repeat(61)).success).toBe(false);
    expect(RoleTitleSchema.parse('x'.repeat(60))).toHaveLength(60);
  });
  it('RoleInstructionsSchema bounds ≤16KB, allows null to clear', () => {
    expect(RoleInstructionsSchema.parse('# Job\n\nDo the thing.')).toContain('Job');
    expect(RoleInstructionsSchema.parse(null)).toBeNull();
    expect(RoleInstructionsSchema.safeParse('x'.repeat(16 * 1024)).success).toBe(true);
    expect(RoleInstructionsSchema.safeParse('x'.repeat(16 * 1024 + 1)).success).toBe(false);
  });
  it('UpdateMeAgentRequest: name and/or role halves, ≥1 required', () => {
    expect(UpdateMeAgentRequestSchema.parse({ roleTitle: 'Ops' }).roleTitle).toBe('Ops');
    expect(UpdateMeAgentRequestSchema.parse({ roleInstructions: 'do X' }).roleInstructions).toBe('do X');
    expect(UpdateMeAgentRequestSchema.parse({ roleTitle: null }).roleTitle).toBeNull();
    expect(UpdateMeAgentRequestSchema.parse({ name: 'bot', roleTitle: 'Ops' })).toEqual({ name: 'bot', roleTitle: 'Ops' });
    // Empty body → 400 (≥1 field required).
    expect(UpdateMeAgentRequestSchema.safeParse({}).success).toBe(false);
    // Name-only still works (backward compatible with rename).
    expect(UpdateMeAgentRequestSchema.parse({ name: '  deploy-bot  ' }).name).toBe('deploy-bot');
  });
  it('UpdateAgentRequest (owner): role halves join sharing/name in the ≥1 rule', () => {
    expect(UpdateAgentRequestSchema.parse({ roleTitle: 'Ops' }).roleTitle).toBe('Ops');
    expect(UpdateAgentRequestSchema.parse({ roleInstructions: null }).roleInstructions).toBeNull();
    expect(UpdateAgentRequestSchema.safeParse({}).success).toBe(false);
  });
  it('MePrincipal (agent branch) carries the full role, including private instructions', () => {
    const ag = MePrincipalSchema.parse({
      type: 'agent', id: 'agt_a', name: 'deploy-bot', orgId: 'org_a', owner: inviter,
      roleTitle: 'Ops', roleInstructions: 'be terse', roleUpdatedAt: '2026-08-20T00:00:00Z',
    });
    if (ag.type !== 'agent') throw new Error('expected agent');
    expect(ag.roleTitle).toBe('Ops');
    expect(ag.roleInstructions).toBe('be terse');
    expect(ag.roleUpdatedAt).toBe('2026-08-20T00:00:00Z');
    // Defaulted to null when a pre-role server omits them.
    const bare = MePrincipalSchema.parse({ type: 'agent', id: 'agt_a', name: 'b', orgId: 'org_a', owner: inviter });
    if (bare.type !== 'agent') throw new Error('expected agent');
    expect(bare.roleTitle).toBeNull();
    expect(bare.roleInstructions).toBeNull();
    expect(bare.roleUpdatedAt).toBeNull();
  });
  it('VisibilityAgent: owner entry carries private roleInstructions; default null', () => {
    const owned = VisibilityAgentSchema.parse({
      agent: { ...agent, roleTitle: 'Ops' }, owner: inviter, sharedBy: null,
      rooms: [], sharedWith: [], roleInstructions: 'be terse',
    });
    expect(owned.roleInstructions).toBe('be terse');
    expect(owned.agent.roleTitle).toBe('Ops');
    // A shared-to-caller entry defaults instructions to null (private to owner).
    const shared = VisibilityAgentSchema.parse({
      agent: { ...agent, roleTitle: 'Ops' }, owner: inviter, sharedBy: { id: 'usr_b', displayName: 'Bo' },
    });
    expect(shared.roleInstructions).toBeNull();
    // Non-owner still sees the org-visible title on the agent.
    expect(shared.agent.roleTitle).toBe('Ops');
  });
  it('RoleUpdatedEvent carries agentId + title + updatedAt, never instructions', () => {
    const ev = RoleUpdatedEventSchema.parse({ agentId: 'agt_a', roleTitle: 'Ops', roleUpdatedAt: '2026-08-20T00:00:00Z' });
    expect(ev.agentId).toBe('agt_a');
    expect(ev.roleTitle).toBe('Ops');
    expect('roleInstructions' in ev).toBe(false);
    expect(RoleUpdatedEventSchema.parse({ agentId: 'agt_a', roleTitle: null, roleUpdatedAt: '2026-08-20T00:00:00Z' }).roleTitle).toBeNull();
    // agentId is REQUIRED — human recipients route the refetch by it.
    expect(RoleUpdatedEventSchema.safeParse({ roleTitle: 'Ops', roleUpdatedAt: '2026-08-20T00:00:00Z' }).success).toBe(false);
  });
});

describe('room invitations', () => {
  it('InviteHuman body + admin invitation + response + list', () => {
    expect(InviteHumanRequestSchema.parse({ human: 'usr_a' }).human).toBe('usr_a');
    const adminInv = { id: 'rin_a', human: inviter, invitedBy: { id: 'usr_b', displayName: 'Bo' }, status: 'pending', createdAt: '2026-08-20T00:00:00Z', resolvedAt: null };
    expect(RoomInvitationAdminSchema.parse(adminInv).status).toBe('pending');
    expect(InviteHumanResponseSchema.parse({ invitation: adminInv }).invitation.id).toBe('rin_a');
    expect(ListRoomInvitationsResponseSchema.parse({ items: [adminInv] }).items).toHaveLength(1);
  });
  it('invitee-facing invitation + list + accept + event', () => {
    const inv = { id: 'rin_a', room: { id: 'room_a', name: 'ops', orgId: 'org_a' }, invitedBy: inviter, createdAt: '2026-08-20T00:00:00Z' };
    expect(RoomInvitationSchema.parse(inv).room.orgId).toBe('org_a');
    expect(ListMeRoomInvitationsResponseSchema.parse({ items: [inv] }).items).toHaveLength(1);
    expect(RoomInvitationEventSchema.parse({ invitation: inv }).invitation.id).toBe('rin_a');
    const accept = AcceptRoomInvitationResponseSchema.parse({
      room: { id: 'room_a', orgId: 'org_a', name: 'ops', kind: 'project', archivedAt: null, settings: {} },
      member: { id: 'mem_a', kind: 'human', principalId: 'usr_a', displayName: 'Ada', avatarUrl: null, roomRole: 'member', lastSeenAt: null, createdAt: '2026-08-20T00:00:00Z' },
    });
    expect(accept.member.roomRole).toBe('member');
  });
});

describe('admin', () => {
  it('AdminOrg with counts', () => {
    const row = { id: 'org_a', name: 'Acme', slug: 'acme', humanCount: 3, agentCount: 2, roomCount: 5, createdAt: '2026-08-20T00:00:00Z' };
    expect(AdminOrgSchema.parse(row).humanCount).toBe(3);
    expect(ListAdminOrgsResponseSchema.parse({ items: [row] }).items).toHaveLength(1);
  });
  it('AdminRoom with kind + counts', () => {
    const row = { id: 'room_a', orgId: 'org_a', name: 'ops', kind: 'dm', archivedAt: null, memberCount: 2, messageCount: 9, createdAt: '2026-08-20T00:00:00Z' };
    expect(AdminRoomSchema.parse(row).kind).toBe('dm');
    expect(ListAdminRoomsResponseSchema.parse({ items: [row] }).items).toHaveLength(1);
  });
});

describe('config', () => {
  const descriptor = { key: 'auth.allowSignup', type: 'boolean', label: 'Allow signup', description: 'May new accounts self-register?', default: true };
  it('ConfigDescriptorSchema + env/secret', () => {
    expect(ConfigDescriptorSchema.parse(descriptor).key).toBe('auth.allowSignup');
    expect(ConfigDescriptorSchema.parse({ ...descriptor, key: 'orgs.openCreation', envVar: 'OPEN_ORG_CREATION', secret: false }).envVar)
      .toBe('OPEN_ORG_CREATION');
    expect(ConfigDescriptorSchema.safeParse({ ...descriptor, type: 'number' }).success).toBe(false);
  });
  it('ConfigEntry + GetConfig + PutConfig', () => {
    const entry = { descriptor, value: true, source: 'default' };
    expect(ConfigEntrySchema.parse(entry).source).toBe('default');
    expect(ConfigEntrySchema.safeParse({ ...entry, source: 'file' }).success).toBe(false);
    expect(GetConfigResponseSchema.parse({ entries: [entry] }).entries).toHaveLength(1);
    expect(PutConfigRequestSchema.parse({ values: { 'auth.allowSignup': false } }).values).toBeTruthy();
    expect(PutConfigRequestSchema.safeParse({}).success).toBe(false);
  });
});
