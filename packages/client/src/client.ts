import { z } from 'zod';
import {
  // protocol constants
  MAX_ATTACHMENT_BYTES,
  // response/request schemas (validation happens against these)
  AuthConfigResponseSchema,
  AuthMeResponseSchema,
  AuthSessionResponseSchema,
  MeResponseSchema,
  MeOrgsResponseSchema,
  GetOrgResponseSchema,
  ResolveOrgResponseSchema,
  CreateOrgResponseSchema,
  ListOrgHumansResponseSchema,
  AddOrgMemberResponseSchema,
  DirectoryResponseSchema,
  ListOrgAgentsResponseSchema,
  OkResponseSchema,
  CreateInviteResponseSchema,
  ListInvitesResponseSchema,
  InviteInfoResponseSchema,
  EnrollAgentPendingResponseSchema,
  EnrollAgentAdmittedResponseSchema,
  EnrollHumanAdmittedResponseSchema,
  EnrollHumanPendingResponseSchema,
  PollEnrollmentResponseSchema,
  ListEnrollmentsResponseSchema,
  CreateAgentResponseSchema,
  ListAgentsResponseSchema,
  UpdateAgentResponseSchema,
  CreateRoomResponseSchema,
  GetRoomResponseSchema,
  UpdateRoomResponseSchema,
  ListMembersResponseSchema,
  GetMemberResponseSchema,
  MemberResponseSchema,
  InviteHumanResponseSchema,
  ListRoomInvitationsResponseSchema,
  ListMeRoomInvitationsResponseSchema,
  AcceptRoomInvitationResponseSchema,
  MeRoomsResponseSchema,
  EnsureDmResponseSchema,
  ClawbackMessageResponseSchema,
  SendMessageResponseSchema,
  ListInboxResponseSchema,
  PopNextMessageResponseSchema,
  ReadMessageResponseSchema,
  ListOutboxResponseSchema,
  ListRoomMessagesResponseSchema,
  ListAgentDmsResponseSchema,
  SeverAgentDmResponseSchema,
  AllowAgentDmResponseSchema,
  ListOrgRoomsResponseSchema,
  UpdateOrgRoomResponseSchema,
  GetMessageStatusResponseSchema,
  WhoamiResponseSchema,
  SetStatusResponseSchema,
  ListStatusesResponseSchema,
  SetPresenceResponseSchema,
  ListDraftsResponseSchema,
  CreateDraftResponseSchema,
  MeInboxResponseSchema,
  MeInboxPopResponseSchema,
  InboxEntrySchema,
  WorkItemSchema,
  WorkItemTypeSchema,
  ActivityEntrySchema,
  ActivityEntryTypeSchema,
  MediumSchema,
  HintSchema,
  MeHintsResponseSchema,
  ListActivityResponseSchema,
  MeMessageResponseSchema,
  // the email medium
  EmailAddressResponseSchema,
  ListEmailThreadsResponseSchema,
  GetEmailThreadResponseSchema,
  GetEmailResponseSchema,
  EmailMutationResponseSchema,
  SendEmailResponseSchema,
  ListEmailApprovalsResponseSchema,
  ListContactsResponseSchema,
  UpdateContactResponseSchema,
  MeEventsLogResponseSchema,
  ListAdminOrgsResponseSchema,
  ListAdminRoomsResponseSchema,
  GetConfigResponseSchema,
  HealthzResponseSchema,
  CapabilitiesResponseSchema,
  TranscriptionResponseSchema,
  ErrorResponseSchema,
  // SSE event schemas
  MessageNewEventSchema,
  MessageReadEventSchema,
  MessageReceivedEventSchema,
  MessageClawbackEventSchema,
  MemberJoinedEventSchema,
  MemberUpdatedEventSchema,
  MemberRemovedEventSchema,
  RoomUpdatedEventSchema,
  StatusChangedEventSchema,
  PresenceChangedEventSchema,
  EnrollmentRequestedEventSchema,
  EnrollmentResolvedEventSchema,
  RoomInvitationEventSchema,
  AgentSharedEventSchema,
  ActivityAppendedEventSchema,
  EmailReceivedEventSchema,
  EmailSentEventSchema,
  EmailQuarantinedEventSchema,
  EmailHeldEventSchema,
  EmailRejectedEventSchema,
  EmailResolvedEventSchema,
  ReplayGapEventSchema,
  EventRoomRefSchema,
  OrgMeHumansResponseSchema,
  // types
  type SidebarHuman,
  type AuthConfigResponse,
  type AuthSessionResponse,
  type User,
  type MePrincipal,
  type MeOrg,
  type Org,
  type ResolveOrgResponse,
  type HumanContact,
  type OrgAgentGovernance,
  type OrgRole,
  type AddOrgMemberResponse,
  type OkResponse,
  type CreateInviteResponse,
  type Invite,
  type InviteInfoResponse,
  type EnrollAgentPendingResponse,
  type EnrollAgentAdmittedResponse,
  type EnrollHumanAdmittedResponse,
  type EnrollHumanPendingResponse,
  type PollEnrollmentResponse,
  type EnrollmentSummary,
  type CreateAgentResponse,
  type VisibilityAgent,
  type Room,
  type ListMembersResponse,
  type Member,
  type RoomInvitationAdmin,
  type RoomInvitation,
  type AcceptRoomInvitationResponse,
  type MeRoom,
  type RoomRole,
  type DmCounterpart,
  type EnsureDmResponse,
  type SendMessageResponse,
  type ClawbackMessageResponse,
  type Hint,
  type MeHintsResponse,
  type QuietableEvent,
  type ListInboxResponse,
  type Message,
  type ListOutboxResponse,
  type ListRoomMessagesResponse,
  type ListAgentDmsResponse,
  type AgentDmSever,
  type OrgRoomSummary,
  type MessageStatus,
  type MemberStatus,
  type ListStatusesResponse,
  type SetPresenceResponse,
  type Draft,
  type MeInboxResponse,
  type InboxEntry,
  type WorkItem,
  type Medium,
  type ActivityEntry,
  type ListActivityResponse,
  type MeMessageResponse,
  type EmailAddressResponse,
  type ListEmailThreadsResponse,
  type GetEmailThreadResponse,
  type Email,
  type EmailDirection,
  type SendEmailResponse,
  type SendEmailRequest,
  type ReplyEmailRequest,
  type ListEmailApprovalsResponse,
  type ListContactsResponse,
  type ExternalContact,
  type ContactTrust,
  type InboxRoomRef,
  type AdminOrg,
  type AdminRoom,
  type GetConfigResponse,
  type HealthzResponse,
  type CapabilitiesResponse,
  type TranscriptionRequest,
  type TranscriptionResponse,
  type MessageOrigin,
  type AttachmentInput,
  type SuggestedReplyInput,
  type SetStatusRequest,
  type MessageNewEvent,
  type MessageReadEvent,
  type MessageReceivedEvent,
  type MessageClawbackEvent,
  type MemberJoinedEvent,
  type MemberUpdatedEvent,
  type MemberRemovedEvent,
  type RoomUpdatedEvent,
  type StatusChangedEvent,
  type PresenceChangedEvent,
  type EnrollmentRequestedEvent,
  type EnrollmentResolvedEvent,
  type RoomInvitationEvent,
  type AgentSharedEvent,
  type ActivityAppendedEvent,
  type EmailReceivedEvent,
  type EmailSentEvent,
  type EmailQuarantinedEvent,
  type EmailHeldEvent,
  type EmailRejectedEvent,
  type EmailResolvedEvent,
  type AgentSharingMode,
  type UpdateAgentResponse,
  type ReplayGapEvent,
  type EventRoomRef,
} from '@sparrow/common-types';
import { ApiError } from './errors.js';
import { SSEParser } from './sse.js';
import { voiceStreamUrl } from './voiceStream.js';

/* ------------------------------------------------------------------ *
 * Client-surfaced result unions.
 * ------------------------------------------------------------------ */

/** Outcome of {@link SparrowClient.enrollAgent}: instant mint or a pending request. */
export type EnrollAgentResult =
  | ({ status: 'admitted' } & EnrollAgentAdmittedResponse)
  | ({ status: 'pending' } & EnrollAgentPendingResponse);

/** Outcome of {@link SparrowClient.enrollHuman}: an org membership or a pending request. */
export type EnrollHumanResult =
  | ({ status: 'member' } & EnrollHumanAdmittedResponse)
  | ({ status: 'pending' } & EnrollHumanPendingResponse);

/** Outcome of {@link SparrowClient.ensureDm}: the DM room + counterpart + created flag. */
export interface EnsureDmResult extends EnsureDmResponse {
  /** `true` when the DM was created (`201`), `false` for an existing one (`200`). */
  created: boolean;
}

/**
 * A work item whose `type` this client version does not know — a medium added
 * after it was built. Surfaced verbatim (never parsed, never thrown) so a caller
 * can log it and LEAVE it for a newer client, per SPEC "The medium-spanning work
 * queue": an agent that only understands chat must keep working when a v5 medium
 * appears.
 */
export interface UnknownWorkItem {
  type: string;
  [key: string]: unknown;
}

/**
 * Outcome of {@link SparrowClient.meInboxPop}: ONE typed work item spanning
 * mediums, or `null` on an empty queue (never a `404`). v3's `{ message, room }`
 * response is gone — switch on `item.type`.
 *
 * An item whose `type` this client does not recognize arrives on
 * {@link unknownItem} with `item: null`: unknown work is not this client's to do,
 * and it is never an error.
 */
export interface MeInboxPopResult {
  /** The typed work item, or `null` — an empty queue OR an unrecognized `type`. */
  item: WorkItem | null;
  /** The raw item when its `type` is unknown to this client (forward compat). */
  unknownItem?: UnknownWorkItem;
  /**
   * Optional mechanical teaching hints (agents; absent when none fired). They
   * ride the PAUSE only — the `item: null` response at the end of a drain. A pop
   * that hands back work never carries one: the agent is about to start a task
   * and must not be taught mid-stride.
   */
  hints?: Hint[];
}

/**
 * Outcome of {@link SparrowClient.markRead} / {@link SparrowClient.getMessage}: a
 * single message resolved by id across the caller's memberships, plus its room
 * context (so an id-only caller learns which room to reply in).
 */
export interface MeMessageResult {
  message: Message;
  room: InboxRoomRef;
}

/** Outcome of {@link SparrowClient.inviteHuman}: the invitation + whether it was newly created. */
export interface InviteHumanResult {
  invitation: RoomInvitationAdmin;
  /** `true` on a fresh `201`, `false` when an existing pending invite was returned (`200`). */
  created: boolean;
}

/* ------------------------------------------------------------------ *
 * SSE events.
 * ------------------------------------------------------------------ */

/** A decoded named SSE event from a room stream or the `/me/events` fan-in. */
export type SparrowEvent =
  | { type: 'message.new'; data: MessageNewEvent }
  | { type: 'message.read'; data: MessageReadEvent }
  | { type: 'message.received'; data: MessageReceivedEvent }
  | { type: 'message.clawback'; data: MessageClawbackEvent }
  | { type: 'member.joined'; data: MemberJoinedEvent }
  | { type: 'member.updated'; data: MemberUpdatedEvent }
  | { type: 'member.removed'; data: MemberRemovedEvent }
  | { type: 'room.updated'; data: RoomUpdatedEvent }
  | { type: 'status.changed'; data: StatusChangedEvent }
  | { type: 'presence.changed'; data: PresenceChangedEvent }
  | { type: 'enrollment.requested'; data: EnrollmentRequestedEvent }
  | { type: 'enrollment.resolved'; data: EnrollmentResolvedEvent }
  | { type: 'room.invitation'; data: RoomInvitationEvent }
  | { type: 'agent.shared'; data: AgentSharedEvent }
  | { type: 'agent.unshared'; data: AgentSharedEvent }
  | { type: 'activity.appended'; data: ActivityAppendedEvent }
  // The email medium's six unwrapped principal events. `email.received` /
  // `email.sent` target the AGENT; the other four target the humans who decide.
  | { type: 'email.received'; data: EmailReceivedEvent }
  | { type: 'email.sent'; data: EmailSentEvent }
  | { type: 'email.quarantined'; data: EmailQuarantinedEvent }
  | { type: 'email.held'; data: EmailHeldEvent }
  | { type: 'email.rejected'; data: EmailRejectedEvent }
  | { type: 'email.resolved'; data: EmailResolvedEvent }
  | { type: 'replay.gap'; data: ReplayGapEvent }
  | { type: string; data: unknown };

/**
 * A `GET /me/events` fan-in event: a {@link SparrowEvent} plus the `room` context
 * carried on wrapped ROOM events. Principal-level events (enrollment, room
 * invitation, share) arrive unwrapped, so `room` is optional.
 */
export type PrincipalEvent = SparrowEvent & {
  room?: EventRoomRef;
  /**
   * The frame's SSE `id:` — the per-principal journal cursor. Present on every
   * live and replayed `/me/events` frame; absent on structural frames like
   * `replay.gap`. Remember the last one seen and pass it as `meEvents({ since })`
   * on reconnect to replay what was missed.
   */
  id?: string;
};

export interface EventStreamHandle {
  /** Abort the stream. */
  close(): void;
  /** Resolves when the stream ends (naturally or via `close()`). */
  closed: Promise<void>;
}

/**
 * Result of {@link SparrowClient.meEventsLog}: the journaled `/me/events` frames
 * after the requested cursor, decoded EXACTLY like live frames (so a caller can
 * feed them through the same handler), plus the journal metadata.
 */
export interface MeEventsLogResult {
  /** The decoded frames after the cursor (each carries its `id`), oldest-first. */
  events: PrincipalEvent[];
  /** The principal's newest journal cursor as a string (`"0"` when empty). */
  latest: string;
  /** True when the cursor predated retention — replay is incomplete (reconcile). */
  gap: boolean;
  /** True when the page was capped — poll again from the last returned id. */
  more: boolean;
}

/** Additive per-stream options for {@link SparrowClient.events}/{@link SparrowClient.meEvents}. */
export interface EventStreamOptions {
  /**
   * Invoked once the SSE response is established (status OK, body present),
   * before any events flow. Lets callers detect a successful (re)connect —
   * e.g. the CLI's auto-reconnecting `watch`/`loop`. Optional; omitting it
   * preserves the prior behavior exactly.
   */
  onOpen?: () => void;
  /**
   * Invoked for every raw chunk read off the stream — INCLUDING heartbeat
   * comment lines (`: ping`) and the `: open` preamble, which never surface as
   * events. A byte-level liveness signal: it lets a stale-stream watchdog tell a
   * live-but-quiet stream from one whose socket has silently half-closed (a
   * server replaced behind a tunnel drops no FIN, so `read()` blocks forever and
   * no `onOpen`/close ever follows). Optional; omitting it changes nothing.
   */
  onActivity?: () => void;
  /**
   * An opaque per-request transport dispatcher forwarded verbatim into the SSE
   * `fetch` call's init (undici honors a `dispatcher` option). The CLI passes a
   * FRESH single-connection undici `Agent` per (re)connect so a reconnect can
   * never reuse a pooled, silently-dead keep-alive path to the same edge — the
   * failure mode where a black-holed tunnel wedges retries too.
   *
   * MUST be paired with {@link EventStreamOptions.fetchImpl} from the SAME undici
   * instance: a `Dispatcher` from a separately-installed undici is a foreign type
   * that Node's BUNDLED global `fetch` will not drive (the fetch hangs/breaks), so
   * the dispatcher's matching `fetch` has to consume it. Left undefined by default,
   * so web/mcp keep the standard global-fetch (pooled) behavior unchanged.
   */
  dispatcher?: unknown;
  /**
   * A `fetch` implementation to use for THIS stream only (defaults to the client's
   * configured fetch). Plumbed alongside {@link EventStreamOptions.dispatcher} so a
   * caller can supply an undici `fetch` that understands its own `Agent` — the two
   * must come from the same undici instance. Undefined leaves the default path
   * byte-for-byte unchanged.
   */
  fetchImpl?: typeof fetch;
}

/** Attachment bytes + metadata returned by {@link SparrowClient.getAttachment}. */
export interface AttachmentDownload {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface SparrowClientOptions {
  /** Server origin, e.g. `http://localhost:8722` (with or without trailing slash). */
  server: string;
  /**
   * The caller's credential: a human session token (`ses_...`) or an agent key
   * (`agk_...`). Sent as `Authorization: Bearer`. Omit for anonymous calls
   * (auth config, agent enrollment). Cookie auth is the browser's business — the
   * client always uses bearer.
   */
  token?: string;
  /** Default instance admin token for `/admin/*` and `/config` (per-call override wins). */
  adminToken?: string;
  /** Optional `fetch` implementation (defaults to the global). */
  fetch?: typeof fetch;
  /**
   * Self-identification for the client-version gate: when set, every request
   * carries `X-Sparrow-Client: <clientIdent>` (e.g. `sparrow-cli/0.1.0+…`). The
   * server uses it to advertise upgrades (a soft hint) and, past a configured
   * minimum, to reject known-old clients with `426`. Omit it (the default) and no
   * header is sent — web and third-party callers are unaffected and ungated.
   */
  clientIdent?: string;
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions<T> {
  /** Zod schema (input type may differ from output for transforms/defaults). */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  body?: unknown;
  query?: Query;
  /** Explicit bearer token; `null` sends no Authorization header; omit for the default. */
  token?: string | null;
  /** Instance admin token → `X-Admin-Token` (falls back to the client default). */
  adminToken?: string;
  /** Per-request abort signal (timeout/cancel); default path unaffected when omitted. */
  signal?: AbortSignal;
  /**
   * An opaque per-request transport dispatcher forwarded verbatim into the fetch
   * init (undici honors a `dispatcher` option) — for a FRESH single-connection
   * request that can't inherit a poisoned pool. MUST be paired with `fetchImpl`
   * from the SAME undici instance. Omitted leaves the portable path unchanged.
   */
  dispatcher?: unknown;
  /** A `fetch` for THIS request only (must drive `dispatcher`); defaults to the client's. */
  fetchImpl?: typeof fetch;
}

/**
 * Typed HTTP + SSE client over global `fetch`. Covers the entire v4 API surface —
 * the chat medium plus layer 3 (the work queue, the activity timeline, `/me/events`);
 * every method mirrors a SPEC route, sources its request/response types from
 * `@sparrow/common-types`, and throws {@link ApiError} on error envelopes. Node ≥ 22
 * and browsers (no `node:*` imports in this entry).
 */
export class SparrowClient {
  readonly server: string;
  private _token: string | undefined;
  private _adminToken: string | undefined;
  private _fetch: typeof fetch;
  private _clientIdent: string | undefined;

  constructor(opts: SparrowClientOptions) {
    this.server = opts.server.replace(/\/+$/, '');
    this._token = opts.token;
    this._adminToken = opts.adminToken;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this._clientIdent = opts.clientIdent;
  }

  get token(): string | undefined {
    return this._token;
  }

  /** Adopt a new credential (e.g. after login, or an approved agent enrollment). */
  setToken(token: string | undefined): void {
    this._token = token;
  }

  /* ============================================================ *
   * Accounts & sessions
   * ============================================================ */

  /** `GET /auth/config` — providers + `allowSignup` (no auth). */
  authConfig(): Promise<AuthConfigResponse> {
    return this.request('GET', '/auth/config', { schema: AuthConfigResponseSchema, token: null });
  }

  /**
   * `POST /auth/signup` — create a password account. Returns the user + its
   * session token and adopts the token so the client is immediately authed.
   */
  async signup(input: {
    email: string;
    password: string;
    displayName?: string;
    /**
     * Name for the workspace this signup founds — honored only on the bootstrap
     * signup (`GET /auth/config` → `bootstrapOrg`), ignored otherwise.
     */
    orgName?: string;
  }): Promise<AuthSessionResponse> {
    const res = await this.request('POST', '/auth/signup', {
      schema: AuthSessionResponseSchema,
      token: null,
      body: input,
    });
    this._token = res.token;
    return res;
  }

  /**
   * `POST /auth/login` — password login (wrong anything → the same `401`).
   * Adopts the returned session token.
   */
  async login(input: { email: string; password: string }): Promise<AuthSessionResponse> {
    const res = await this.request('POST', '/auth/login', {
      schema: AuthSessionResponseSchema,
      token: null,
      body: input,
    });
    this._token = res.token;
    return res;
  }

  /** `POST /auth/logout` — delete the session; clears the client's token. */
  async logout(): Promise<OkResponse> {
    const res = await this.request('POST', '/auth/logout', { schema: OkResponseSchema });
    this._token = undefined;
    return res;
  }

  /**
   * `GET /auth/me` — the signed-in user, or `null` when this client holds no
   * credential (signed out is an answer, not an error). A token that IS set but
   * no longer resolves still throws `ApiError(401)`: the caller has stale state
   * to clear, which a quiet `null` would hide.
   */
  async authMe(): Promise<User | null> {
    const res = await this.request('GET', '/auth/me', { schema: AuthMeResponseSchema });
    return res.user;
  }

  /** `GET /me` — the principal union (human session OR agent key). */
  async me(): Promise<MePrincipal> {
    const res = await this.request('GET', '/me', { schema: MeResponseSchema });
    return res.principal;
  }

  /**
   * `GET /me/hints` — run the hint engine on demand and read back EVERY nudge
   * that applies right now (`sparrow tips`). Agents only; a human session gets
   * `403`, as with `/me/hint-preferences`.
   *
   * The counterpart to the pause-attached hint, and the opposite trade: a real
   * delivery is at most one hint, cooldown-gated, journaled on the owner's
   * timeline; this is the whole list, whenever the agent asks, and it is
   * READ-ONLY — no delivery is recorded and no cooldown is burned, so looking at
   * your tips never suppresses a hint you would otherwise have been handed at
   * your next pause. `hints` is always present and may be `[]`.
   */
  async meHints(): Promise<MeHintsResponse> {
    return this.request('GET', '/me/hints', { schema: MeHintsResponseSchema });
  }

  /**
   * `PATCH /me` — update the caller's principal. A human session passes
   * `{ displayName? , theme? }`; an agent key passes any of `{ name?, roleTitle?,
   * roleInstructions? }` — a self-rename (org-unique; a collision `409`s) and/or a
   * ROLE change (a string sets, `null` clears). Returns the refreshed principal;
   * a rename propagates live to every room, and a role change nudges the agent to
   * re-read it.
   */
  async updateMe(
    input:
      | { displayName?: string; theme?: 'auto' | 'light' | 'dark' }
      | { name?: string; roleTitle?: string | null; roleInstructions?: string | null },
  ): Promise<MePrincipal> {
    const res = await this.request('PATCH', '/me', { schema: MeResponseSchema, body: input });
    return res.principal;
  }

  /* ============================================================ *
   * Orgs
   * ============================================================ */

  /** `GET /me/orgs` — the caller's orgs with per-org roles. */
  async meOrgs(): Promise<MeOrg[]> {
    const res = await this.request('GET', '/me/orgs', { schema: MeOrgsResponseSchema });
    return res.items;
  }

  /** `POST /orgs` — create an org (caller becomes owner). */
  async createOrg(input: { name: string; slug?: string }): Promise<Org> {
    const res = await this.request('POST', '/orgs', { schema: CreateOrgResponseSchema, body: input });
    return res.org;
  }

  /** `GET /orgs/:orgId`. */
  async getOrg(orgId: string): Promise<Org> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}`, { schema: GetOrgResponseSchema });
    return res.org;
  }

  /**
   * `GET /orgs/resolve/:slug` — map an org slug to its canonical id + the
   * caller's role. Members only; a non-member or unknown slug both `404` (the
   * slug→org seam for host/path-scoped SPA boot).
   */
  resolveOrg(slug: string): Promise<ResolveOrgResponse> {
    return this.request('GET', `/orgs/resolve/${enc(slug)}`, { schema: ResolveOrgResponseSchema });
  }

  /** `PATCH /orgs/:orgId` — owner/admin; any subset of `{ name, slug, settings }`. */
  async updateOrg(
    orgId: string,
    input: { name?: string; slug?: string; settings?: Org['settings'] },
  ): Promise<Org> {
    const res = await this.request('PATCH', `/orgs/${enc(orgId)}`, {
      schema: GetOrgResponseSchema,
      body: input,
    });
    return res.org;
  }

  /** `GET /orgs/:orgId/humans` — the org membership roster (paged). */
  listOrgHumans(orgId: string, page?: { limit?: number; cursor?: string }) {
    return this.request('GET', `/orgs/${enc(orgId)}/humans`, {
      schema: ListOrgHumansResponseSchema,
      query: { limit: page?.limit, cursor: page?.cursor },
    });
  }

  /**
   * `POST /orgs/:orgId/members` — owner/admin adds a person to the org directly
   * by email (no invite round-trip). Reuses an existing human or provisions one;
   * `role` is any non-owner role (defaults to `member`). Already a member → 409.
   */
  addOrgMember(
    orgId: string,
    input: { email: string; role?: OrgRole },
  ): Promise<AddOrgMemberResponse> {
    return this.request('POST', `/orgs/${enc(orgId)}/members`, {
      schema: AddOrgMemberResponseSchema,
      body: input,
    });
  }

  /** `PATCH /orgs/:orgId/humans/:humanId` — set a human's org role. */
  setOrgRole(orgId: string, humanId: string, role: OrgRole): Promise<OkResponse> {
    return this.request('PATCH', `/orgs/${enc(orgId)}/humans/${enc(humanId)}`, {
      schema: OkResponseSchema,
      body: { role },
    });
  }

  /** `DELETE /orgs/:orgId/humans/:humanId` — remove a member (or leave, if self). */
  removeOrgHuman(orgId: string, humanId: string): Promise<OkResponse> {
    return this.request('DELETE', `/orgs/${enc(orgId)}/humans/${enc(humanId)}`, {
      schema: OkResponseSchema,
    });
  }

  /** `GET /orgs/:orgId/directory?q=` — human search (prefix match, capped at 25). */
  async directory(orgId: string, q?: string): Promise<HumanContact[]> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/directory`, {
      schema: DirectoryResponseSchema,
      query: { q },
    });
    return res.items;
  }

  /** `GET /orgs/:orgId/agents` — the governance list of ALL org agents (owner/admin). */
  async listOrgAgents(orgId: string): Promise<OrgAgentGovernance[]> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/agents`, {
      schema: ListOrgAgentsResponseSchema,
    });
    return res.items;
  }

  /* ============================================================ *
   * Invites
   * ============================================================ */

  /** `POST /orgs/:orgId/invites` — the token appears once, inside `url`. */
  createInvite(
    orgId: string,
    input?: { note?: string; expiresInDays?: number },
  ): Promise<CreateInviteResponse> {
    return this.request('POST', `/orgs/${enc(orgId)}/invites`, {
      schema: CreateInviteResponseSchema,
      body: input ?? {},
    });
  }

  /** `GET /orgs/:orgId/invites` — the caller's invites (owners/admins: all). */
  async listInvites(orgId: string): Promise<Invite[]> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/invites`, {
      schema: ListInvitesResponseSchema,
    });
    return res.items;
  }

  /** `DELETE /orgs/:orgId/invites/:id` — revoke. */
  revokeInvite(orgId: string, inviteId: string): Promise<OkResponse> {
    return this.request('DELETE', `/orgs/${enc(orgId)}/invites/${enc(inviteId)}`, {
      schema: OkResponseSchema,
    });
  }

  /* ============================================================ *
   * Enrollment (following an invite)
   * ============================================================ */

  /**
   * `GET /invite/:token/info` — public landing metadata for a valid invite (org
   * name, inviter display name, agent policy); no auth. A dead token is told
   * apart: unknown → `404 not_found`; revoked or expired → `410 gone`, with a
   * message naming which (neither names the org or the inviter). Callers should
   * render `ApiError.message` rather than inventing their own copy.
   */
  inviteInfo(inviteToken: string): Promise<InviteInfoResponse> {
    return this.request('GET', `/invite/${enc(inviteToken)}/info`, {
      schema: InviteInfoResponseSchema,
      token: null,
    });
  }

  /**
   * `POST /invite/:token/enroll` as an ANONYMOUS caller → an agent enrollment.
   * `open` policy mints instantly (`admitted`, key delivered once); `approval`
   * returns a pending ref + a one-time `enr_` token to poll with. Always sent
   * without credentials. Dead tokens mirror `inviteInfo`: unknown → `404`,
   * revoked/expired → `410` naming which.
   */
  async enrollAgent(
    inviteToken: string,
    input: { name: string; note?: string },
  ): Promise<EnrollAgentResult> {
    const { status, json } = await this.send('POST', `/invite/${enc(inviteToken)}/enroll`, {
      body: input,
      token: null,
    });
    if (status >= 400) this.throwFromJson(status, json);
    if (isObj(json) && 'agent' in json) {
      return { status: 'admitted', ...EnrollAgentAdmittedResponseSchema.parse(json) };
    }
    return { status: 'pending', ...EnrollAgentPendingResponseSchema.parse(json) };
  }

  /**
   * `POST /invite/:token/enroll` as a SESSION caller → a human enrollment.
   * A signed-in human holding a valid invite is admitted immediately (the invite
   * IS the approval), so this returns `member` (already a member, or freshly
   * admitted). The `pending` arm remains only for forward compatibility.
   */
  async enrollHuman(inviteToken: string, input?: { note?: string }): Promise<EnrollHumanResult> {
    const { status, json } = await this.send('POST', `/invite/${enc(inviteToken)}/enroll`, {
      body: input ?? {},
    });
    if (status >= 400) this.throwFromJson(status, json);
    if (isObj(json) && 'org' in json) {
      return { status: 'member', ...EnrollHumanAdmittedResponseSchema.parse(json) };
    }
    return { status: 'pending', ...EnrollHumanPendingResponseSchema.parse(json) };
  }

  /**
   * `GET /invite/:token/enrollments/:eid` — poll an enrollment. Auth must match:
   * pass `enrollmentToken` (`enr_...`, anonymous agent enrollments) or rely on the
   * client's session credential (human enrollments). An approved agent enrollment
   * delivers `key` exactly once on the first approved poll.
   */
  pollEnrollment(
    inviteToken: string,
    enrollmentId: string,
    opts?: { enrollmentToken?: string },
  ): Promise<PollEnrollmentResponse> {
    return this.request('GET', `/invite/${enc(inviteToken)}/enrollments/${enc(enrollmentId)}`, {
      schema: PollEnrollmentResponseSchema,
      token: opts?.enrollmentToken ?? undefined,
    });
  }

  /**
   * `GET /orgs/:orgId/enrollments` — pending enrollments (approver). Owners/admins
   * see ALL by default; `mine: true` (→ `?mine=true`) restricts anyone to the
   * enrollments on their own invites.
   */
  async listEnrollments(
    orgId: string,
    opts?: { mine?: boolean; adminToken?: string },
  ): Promise<EnrollmentSummary[]> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/enrollments`, {
      schema: ListEnrollmentsResponseSchema,
      query: { mine: opts?.mine },
      adminToken: opts?.adminToken,
    });
    return res.items;
  }

  /**
   * `POST /orgs/:orgId/enrollments/:eid/approve` — approver. Approval is strictly
   * yes/no; the agent's proposed name (chosen at enroll) is final, so there is no
   * name override. The empty body mints the agent on the approver's say-so.
   */
  approveEnrollment(
    orgId: string,
    enrollmentId: string,
    opts?: { adminToken?: string },
  ): Promise<OkResponse> {
    return this.request('POST', `/orgs/${enc(orgId)}/enrollments/${enc(enrollmentId)}/approve`, {
      schema: OkResponseSchema,
      body: {},
      adminToken: opts?.adminToken,
    });
  }

  /** `POST /orgs/:orgId/enrollments/:eid/deny` — approver. */
  denyEnrollment(
    orgId: string,
    enrollmentId: string,
    opts?: { adminToken?: string },
  ): Promise<OkResponse> {
    return this.request('POST', `/orgs/${enc(orgId)}/enrollments/${enc(enrollmentId)}/deny`, {
      schema: OkResponseSchema,
      adminToken: opts?.adminToken,
    });
  }

  /* ============================================================ *
   * Agents, visibility & sharing
   * ============================================================ */

  /** `POST /me/agents` — mint an agent; the `agk_` key is returned exactly once. */
  createAgent(input: { orgId: string; name: string }): Promise<CreateAgentResponse> {
    return this.request('POST', '/me/agents', { schema: CreateAgentResponseSchema, body: input });
  }

  /** `GET /me/agents?org=` — the caller's visibility list (owned + shared-to-them). */
  async listAgents(opts?: { org?: string }): Promise<VisibilityAgent[]> {
    const res = await this.request('GET', '/me/agents', {
      schema: ListAgentsResponseSchema,
      query: { org: opts?.org },
    });
    return res.items;
  }

  /** `POST /me/agents/:id/rotate` — new key (old dies); returned exactly once. */
  rotateAgent(agentId: string): Promise<CreateAgentResponse> {
    return this.request('POST', `/me/agents/${enc(agentId)}/rotate`, {
      schema: CreateAgentResponseSchema,
    });
  }

  /** `DELETE /me/agents/:id` — delete the agent + its members + visibility rows. */
  deleteAgent(agentId: string): Promise<OkResponse> {
    return this.request('DELETE', `/me/agents/${enc(agentId)}`, { schema: OkResponseSchema });
  }

  /** `POST /me/agents/:id/share` — grant visibility (target by `usr_...` id or email). */
  shareAgent(agentId: string, human: string): Promise<OkResponse> {
    return this.request('POST', `/me/agents/${enc(agentId)}/share`, {
      schema: OkResponseSchema,
      body: { human },
    });
  }

  /** `DELETE /me/agents/:id/share/:humanId` — revoke visibility. */
  unshareAgent(agentId: string, humanId: string): Promise<OkResponse> {
    return this.request('DELETE', `/me/agents/${enc(agentId)}/share/${enc(humanId)}`, {
      schema: OkResponseSchema,
    });
  }

  /** `PATCH /me/agents/:id` — owner-only change of the agent's sharing mode. */
  setAgentSharing(agentId: string, sharing: AgentSharingMode): Promise<UpdateAgentResponse> {
    return this.request('PATCH', `/me/agents/${enc(agentId)}`, {
      schema: UpdateAgentResponseSchema,
      body: { sharing },
    });
  }

  /**
   * `PATCH /me/agents/:id` — owner-only rename of an agent. `name` is org-unique
   * (case-insensitive); a collision `409`s (never auto-suffixed). Renaming
   * propagates live to every room the agent inhabits.
   */
  renameAgent(agentId: string, name: string): Promise<UpdateAgentResponse> {
    return this.request('PATCH', `/me/agents/${enc(agentId)}`, {
      schema: UpdateAgentResponseSchema,
      body: { name },
    });
  }

  /**
   * `PATCH /me/agents/:id` — owner-only change of an agent's ROLE. `roleTitle`
   * (org-visible) and/or `roleInstructions` (private) are each a string to set or
   * `null` to clear. The change nudges the agent to re-read its role.
   */
  setAgentRole(
    agentId: string,
    role: { roleTitle?: string | null; roleInstructions?: string | null },
  ): Promise<UpdateAgentResponse> {
    return this.request('PATCH', `/me/agents/${enc(agentId)}`, {
      schema: UpdateAgentResponseSchema,
      body: role,
    });
  }

  /** `GET /orgs/:orgId/me/agents` — the AGENTS sidebar source (this org's visibility list). */
  async orgMeAgents(orgId: string): Promise<VisibilityAgent[]> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/me/agents`, {
      schema: ListAgentsResponseSchema,
    });
    return res.items;
  }

  /* ============================================================ *
   * Rooms & members
   * ============================================================ */

  /** `POST /orgs/:orgId/rooms` — create a project room (creator becomes owner). */
  async createRoom(orgId: string, input: { name: string }): Promise<Room> {
    const res = await this.request('POST', `/orgs/${enc(orgId)}/rooms`, {
      schema: CreateRoomResponseSchema,
      body: input,
    });
    return res.room;
  }

  /** `GET /rooms/:roomId`. */
  getRoom(roomId: string): Promise<Room> {
    return this.request('GET', `/rooms/${enc(roomId)}`, { schema: GetRoomResponseSchema });
  }

  /**
   * `PATCH /rooms/:roomId` — admin (archive/restore: owner); ≥1 of
   * `{name,settings,archived}`. The wire answers `{ room }` (like create); the SDK
   * unwraps it so callers keep getting the room itself.
   */
  async updateRoom(
    roomId: string,
    input: { name?: string; settings?: Room['settings']; archived?: boolean },
  ): Promise<Room> {
    const res = await this.request('PATCH', `/rooms/${enc(roomId)}`, {
      schema: UpdateRoomResponseSchema,
      body: input,
    });
    return res.room;
  }

  /** `GET /rooms/:roomId/members` — paged Member resources. */
  listMembers(roomId: string, page?: { limit?: number; cursor?: string }): Promise<ListMembersResponse> {
    return this.request('GET', `/rooms/${enc(roomId)}/members`, {
      schema: ListMembersResponseSchema,
      query: { limit: page?.limit, cursor: page?.cursor },
    });
  }

  /** `GET /rooms/:roomId/members/:id` — `:id` is a member id or a principal id. */
  getMember(roomId: string, id: string): Promise<Member> {
    return this.request('GET', `/rooms/${enc(roomId)}/members/${enc(id)}`, {
      schema: GetMemberResponseSchema,
    });
  }

  /** `POST /rooms/:roomId/members` — attach an agent (`agt_...`); caller holds visibility. */
  async addMember(roomId: string, principal: string): Promise<Member> {
    const res = await this.request('POST', `/rooms/${enc(roomId)}/members`, {
      schema: MemberResponseSchema,
      body: { principal },
    });
    return res.member;
  }

  /** `PATCH /rooms/:roomId/members/:id` — set a member's room role. */
  async setMemberRole(roomId: string, memberId: string, roomRole: RoomRole): Promise<Member> {
    const res = await this.request('PATCH', `/rooms/${enc(roomId)}/members/${enc(memberId)}`, {
      schema: MemberResponseSchema,
      body: { roomRole },
    });
    return res.member;
  }

  /** `DELETE /rooms/:roomId/members/:id` — kick a member. */
  removeMember(roomId: string, memberId: string): Promise<OkResponse> {
    return this.request('DELETE', `/rooms/${enc(roomId)}/members/${enc(memberId)}`, {
      schema: OkResponseSchema,
    });
  }

  /** `POST /rooms/:roomId/invitations` — invite a human (org member) to the room. */
  async inviteHuman(roomId: string, human: string): Promise<InviteHumanResult> {
    const { status, json } = await this.send('POST', `/rooms/${enc(roomId)}/invitations`, {
      body: { human },
    });
    if (status >= 400) this.throwFromJson(status, json);
    const { invitation } = InviteHumanResponseSchema.parse(json);
    return { invitation, created: status === 201 };
  }

  /** `GET /rooms/:roomId/invitations` — pending invitations (admin). */
  async listRoomInvitations(roomId: string): Promise<RoomInvitationAdmin[]> {
    const res = await this.request('GET', `/rooms/${enc(roomId)}/invitations`, {
      schema: ListRoomInvitationsResponseSchema,
    });
    return res.items;
  }

  /** `DELETE /rooms/:roomId/invitations/:id` — revoke a room invitation (admin). */
  revokeRoomInvitation(roomId: string, invitationId: string): Promise<OkResponse> {
    return this.request('DELETE', `/rooms/${enc(roomId)}/invitations/${enc(invitationId)}`, {
      schema: OkResponseSchema,
    });
  }

  /** `GET /me/room-invitations` — the caller's pending room invitations (invitee view). */
  async meRoomInvitations(): Promise<RoomInvitation[]> {
    const res = await this.request('GET', '/me/room-invitations', {
      schema: ListMeRoomInvitationsResponseSchema,
    });
    return res.items;
  }

  /** `POST /me/room-invitations/:id/accept` — join the room. */
  acceptRoomInvitation(invitationId: string): Promise<AcceptRoomInvitationResponse> {
    return this.request('POST', `/me/room-invitations/${enc(invitationId)}/accept`, {
      schema: AcceptRoomInvitationResponseSchema,
    });
  }

  /** `POST /me/room-invitations/:id/decline`. */
  declineRoomInvitation(invitationId: string): Promise<OkResponse> {
    return this.request('POST', `/me/room-invitations/${enc(invitationId)}/decline`, {
      schema: OkResponseSchema,
    });
  }

  /** `GET /me/rooms?org=` — the caller's memberships (DM rows carry a counterpart). */
  async meRooms(opts?: { org?: string }): Promise<MeRoom[]> {
    const res = await this.request('GET', '/me/rooms', {
      schema: MeRoomsResponseSchema,
      query: { org: opts?.org },
    });
    return res.items;
  }

  /** `DELETE /me/rooms/:roomId` — leave a room (sole owner → `409`). */
  leaveRoom(roomId: string): Promise<OkResponse> {
    return this.request('DELETE', `/me/rooms/${enc(roomId)}`, { schema: OkResponseSchema });
  }

  /* ============================================================ *
   * Direct conversations
   * ============================================================ */

  /**
   * `POST /me/dms` — ensure the DM room with a principal (`usr_...`/`agt_...`).
   * Idempotent: `created: true` on first create (`201`), `false` afterwards
   * (`200`). `orgId` is required only when the pair shares more than one org.
   */
  async ensureDm(input: { principal: string; orgId?: string }): Promise<EnsureDmResult> {
    const { status, json } = await this.send('POST', '/me/dms', { body: input });
    if (status >= 400) this.throwFromJson(status, json);
    return { ...EnsureDmResponseSchema.parse(json), created: status === 201 };
  }

  /* ============================================================ *
   * Messages (room-in-URL)
   * ============================================================ */

  /** `POST /rooms/:roomId/messages` — returns `{ message, unreadCount }`. */
  sendMessage(
    roomId: string,
    input: {
      /** Optional and ignored server-side: every room message reaches the whole room. */
      to?: string;
      subject?: string;
      body: string;
      attachments?: AttachmentInput[];
      suggestedReplies?: SuggestedReplyInput[];
      inReplyTo?: string;
      replyValue?: string;
      /** Declares the body was derived from speech (STT). Absent = typed. */
      origin?: MessageOrigin;
    },
  ): Promise<SendMessageResponse> {
    return this.request('POST', `/rooms/${enc(roomId)}/messages`, {
      schema: SendMessageResponseSchema,
      body: input,
    });
  }

  /**
   * `POST /rooms/:roomId/messages/:messageId/clawback` — retract the caller's
   * OWN still-unread-by-everyone message (SPEC "Clawback"). Returns the full
   * message (body included) so a client can restore it into its composer; the
   * row is dead from every other surface, and `message.clawback` fans out to
   * the room. `409` once ANY recipient has read it, outside the sender's last
   * `CLAWBACK_WINDOW` messages, or already clawed; `404` for a message that is
   * not the caller's own in that room.
   */
  clawbackMessage(roomId: string, messageId: string): Promise<ClawbackMessageResponse> {
    return this.request('POST', `/rooms/${enc(roomId)}/messages/${enc(messageId)}/clawback`, {
      schema: ClawbackMessageResponseSchema,
    });
  }

  /** `GET /rooms/:roomId/inbox` — unread previews (`all: true` for everything), paged. */
  listInbox(
    roomId: string,
    opts?: { all?: boolean; limit?: number; cursor?: string },
  ): Promise<ListInboxResponse> {
    return this.request('GET', `/rooms/${enc(roomId)}/inbox`, {
      schema: ListInboxResponseSchema,
      query: { all: opts?.all, limit: opts?.limit, cursor: opts?.cursor },
    });
  }

  /** `POST /rooms/:roomId/inbox/pop` — atomic oldest-unread (`null` when empty). */
  async popNextMessage(
    roomId: string,
    opts?: { ack?: boolean; note?: string; ttlSeconds?: number },
  ): Promise<Message | null> {
    const res = await this.request('POST', `/rooms/${enc(roomId)}/inbox/pop`, {
      schema: PopNextMessageResponseSchema,
      body: ackBody(opts),
    });
    return res.message;
  }

  /** `GET /rooms/:roomId/messages/:id` — marks read (unless `peek`). */
  async readMessage(roomId: string, messageId: string, opts?: { peek?: boolean }): Promise<Message> {
    const res = await this.request('GET', `/rooms/${enc(roomId)}/messages/${enc(messageId)}`, {
      schema: ReadMessageResponseSchema,
      query: { peek: opts?.peek },
    });
    return res.message;
  }

  /** `GET /rooms/:roomId/outbox` — messages the caller sent (paged). */
  listOutbox(roomId: string, page?: { limit?: number; cursor?: string }): Promise<ListOutboxResponse> {
    return this.request('GET', `/rooms/${enc(roomId)}/outbox`, {
      schema: ListOutboxResponseSchema,
      query: { limit: page?.limit, cursor: page?.cursor },
    });
  }

  /**
   * `GET /rooms/:roomId/messages` — the room's conversation history: full
   * Messages the caller can see (sender or recipient), newest-first. Peek-only —
   * listing writes no read state. Page backwards with `before` (a message id);
   * the response's `nextBefore` is the next cursor (`null` at the start).
   */
  listRoomMessages(
    roomId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<ListRoomMessagesResponse> {
    return this.request('GET', `/rooms/${enc(roomId)}/messages`, {
      schema: ListRoomMessagesResponseSchema,
      query: { limit: opts?.limit, before: opts?.before },
    });
  }

  /**
   * `GET /orgs/:orgId/agent-dms` — the caller's agent↔agent DM oversight boxes:
   * every such DM in the org whose TWO agents the caller can currently see, each
   * a collapsed, read-only box (no unread state ever rides here). A human who
   * cannot see both agents of a DM simply does not get its box.
   */
  agentDms(orgId: string): Promise<ListAgentDmsResponse> {
    return this.request('GET', `/orgs/${enc(orgId)}/agent-dms`, {
      schema: ListAgentDmsResponseSchema,
    });
  }

  /**
   * `GET /orgs/:orgId/agent-dms/:roomId/messages` — one oversight box's
   * transcript, read-only (writes no read state), newest-first, paged backward
   * with `before`. Gated by the same "can see BOTH agents" predicate the box
   * list uses; a caller who fails it (or loses sight of either agent) gets `404`.
   */
  agentDmMessages(
    orgId: string,
    roomId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<ListRoomMessagesResponse> {
    return this.request('GET', `/orgs/${enc(orgId)}/agent-dms/${enc(roomId)}/messages`, {
      schema: ListRoomMessagesResponseSchema,
      query: { limit: opts?.limit, before: opts?.before },
    });
  }

  /**
   * `POST /orgs/:orgId/agent-dms/:roomId/sever` — cut an agent↔agent pair's
   * line. An org owner/admin, or an owning human of either agent, may call it;
   * anyone else gets `404` (the control never confirms the conversation
   * exists). The pair stays severed — durably, across restarts and re-ensures —
   * until {@link allowAgentDm}. Oversight of what they already said is
   * unaffected.
   */
  severAgentDm(orgId: string, roomId: string): Promise<AgentDmSever> {
    return this.request('POST', `/orgs/${enc(orgId)}/agent-dms/${enc(roomId)}/sever`, {
      schema: SeverAgentDmResponseSchema,
      body: {},
    }).then((res) => res.sever);
  }

  /**
   * `POST /orgs/:orgId/agent-dms/:roomId/allow` — lift a sever. This PERMITS
   * the pair again; it does not reconnect them (the agents must re-ensure the
   * DM and pass the ordinary gate). A sever recorded by an org owner/admin can
   * only be lifted by an org owner/admin → `403`.
   */
  async allowAgentDm(orgId: string, roomId: string): Promise<void> {
    await this.request('POST', `/orgs/${enc(orgId)}/agent-dms/${enc(roomId)}/allow`, {
      schema: AllowAgentDmResponseSchema,
      body: {},
    });
  }

  /**
   * `GET /orgs/:orgId/rooms` — org room governance (owner/admin): every PROJECT
   * room in the org, member or not, as a structural summary. Never messages,
   * and never DM rooms.
   */
  async listOrgRooms(orgId: string): Promise<OrgRoomSummary[]> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/rooms`, {
      schema: ListOrgRoomsResponseSchema,
    });
    return res.items;
  }

  /**
   * `PATCH /orgs/:orgId/rooms/:roomId` — archive (or restore) any project room
   * in the org as its owner/admin, without joining it. Archiving is the whole
   * verb: no rename, no settings, no read access.
   */
  async setOrgRoomArchived(
    orgId: string,
    roomId: string,
    archived: boolean,
  ): Promise<OrgRoomSummary> {
    const res = await this.request('PATCH', `/orgs/${enc(orgId)}/rooms/${enc(roomId)}`, {
      schema: UpdateOrgRoomResponseSchema,
      body: { archived },
    });
    return res.room;
  }

  /** `GET /rooms/:roomId/messages/:id/status` — per-recipient read status. */
  getMessageStatus(roomId: string, messageId: string): Promise<MessageStatus> {
    return this.request('GET', `/rooms/${enc(roomId)}/messages/${enc(messageId)}/status`, {
      schema: GetMessageStatusResponseSchema,
    });
  }

  /** `GET /rooms/:roomId/whoami` — the caller's Member resource in the room. */
  whoami(roomId: string): Promise<Member> {
    return this.request('GET', `/rooms/${enc(roomId)}/whoami`, { schema: WhoamiResponseSchema });
  }

  /**
   * Prepare a file to send into a room as a message attachment — the counterpart
   * to {@link getAttachment}. sparrow binds attachments to a message at send time
   * (there is no orphan upload store), so this encodes `bytes` into the
   * `AttachmentInput` "ref" that {@link sendMessage} carries in its `attachments`
   * array; the bytes travel with that send. `roomId` names the room you intend to
   * send into. Enforces the per-file size limit up front so oversize files fail
   * fast rather than after a wasted upload; the ≤8-count and ≤20 MB-total limits
   * are enforced when the assembled `attachments` array reaches the server.
   *
   * ```ts
   * const ref = await client.uploadAttachment(roomId, {
   *   filename: 'shot.png', contentType: 'image/png', bytes,
   * });
   * await client.sendMessage(roomId, { to: 'all', body: 'see attached', attachments: [ref] });
   * ```
   */
  async uploadAttachment(
    roomId: string,
    input: { filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<AttachmentInput> {
    void roomId; // reserved: attachments bind to the room via the subsequent send
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
      throw new Error(
        `Attachment "${input.filename}" is ${(input.bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; ` +
          `the limit is ${mb} MB per file.`,
      );
    }
    return {
      filename: input.filename,
      contentType: input.contentType,
      dataBase64: base64FromBytes(input.bytes),
    };
  }

  /** `GET /rooms/:roomId/attachments/:id` — binary download (sender/recipient only). */
  getAttachment(roomId: string, attachmentId: string): Promise<AttachmentDownload> {
    return this.download(`/rooms/${enc(roomId)}/attachments/${enc(attachmentId)}`, attachmentId);
  }

  /**
   * Shared binary reader for every attachment route (chat and email): bytes plus
   * the server's `content-disposition` filename, falling back to the id.
   */
  private async download(path: string, fallbackName: string): Promise<AttachmentDownload> {
    const res = await this._fetch(this.apiUrl(path), { headers: this.authHeaders() });
    if (!res.ok) await this.throwFromResponse(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const filename =
      parseContentDispositionFilename(res.headers.get('content-disposition')) ?? fallbackName;
    return { bytes, filename, contentType };
  }

  /* ============================================================ *
   * Voice (STT & TTS) — vendor-key-gated, hidden when unregistered
   * ============================================================ */

  /**
   * `GET /capabilities` — registered-provider booleans (no auth). Clients hide
   * every voice control when `voice.stt` / `voice.tts` are false.
   */
  getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request('GET', '/capabilities', {
      schema: CapabilitiesResponseSchema,
      token: null,
    });
  }

  /**
   * `POST /voice/transcriptions` — principal-scoped STT. Returns the transcript
   * to the caller only (never sent); `404` when no STT provider is registered.
   */
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResponse> {
    return this.request('POST', '/voice/transcriptions', {
      schema: TranscriptionResponseSchema,
      body: req,
    });
  }

  /**
   * The `ws(s)://…/api/v1/voice/transcriptions/stream` URL for STREAMING STT
   * (hands-free mode), derived from this client's configured server — `http` →
   * `ws`, `https` → `wss`, and an empty server (the same-origin web app)
   * resolves against the page. A configured token rides as `?token=` because a
   * WebSocket handshake carries no `Authorization` header; the browser needs
   * neither, its session cookie is same-origin.
   *
   * Only meaningful when `capabilities.voice.sttStreaming` is true — the route
   * 404s before the upgrade otherwise. Open it with
   * {@link openTranscriptionStream}.
   */
  voiceStreamUrl(): string {
    return voiceStreamUrl(this.server, { token: this._token });
  }

  /**
   * `GET /rooms/:roomId/messages/:id/speech` — synthesized speech of a message
   * (sender/recipient only), streamable into `<audio>`. Binary; `audio/mpeg`.
   * `404` when no TTS provider is registered.
   */
  async getMessageSpeech(
    roomId: string,
    messageId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this._fetch(
      this.apiUrl(`/rooms/${enc(roomId)}/messages/${enc(messageId)}/speech`),
      { headers: this.authHeaders() },
    );
    if (!res.ok) await this.throwFromResponse(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    return { bytes, contentType };
  }

  /* ============================================================ *
   * Working status & presence
   * ============================================================ */

  /**
   * `POST /rooms/:roomId/status` — advertise (`working`) or clear (`idle`) a
   * transient status. Returns the active status, or `null` when cleared. Pass
   * `sticky: true` for a long task (no TTL; mutually exclusive with `ttlSeconds`)
   * — it persists until an explicit idle/clear or a long offline horizon.
   */
  async setStatus(
    roomId: string,
    input: {
      state: SetStatusRequest['state'];
      note?: string;
      to?: string;
      ttlSeconds?: number;
      sticky?: boolean;
    },
  ): Promise<MemberStatus | null> {
    const res = await this.request('POST', `/rooms/${enc(roomId)}/status`, {
      schema: SetStatusResponseSchema,
      body: input,
    });
    return res.status;
  }

  /**
   * `GET /rooms/:roomId/status` — the statuses visible to the caller plus the
   * room's presence (`presence.online` = member ids currently on an events stream).
   */
  listStatuses(roomId: string): Promise<ListStatusesResponse> {
    return this.request('GET', `/rooms/${enc(roomId)}/status`, {
      schema: ListStatusesResponseSchema,
    });
  }

  /**
   * `POST /me/presence` — heartbeat presence for a turn-based agent that holds no
   * events stream. Marks the caller online org/room-wide until now+`ttlSeconds`
   * (capped at 300); `0` clears the mark. Returns `{ onlineUntil }` (null when
   * cleared). Effective online stays `stream-connected OR unexpired mark`.
   */
  setPresence(ttlSeconds: number): Promise<SetPresenceResponse> {
    return this.request('POST', '/me/presence', {
      schema: SetPresenceResponseSchema,
      body: { ttlSeconds },
    });
  }

  /* ============================================================ *
   * Drafts (personal, room-scoped)
   * ============================================================ */

  /** `GET /rooms/:roomId/drafts` — the caller's own drafts, oldest first. */
  async listDrafts(roomId: string): Promise<Draft[]> {
    const res = await this.request('GET', `/rooms/${enc(roomId)}/drafts`, {
      schema: ListDraftsResponseSchema,
    });
    return res.items;
  }

  /** `POST /rooms/:roomId/drafts` — queue a draft (trimmed server-side); returns it. */
  async createDraft(roomId: string, text: string): Promise<Draft> {
    const res = await this.request('POST', `/rooms/${enc(roomId)}/drafts`, {
      schema: CreateDraftResponseSchema,
      body: { text },
    });
    return res.draft;
  }

  /** `DELETE /rooms/:roomId/drafts/:draftId` — drop one (unknown/foreign → 404). */
  deleteDraft(roomId: string, draftId: string): Promise<OkResponse> {
    return this.request('DELETE', `/rooms/${enc(roomId)}/drafts/${enc(draftId)}`, {
      schema: OkResponseSchema,
    });
  }

  /* ============================================================ *
   * Principal inbox & sidebar
   * ============================================================ */

  /**
   * `GET /me/inbox` — previews across every medium and every membership (paged,
   * ascending). Items are a `type`-discriminated union (`chat.message` | `email`)
   * sharing one preview core; `medium` narrows to one. Listing marks chat items
   * `received` (server-observed delivery) and marks nothing on email items.
   *
   * Entries whose `type` this client does not recognize are DROPPED rather than
   * thrown (the registry is additive — a v4 client must survive a v5 medium).
   */
  async meInbox(opts?: {
    org?: string;
    medium?: 'chat' | 'email';
    all?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<MeInboxResponse> {
    const res = await this.request('GET', '/me/inbox', {
      schema: LenientPageSchema,
      query: {
        org: opts?.org,
        medium: opts?.medium,
        all: opts?.all,
        limit: opts?.limit,
        cursor: opts?.cursor,
      },
    });
    return {
      items: keepKnown(res.items, KNOWN_ITEM_TYPES, InboxEntrySchema) as InboxEntry[],
      nextCursor: res.nextCursor,
    };
  }

  /**
   * `POST /me/inbox/pop` — the medium-spanning work queue: ONE typed work item
   * (`chat.message` | `email`), oldest first across every membership and every
   * delivered inbound email, or `null` on an empty queue (never a `404`).
   *
   * `ack: true` behaves per medium: a chat item atomically sets the popper's
   * `working` status scoped to the sender (as in v3); an email item sets nothing
   * (there is no room to scope to) and is NOT an error — the loop passes `ack`
   * blindly. `note`/`ttlSeconds` without `ack` are a `400`, as in v3.
   *
   * An item whose `type` is unknown to this client comes back as
   * {@link MeInboxPopResult.unknownItem} with `item: null` — leave it for a newer
   * client; never an error.
   */
  async meInboxPop(opts?: {
    ack?: boolean;
    note?: string;
    ttlSeconds?: number;
  }): Promise<MeInboxPopResult> {
    const res = await this.request('POST', '/me/inbox/pop', {
      schema: LenientPopSchema,
      body: ackBody(opts),
    });
    const hints = res.hints;
    const raw = res.item ?? null;
    if (raw === null) return hints ? { item: null, hints } : { item: null };
    if (!KNOWN_ITEM_TYPES.has(typeOf(raw))) {
      const unknownItem = raw as UnknownWorkItem;
      return hints ? { item: null, unknownItem, hints } : { item: null, unknownItem };
    }
    // A KNOWN type must satisfy its schema — a malformed one is a real contract
    // violation and must throw, not be laundered into "unknown medium".
    const item: WorkItem = WorkItemSchema.parse(raw);
    return hints ? { item, hints } : { item };
  }

  /**
   * `GET /me/activity` — the caller's own interleaved timeline: every entry
   * involving them across mediums, **newest-first**, paged backward with
   * `before` (a transcript reads backward from now). An agent key gets its own
   * entries; a session gets entries on the agents they own plus entries where
   * they were the actor.
   *
   * A record, not a mailbox: reading writes nothing (no read state, no `peek`,
   * no `?all=`). Entries are typed REFS — fetch bodies through the owning
   * medium's routes and tolerate a `404` there (render from `summary` alone).
   * Entries of an unrecognized `type`/`medium` are ignored, per SPEC.
   */
  meActivity(opts?: {
    org?: string;
    medium?: Medium;
    limit?: number;
    before?: string;
  }): Promise<ListActivityResponse> {
    return this.activityPage('/me/activity', {
      org: opts?.org,
      medium: opts?.medium,
      limit: opts?.limit,
      before: opts?.before,
    });
  }

  /**
   * `GET /orgs/:orgId/agents/:agentId/activity` — ONE agent's timeline, readable
   * by its owner, the org's owners/admins, or the admin token. A timeline is
   * correspondence, not room data, so agent ACCESS alone does not admit a reader;
   * a caller who fails every test gets `404` (existence never leaks).
   */
  agentActivity(
    orgId: string,
    agentId: string,
    opts?: { medium?: Medium; limit?: number; before?: string },
  ): Promise<ListActivityResponse> {
    return this.activityPage(`/orgs/${enc(orgId)}/agents/${enc(agentId)}/activity`, {
      medium: opts?.medium,
      limit: opts?.limit,
      before: opts?.before,
    });
  }

  /** Shared reader for both activity routes (drops unrecognized entries). */
  private async activityPage(path: string, query: Query): Promise<ListActivityResponse> {
    const res = await this.request('GET', path, { schema: LenientTranscriptSchema, query });
    return {
      items: keepKnown(res.items, KNOWN_ACTIVITY_TYPES, ActivityEntrySchema, KNOWN_MEDIUMS) as ActivityEntry[],
      nextBefore: res.nextBefore,
    };
  }

  /**
   * `GET /me/messages/:messageId` — fetch ONE message by id across the caller's
   * memberships WITHOUT consuming it (a pure peek; no read state written).
   * Returns the full message + its room. Unknown or foreign id → `404`.
   */
  getMessage(messageId: string): Promise<MeMessageResult> {
    return this.request('GET', `/me/messages/${enc(messageId)}`, {
      schema: MeMessageResponseSchema,
    });
  }

  /**
   * `POST /me/messages/:messageId/read` — ack-by-id: mark THIS specific message
   * read for the caller (across memberships), emitting `message.read` to the
   * sender on the unread→read transition. Idempotent (already-read → the message,
   * no re-emit). The precise alternative to {@link SparrowClient.meInboxPop} when
   * handling a message you already have the id for. Unknown/foreign id → `404`.
   */
  markRead(messageId: string): Promise<MeMessageResult> {
    return this.request('POST', `/me/messages/${enc(messageId)}/read`, {
      schema: MeMessageResponseSchema,
    });
  }

  /* ============================================================ *
   * The email medium
   *
   * `/me/email/*` is the AGENT's own mailbox (a human session there is a
   * `403` — addresses belong to agents); the `/orgs/:orgId/...` twins are how a
   * human reads their agents' mail and clears the approvals queue. With the
   * medium unconfigured every one of these `404`s and `GET /capabilities`
   * reports `email: false` — check capabilities, never these routes, for the
   * medium's on/off.
   * ============================================================ */

  /**
   * `GET /me/email/address` — the caller agent's DERIVED address
   * (`<name>@<org-slug><suffix>`). Because it is derived, a rename MOVES the
   * mailbox: the old address stops resolving and is never aliased.
   */
  meEmailAddress(): Promise<EmailAddressResponse> {
    return this.request('GET', '/me/email/address', { schema: EmailAddressResponseSchema });
  }

  /**
   * `GET /me/email/threads` — the agent's threads with ≥1 delivered/sent email,
   * **newest-first** by `lastEmailAt`, paged backward with `before` (a triage
   * list reads backward from now). Items are FULL threads: `unreadCount`,
   * `participants` and `lastDisposition` come down with the row, so triaging
   * costs one request, not one per thread. A thread whose only email was
   * quarantined/held/rejected never appears: an unknown sender cannot push a
   * subject line into a mailbox just by sending.
   */
  listEmailThreads(page?: { limit?: number; before?: string }): Promise<ListEmailThreadsResponse> {
    return this.request('GET', '/me/email/threads', {
      schema: ListEmailThreadsResponseSchema,
      query: { limit: page?.limit, before: page?.before },
    });
  }

  /**
   * `GET /me/email/threads/:threadId` — the thread plus its emails, ascending,
   * paged. Quarantined/held/rejected emails ARE included so the agent can see
   * what did not go out. A **peek**: it writes no read state.
   */
  getEmailThread(
    threadId: string,
    page?: { limit?: number; cursor?: string },
  ): Promise<GetEmailThreadResponse> {
    return this.request('GET', `/me/email/threads/${enc(threadId)}`, {
      schema: GetEmailThreadResponseSchema,
      query: { limit: page?.limit, cursor: page?.cursor },
    });
  }

  /**
   * `GET /me/email/emails/:emailId` — one email in full. A non-peek read sets
   * `read_at`, but ONLY on an inbound `delivered` email (the only kind that
   * carries read state); `peek: true` never writes.
   */
  async readEmail(emailId: string, opts?: { peek?: boolean }): Promise<Email> {
    const res = await this.request('GET', `/me/email/emails/${enc(emailId)}`, {
      schema: GetEmailResponseSchema,
      query: { peek: opts?.peek },
    });
    return res.email;
  }

  /**
   * `POST /me/email/threads/:threadId/reply` — answer inside an existing thread.
   * The subject and the base recipient set come from the thread; `cc` adds
   * people. The returned email's `disposition` says what happened: `sent`
   * (relayed) or `held` (waiting on the owning human — not a failure, and never
   * to be retried in a loop). A thread with no inbound email → `400`; a policy
   * refusal → `403`.
   */
  async replyEmail(threadId: string, input: ReplyEmailRequest): Promise<Email> {
    const res = await this.request('POST', `/me/email/threads/${enc(threadId)}/reply`, {
      schema: EmailMutationResponseSchema,
      body: input,
    });
    return res.email;
  }

  /**
   * `POST /me/email/send` — start a NEW thread. Returns the email and the thread
   * it opened; `email.disposition` is `sent` or `held` (an unrecognized
   * recipient under an `approve` policy). Under the default `reject` policy an
   * unrecognized recipient is a `403`.
   */
  sendEmail(input: SendEmailRequest): Promise<SendEmailResponse> {
    return this.request('POST', '/me/email/send', {
      schema: SendEmailResponseSchema,
      body: input,
    });
  }

  /**
   * `POST /me/email/emails/:emailId/retry` — re-relay one of the agent's own
   * `send-failed` emails. Any other disposition → `409` (a `held` email is
   * waiting on a human, not on a retry).
   */
  async retryEmail(emailId: string): Promise<Email> {
    const res = await this.request('POST', `/me/email/emails/${enc(emailId)}/retry`, {
      schema: EmailMutationResponseSchema,
    });
    return res.email;
  }

  /**
   * `GET /me/email/attachments/:attachmentId` — binary download (forced
   * `content-disposition: attachment`, mirroring chat). The attachment must hang
   * off an email in one of the caller's threads, else `404`.
   */
  getEmailAttachment(attachmentId: string): Promise<AttachmentDownload> {
    return this.download(`/me/email/attachments/${enc(attachmentId)}`, attachmentId);
  }

  /* ---- how a human reads their agents' email ---- */

  /** `GET /orgs/:orgId/agents/:agentId/email/address` — owner / org owner-admin. */
  agentEmailAddress(orgId: string, agentId: string): Promise<EmailAddressResponse> {
    return this.request('GET', `/orgs/${enc(orgId)}/agents/${enc(agentId)}/email/address`, {
      schema: EmailAddressResponseSchema,
    });
  }

  /**
   * `GET /orgs/:orgId/agents/:agentId/email/threads` — the agent's thread list,
   * on the same terms as {@link SparrowClient.listEmailThreads}: newest-first,
   * `before`/`nextBefore`, full threads.
   */
  agentEmailThreads(
    orgId: string,
    agentId: string,
    page?: { limit?: number; before?: string },
  ): Promise<ListEmailThreadsResponse> {
    return this.request('GET', `/orgs/${enc(orgId)}/agents/${enc(agentId)}/email/threads`, {
      schema: ListEmailThreadsResponseSchema,
      query: { limit: page?.limit, before: page?.before },
    });
  }

  /**
   * `GET /orgs/:orgId/agents/:agentId/email/threads/:threadId` — one of the
   * agent's threads. ALWAYS a peek: a human reading never marks the agent's mail
   * read.
   */
  agentEmailThread(
    orgId: string,
    agentId: string,
    threadId: string,
    page?: { limit?: number; cursor?: string },
  ): Promise<GetEmailThreadResponse> {
    return this.request(
      'GET',
      `/orgs/${enc(orgId)}/agents/${enc(agentId)}/email/threads/${enc(threadId)}`,
      { schema: GetEmailThreadResponseSchema, query: { limit: page?.limit, cursor: page?.cursor } },
    );
  }

  /**
   * `GET /orgs/:orgId/email/emails/:emailId` — the approval-detail read (peek),
   * for the anchor agent's owner or an org owner/admin. One email is addressed
   * one way everywhere: this org-level path, with `/approve` and `/deny` hanging
   * off it.
   */
  async getOrgEmail(orgId: string, emailId: string): Promise<Email> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/email/emails/${enc(emailId)}`, {
      schema: GetEmailResponseSchema,
    });
    return res.email;
  }

  /** `GET /orgs/:orgId/email/attachments/:attachmentId` — binary download (human side). */
  getOrgEmailAttachment(orgId: string, attachmentId: string): Promise<AttachmentDownload> {
    return this.download(
      `/orgs/${enc(orgId)}/email/attachments/${enc(attachmentId)}`,
      attachmentId,
    );
  }

  /**
   * `GET /orgs/:orgId/email/approvals` — the queue: every `quarantined` inbound
   * and `held` outbound email, ascending `createdAt`. An owner sees their own
   * agents' mail; an org owner/admin sees all of it. There is no approvals
   * table — the queue IS those two dispositions.
   */
  listEmailApprovals(
    orgId: string,
    opts?: { agent?: string; direction?: EmailDirection; limit?: number; cursor?: string },
  ): Promise<ListEmailApprovalsResponse> {
    return this.request('GET', `/orgs/${enc(orgId)}/email/approvals`, {
      schema: ListEmailApprovalsResponseSchema,
      query: {
        agent: opts?.agent,
        direction: opts?.direction,
        limit: opts?.limit,
        cursor: opts?.cursor,
      },
    });
  }

  /**
   * `POST /orgs/:orgId/email/emails/:emailId/approve` — deliver a quarantined
   * inbound email, or relay a held outbound one. Approving is DURABLE by
   * default: the thread becomes trusted and, unless `trustSender: false`, the
   * other party becomes an `approved` contact. Not pending → `409`.
   */
  async approveEmail(
    orgId: string,
    emailId: string,
    input?: { trustSender?: boolean },
  ): Promise<Email> {
    const res = await this.request(
      'POST',
      `/orgs/${enc(orgId)}/email/emails/${enc(emailId)}/approve`,
      { schema: EmailMutationResponseSchema, body: input ?? {} },
    );
    return res.email;
  }

  /**
   * `POST /orgs/:orgId/email/emails/:emailId/deny` — refuse a pending email
   * (`disposition: 'rejected'`, `reason: 'denied'`). `blockSender: true` blocks
   * that contact for the org, which short-circuits every trust rung in both
   * directions from then on. Not pending → `409`.
   */
  async denyEmail(
    orgId: string,
    emailId: string,
    input?: { blockSender?: boolean },
  ): Promise<Email> {
    const res = await this.request(
      'POST',
      `/orgs/${enc(orgId)}/email/emails/${enc(emailId)}/deny`,
      { schema: EmailMutationResponseSchema, body: input ?? {} },
    );
    return res.email;
  }

  /**
   * `GET /orgs/:orgId/email/contacts` — org owner/admin only: every external
   * address that has ever written to the org's agents, with its durable trust.
   * `trust: 'unknown'` selects the rows whose trust is `null`; `q` is an address
   * prefix.
   */
  listEmailContacts(
    orgId: string,
    opts?: {
      trust?: 'approved' | 'blocked' | 'unknown';
      q?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<ListContactsResponse> {
    return this.request('GET', `/orgs/${enc(orgId)}/email/contacts`, {
      schema: ListContactsResponseSchema,
      query: { trust: opts?.trust, q: opts?.q, limit: opts?.limit, cursor: opts?.cursor },
    });
  }

  /**
   * `PATCH /orgs/:orgId/email/contacts/:contactId` — set a contact's trust
   * directly, outside any one email. `null` returns it to unknown. Revocation is
   * forward-looking: already-delivered email is never withdrawn.
   */
  async updateEmailContact(
    orgId: string,
    contactId: string,
    trust: ContactTrust | null,
  ): Promise<ExternalContact> {
    const res = await this.request(
      'PATCH',
      `/orgs/${enc(orgId)}/email/contacts/${enc(contactId)}`,
      { schema: UpdateContactResponseSchema, body: { trust } },
    );
    return res.contact;
  }

  /** `GET /orgs/:orgId/me/humans` — the HUMANS sidebar source. */
  async orgMeHumans(orgId: string): Promise<SidebarHuman[]> {
    const res = await this.request('GET', `/orgs/${enc(orgId)}/me/humans`, {
      schema: OrgMeHumansResponseSchema,
    });
    return res.items;
  }

  /* ============================================================ *
   * Config (admin token)
   * ============================================================ */

  /** `GET /config` — resolved instance config entries (admin token). */
  getConfig(adminToken?: string): Promise<GetConfigResponse> {
    return this.request('GET', '/config', {
      schema: GetConfigResponseSchema,
      token: null,
      adminToken,
    });
  }

  /** `PUT /config` — write config values (validated server-side). */
  putConfig(values: Record<string, unknown>, adminToken?: string): Promise<GetConfigResponse> {
    return this.request('PUT', '/config', {
      schema: GetConfigResponseSchema,
      token: null,
      adminToken,
      body: { values },
    });
  }

  /* ============================================================ *
   * Admin (X-Admin-Token)
   * ============================================================ */

  /** `GET /admin/orgs` — all orgs with human/agent/room counts. */
  async adminListOrgs(adminToken?: string): Promise<AdminOrg[]> {
    const res = await this.request('GET', '/admin/orgs', {
      schema: ListAdminOrgsResponseSchema,
      token: null,
      adminToken,
    });
    return res.items;
  }

  /** `DELETE /admin/orgs/:id` — hard delete an org + cascade. */
  adminDeleteOrg(orgId: string, adminToken?: string): Promise<OkResponse> {
    return this.request('DELETE', `/admin/orgs/${enc(orgId)}`, {
      schema: OkResponseSchema,
      token: null,
      adminToken,
    });
  }

  /** `GET /admin/rooms?org=` — all rooms (incl. archived + DMs) with counts. */
  async adminListRooms(opts?: { org?: string; adminToken?: string }): Promise<AdminRoom[]> {
    const res = await this.request('GET', '/admin/rooms', {
      schema: ListAdminRoomsResponseSchema,
      token: null,
      adminToken: opts?.adminToken,
      query: { org: opts?.org },
    });
    return res.items;
  }

  /** `DELETE /admin/rooms/:id` — hard delete a room + cascade. */
  adminDeleteRoom(roomId: string, adminToken?: string): Promise<OkResponse> {
    return this.request('DELETE', `/admin/rooms/${enc(roomId)}`, {
      schema: OkResponseSchema,
      token: null,
      adminToken,
    });
  }

  /** `DELETE /admin/agents/:id` — delete an agent (key dies). */
  adminDeleteAgent(agentId: string, adminToken?: string): Promise<OkResponse> {
    return this.request('DELETE', `/admin/agents/${enc(agentId)}`, {
      schema: OkResponseSchema,
      token: null,
      adminToken,
    });
  }

  /** `DELETE /admin/humans/:id` — delete a human account (owned agents must go first). */
  adminDeleteHuman(humanId: string, adminToken?: string): Promise<OkResponse> {
    return this.request('DELETE', `/admin/humans/${enc(humanId)}`, {
      schema: OkResponseSchema,
      token: null,
      adminToken,
    });
  }

  /* ============================================================ *
   * Misc
   * ============================================================ */

  /** `GET /healthz` — liveness + version (no auth; mounted at the server root). */
  async healthz(): Promise<HealthzResponse> {
    const res = await this._fetch(`${this.server}/healthz`, { headers: this.authHeaders() });
    if (!res.ok) await this.throwFromResponse(res);
    return HealthzResponseSchema.parse(await res.json());
  }

  /* ============================================================ *
   * Events (SSE)
   * ============================================================ */

  /**
   * Build the URL for a room's SSE stream (`GET /rooms/:roomId/events`) with the
   * credential as `?token=` (session `ses_` or agent `agk_`), since EventSource
   * cannot set headers. Defaults to the client's own token.
   */
  roomEventsUrl(roomId: string, token?: string): string {
    const t = token ?? this._token;
    return this.apiUrl(`/rooms/${enc(roomId)}/events`, t ? { token: t } : undefined);
  }

  /**
   * Build the URL for the `GET /me/events` fan-in stream (`?token=`). `since`
   * (a journal cursor from a prior frame's `id`) adds `?since=` so the server
   * replays events missed while disconnected before going live. `quiet` adds the
   * subscription-time filter (`?quiet=presence,status`) — see
   * {@link SparrowClient.meEvents}. An empty list is omitted entirely, so an
   * unfiltered URL stays byte-identical to what older clients built.
   */
  meEventsUrl(token?: string, since?: string, quiet?: readonly QuietableEvent[]): string {
    const t = token ?? this._token;
    return this.apiUrl('/me/events', {
      token: t ?? undefined,
      since: since ?? undefined,
      quiet: quiet && quiet.length > 0 ? quiet.join(',') : undefined,
    });
  }

  /**
   * Consume a room's SSE stream (`GET /rooms/:roomId/events`), invoking `onEvent`
   * per named event. Known payloads are validated against their `common-types`
   * schemas; unknown types pass through with raw parsed `data`.
   */
  events(
    roomId: string,
    onEvent: (event: SparrowEvent) => void,
    opts?: EventStreamOptions,
  ): EventStreamHandle {
    return this.consume(
      this.roomEventsUrl(roomId),
      (type, raw) => {
        const ev = decodeEvent(type, raw);
        if (ev) onEvent(ev);
      },
      opts,
    );
  }

  /**
   * Consume the `GET /me/events` fan-in stream — one stream over ALL the
   * principal's rooms. ROOM events arrive wrapped `{ room, ...payload }`;
   * principal-level events (enrollment, room invitation, share) arrive unwrapped.
   * Each event carries its frame `id` (the journal cursor). Pass `{ since }` (the
   * last id seen) to resume: the server replays what was missed before going live.
   *
   * `{ quiet: ['presence', 'status'] }` is a SUBSCRIPTION-TIME filter: the server
   * stops writing those events to THIS stream. Presence and status churn is the
   * loudest traffic on the fan-in and the least actionable for an agent — a room
   * of members flipping online/offline says nothing about work waiting for you.
   * The journal is untouched (frames are still recorded and still consume cursor
   * ids), an unfiltered subscriber such as the web still sees every one, and
   * `?since=` replay honors the same filter so a resume shows exactly what the
   * live stream would have.
   */
  meEvents(
    onEvent: (event: PrincipalEvent) => void,
    opts?: EventStreamOptions & { since?: string; quiet?: readonly QuietableEvent[] },
  ): EventStreamHandle {
    return this.consume(
      this.meEventsUrl(undefined, opts?.since, opts?.quiet),
      (type, raw, id) => {
        const ev = decodePrincipalEvent(type, raw);
        if (ev) onEvent({ ...ev, id });
      },
      opts,
    );
  }

  /**
   * `GET /me/events/log?since=<id>` — the NON-streaming read of the `/me/events`
   * journal. A one-shot HTTP request that returns the frames after `since`
   * (decoded exactly like {@link SparrowClient.meEvents} delivers them), so it
   * can be handled through the same path. Because it is a fresh request it
   * punches through a stall that has silently wedged the long-lived SSE socket —
   * the CLI's reconcile poll. Omit `since` to cheaply learn the current cursor
   * (`latest`) with no events. `gap` mirrors the stream's `replay.gap`; `more`
   * signals a capped page (poll again from the last returned id).
   *
   * `quiet` applies the SAME subscription filter as {@link SparrowClient.meEvents}
   * to what this read hands back. A client that quiets presence/status on its
   * stream must quiet its reconcile poll too, or the noise it filtered comes
   * straight back through the other door. `latest`/`gap`/`more` are computed from
   * the UNFILTERED journal (the cursor space is shared), so the two reads agree.
   *
   * `opts` bounds/isolates a single call for the CLI's reconcile poll: `signal`
   * aborts the request at a timeout so a hung read can't wedge the poll loop, and
   * `dispatcher`/`fetchImpl` (a fresh single-connection undici Agent + its own
   * fetch, from the same undici) route it over a fresh socket so a poisoned pool
   * can't wedge it either. All optional — omitting them keeps the default path.
   */
  async meEventsLog(
    since?: string,
    opts?: {
      signal?: AbortSignal;
      dispatcher?: unknown;
      fetchImpl?: typeof fetch;
      quiet?: readonly QuietableEvent[];
    },
  ): Promise<MeEventsLogResult> {
    const res = await this.request('GET', '/me/events/log', {
      schema: MeEventsLogResponseSchema,
      query: {
        since,
        quiet: opts?.quiet && opts.quiet.length > 0 ? opts.quiet.join(',') : undefined,
      },
      signal: opts?.signal,
      dispatcher: opts?.dispatcher,
      fetchImpl: opts?.fetchImpl,
    });
    const events = res.events.map((item) =>
      decodePrincipalEventFromValue(item.event, item.data, String(item.id)),
    );
    return {
      events,
      latest: String(res.latest),
      gap: res.gap ?? false,
      more: res.more ?? false,
    };
  }

  /* ============================================================ *
   * internals
   * ============================================================ */

  private apiUrl(path: string, query?: Query): string {
    let u = `${this.server}/api/v1${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) u += `?${qs}`;
    }
    return u;
  }

  private authHeaders(explicitToken?: string | null): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = explicitToken !== undefined ? explicitToken : this._token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Self-identify for the client-version gate (only when configured — web and
    // third-party callers send nothing and stay ungated). Every credentialed and
    // anonymous request routes through here, so the header rides along uniformly.
    if (this._clientIdent) headers['X-Sparrow-Client'] = this._clientIdent;
    return headers;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions<T>): Promise<T> {
    const headers = this.authHeaders(opts.token);
    const admin = opts.adminToken ?? this._adminToken;
    if (admin) headers['X-Admin-Token'] = admin;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }
    const init: RequestInit = { method, headers, body: payload };
    if (opts.signal !== undefined) init.signal = opts.signal;
    // `dispatcher` is a non-standard (undici) init field Node's fetch honors; the
    // cast keeps it off the portable RequestInit type. Only set when supplied so
    // the default path is byte-for-byte the prior behavior.
    if (opts.dispatcher !== undefined) {
      (init as { dispatcher?: unknown }).dispatcher = opts.dispatcher;
    }
    // A per-request `fetchImpl` (e.g. undici's own fetch) must drive its own
    // dispatcher; default to the client's fetch so web/mcp are untouched.
    const doFetch = opts.fetchImpl ?? this._fetch;
    const res = await doFetch(this.apiUrl(path, opts.query), init);
    if (!res.ok) await this.throwFromResponse(res);
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    return opts.schema.parse(json);
  }

  /**
   * Low-level send returning HTTP status + parsed JSON without throwing or
   * schema-validating — for routes whose success shape varies by status code
   * (enroll 200/201/202, ensureDm 200/201, inviteHuman 200/201). Sends the
   * client's default bearer unless `token` overrides it.
   */
  private async send(
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string | null },
  ): Promise<{ status: number; json: unknown }> {
    const headers = this.authHeaders(opts?.token);
    let payload: string | undefined;
    if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }
    const res = await this._fetch(this.apiUrl(path), { method, headers, body: payload });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    return { status: res.status, json };
  }

  private consume(
    url: string,
    onEvent: (type: string, rawData: string, id?: string) => void,
    opts?: EventStreamOptions,
  ): EventStreamHandle {
    const controller = new AbortController();
    const headers = this.authHeaders();
    const parser = new SSEParser();
    // `dispatcher` is a non-standard (undici) init field Node's fetch honors; the
    // cast keeps it off the portable RequestInit type. Only set when supplied so
    // the default path is byte-for-byte the prior behavior.
    const init: RequestInit = { headers, signal: controller.signal };
    if (opts?.dispatcher !== undefined) {
      (init as { dispatcher?: unknown }).dispatcher = opts.dispatcher;
    }
    // A per-stream `fetchImpl` (e.g. undici's own fetch) must drive its own
    // dispatcher; default to the client's fetch so web/mcp are untouched.
    const doFetch = opts?.fetchImpl ?? this._fetch;
    const closed = (async () => {
      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch (err) {
        // Once WE have aborted (close(), or a watchdog/max-age teardown), any
        // transport error is expected teardown noise, not a real failure — a
        // server closing the socket surfaces as UND_ERR_SOCKET, not AbortError.
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
        throw err;
      }
      if (!res.ok || !res.body) {
        await this.throwFromResponse(res);
        return;
      }
      opts?.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // Any byte counts as liveness — heartbeats/comments included — even
          // when it yields no event. Fire before parsing so a watchdog sees it.
          opts?.onActivity?.();
          for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
            onEvent(ev.event, ev.data, ev.id);
          }
        }
      } catch (err) {
        // Same as above: a read failing after we've torn the stream down is
        // expected — only surface errors from a stream we did not abort.
        if (!controller.signal.aborted && (err as Error).name !== 'AbortError') throw err;
      }
    })();
    return { close: () => controller.abort(), closed };
  }

  private throwFromJson(status: number, json: unknown): never {
    const parsed = ErrorResponseSchema.safeParse(json);
    throw new ApiError({
      code: parsed.success ? parsed.data.error.code : 'internal',
      status,
      message: parsed.success ? parsed.data.error.message : `HTTP ${status}`,
    });
  }

  private async throwFromResponse(res: Response): Promise<never> {
    let code: string = 'internal';
    let message: string = res.statusText || `HTTP ${res.status}`;
    try {
      const parsed = ErrorResponseSchema.safeParse(await res.json());
      if (parsed.success) {
        code = parsed.data.error.code;
        message = parsed.data.error.message;
      }
    } catch {
      /* non-JSON error body — keep defaults */
    }
    throw new ApiError({ code, status: res.status, message });
  }
}

/* ------------------------------------------------------------------ *
 * Module helpers
 * ------------------------------------------------------------------ */

const enc = encodeURIComponent;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/* ---------------- layer-3 forward compatibility ---------------- */

/**
 * The layer-3 registries this client version knows. Everything in unified
 * attention is ADDITIVE: a v4 client will meet a v5 medium, and SPEC ("The
 * activity timeline", "The medium-spanning work queue") requires it to IGNORE
 * what it does not recognize rather than fail. So layer-3 pages are read through
 * a lenient envelope and each element is admitted only when its discriminator is
 * one of these; a recognized element is then parsed STRICTLY, so a malformed
 * known shape still surfaces as the contract violation it is.
 */
const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set(WorkItemTypeSchema.options);
const KNOWN_ACTIVITY_TYPES: ReadonlySet<string> = new Set(ActivityEntryTypeSchema.options);
const KNOWN_MEDIUMS: ReadonlySet<string> = new Set(MediumSchema.options);

/** A paged layer-3 response before its elements are typed. */
const LenientPageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});

/** The same leniency for a TRANSCRIPT page (`{ items, nextBefore }`). */
const LenientTranscriptSchema = z.object({
  items: z.array(z.unknown()),
  nextBefore: z.string().nullable(),
});

/** `POST /me/inbox/pop` before its item is typed (an unknown `type` is data, not an error). */
const LenientPopSchema = z.object({
  item: z.unknown().nullable(),
  hints: z.array(HintSchema).optional(),
});

/** The discriminator of a layer-3 element (`''` when it carries none). */
function typeOf(value: unknown): string {
  const t = isObj(value) ? value.type : undefined;
  return typeof t === 'string' ? t : '';
}

/** Keep only elements whose `type` (and `medium`, when checked) is recognized. */
function keepKnown<T>(
  items: unknown[],
  knownTypes: ReadonlySet<string>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  knownMediums?: ReadonlySet<string>,
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (!knownTypes.has(typeOf(item))) continue;
    if (knownMediums) {
      const medium = isObj(item) ? item.medium : undefined;
      if (typeof medium !== 'string' || !knownMediums.has(medium)) continue;
    }
    kept.push(schema.parse(item));
  }
  return kept;
}

/** Build the optional `{ ack, note, ttlSeconds }` pop body only when a field is set. */
function ackBody(opts?: { ack?: boolean; note?: string; ttlSeconds?: number }): unknown {
  if (!opts) return undefined;
  if (opts.ack === undefined && opts.note === undefined && opts.ttlSeconds === undefined) {
    return undefined;
  }
  return { ack: opts.ack, note: opts.note, ttlSeconds: opts.ttlSeconds };
}

function decodeEvent(type: string, rawData: string): SparrowEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return null;
  }
  return decodeEventValue(type, data);
}

/**
 * Decode a `GET /me/events` block. ROOM events are wrapped `{ room, ...fields }`;
 * principal-level events are unwrapped. Split out any `room` wrapper, then decode
 * the remaining fields exactly like a per-room event.
 */
function decodePrincipalEvent(type: string, rawData: string): PrincipalEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  return decodePrincipalEventFromValue(type, parsed);
}

/**
 * Decode an ALREADY-PARSED `/me/events` payload (the shape the journal-log read
 * returns) into a {@link PrincipalEvent}. ROOM events are wrapped
 * `{ room, ...fields }`; principal-level events are unwrapped. `id` (a journal
 * cursor) is attached when supplied, exactly as a live frame carries it.
 */
function decodePrincipalEventFromValue(type: string, parsed: unknown, id?: string): PrincipalEvent {
  if (isObj(parsed) && 'room' in parsed) {
    const { room: rawRoom, ...rest } = parsed;
    const roomParse = EventRoomRefSchema.safeParse(rawRoom);
    const room = (roomParse.success ? roomParse.data : rawRoom) as EventRoomRef;
    return { ...decodeEventValue(type, rest), room, id };
  }
  return { ...decodeEventValue(type, parsed), id };
}

function decodeEventValue(type: string, data: unknown): SparrowEvent {
  switch (type) {
    case 'message.new':
      return { type, data: pick(MessageNewEventSchema, data) };
    case 'message.read':
      return { type, data: pick(MessageReadEventSchema, data) };
    case 'message.received':
      return { type, data: pick(MessageReceivedEventSchema, data) };
    // Clawback: the sender pulled an unread message back — drop it everywhere.
    case 'message.clawback':
      return { type, data: pick(MessageClawbackEventSchema, data) };
    case 'member.joined':
      return { type, data: pick(MemberJoinedEventSchema, data) };
    case 'member.updated':
      return { type, data: pick(MemberUpdatedEventSchema, data) };
    case 'member.removed':
      return { type, data: pick(MemberRemovedEventSchema, data) };
    case 'room.updated':
      return { type, data: pick(RoomUpdatedEventSchema, data) };
    case 'status.changed':
      return { type, data: pick(StatusChangedEventSchema, data) };
    case 'presence.changed':
      return { type, data: pick(PresenceChangedEventSchema, data) };
    case 'enrollment.requested':
      return { type, data: pick(EnrollmentRequestedEventSchema, data) };
    case 'enrollment.resolved':
      return { type, data: pick(EnrollmentResolvedEventSchema, data) };
    case 'room.invitation':
      return { type, data: pick(RoomInvitationEventSchema, data) };
    case 'agent.shared':
      return { type, data: pick(AgentSharedEventSchema, data) };
    case 'agent.unshared':
      return { type, data: pick(AgentSharedEventSchema, data) };
    // The live half of the timeline (v4): unwrapped, owner-only, `{ entry }`.
    case 'activity.appended':
      return { type, data: pick(ActivityAppendedEventSchema, data) };
    // The email medium (v4): six unwrapped principal events, each carrying an
    // `EmailPreview` + its thread — never a body.
    case 'email.received':
      return { type, data: pick(EmailReceivedEventSchema, data) };
    case 'email.sent':
      return { type, data: pick(EmailSentEventSchema, data) };
    case 'email.quarantined':
      return { type, data: pick(EmailQuarantinedEventSchema, data) };
    case 'email.held':
      return { type, data: pick(EmailHeldEventSchema, data) };
    case 'email.rejected':
      return { type, data: pick(EmailRejectedEventSchema, data) };
    case 'email.resolved':
      return { type, data: pick(EmailResolvedEventSchema, data) };
    case 'replay.gap':
      return { type, data: pick(ReplayGapEventSchema, data) };
    default:
      return { type, data };
  }
}

/** safeParse a value against a schema, falling back to the raw value on failure. */
function pick<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown): T {
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : (data as T);
}

/** Parse a filename out of a `Content-Disposition` header value. */
export function parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  // RFC 5987 extended form: filename*=UTF-8''foo%20bar.txt
  const ext = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (ext?.[1]) {
    try {
      return decodeURIComponent(ext[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const basic = /filename="?([^";]+)"?/i.exec(header);
  if (basic?.[1]) return basic[1].trim();
  return undefined;
}

/**
 * Base64-encode bytes for the attachment wire shape, in Node OR the browser.
 * Uses `Buffer` when present (Node); otherwise builds a binary string in chunks
 * (avoiding call-stack overflow on large inputs) and `btoa`s it. Both branches
 * yield identical standard base64.
 */
export function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
