import { z } from 'zod';
import {
  MAX_ATTACHMENTS,
  STATUS_NOTE_MAX,
  STATUS_TTL_MIN,
  STATUS_TTL_MAX,
  PRESENCE_TTL_MAX,
  SUGGESTED_REPLIES_MAX,
  SUGGESTED_REPLY_LABEL_MAX,
  SUGGESTED_REPLY_VALUE_MAX,
  AGENT_NAME_MIN,
  AGENT_NAME_MAX,
  ROLE_TITLE_MAX,
  ROLE_INSTRUCTIONS_MAX,
  ORG_NAME_MIN,
  ORG_NAME_MAX,
  ORG_SLUG_MIN,
  ORG_SLUG_MAX,
  ROOM_NAME_MAX,
  ROOM_DESCRIPTION_MAX,
  INVITE_NOTE_MAX,
  INVITE_EXPIRY_DAYS_MIN,
  INVITE_EXPIRY_DAYS_MAX,
  ENROLLMENT_NOTE_MAX,
  DISPLAY_NAME_MIN,
  DISPLAY_NAME_MAX,
  PASSWORD_MIN_LENGTH,
  MESSAGES_LIST_MAX_LIMIT,
  HINT_TEXT_MAX,
  AGENT_NAME_RULE_MESSAGE,
  isWellFormedAgentName,
  EMAIL_SUBJECT_MAX,
  EMAIL_RECIPIENTS_MAX,
  EMAIL_TRUSTED_PATTERNS_MAX,
  EMAIL_TRUSTED_PATTERN_MIN,
  EMAIL_TRUSTED_PATTERN_MAX,
  EMAIL_TRUSTED_PATTERN_REGEX,
  EMAIL_JUDGE_PROMPT_MAX,
  JUDGE_REASON_MAX,
  ACTIVITY_SUMMARY_MAX,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_BODY_MAX,
} from './constants.js';

/**
 * Zod schemas + inferred TS types for every sparrow wire shape in SPEC v3.
 * This module is the single source of truth for wire types. Browser-safe
 * (zod only, no node imports).
 */

/* ================================================================== *
 * Primitives / enums
 * ================================================================== */

/** ISO-8601 UTC datetime string, e.g. `2026-08-20T17:00:00Z`. */
export const IsoDateTimeSchema = z.string().datetime();

/** A principal's kind. `Principal = Human | Agent`; a code/API term, never UI copy. */
export const PrincipalKindSchema = z.enum(['human', 'agent']);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

/** A member's role in its room. Roles above `member` require a human principal. */
export const RoomRoleSchema = z.enum(['owner', 'admin', 'member']);
export type RoomRole = z.infer<typeof RoomRoleSchema>;

/** A human's role in an org. Unrelated to room roles. */
export const OrgRoleSchema = z.enum(['owner', 'admin', 'member']);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

/** A message's fan-out kind. */
export const MessageKindSchema = z.enum(['dm', 'broadcast']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/** A room's kind: a many-member `project` room or a hidden two-principal `dm`. */
export const RoomKindSchema = z.enum(['project', 'dm']);
export type RoomKind = z.infer<typeof RoomKindSchema>;

/**
 * A **medium** — a way a principal is reached, each with its own native
 * semantics, tables, and routes. Mediums share layer-1 identity and the two
 * layer-3 contracts (work items, activity entries) and nothing else; there is
 * deliberately no generic `Medium` interface behind this enum.
 *
 * `system` is sparrow itself speaking — no tables or routes of its own, it
 * exists so timeline entries the PLATFORM writes (hint deliveries) have an
 * honest register instead of masquerading as chat.
 */
export const MediumSchema = z.enum(['chat', 'email', 'voice', 'system']);
export type Medium = z.infer<typeof MediumSchema>;

/**
 * Per-recipient read state — three-valued: `unread` → `received` → `read`.
 * `received` is server-observed delivery (the recipient's client has the
 * message), never a client-reported flag; `read` supersedes it.
 */
export const ReadStatusSchema = z.enum(['unread', 'received', 'read']);
export type ReadStatus = z.infer<typeof ReadStatusSchema>;

/** Error codes returned by every non-2xx response. */
export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'gone',
  'rate_limited',
  'payload_too_large',
  'client_upgrade_required',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/* ================================================================== *
 * Shared refs & validators
 * ================================================================== */

/** Compact reference to a human principal (`{ id, displayName }`). */
export const HumanRefSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});
export type HumanRef = z.infer<typeof HumanRefSchema>;

/**
 * A human with contact info (`{ id, displayName, email, avatarUrl }`) — org
 * directory/roster. `avatarUrl` is the server-resolved effective avatar (uploaded
 * → provider photo → gravatar when enabled → null); the client renders a
 * generated avatar when it is null.
 */
export const HumanContactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable().optional().default(null),
});
export type HumanContact = z.infer<typeof HumanContactSchema>;

/**
 * Agent-name validator (SPEC v4 — *Identity & addressing → Agent names &
 * addresses*). An agent's name IS the local part of its email address
 * (`<name>@<org-slug><EMAIL_ORG_SUFFIX>`), so v4 makes names email-safe: the
 * trimmed input must be lowercase, 1–60 characters, match
 * `/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/`, and contain no `..` anywhere.
 *
 * Scope of this schema is the **shape** rule only — the `400 bad_request` case.
 * The two `409 conflict` cases are deliberately NOT enforced here because they
 * are a different outcome the server must distinguish:
 *  - a RESERVED local part (see {@link isReservedAgentName});
 *  - a name already taken in the org (case-insensitive; server-side).
 */
export const AgentNameSchema = z
  .string()
  .trim()
  .min(AGENT_NAME_MIN)
  .max(AGENT_NAME_MAX)
  .refine((name) => isWellFormedAgentName(name), { message: AGENT_NAME_RULE_MESSAGE });
export type AgentName = z.infer<typeof AgentNameSchema>;

/* ---- Agent roles (a persistent job description on an agent) ---- *
 *
 * A role has two writable halves. `roleTitle` is a short, ORG-VISIBLE job label
 * (trimmed, ≤ ROLE_TITLE_MAX); `roleInstructions` is a long, PRIVATE markdown job
 * description (≤ ROLE_INSTRUCTIONS_MAX chars), readable only by the owner and the
 * agent itself. Either half is set by passing a string, or CLEARED by passing
 * `null`; an empty/whitespace-only string is treated as a clear, server-side. Both
 * halves are optional on every request body they appear in.
 */

/** A `roleTitle` value on a write body: a trimmed ≤60 string, or `null` to clear. */
export const RoleTitleSchema = z.string().trim().max(ROLE_TITLE_MAX).nullable();
export type RoleTitleInput = z.infer<typeof RoleTitleSchema>;

/** A `roleInstructions` value on a write body: a ≤16 KB markdown string, or `null` to clear. */
export const RoleInstructionsSchema = z.string().max(ROLE_INSTRUCTIONS_MAX).nullable();
export type RoleInstructionsInput = z.infer<typeof RoleInstructionsSchema>;

/**
 * Room-name validator: trimmed, a leading `#` run stripped, non-empty, ≤ 80 chars.
 *
 * `#name` is how people SAY a room's name out loud, and `sparrow room create
 * "#launch-readiness"` used to store the literal `#` — the sidebar prepends its
 * own, rendering `##launch-readiness`. So normalize instead of rejecting: trim →
 * drop the whole leading run of `#` → trim again, then enforce length. Only
 * LEADING hashes go (`a#b` survives); a name that is nothing but hashes
 * normalizes to empty and is rejected by `min(1)`, and the max is measured on
 * the normalized value. This feeds both create and rename, so it closes both.
 */
export const RoomNameSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^#+/, '').trim())
  .pipe(z.string().min(1).max(ROOM_NAME_MAX));
export type RoomName = z.infer<typeof RoomNameSchema>;

/** Org-name validator: 1–80 chars, trimmed. */
export const OrgNameSchema = z.string().trim().min(ORG_NAME_MIN).max(ORG_NAME_MAX);
export type OrgName = z.infer<typeof OrgNameSchema>;

/** Org-slug validator: lowercase `[a-z0-9-]`, 1–40 chars. */
export const OrgSlugSchema = z
  .string()
  .min(ORG_SLUG_MIN)
  .max(ORG_SLUG_MAX)
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens');
export type OrgSlug = z.infer<typeof OrgSlugSchema>;

/* ================================================================== *
 * Errors, paging, query helpers
 * ================================================================== */

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /**
     * Absolute URL of the human/agent-readable markdown docs for the endpoint
     * that failed, when it is a documented route (built from the request's own
     * origin, so self-hosted instances link to themselves). Additive — clients
     * that ignore it are unaffected.
     */
    docs: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/* ================================================================== *
 * Hints — mechanical, server-observed nudges taught through responses
 * ================================================================== */

/** A concrete next call a hint points at (method + path, optional example body). */
export const HintActionSchema = z.object({
  method: z.string(),
  path: z.string(),
  exampleBody: z.record(z.unknown()).optional(),
});
export type HintAction = z.infer<typeof HintActionSchema>;

/**
 * One hint: a short imperative nudge the server attaches to certain agent
 * responses to teach fuller use of the product. Purely mechanical (no LLM).
 * `docs` is an absolute URL built from the request's own origin.
 */
export const HintSchema = z.object({
  id: z.string(),
  text: z.string().max(HINT_TEXT_MAX),
  action: HintActionSchema.optional(),
  docs: z.string().optional(),
});
export type Hint = z.infer<typeof HintSchema>;

/** Agent-chosen coaching intensity for hints. */
export const HintLevelSchema = z.enum(['off', 'normal', 'aggressive']);
export type HintLevel = z.infer<typeof HintLevelSchema>;

/** One selectable hint level plus the copy explaining what choosing it means. */
export const HintPreferenceChoiceSchema = z.object({
  level: HintLevelSchema,
  summary: z.string(),
});
export type HintPreferenceChoice = z.infer<typeof HintPreferenceChoiceSchema>;

/** GET /me/hint-preferences response: the current level + the choice menu. */
export const HintPreferencesResponseSchema = z.object({
  level: HintLevelSchema,
  choices: z.array(HintPreferenceChoiceSchema),
});
export type HintPreferencesResponse = z.infer<typeof HintPreferencesResponseSchema>;

/** PUT /me/hint-preferences body: `{ level }`. */
export const UpdateHintPreferencesRequestSchema = z.object({
  level: HintLevelSchema,
});
export type UpdateHintPreferencesRequest = z.infer<typeof UpdateHintPreferencesRequestSchema>;

/**
 * `GET /me/hints` — the on-demand read of the same trigger engine that decorates
 * the pause (`sparrow tips`). Unlike the response-attached `hints`, this array is
 * ALWAYS present and MAY be empty: the caller asked a question, and `[]` is the
 * honest answer ("nothing right now"). Evaluating it is READ-ONLY — no delivery
 * is recorded and no cooldown is burned, so looking at your tips never suppresses
 * a hint you would otherwise have been handed at your next pause.
 */
export const MeHintsResponseSchema = z.object({
  hints: z.array(HintSchema),
});
export type MeHintsResponse = z.infer<typeof MeHintsResponseSchema>;

/** `{ ok: true }` — the shape every mutation-with-no-body endpoint returns. */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** Generic paged-response envelope: `{ items, nextCursor }`. */
export function pagedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export type PagedResponse<T> = { items: T[]; nextCursor: string | null };

/**
 * Generic TRANSCRIPT envelope: `{ items, nextBefore }`. The newest-first lists —
 * room history, the two activity timelines, the two email thread lists — read
 * backward from now and page with an id-valued `before` cursor instead of the
 * opaque `?cursor=`. `nextBefore` is the OLDEST returned id when more remain,
 * else `null` (feed it back as the next `before`).
 */
export function transcriptResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextBefore: z.string().nullable(),
  });
}
export type TranscriptResponse<T> = { items: T[]; nextBefore: string | null };

/** Generic unpaged list envelope: `{ items }`. */
export function listResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item) });
}
export type ListResponse<T> = { items: T[] };

/** Shared query params for paged list endpoints (`?limit=&cursor=`). */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/**
 * Shared query params for the newest-first transcript lists (`?limit=&before=`).
 * `before` is an ID cursor — the id of the oldest row already held — not the
 * opaque `?cursor=` of an ascending list.
 */
export const TranscriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().optional(),
});
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;

/** Query-string boolean: accepts real booleans plus "true"/"false"/"1"/"0". */
export const BoolishSchema = z.preprocess((v) => {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return v;
}, z.boolean());

/* ================================================================== *
 * Accounts & sessions
 * ================================================================== */

/**
 * The human's UI theme preference. `auto` follows the OS `prefers-color-scheme`
 * live; `dark` / `light` force that theme regardless of the system. Persisted
 * per-human (server-side) and mirrored to localStorage so the choice applies
 * before first paint. `.default('auto')` keeps the field backward-compatible on
 * the wire — a payload without `theme` parses to `auto`.
 */
export const ThemePreferenceSchema = z.enum(['auto', 'dark', 'light']);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

/** A human account (wire shape; never includes secrets). Role is per-org, not here. */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  provider: z.string(),
  /** UI theme preference; server always sends it, defaults to `auto`. */
  theme: ThemePreferenceSchema.default('auto'),
});
export type User = z.infer<typeof UserSchema>;

export const AuthProviderKindSchema = z.enum(['credentials', 'oauth-redirect']);
export type AuthProviderKind = z.infer<typeof AuthProviderKindSchema>;

/** Provider summary in GET /auth/config (what the web UI needs pre-login). */
export const AuthProviderInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: AuthProviderKindSchema,
  loginUrl: z.string().optional(),
  /**
   * When true, an instance has marked this (oauth-redirect) provider as its
   * primary sign-in path. Clients MAY auto-initiate it for low-friction flows
   * like invite acceptance instead of showing an explicit sign-in button.
   * Omitted/false by default — self-hosted instances are unaffected.
   */
  primary: z.boolean().optional(),
});
export type AuthProviderInfo = z.infer<typeof AuthProviderInfoSchema>;

/** GET /auth/config. */
export const AuthConfigResponseSchema = z.object({
  providers: z.array(AuthProviderInfoSchema),
  allowSignup: z.boolean(),
  /**
   * The NEXT signup would found this instance's first workspace, so a sign-up
   * form may offer a `orgName` field ("Workspace name") instead of letting the
   * founder discover `alice@example.com's org` after the fact.
   *
   * Present (and `true`) only while all three hold: signup is open, `auth.bootstrapFirstOrg`
   * is on, and no human exists yet. Omitted otherwise — so it never tells a
   * stranger anything they could not learn by simply signing up, which is the
   * bar `allowSignup` already sets on this unauthenticated route.
   */
  bootstrapOrg: z.boolean().optional(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponseSchema>;

/**
 * GET /auth/me → `{ user }`, where `user` is `null` for a caller that presented
 * NO credential. Being signed out is the answer to the question, not a failure:
 * a `401` there made the browser log a red line on every anonymous page load.
 * A credential that IS present but dead still 401s — see the route.
 */
export const AuthMeResponseSchema = z.object({
  user: UserSchema.nullable(),
});
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

/**
 * POST /auth/signup body. `.strict()` — an unknown key is a `400` naming it,
 * never a silent drop: the near-miss `{ name }` (instead of `displayName`) used
 * to create an account whose display name silently fell back to the email
 * address, with a `201` and no signal that anything had been ignored.
 */
export const SignupRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(PASSWORD_MIN_LENGTH),
    displayName: z.string().min(1).optional(),
    /**
     * Name for the workspace this signup FOUNDS — honored only when this is the
     * bootstrap signup (the first human, with `auth.bootstrapFirstOrg` on);
     * ignored entirely otherwise, since a later signup founds nothing.
     *
     * Deliberately NOT `OrgNameSchema`: a blank value must mean "I didn't fill
     * that in" and fall back to the possessive default (`Alice's org`), not
     * `400`. Only the length ceiling is enforced.
     */
    orgName: z.string().trim().max(ORG_NAME_MAX).optional(),
  })
  .strict();
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

/** POST /auth/login body. `.strict()` — see {@link SignupRequestSchema}. */
export const LoginRequestSchema = z
  .object({
    email: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * POST /auth/signup (201) / POST /auth/login (200) response body: the user plus
 * the freshly minted session token (`ses_...`, the same secret the cookie
 * carries) so CLIs can persist it.
 */
export const AuthSessionResponseSchema = z.object({
  user: UserSchema,
  token: z.string(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

/**
 * The caller's OWN effective presence, as carried on `GET /me` — "am I actually
 * online?" in one call. `online` is the spec's effective-online rule (an open
 * events stream OR an unexpired self-reported mark); `via` names which of the
 * two carries it right now (`'stream'` wins when both hold, `null` when
 * offline); `onlineUntil` is the mark's expiry when `via === 'mark'`, else
 * `null` — a stream has no expiry to report.
 */
export const MePresenceSchema = z.object({
  online: z.boolean(),
  via: z.enum(['stream', 'mark']).nullable(),
  onlineUntil: IsoDateTimeSchema.nullable(),
});
export type MePresence = z.infer<typeof MePresenceSchema>;

/** What a server that predates self-presence implies: plainly offline. */
const OFFLINE_PRESENCE: MePresence = { online: false, via: null, onlineUntil: null };

/**
 * GET /me → `{ principal }`, a discriminated union: a human account or an agent
 * (with its owning human). Both kinds carry the same `presence` block.
 */
export const MePrincipalSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('human'),
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    /** UI theme preference; server always sends it, defaults to `auto`. */
    theme: ThemePreferenceSchema.default('auto'),
    /** The caller's own effective presence. Defaulted so a pre-presence server still parses. */
    presence: MePresenceSchema.default(OFFLINE_PRESENCE),
  }),
  z.object({
    type: z.literal('agent'),
    id: z.string(),
    name: z.string(),
    orgId: z.string(),
    /**
     * The agent's DERIVED email address (`<name>@<org-slug><EMAIL_ORG_SUFFIX>`),
     * or `null` when the email medium is off. Never stored — a rename or a slug
     * change moves it, with no alias.
     */
    emailAddress: z.string().nullable().default(null),
    owner: HumanRefSchema,
    /**
     * The agent's OWN role, in full — both halves, because an agent reads its own
     * private instructions here (nobody else's `GET /me` exposes them). `roleTitle`
     * is the org-visible label; `roleInstructions` is the private markdown job
     * description; `roleUpdatedAt` is when the role last changed (drives the
     * re-read nudge). All `null` when the agent has no role. Defaulted so a
     * pre-role server still parses.
     */
    roleTitle: z.string().nullable().default(null),
    roleInstructions: z.string().nullable().default(null),
    roleUpdatedAt: IsoDateTimeSchema.nullable().default(null),
    /** The caller's own effective presence. Defaulted so a pre-presence server still parses. */
    presence: MePresenceSchema.default(OFFLINE_PRESENCE),
  }),
]);
export type MePrincipal = z.infer<typeof MePrincipalSchema>;

export const MeResponseSchema = z.object({ principal: MePrincipalSchema });
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * PATCH /me body — update the caller's human account. Both fields are optional,
 * but at least one must be present. Renaming (`displayName`) propagates live
 * (members render principal names live) and emits `member.updated` in every room
 * the human inhabits; a `theme` update is private to the caller. The response
 * reuses {@link MeResponseSchema} (`{ principal }`). `.strict()`: an unknown key
 * is a `400`, never a silent drop.
 */
export const UpdateMeRequestSchema = z
  .object({
    displayName: z.string().trim().min(DISPLAY_NAME_MIN).max(DISPLAY_NAME_MAX).optional(),
    theme: ThemePreferenceSchema.optional(),
  })
  .strict()
  .refine((body) => body.displayName !== undefined || body.theme !== undefined, {
    message: 'Provide at least one of displayName or theme',
  });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;

/**
 * PATCH /me body — AGENT principal. An agent mutates ITSELF: `name` is trimmed,
 * 1..AGENT_NAME_MAX, and must be org-unique (case-insensitive; a collision `409`s,
 * never auto-suffixed). It may also set its own ROLE — `roleTitle` (org-visible)
 * and/or `roleInstructions` (private), each a string to set or `null` to clear.
 * At least one field must be present. The response reuses {@link MeResponseSchema}
 * (`{ principal }`, the agent branch). The `agt_` id is the permanent identity;
 * `name` is display-layer and propagates live (`member.updated` in every room the
 * agent inhabits), and any role change nudges the agent to re-read it. `.strict()`:
 * an unknown key is a `400`, never a silent drop.
 */
export const UpdateMeAgentRequestSchema = z
  .object({
    name: AgentNameSchema.optional(),
    roleTitle: RoleTitleSchema.optional(),
    roleInstructions: RoleInstructionsSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.roleTitle !== undefined ||
      body.roleInstructions !== undefined,
    { message: 'Provide at least one of name, roleTitle or roleInstructions' },
  );
export type UpdateMeAgentRequest = z.infer<typeof UpdateMeAgentRequestSchema>;

/**
 * PUT/DELETE `/me/avatar` response: the caller's freshly resolved effective
 * `avatarUrl` after the mutation. Non-null after an upload; may be null after a
 * delete (falls back to provider photo → gravatar → null).
 */
export const AvatarMutationResponseSchema = z.object({
  avatarUrl: z.string().nullable().optional().default(null),
});
export type AvatarMutationResponse = z.infer<typeof AvatarMutationResponseSchema>;

/* ================================================================== *
 * Orgs
 * ================================================================== */

/** `invites.who` — who may create invites. */
export const OrgInvitesSettingsSchema = z
  .object({
    who: z.enum(['members', 'admins']).default('members'),
  })
  .strict();
export type OrgInvitesSettings = z.infer<typeof OrgInvitesSettingsSchema>;

/**
 * `enroll.*` — agent enrollment admission policy. Applies to AGENTS only: a
 * human holding a valid invite token is admitted immediately (the inviter has
 * already chosen them), so there is no human admission knob. Legacy `humans` /
 * `autoApproveEmailPatterns` keys on stored settings are stripped on read (see
 * `parseOrgSettings`).
 */
export const OrgEnrollSettingsSchema = z
  .object({
    agents: z.enum(['approval', 'open']).default('approval'),
  })
  .strict();
export type OrgEnrollSettings = z.infer<typeof OrgEnrollSettingsSchema>;

/** `rooms.create` — who may create rooms. */
export const OrgRoomsSettingsSchema = z
  .object({
    create: z.enum(['members', 'admins']).default('members'),
  })
  .strict();
export type OrgRoomsSettings = z.infer<typeof OrgRoomsSettingsSchema>;

/**
 * The org's policy for a party the trust set does not recognize:
 *  - `reject` (default) — refuse it outright;
 *  - `approve` — park it for a human (inbound `quarantined` / outbound `held`);
 *  - `judge` — ask the LLM judge; with no working judge this DEGRADES to
 *    `approve`, never to `allow` (SPEC → *The judge*).
 */
export const EmailUnrecognizedPolicySchema = z.enum(['reject', 'approve', 'judge']);
export type EmailUnrecognizedPolicy = z.infer<typeof EmailUnrecognizedPolicySchema>;

/**
 * One `email.trustedPatterns` glob — an always-trusted address pattern, e.g.
 * `*@partner.example.com`. `*` matches any run of characters, `?` matches one;
 * matching is case-insensitive over the whole address, with no regex and no
 * anchoring characters. Lowercased (and trimmed) on write.
 *
 * Rules: 3–200 chars, exactly one `@`, matching
 * {@link EMAIL_TRUSTED_PATTERN_REGEX}, and **no catch-alls** — every label of
 * the domain must carry ≥1 non-wildcard character. So `*`, `*@*`, `*@*.com` and
 * `*@*.example.com` are rejected while `*@partner.example.com` — the spec's own
 * canonical "trust everyone at a company" pattern — is accepted.
 *
 * NOTE: SPEC states the no-catch-all rule as "≥1 non-wildcard character on
 * **both** sides of the `@`", which would also reject `*@partner.example.com`,
 * contradicting the same document's trust-ladder example, the org-admin help
 * copy ("Use `*@partner.example.com` to trust everyone at a company"), and
 * scenario 135-email-trust. The per-domain-label reading satisfies every
 * concrete example the spec gives — the three it names as `400` AND the one it
 * names as valid — so it is the one implemented here.
 */
export const EmailTrustedPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(EMAIL_TRUSTED_PATTERN_MIN)
  .max(EMAIL_TRUSTED_PATTERN_MAX)
  .refine((p) => p.split('@').length === 2, { message: 'pattern must contain exactly one @' })
  .refine((p) => EMAIL_TRUSTED_PATTERN_REGEX.test(p), {
    message: 'pattern may only contain a-z, 0-9, . _ + - and the wildcards * ?',
  })
  .refine(
    (p) => {
      const domain = p.split('@')[1] ?? '';
      const labels = domain.split('.');
      return labels.every((label) => label.replace(/[*?]/g, '').length > 0);
    },
    { message: 'pattern must not be a catch-all: every part of the domain needs a real name' },
  );
export type EmailTrustedPattern = z.infer<typeof EmailTrustedPatternSchema>;

/**
 * `email.*` — the org's email trust policy (SPEC → *The email medium → Org
 * policy*). Validated whole with the rest of `settings`; policy changes are
 * forward-looking and never re-run against already-dispositioned email.
 */
export const OrgEmailSettingsSchema = z
  .object({
    /** Applies to unrecognized senders (authenticated or not) and spam-flagged mail. */
    inboundUnrecognized: EmailUnrecognizedPolicySchema.default('reject'),
    /** Applies when ≥1 outbound recipient is unrecognized. */
    outboundUnrecognized: EmailUnrecognizedPolicySchema.default('reject'),
    /** Always-trusted address globs; ≤50, de-duplicated on write. */
    trustedPatterns: z
      .array(EmailTrustedPatternSchema)
      .max(EMAIL_TRUSTED_PATTERNS_MAX)
      .transform((patterns) => [...new Set(patterns)])
      .default([]),
    /** Prepended to core's built-in judge prompt; never replaces it. */
    judgePrompt: z.string().trim().min(1).max(EMAIL_JUDGE_PROMPT_MAX).nullable().default(null),
  })
  .strict();
export type OrgEmailSettings = z.infer<typeof OrgEmailSettingsSchema>;

/**
 * An org's settings object (stored as JSON, always returned merged with
 * defaults). `OrgSettingsSchema.parse({})` yields the complete default object.
 * `.strict()` at every level → unknown keys `400`.
 */
export const OrgSettingsSchema = z
  .object({
    invites: OrgInvitesSettingsSchema.default(() => OrgInvitesSettingsSchema.parse({})),
    enroll: OrgEnrollSettingsSchema.default(() => OrgEnrollSettingsSchema.parse({})),
    rooms: OrgRoomsSettingsSchema.default(() => OrgRoomsSettingsSchema.parse({})),
    email: OrgEmailSettingsSchema.default(() => OrgEmailSettingsSchema.parse({})),
  })
  .strict();
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/**
 * The WRITE shape for `PATCH /orgs/:orgId { settings }` — a merge-patch, not a
 * replacement. Every key is optional at both levels and NO defaults are filled
 * in, so "absent" stays distinguishable from "set to the default value"; the
 * server merges what is present into the stored policy (see `mergeOrgSettings`).
 * `.strict()` survives `.partial()`, so an unknown key at either level is still
 * a `400`.
 *
 * Parsing `settings` with the full {@link OrgSettingsSchema} instead is what
 * made PATCH destructive: its per-key `.default()`s turned a one-group body into
 * a complete object that then overwrote the stored JSON, silently resetting
 * every group the caller never mentioned.
 */
export const OrgSettingsPatchSchema = z
  .object({
    invites: OrgInvitesSettingsSchema.partial().optional(),
    enroll: OrgEnrollSettingsSchema.partial().optional(),
    rooms: OrgRoomsSettingsSchema.partial().optional(),
    email: OrgEmailSettingsSchema.partial().optional(),
  })
  .strict();
export type OrgSettingsPatch = z.infer<typeof OrgSettingsPatchSchema>;

/** Compact org reference (`{ id, name, slug }`). */
export const OrgSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type OrgSummary = z.infer<typeof OrgSummarySchema>;

/** Minimal org reference (`{ id, name }`) as carried on agent-enrollment deliveries. */
export const OrgMiniSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type OrgMini = z.infer<typeof OrgMiniSchema>;

/** Full org resource (GET /orgs/:orgId → `{ org }`). */
export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: OrgSettingsSchema,
  createdAt: IsoDateTimeSchema,
});
export type Org = z.infer<typeof OrgSchema>;

export const GetOrgResponseSchema = z.object({ org: OrgSchema });
export type GetOrgResponse = z.infer<typeof GetOrgResponseSchema>;

/** POST /orgs body. */
export const CreateOrgRequestSchema = z.object({
  name: OrgNameSchema,
  slug: OrgSlugSchema.optional(),
});
export type CreateOrgRequest = z.infer<typeof CreateOrgRequestSchema>;

/** POST /orgs response (`201 { org }` — the GetOrg shape; caller becomes owner). */
export const CreateOrgResponseSchema = z.object({ org: OrgSchema });
export type CreateOrgResponse = z.infer<typeof CreateOrgResponseSchema>;

/**
 * PATCH /orgs/:orgId body: `{ name?, slug?, settings? }` (≥1 key). `settings` is
 * a MERGE-PATCH ({@link OrgSettingsPatchSchema}): keys present replace the stored
 * value at that key's level, keys absent are left alone, unknown keys `400`.
 *
 * `.strict()` at the ROOT too (it must precede `.refine()`, which wraps the
 * object): the root used to swallow unknown keys while `settings` was strict
 * inside, so `{"nme":"Typo"}` or a misspelled `setings` block returned `200` and
 * changed nothing — a silent no-op on exactly the requests most likely to be
 * hand-typed. An unknown key is now a `400` naming it.
 */
export const UpdateOrgRequestSchema = z
  .object({
    name: OrgNameSchema.optional(),
    slug: OrgSlugSchema.optional(),
    settings: OrgSettingsPatchSchema.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.slug !== undefined || v.settings !== undefined, {
    message: 'At least one field is required',
  });
export type UpdateOrgRequest = z.infer<typeof UpdateOrgRequestSchema>;

/** GET /me/orgs item: `{ org, role }`. */
export const MeOrgSchema = z.object({
  org: OrgSummarySchema,
  role: OrgRoleSchema,
});
export type MeOrg = z.infer<typeof MeOrgSchema>;

/**
 * GET /orgs/resolve/:slug — the slug→org seam. Session-authed; returns the org
 * summary plus the caller's role ONLY when the caller is a member. Non-members
 * and unknown slugs alike get `404` (orgs never leak their existence). Backs the
 * SPA's host/path-scoped boot: a fronting edge (or a `/orgs/:slug` path prefix)
 * names an org by slug, and the SPA maps it to the canonical org id here.
 */
export const ResolveOrgResponseSchema = z.object({
  org: OrgSummarySchema,
  role: OrgRoleSchema,
});
export type ResolveOrgResponse = z.infer<typeof ResolveOrgResponseSchema>;

/**
 * POST /admin/orgs body (admin-token only). `slug` is required (an operator
 * names the tenant); rules mirror POST /orgs (reserved/taken → 409, invalid →
 * 400).
 *
 * Two modes, chosen by `owner`:
 * - **owner-pending** (no `owner`): provision an org with NO members and return
 *   an owner invite whose redeemer becomes the first owner.
 * - **pre-provisioned owner** (`owner` present): create the org AND add
 *   `owner.email` as its `owner` (resolving an existing human by email, or
 *   creating one). No invite is minted.
 */
export const AdminCreateOrgRequestSchema = z.object({
  name: OrgNameSchema,
  slug: OrgSlugSchema,
  owner: z
    .object({
      // Trimmed before validation so a padded address is accepted and normalized
      // (the route lowercases it too); a malformed address still → 400.
      email: z.string().trim().email(),
      displayName: z.string().min(1).optional(),
    })
    .optional(),
});
export type AdminCreateOrgRequest = z.infer<typeof AdminCreateOrgRequestSchema>;

/**
 * POST /admin/orgs response: the created org (GetOrg shape) plus a `url`.
 *
 * - Owner-pending: `url` is the one-time owner-invite URL (the invite token
 *   appears ONCE, inside it) and `owner` is absent.
 * - Pre-provisioned owner: `url` is the org's base URL (effective-origin org
 *   host) and `owner` carries the resolved/created owner's id + email. Callers
 *   distinguish the two by the presence of `owner`.
 */
export const AdminCreateOrgResponseSchema = z.object({
  org: OrgSchema,
  url: z.string(),
  owner: z.object({ id: z.string(), email: z.string() }).optional(),
});
export type AdminCreateOrgResponse = z.infer<typeof AdminCreateOrgResponseSchema>;

export const MeOrgsResponseSchema = listResponseSchema(MeOrgSchema);
export type MeOrgsResponse = z.infer<typeof MeOrgsResponseSchema>;

/** GET /orgs/:orgId/humans item: `{ human, role, joinedAt }` (paged). */
export const OrgMembershipSchema = z.object({
  human: HumanContactSchema,
  role: OrgRoleSchema,
  joinedAt: IsoDateTimeSchema,
});
export type OrgMembership = z.infer<typeof OrgMembershipSchema>;

export const ListOrgHumansResponseSchema = pagedResponseSchema(OrgMembershipSchema);
export type ListOrgHumansResponse = z.infer<typeof ListOrgHumansResponseSchema>;

/** PATCH /orgs/:orgId/humans/:humanId body. */
export const SetOrgRoleRequestSchema = z.object({ role: OrgRoleSchema });
export type SetOrgRoleRequest = z.infer<typeof SetOrgRoleRequestSchema>;

/**
 * POST /orgs/:orgId/members body — an owner/admin adds a person to the org
 * directly by email (no invite round-trip). The email is trimmed before
 * validation (the route lowercases it too); a malformed address → 400. `role`
 * is any non-owner role (defaults to `member`); ownership transfers go through
 * role management, never a direct add, so `owner` is rejected.
 */
export const AddOrgMemberRequestSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['admin', 'member']).optional(),
});
export type AddOrgMemberRequest = z.infer<typeof AddOrgMemberRequestSchema>;

/**
 * POST /orgs/:orgId/members response: the added member (roster item shape) fused
 * with a standard org invite. `inviteUrl` carries a freshly minted `ivk_` token
 * (built the effective-origin way, so it lands on the org host) that the normal
 * invite-redemption flow accepts — the recipient may even sign in under a
 * different email and the token still admits them. `emailSent` reports whether
 * the invitation email actually went out (false when no email webhook is
 * configured or the hook failed — the caller can then share `inviteUrl` directly).
 */
export const AddOrgMemberResponseSchema = z.object({
  member: z.object({ human: HumanContactSchema, role: OrgRoleSchema }),
  inviteUrl: z.string(),
  emailSent: z.boolean(),
});
export type AddOrgMemberResponse = z.infer<typeof AddOrgMemberResponseSchema>;

/**
 * One roster entry on the admin (`X-Admin-Token`) member surface: `{ human, role }`
 * — the same shape as a session roster row minus `joinedAt`. Used by the
 * control-plane list + add responses.
 */
export const AdminOrgMemberSchema = z.object({ human: HumanContactSchema, role: OrgRoleSchema });
export type AdminOrgMember = z.infer<typeof AdminOrgMemberSchema>;

/** GET /admin/orgs/:orgId/members response — the full roster, unpaged. */
export const AdminListOrgMembersResponseSchema = z.object({
  members: z.array(AdminOrgMemberSchema),
});
export type AdminListOrgMembersResponse = z.infer<typeof AdminListOrgMembersResponseSchema>;

/**
 * POST /admin/orgs/:orgId/members response — the added member only. Unlike the
 * session add-by-email, the control-plane add mints NO invite and sends NO
 * email, so there is no `inviteUrl`/`emailSent`.
 */
export const AdminAddOrgMemberResponseSchema = z.object({ member: AdminOrgMemberSchema });
export type AdminAddOrgMemberResponse = z.infer<typeof AdminAddOrgMemberResponseSchema>;

/** DELETE /admin/orgs/:orgId/members/:humanId response. */
export const AdminRemoveOrgMemberResponseSchema = z.object({ removed: z.literal(true) });
export type AdminRemoveOrgMemberResponse = z.infer<typeof AdminRemoveOrgMemberResponseSchema>;

/** GET /orgs/:orgId/directory response (human search, capped at 25). */
export const DirectoryResponseSchema = listResponseSchema(HumanContactSchema);
export type DirectoryResponse = z.infer<typeof DirectoryResponseSchema>;

/** GET /orgs/:orgId/agents governance item: `{ agent, owner }` (a LIST, not visibility). */
export const OrgAgentGovernanceSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    /** The derived address, or `null` with the email medium off. */
    emailAddress: z.string().nullable().default(null),
    createdAt: IsoDateTimeSchema,
  }),
  owner: HumanRefSchema,
});
export type OrgAgentGovernance = z.infer<typeof OrgAgentGovernanceSchema>;

export const ListOrgAgentsResponseSchema = listResponseSchema(OrgAgentGovernanceSchema);
export type ListOrgAgentsResponse = z.infer<typeof ListOrgAgentsResponseSchema>;

/**
 * One entry in the HUMANS sidebar source (`GET /orgs/:orgId/me/humans`): humans
 * sharing ≥1 non-DM room or a DM with the caller, with principal-level presence.
 * `human` is a {@link HumanRef} (`{ id, displayName }`) — no email; full-org
 * reach lives behind `directory?q=`, not this list.
 */
export const SidebarHumanSchema = z.object({
  human: HumanRefSchema.extend({ avatarUrl: z.string().nullable().optional().default(null) }),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
});
export type SidebarHuman = z.infer<typeof SidebarHumanSchema>;

export const OrgMeHumansResponseSchema = listResponseSchema(SidebarHumanSchema);
export type OrgMeHumansResponse = z.infer<typeof OrgMeHumansResponseSchema>;

/* ================================================================== *
 * Invites
 * ================================================================== */

/** An invite as the issuer surface sees it (never carries the token). */
export const InviteSchema = z.object({
  id: z.string(),
  inviter: HumanRefSchema,
  note: z.string().nullable(),
  expiresAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Invite = z.infer<typeof InviteSchema>;

/** POST /orgs/:orgId/invites body. */
export const CreateInviteRequestSchema = z.object({
  note: z.string().max(INVITE_NOTE_MAX).optional(),
  expiresInDays: z
    .number()
    .int()
    .min(INVITE_EXPIRY_DAYS_MIN)
    .max(INVITE_EXPIRY_DAYS_MAX)
    .optional(),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

/** POST /orgs/:orgId/invites response: the token appears ONCE, inside `url`. */
export const CreateInviteResponseSchema = z.object({
  invite: InviteSchema,
  url: z.string(),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

export const ListInvitesResponseSchema = listResponseSchema(InviteSchema);
export type ListInvitesResponse = z.infer<typeof ListInvitesResponseSchema>;

/**
 * GET /invite/:token/info — browser-facing landing metadata for the SPA hero.
 * Reveals the org name plus the inviter's display name and email (shown next to
 * the name on the landing page); ids and slug are NOT surfaced. Invalid/expired/
 * revoked tokens `404` instead.
 */
export const InviteInfoResponseSchema = z.object({
  org: z.object({ name: z.string() }),
  inviter: z.object({ displayName: z.string(), email: z.string() }),
  agentPolicy: z.enum(['approval', 'open']),
});
export type InviteInfoResponse = z.infer<typeof InviteInfoResponseSchema>;

/* ================================================================== *
 * Enrollment
 * ================================================================== */

/** Enrollment kind — which principal a followed invite is minting. */
export const EnrollmentKindSchema = z.enum(['human', 'agent']);
export type EnrollmentKind = z.infer<typeof EnrollmentKindSchema>;

/** Lifecycle state of an enrollment. Denied AND expired both read `denied`. */
export const EnrollmentStatusSchema = z.enum(['pending', 'approved', 'denied']);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;

/** A compact enrollment reference returned to the enroller (`{ id, status }`). */
export const EnrollmentRefSchema = z.object({
  id: z.string(),
  status: EnrollmentStatusSchema,
});
export type EnrollmentRef = z.infer<typeof EnrollmentRefSchema>;

/** POST /invite/:token/enroll body — anonymous caller (mints an agent enrollment). */
export const EnrollAgentRequestSchema = z.object({
  name: AgentNameSchema,
  note: z.string().max(ENROLLMENT_NOTE_MAX).optional(),
});
export type EnrollAgentRequest = z.infer<typeof EnrollAgentRequestSchema>;

/** POST /invite/:token/enroll body — session caller (mints a human enrollment). */
export const EnrollHumanRequestSchema = z.object({
  note: z.string().max(ENROLLMENT_NOTE_MAX).optional(),
});
export type EnrollHumanRequest = z.infer<typeof EnrollHumanRequestSchema>;

/* ---- Agent principal resource (used by mint/poll/visibility/events) ---- */

/**
 * An agent's sharing mode — who, beyond explicit grants, can see & reach it:
 *  - `selected` (default): only humans the owner explicitly granted visibility;
 *  - `room-members`: any human currently co-member of ≥1 non-DM, non-archived
 *    room with the agent;
 *  - `org`: every human in the agent's org.
 * The explicit grant list stays meaningful in every mode (extra grants).
 */
export const AgentSharingModeSchema = z.enum(['selected', 'room-members', 'org']);
export type AgentSharingMode = z.infer<typeof AgentSharingModeSchema>;

/**
 * An agent resource. `online` is the OR across its open events streams;
 * `lastSeenAt` is null for a freshly minted agent that has never polled.
 * `sharing` is the agent-level sharing mode (see {@link AgentSharingModeSchema});
 * it defaults to `selected` so older payloads that predate the field still parse.
 */
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  /**
   * The agent's DERIVED email address (`<name>@<org-slug><EMAIL_ORG_SUFFIX>`), or
   * `null` when the email medium is off. It rides on the agent resource so every
   * human-facing surface renders it without composing the address itself; it is
   * public routing information, not a secret. Never stored — a rename (or an org
   * slug change) moves it immediately, with no alias and no grace window.
   */
  emailAddress: z.string().nullable().default(null),
  online: z.boolean(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
  sharing: AgentSharingModeSchema.default('room-members'),
  /**
   * The agent's ORG-VISIBLE role title — a short job label its owner or the agent
   * itself set, or `null` when it has no role. Rides on the agent resource so every
   * agent-facing surface (lists, badges, the wire Agent shape) renders it without a
   * second call. The role's INSTRUCTIONS are private and never appear here — only on
   * the agent's own `GET /me` and the owner's visibility-list entry. Defaulted so a
   * pre-role server still parses.
   */
  roleTitle: z.string().nullable().default(null),
  createdAt: IsoDateTimeSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

/** Anonymous enroll, `approval` policy (`202`): pending ref + one-time `enr_` token. */
export const EnrollAgentPendingResponseSchema = z.object({
  enrollment: EnrollmentRefSchema,
  enrollmentToken: z.string(),
});
export type EnrollAgentPendingResponse = z.infer<typeof EnrollAgentPendingResponseSchema>;

/** Anonymous enroll, `open` policy (`201`): the minted agent + one-time key + DM. */
export const EnrollAgentAdmittedResponseSchema = z.object({
  agent: AgentSchema,
  key: z.string(),
  org: OrgMiniSchema,
  dmRoomId: z.string(),
  /**
   * The newly minted agent's derived address when the email medium is on, else
   * `null` — so an agent learns it has a second medium at the moment it gets its
   * credential, with no extra call.
   */
  emailAddress: z.string().nullable().default(null),
});
export type EnrollAgentAdmittedResponse = z.infer<typeof EnrollAgentAdmittedResponseSchema>;

/** Session enroll admitted (`200` already-member / `201` via a valid invite): `{ org, role }`. */
export const EnrollHumanAdmittedResponseSchema = z.object({
  org: OrgSummarySchema,
  role: OrgRoleSchema,
});
export type EnrollHumanAdmittedResponse = z.infer<typeof EnrollHumanAdmittedResponseSchema>;

/** Session enroll pending (`202`): the session polls with its own credential. */
export const EnrollHumanPendingResponseSchema = z.object({
  enrollment: EnrollmentRefSchema,
});
export type EnrollHumanPendingResponse = z.infer<typeof EnrollHumanPendingResponseSchema>;

/* ---- Poll (GET /invite/:token/enrollments/:eid) ---- */

export const PollPendingResponseSchema = z.object({
  status: z.literal('pending'),
  retryAfterSeconds: z.number().int().positive(),
});
export type PollPendingResponse = z.infer<typeof PollPendingResponseSchema>;

/**
 * Approved agent enrollment. `key` is present on the FIRST poll only (delivered
 * exactly once, then cleared); later polls return the same shape WITHOUT `key`.
 */
export const PollApprovedAgentResponseSchema = z.object({
  status: z.literal('approved'),
  agent: AgentSchema,
  key: z.string().optional(),
  org: OrgMiniSchema,
  dmRoomId: z.string(),
  /**
   * The newly minted agent's derived address when the email medium is on, else
   * `null` — delivered alongside the key, so an agent learns about its second
   * medium in the same breath as its credential.
   */
  emailAddress: z.string().nullable().default(null),
});
export type PollApprovedAgentResponse = z.infer<typeof PollApprovedAgentResponseSchema>;

/** Approved human enrollment. */
export const PollApprovedHumanResponseSchema = z.object({
  status: z.literal('approved'),
  org: OrgSummarySchema,
  role: OrgRoleSchema,
});
export type PollApprovedHumanResponse = z.infer<typeof PollApprovedHumanResponseSchema>;

export const PollDeniedResponseSchema = z.object({
  status: z.literal('denied'),
});
export type PollDeniedResponse = z.infer<typeof PollDeniedResponseSchema>;

/**
 * PollEnrollment response. `status` is not enough to discriminate (agent and
 * human approvals differ), so this is a plain union.
 */
export const PollEnrollmentResponseSchema = z.union([
  PollPendingResponseSchema,
  PollApprovedAgentResponseSchema,
  PollApprovedHumanResponseSchema,
  PollDeniedResponseSchema,
]);
export type PollEnrollmentResponse = z.infer<typeof PollEnrollmentResponseSchema>;

/** A pending enrollment as an approver sees it (List + `enrollment.requested`). */
export const EnrollmentSummarySchema = z.object({
  id: z.string(),
  kind: EnrollmentKindSchema,
  /** The agent's proposed name (agent enrollments); null for humans. */
  proposedName: z.string().nullable(),
  note: z.string().nullable(),
  /** The account's email/display name (human enrollments). */
  email: z.string().optional(),
  displayName: z.string().optional(),
  inviter: HumanRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type EnrollmentSummary = z.infer<typeof EnrollmentSummarySchema>;

export const ListEnrollmentsResponseSchema = listResponseSchema(EnrollmentSummarySchema);
export type ListEnrollmentsResponse = z.infer<typeof ListEnrollmentsResponseSchema>;

/**
 * POST /orgs/:orgId/enrollments/:eid/approve body — approval is strictly yes/no.
 * The body is empty; the agent's proposed name (chosen at enroll) is final. Any
 * stray key (e.g. a legacy `name`) is ignored (stripped), consistent with the
 * house style for request bodies.
 */
export const ApproveEnrollmentRequestSchema = z.object({});
export type ApproveEnrollmentRequest = z.infer<typeof ApproveEnrollmentRequestSchema>;

/* ================================================================== *
 * Agents, visibility & sharing
 * ================================================================== */

/** POST /me/agents body. */
export const CreateAgentRequestSchema = z.object({
  orgId: z.string().min(1),
  name: AgentNameSchema,
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/** POST /me/agents (201) / POST /me/agents/:id/rotate (200): agent + one-time key. */
export const CreateAgentResponseSchema = z.object({
  agent: AgentSchema,
  key: z.string(),
});
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

/** A room membership of an owned agent, with the `mem_` id that detaches it. */
export const AgentRoomMembershipSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberId: z.string(),
});
export type AgentRoomMembership = z.infer<typeof AgentRoomMembershipSchema>;

/** A visibility grant on an owned agent (who it is shared with, and since when). */
export const AgentShareSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type AgentShare = z.infer<typeof AgentShareSchema>;

/** One visibility-list entry (GET /me/agents, GET /orgs/:orgId/me/agents). */
export const VisibilityAgentSchema = z.object({
  agent: AgentSchema,
  owner: HumanRefSchema,
  /** Who shared the agent with the caller; null when the caller is the owner. */
  sharedBy: HumanRefSchema.nullable(),
  /**
   * The agent's room memberships (`memberId` enables detach via RemoveMember) —
   * present for OWNED agents only; absent on agents shared to the caller.
   */
  rooms: z.array(AgentRoomMembershipSchema).optional(),
  /**
   * Who the agent is shared with (backs the owner's share management) — present
   * for OWNED agents only; absent on agents shared to the caller.
   */
  sharedWith: z.array(AgentShareSchema).optional(),
  /**
   * The agent's unread email — delivered inbound mail with no `read_at` — so the
   * AGENTS badge can fold chat and mail into one number without walking every
   * thread. `null` for an agent the caller does not OWN (mail is correspondence,
   * not room data) and `null` for everyone when the medium is off. Defaulted so a
   * pre-count server still parses.
   */
  emailUnreadCount: z.number().int().nonnegative().nullable().default(null),
  /**
   * The agent's PRIVATE role instructions — the markdown job description only the
   * owner and the agent itself may read. Present (as a string, or `null` when the
   * agent has no instructions) for OWNED agents only; always `null` on an agent
   * shared to the caller, mirroring the isOwner-only `rooms`/`sharedWith` extras.
   * The org-visible `roleTitle` rides on `agent`, so a non-owner still sees the
   * label — just never the body. Defaulted so a pre-role server still parses.
   */
  roleInstructions: z.string().nullable().default(null),
});
export type VisibilityAgent = z.infer<typeof VisibilityAgentSchema>;

export const ListAgentsResponseSchema = listResponseSchema(VisibilityAgentSchema);
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

/** GET /me/agents query (`?org=` optional — all orgs when absent). */
export const ListAgentsQuerySchema = z.object({ org: z.string().optional() });
export type ListAgentsQuery = z.infer<typeof ListAgentsQuerySchema>;

/** POST /me/agents/:id/share body — target by `usr_...` id or email. */
export const ShareAgentRequestSchema = z.object({ human: z.string().min(1) });
export type ShareAgentRequest = z.infer<typeof ShareAgentRequestSchema>;

/**
 * PATCH /me/agents/:id body — owner-only. Change the agent's `sharing` mode,
 * `name`, and/or its ROLE — `roleTitle` (org-visible) and/or `roleInstructions`
 * (private), each a string to set or `null` to clear (at least one field required).
 * A `name` is trimmed, 1..AGENT_NAME_MAX, and org-unique case-insensitively — an
 * explicit rename that collides `409`s (never auto-suffixed). Renaming propagates
 * live (`member.updated` in every room the agent inhabits); a role change nudges
 * the agent to re-read it. The `agt_` id is the permanent identity.
 */
export const UpdateAgentRequestSchema = z
  .object({
    sharing: AgentSharingModeSchema.optional(),
    name: AgentNameSchema.optional(),
    roleTitle: RoleTitleSchema.optional(),
    roleInstructions: RoleInstructionsSchema.optional(),
  })
  .refine(
    (body) =>
      body.sharing !== undefined ||
      body.name !== undefined ||
      body.roleTitle !== undefined ||
      body.roleInstructions !== undefined,
    { message: 'Provide at least one of sharing, name, roleTitle or roleInstructions' },
  );
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

/** PATCH /me/agents/:id (200): the updated agent resource. */
export const UpdateAgentResponseSchema = z.object({ agent: AgentSchema });
export type UpdateAgentResponse = z.infer<typeof UpdateAgentResponseSchema>;

/* ================================================================== *
 * Rooms & members
 * ================================================================== */

/**
 * A room's settings object (stored as JSON, always returned merged with
 * defaults). `RoomSettingsSchema.parse({})` yields the complete default object.
 * `.strict()` → unknown keys `400`.
 */
export const RoomSettingsSchema = z
  .object({
    description: z.string().trim().max(ROOM_DESCRIPTION_MAX).default(''),
  })
  .strict();
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

/** Full room resource (GetRoom: `{ id, orgId, name, kind, archivedAt, settings }`). */
export const RoomSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  kind: RoomKindSchema,
  archivedAt: IsoDateTimeSchema.nullable(),
  settings: RoomSettingsSchema,
});
export type Room = z.infer<typeof RoomSchema>;

export const GetRoomResponseSchema = RoomSchema;
export type GetRoomResponse = z.infer<typeof GetRoomResponseSchema>;

/** POST /orgs/:orgId/rooms body. */
export const CreateRoomRequestSchema = z.object({ name: RoomNameSchema });
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

/** POST /orgs/:orgId/rooms response (creator's member row is created as `owner`). */
export const CreateRoomResponseSchema = z.object({ room: RoomSchema });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

/** PATCH /rooms/:roomId body: any subset of `{ name, settings, archived }`, ≥1 key. */
export const UpdateRoomRequestSchema = z
  .object({
    name: RoomNameSchema.optional(),
    settings: RoomSettingsSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.settings !== undefined || v.archived !== undefined,
    { message: 'At least one field is required' },
  );
export type UpdateRoomRequest = z.infer<typeof UpdateRoomRequestSchema>;

/**
 * PATCH /rooms/:roomId response. Enveloped as `{ room }`, matching
 * {@link CreateRoomResponseSchema} — a mutation wraps its resource. (The bare
 * room stays the GET shape; `PATCH` used to answer bare too, so the same resource
 * arrived in two shapes on adjacent calls.)
 */
export const UpdateRoomResponseSchema = z.object({ room: RoomSchema });
export type UpdateRoomResponse = z.infer<typeof UpdateRoomResponseSchema>;

/* ---------------- Org room governance (owner/admin) ---------------- */

/**
 * One row of `GET /orgs/:orgId/rooms` — the org owner/admin's governance view
 * of a room they need not be a member of. Deliberately a SUMMARY, not the room
 * resource: no settings, and above all no messages. Governance is "what rooms
 * exist and are they still live", never "what was said in them".
 */
export const OrgRoomSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: RoomKindSchema,
  memberCount: z.number().int().nonnegative(),
  archivedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type OrgRoomSummary = z.infer<typeof OrgRoomSummarySchema>;

/** `GET /orgs/:orgId/rooms` — every project room in the org, newest first. */
export const ListOrgRoomsResponseSchema = listResponseSchema(OrgRoomSummarySchema);
export type ListOrgRoomsResponse = z.infer<typeof ListOrgRoomsResponseSchema>;

/**
 * `PATCH /orgs/:orgId/rooms/:roomId` body — archive/restore only. The
 * governance route is not a second room editor: name and settings belong to the
 * room's own members.
 */
export const UpdateOrgRoomRequestSchema = z.object({ archived: z.boolean() }).strict();
export type UpdateOrgRoomRequest = z.infer<typeof UpdateOrgRoomRequestSchema>;

/** `PATCH /orgs/:orgId/rooms/:roomId` → the updated governance summary. */
export const UpdateOrgRoomResponseSchema = z.object({ room: OrgRoomSummarySchema });
export type UpdateOrgRoomResponse = z.infer<typeof UpdateOrgRoomResponseSchema>;

/**
 * A member: a principal's presence in one room. `displayName` is live (from the
 * principal). `avatarUrl` is the server-resolved effective avatar for a human
 * member, and always `null` for an agent (agent avatars are generated client-side).
 */
export const MemberSchema = z.object({
  id: z.string(),
  kind: PrincipalKindSchema,
  principalId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional().default(null),
  roomRole: RoomRoleSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Member = z.infer<typeof MemberSchema>;

/**
 * A MemberRef's `kind`. Widens {@link PrincipalKindSchema} with `'unknown'` — the
 * honest answer for a historical ref whose principal can no longer be identified
 * at all. A ref is never *guessed* into `'human'`: a message written by an agent
 * stays `kind: 'agent'` forever, and something genuinely unresolvable says so.
 * Only a pre-identity-snapshot row whose member row is also gone can produce it.
 */
export const MemberRefKindSchema = z.enum(['human', 'agent', 'unknown']);
export type MemberRefKind = z.infer<typeof MemberRefKindSchema>;

/**
 * Compact member reference embedded in messages/events (`{ id, kind, displayName,
 * avatarUrl }`). `avatarUrl` is the server-resolved effective avatar for a human,
 * `null` for an agent (agent avatars are generated client-side).
 *
 * A ref is IDENTITY, not membership: it keeps rendering the principal that wrote
 * or received the message after that principal leaves the room or is destroyed
 * (`displayName` stays live while the principal exists, then falls back to the
 * name captured when the message was written).
 */
export const MemberRefSchema = z.object({
  id: z.string(),
  kind: MemberRefKindSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional().default(null),
  /**
   * The stable PRINCIPAL id (`agt_…`/`usr_…`) behind this per-room member. Rides
   * alongside the room-scoped `id` (`mem_…`) so clients can seed the deterministic
   * procedural avatar off identity, not membership — otherwise one agent draws a
   * different bird in every room. Additive/optional: pre-avatar-fix servers omit
   * it and old cached payloads still parse.
   */
  principalId: z.string().optional(),
});
export type MemberRef = z.infer<typeof MemberRefSchema>;

/** GetMember / Whoami return the bare Member resource. */
export const GetMemberResponseSchema = MemberSchema;
export type GetMemberResponse = z.infer<typeof GetMemberResponseSchema>;

export const WhoamiResponseSchema = MemberSchema;
export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;

export const ListMembersResponseSchema = pagedResponseSchema(MemberSchema);
export type ListMembersResponse = z.infer<typeof ListMembersResponseSchema>;

/** POST /rooms/:roomId/members body — agents only; caller must hold visibility. */
export const AddMemberRequestSchema = z.object({ principal: z.string().min(1) });
export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

/** AddMember / SetMemberRole response: `{ member }`. */
export const MemberResponseSchema = z.object({ member: MemberSchema });
export type MemberResponse = z.infer<typeof MemberResponseSchema>;

/** PATCH /rooms/:roomId/members/:id body. */
export const SetMemberRoleRequestSchema = z.object({ roomRole: RoomRoleSchema });
export type SetMemberRoleRequest = z.infer<typeof SetMemberRoleRequestSchema>;

/* ---- Room invitations ---- */

export const RoomInvitationStatusSchema = z.enum(['pending', 'accepted', 'declined']);
export type RoomInvitationStatus = z.infer<typeof RoomInvitationStatusSchema>;

/** POST /rooms/:roomId/invitations body — target by `usr_...` id or email. */
export const InviteHumanRequestSchema = z.object({ human: z.string().min(1) });
export type InviteHumanRequest = z.infer<typeof InviteHumanRequestSchema>;

/** A room invitation as the room-admin surface sees it (who was invited). */
export const RoomInvitationAdminSchema = z.object({
  id: z.string(),
  human: HumanRefSchema,
  invitedBy: HumanRefSchema,
  status: RoomInvitationStatusSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
});
export type RoomInvitationAdmin = z.infer<typeof RoomInvitationAdminSchema>;

/** InviteHuman response: `{ invitation }` (201 new, 200 dedup'd). */
export const InviteHumanResponseSchema = z.object({ invitation: RoomInvitationAdminSchema });
export type InviteHumanResponse = z.infer<typeof InviteHumanResponseSchema>;

export const ListRoomInvitationsResponseSchema = listResponseSchema(RoomInvitationAdminSchema);
export type ListRoomInvitationsResponse = z.infer<typeof ListRoomInvitationsResponseSchema>;

/** A room invitation as the INVITEE sees it (GET /me/room-invitations, `room.invitation`). */
export const RoomInvitationSchema = z.object({
  id: z.string(),
  room: z.object({ id: z.string(), name: z.string(), orgId: z.string() }),
  invitedBy: HumanRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type RoomInvitation = z.infer<typeof RoomInvitationSchema>;

export const ListMeRoomInvitationsResponseSchema = listResponseSchema(RoomInvitationSchema);
export type ListMeRoomInvitationsResponse = z.infer<typeof ListMeRoomInvitationsResponseSchema>;

/** POST /me/room-invitations/:id/accept response. */
export const AcceptRoomInvitationResponseSchema = z.object({
  room: RoomSchema,
  member: MemberSchema,
});
export type AcceptRoomInvitationResponse = z.infer<typeof AcceptRoomInvitationResponseSchema>;

/* ---- /me/rooms ---- */

/**
 * The DM counterpart — the other principal in a DM room. `avatarUrl` is the
 * server-resolved effective avatar for a human counterpart, `null` for an agent.
 */
export const DmCounterpartSchema = z.object({
  type: PrincipalKindSchema,
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional().default(null),
});
export type DmCounterpart = z.infer<typeof DmCounterpartSchema>;

/** One membership row in GET /me/rooms. */
export const MeRoomSchema = z.object({
  room: z.object({
    id: z.string(),
    name: z.string(),
    orgId: z.string(),
    kind: RoomKindSchema,
    archivedAt: IsoDateTimeSchema.nullable(),
    /** The DM counterpart; present only for `kind: 'dm'` rooms. */
    counterpart: DmCounterpartSchema.optional(),
  }),
  memberId: z.string(),
  roomRole: RoomRoleSchema,
});
export type MeRoom = z.infer<typeof MeRoomSchema>;

export const MeRoomsResponseSchema = listResponseSchema(MeRoomSchema);
export type MeRoomsResponse = z.infer<typeof MeRoomsResponseSchema>;

/* ================================================================== *
 * Direct conversations (DMs)
 * ================================================================== */

/** POST /me/dms body. `orgId` is required only when the pair shares >1 org. */
export const EnsureDmRequestSchema = z.object({
  principal: z.string().min(1),
  orgId: z.string().optional(),
});
export type EnsureDmRequest = z.infer<typeof EnsureDmRequestSchema>;

/** POST /me/dms response (`201` first create, `200` afterwards). */
export const EnsureDmResponseSchema = z.object({
  room: z.object({
    id: z.string(),
    kind: z.literal('dm'),
    orgId: z.string(),
  }),
  counterpart: DmCounterpartSchema,
  memberId: z.string(),
});
export type EnsureDmResponse = z.infer<typeof EnsureDmResponseSchema>;

/* ================================================================== *
 * Messages
 * ================================================================== */

/** Attachment metadata as returned inside a full Message. */
export const AttachmentMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/** Attachment upload payload on SendMessage. */
export const AttachmentInputSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string(),
});
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

/** A one-tap reply suggestion as it rides on a full Message (`value` always present). */
export const SuggestedReplySchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type SuggestedReply = z.infer<typeof SuggestedReplySchema>;

/** A suggested reply as accepted on SendMessage input (`value` defaults to `label`). */
export const SuggestedReplyInputSchema = z
  .object({
    label: z.string().min(1).max(SUGGESTED_REPLY_LABEL_MAX),
    value: z.string().max(SUGGESTED_REPLY_VALUE_MAX).optional(),
  })
  .transform((v): SuggestedReply => ({ label: v.label, value: v.value ?? v.label }));
export type SuggestedReplyInput = z.input<typeof SuggestedReplyInputSchema>;

/** How a message body was authored. `'voice'` = derived from speech (STT); absent/null = typed. */
export const MessageOriginSchema = z.enum(['voice']);
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;

/** Full message. `from`/`to` are MemberRefs. */
export const MessageSchema = z.object({
  id: z.string(),
  from: MemberRefSchema,
  to: z.array(MemberRefSchema),
  kind: MessageKindSchema,
  subject: z.string().nullable(),
  body: z.string(),
  attachments: z.array(AttachmentMetaSchema),
  suggestedReplies: z.array(SuggestedReplySchema),
  inReplyTo: z.string().nullable(),
  replyValue: z.string().nullable(),
  // Defaulted (not required) so new clients tolerate pre-voice servers whose
  // messages omit the field; new servers always emit it.
  origin: MessageOriginSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

/** Truncated inbox preview item (triage view). */
export const InboxItemSchema = z.object({
  id: z.string(),
  from: MemberRefSchema,
  kind: MessageKindSchema,
  subject: z.string().nullable(),
  preview: z.string(),
  truncated: z.boolean(),
  attachmentCount: z.number().int().nonnegative(),
  status: ReadStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** POST /rooms/:roomId/messages body. */
export const SendMessageRequestSchema = z
  .object({
    /**
     * Optional and IGNORED for targeting. Every message in a room reaches the
     * whole room (a project room broadcasts to all current members; a `dm` room
     * reaches the one counterpart). Accepted for backward compatibility with old
     * clients that still pass a member id or `'all'`, but never used to target.
     */
    to: z.string().min(1).optional(),
    subject: z.string().optional(),
    body: z.string(),
    attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS).optional(),
    suggestedReplies: z
      .array(SuggestedReplyInputSchema)
      .min(1)
      .max(SUGGESTED_REPLIES_MAX)
      .optional(),
    inReplyTo: z.string().min(1).optional(),
    replyValue: z.string().optional(),
    origin: MessageOriginSchema.optional(),
  })
  .refine((v) => v.replyValue === undefined || v.inReplyTo !== undefined, {
    message: 'replyValue requires inReplyTo',
    path: ['replyValue'],
  });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * POST /rooms/:roomId/messages response: `{ message, unreadCount }`.
 *
 * `hints` is **RESERVED and never populated** since v0.1.7. Hints attach only to
 * the PAUSE — the `{ item: null }` response of `POST /me/inbox/pop` — because a
 * send is the middle of a task, and coaching an agent mid-task is exactly the
 * interruption the hint engine exists to avoid. The field stays on the schema so
 * a new client still parses an OLD server's hinted send response rather than
 * dropping it on the floor.
 */
export const SendMessageResponseSchema = z.object({
  message: MessageSchema,
  unreadCount: z.number().int().nonnegative(),
  hints: z.array(HintSchema).optional(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

/** GET /rooms/:roomId/inbox query (`?all=&limit=&cursor=`). */
export const ListInboxQuerySchema = PageQuerySchema.extend({
  all: BoolishSchema.optional(),
});
export type ListInboxQuery = z.infer<typeof ListInboxQuerySchema>;

export const ListInboxResponseSchema = pagedResponseSchema(InboxItemSchema);
export type ListInboxResponse = z.infer<typeof ListInboxResponseSchema>;

/**
 * Optional body for POST /rooms/:roomId/inbox/pop and POST /me/inbox/pop (ack
 * sugar). `ack: true` is the switch that advertises a `working` status while you
 * handle the popped message; `note`/`ttlSeconds` only refine that status and are
 * meaningless without it — passing either WITHOUT `ack: true` is rejected rather
 * than silently ignored (a trap that looked like it set a status but did not).
 */
export const PopNextMessageRequestSchema = z
  .object({
    ack: z.boolean().optional(),
    note: z.string().max(STATUS_NOTE_MAX).optional(),
    ttlSeconds: z.number().int().min(STATUS_TTL_MIN).max(STATUS_TTL_MAX).optional(),
  })
  .refine((v) => v.ack === true || (v.note === undefined && v.ttlSeconds === undefined), {
    message: 'note/ttlSeconds require ack: true',
  });
export type PopNextMessageRequest = z.infer<typeof PopNextMessageRequestSchema>;

/** POST /rooms/:roomId/inbox/pop response: `{ message: Message | null }`. */
export const PopNextMessageResponseSchema = z.object({
  message: MessageSchema.nullable(),
});
export type PopNextMessageResponse = z.infer<typeof PopNextMessageResponseSchema>;

/** GET /rooms/:roomId/messages/:id query (`?peek=`). */
export const ReadMessageQuerySchema = z.object({
  peek: BoolishSchema.optional(),
});
export type ReadMessageQuery = z.infer<typeof ReadMessageQuerySchema>;

/** GET /rooms/:roomId/messages/:id response: `{ message }`. */
export const ReadMessageResponseSchema = z.object({ message: MessageSchema });
export type ReadMessageResponse = z.infer<typeof ReadMessageResponseSchema>;

/** GET /rooms/:roomId/outbox — paged bare Messages. */
export const ListOutboxQuerySchema = PageQuerySchema;
export type ListOutboxQuery = z.infer<typeof ListOutboxQuerySchema>;

export const ListOutboxResponseSchema = pagedResponseSchema(MessageSchema);
export type ListOutboxResponse = z.infer<typeof ListOutboxResponseSchema>;

/**
 * GET /rooms/:roomId/messages query — the room message-history list. `limit`
 * defaults server-side (see {@link MESSAGES_LIST_DEFAULT_LIMIT}); `before` is a
 * message-id cursor (return messages strictly older than it, newest-first).
 * Distinct from {@link PageQuerySchema}: its own limit bounds and a message-id
 * `before` cursor rather than the opaque `cursor`.
 */
export const ListRoomMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MESSAGES_LIST_MAX_LIMIT).optional(),
  before: z.string().min(1).optional(),
});
export type ListRoomMessagesQuery = z.infer<typeof ListRoomMessagesQuerySchema>;

/**
 * GET /rooms/:roomId/messages response: full Messages newest-first, plus a
 * `nextBefore` message-id cursor (the oldest returned id, or `null` when the
 * window reaches the start of the caller-visible history). Listing writes no
 * read state — it is a peek.
 */
export const ListRoomMessagesResponseSchema = z.object({
  items: z.array(MessageSchema),
  nextBefore: z.string().nullable(),
});
export type ListRoomMessagesResponse = z.infer<typeof ListRoomMessagesResponseSchema>;

/** Per-recipient status entry inside a MessageStatus (MemberRef + read state). */
export const RecipientStatusSchema = MemberRefSchema.extend({
  status: ReadStatusSchema,
  // Defaulted (not required) so new clients tolerate pre-received servers whose
  // status entries omit the field; new servers always emit it.
  receivedAt: IsoDateTimeSchema.nullable().default(null),
  readAt: IsoDateTimeSchema.nullable(),
});
export type RecipientStatus = z.infer<typeof RecipientStatusSchema>;

/** GET /rooms/:roomId/messages/:id/status response. */
export const MessageStatusSchema = z.object({
  id: z.string(),
  kind: MessageKindSchema,
  createdAt: IsoDateTimeSchema,
  recipients: z.array(RecipientStatusSchema),
});
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const GetMessageStatusResponseSchema = MessageStatusSchema;
export type GetMessageStatusResponse = z.infer<typeof GetMessageStatusResponseSchema>;

/* ================================================================== *
 * Drafts (personal, room-scoped)
 * ================================================================== */

/**
 * A saved message draft. Personal to its authoring member and scoped to one
 * room; only the author ever lists or deletes it. `text` is stored trimmed.
 */
export const DraftSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type Draft = z.infer<typeof DraftSchema>;

/**
 * POST /rooms/:roomId/drafts body. `text` is trimmed and must be non-empty; the
 * byte cap (same as a message body, `MAX_BODY_BYTES`) is enforced server-side.
 */
export const CreateDraftRequestSchema = z.object({
  text: z.string().trim().min(1),
});
export type CreateDraftRequest = z.infer<typeof CreateDraftRequestSchema>;

/** POST /rooms/:roomId/drafts response: `{ draft }`. */
export const CreateDraftResponseSchema = z.object({ draft: DraftSchema });
export type CreateDraftResponse = z.infer<typeof CreateDraftResponseSchema>;

/** GET /rooms/:roomId/drafts response: the caller's own drafts, oldest first. */
export const ListDraftsResponseSchema = listResponseSchema(DraftSchema);
export type ListDraftsResponse = z.infer<typeof ListDraftsResponseSchema>;

/* ================================================================== *
 * The email medium (layer 2)
 *
 * The medium is entirely dormant unless the operator configures it: every
 * `/me/email/*` and `/orgs/:orgId/email/*` route `404`s and `GET /capabilities`
 * reports `email: false`. Nothing below is optional-by-configuration on the
 * wire — these are the shapes the routes speak WHEN the medium is on.
 * ================================================================== */

/** An email's direction. Direction, not sender identity, decides which pipeline ran. */
export const EmailDirectionSchema = z.enum(['in', 'out']);
export type EmailDirection = z.infer<typeof EmailDirectionSchema>;

/**
 * The terminal or pending state of one email:
 * `delivered` | `quarantined` | `rejected` (inbound),
 * `sent` | `held` | `rejected` | `send-failed` (outbound). The quarantine/hold
 * queue IS the set of rows in `quarantined`/`held` — there is no approvals table.
 */
export const EmailDispositionSchema = z.enum([
  'delivered',
  'quarantined',
  'rejected',
  'held',
  'sent',
  'send-failed',
]);
export type EmailDisposition = z.infer<typeof EmailDispositionSchema>;

/**
 * The ONE reason vocabulary in the system (SPEC → *The email medium → Reasons*).
 * A short stable slug for UI copy and tests, never prose; `null` on a clean
 * `delivered`/`sent`. Every wire surface that carries a reason — the approvals
 * queue, `EmailPreview`, the `email.*` events, the CLI, the web cards — carries
 * this slug verbatim. There is no second enum and no mapping layer.
 */
export const EmailReasonSchema = z.enum([
  /** inbound step 5 — `verification.virus === 'fail'` */
  'virus',
  /** inbound step 6 / outbound step 2 — a `blocked` contact */
  'blocked',
  /** inbound step 7 — unauthenticated, but the From would match the trust set */
  'spoof',
  /** inbound step 7½ — `dmarc: fail`: the sender's own domain policy says reject */
  'auth-failed',
  /** inbound step 9 — a spam verdict diverted the message from the fast path */
  'spam',
  /** inbound steps 10–11 — an inbound sender outside the trust set */
  'unrecognized-sender',
  /** outbound step 4 — ≥1 outbound recipient outside the trust set */
  'unrecognized-recipient',
  /** the judge returned `deny` (either direction) */
  'judge-deny',
  /** a `judge` policy degraded to `approve` — no judge, or one that could not answer */
  'judge-unavailable',
  /** a human denied a `quarantined`/`held` email */
  'denied',
  /** outbound relay refused or failed — disposition `send-failed` */
  'relay-error',
]);
export type EmailReason = z.infer<typeof EmailReasonSchema>;

/**
 * Email read state is **two-valued** (`unread` → `read`), keyed by the single
 * nullable `emails.read_at`. There is no `received`: SMTP delivery is not
 * sparrow's to witness, and an email has exactly one addressee inside sparrow
 * (its anchor agent), so there is no fan-out to track.
 */
export const EmailReadStatusSchema = z.enum(['unread', 'read']);
export type EmailReadStatus = z.infer<typeof EmailReadStatusSchema>;

/**
 * An external contact's org-scoped trust state. The third value — unknown — is
 * carried as `null` by the field, never as a member of this enum.
 */
export const ContactTrustSchema = z.enum(['approved', 'blocked']);
export type ContactTrust = z.infer<typeof ContactTrustSchema>;

/** An SPF/DKIM/DMARC verdict computed at the mail edge. */
export const EmailAuthResultSchema = z.enum(['pass', 'fail', 'none']);
export type EmailAuthResult = z.infer<typeof EmailAuthResultSchema>;

/** An optional spam/virus verdict computed at the mail edge. */
export const EmailScanResultSchema = z.enum(['pass', 'fail']);
export type EmailScanResult = z.infer<typeof EmailScanResultSchema>;

/**
 * One party on an email. `principalId` is set when the address resolved to a
 * human account email or an agent address in the org; `contactId` when it
 * resolved to an `external_contacts` row. Both absent/null = an address seen
 * once and never trusted.
 */
export const PartySchema = z.object({
  email: z.string().min(1),
  name: z.string().nullable().optional(),
  principalId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
});
export type Party = z.infer<typeof PartySchema>;

/**
 * The edge's authentication verdicts for an INBOUND email (always `null` on
 * outbound — the org signs its own mail, so there is nothing to spoof-check).
 * `spam` and `virus` are optional and absent when the edge computed no such
 * verdict. `domain` is the domain the passing mechanism authenticated.
 */
export const EmailVerificationSchema = z.object({
  spf: EmailAuthResultSchema,
  dkim: EmailAuthResultSchema,
  dmarc: EmailAuthResultSchema,
  spam: EmailScanResultSchema.optional(),
  virus: EmailScanResultSchema.optional(),
  domain: z.string(),
});
export type EmailVerification = z.infer<typeof EmailVerificationSchema>;

/** What an `LlmJudge` may answer. */
export const JudgeVerdictSchema = z.enum(['allow', 'deny']);
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/**
 * The recorded judgement on an email, or `null` when no judge ran. A `null`
 * VERDICT is the degrade record written when a configured judge could not answer
 * (error, timeout, malformed verdict) — the only place a verdict is not one of
 * the provider's two answers. An `allow` is never durable: it permits one email
 * and creates no contact trust and no thread trust.
 */
export const EmailJudgeSchema = z.object({
  verdict: JudgeVerdictSchema.nullable(),
  reason: z.string().max(JUDGE_REASON_MAX),
  provider: z.string(),
});
export type EmailJudge = z.infer<typeof EmailJudgeSchema>;

/**
 * A thread reference. Threads are anchored to exactly ONE agent and are built
 * from RFC headers, never from subject text; `subject` is the FIRST email's
 * subject and never changes (a re-subjecting reply joins unchanged).
 * `lastEmailAt` is bumped ONLY by a delivered/sent email, so a thread whose only
 * email was quarantined/held/rejected stays `null` and invisible in listings.
 */
export const EmailThreadRefSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  agentId: z.string(),
  subject: z.string(),
  trusted: z.boolean(),
  lastEmailAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type EmailThreadRef = z.infer<typeof EmailThreadRefSchema>;

/**
 * A full thread — the ref plus counts and cast. `unreadCount` counts inbound
 * `delivered` emails with `read_at IS NULL`.
 */
export const EmailThreadSchema = EmailThreadRefSchema.extend({
  emailCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  /**
   * The disposition of the thread's NEWEST email — what a triage row badges —
   * or `null` on a thread with no email at all.
   */
  lastDisposition: EmailDispositionSchema.nullable(),
  participants: z.array(PartySchema),
});
export type EmailThread = z.infer<typeof EmailThreadSchema>;

/**
 * One email in a thread. `bcc` is present for shape stability and is **always
 * `[]`** in v4 (inbound Bcc headers are dropped at ingest and the send request
 * has no `bcc` field). `html` is ALREADY sanitized when non-null. `status` is
 * `unread`/`read` for inbound delivered email and always `read` for everything
 * else — outbound and non-delivered email is never "waiting on" the agent.
 */
export const EmailSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  direction: EmailDirectionSchema,
  from: PartySchema,
  to: z.array(PartySchema),
  cc: z.array(PartySchema),
  /** Always `[]` in v4, in both directions. */
  bcc: z.array(PartySchema),
  subject: z.string(),
  text: z.string(),
  html: z.string().nullable(),
  attachments: z.array(AttachmentMetaSchema),
  rfcMessageId: z.string(),
  inReplyTo: z.string().nullable(),
  /** `null` on outbound. */
  verification: EmailVerificationSchema.nullable(),
  disposition: EmailDispositionSchema,
  reason: EmailReasonSchema.nullable(),
  judge: EmailJudgeSchema.nullable(),
  status: EmailReadStatusSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
});
export type Email = z.infer<typeof EmailSchema>;

/**
 * **The** email preview shape: the approvals queue, the `email.*` event
 * payloads, and the email variant of `/me/inbox` all carry it (the inbox adds a
 * `thread` object). There is no second, narrower preview — and never a body.
 */
export const EmailPreviewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  direction: EmailDirectionSchema,
  from: PartySchema,
  subject: z.string(),
  preview: z.string(),
  truncated: z.boolean(),
  attachmentCount: z.number().int().nonnegative(),
  disposition: EmailDispositionSchema,
  reason: EmailReasonSchema.nullable(),
  status: EmailReadStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type EmailPreview = z.infer<typeof EmailPreviewSchema>;

/**
 * Compact agent reference (`{ id, name }`) — carried on approval items, the
 * approval events, and every activity entry.
 */
export const AgentRefSchema = z.object({ id: z.string(), name: z.string() });
export type AgentRef = z.infer<typeof AgentRefSchema>;

/* ================================================================== *
 * Agent↔agent DM oversight (the ambient "who is my agent talking to"
 * box for humans). An agent↔agent DM exists only while at least one human
 * can currently see BOTH agents; every such human gets a read-only box.
 * ================================================================== */

/**
 * One collapsed oversight box: an agent↔agent DM the caller may watch because
 * they can currently see BOTH agents. `agents` is the unordered pair (rendered
 * "<a> ↔ <b>"), `lastMessage` the newest line for the collapsed summary (`null`
 * only in the degenerate empty-room case). It is ambient: no unread count ever
 * rides here — reading the thread writes nothing and badges nothing.
 */
export const AgentDmBoxSchema = z.object({
  roomId: z.string(),
  orgId: z.string(),
  agents: z.tuple([AgentRefSchema, AgentRefSchema]),
  lastMessage: z
    .object({ preview: z.string(), at: IsoDateTimeSchema })
    .nullable(),
  /**
   * When a human SEVERED this pair, else `null`. A severed box stays listed and
   * readable for exactly the humans who could already read it — severing cuts
   * the agents' line, it never hides the transcript from oversight.
   */
  severedAt: IsoDateTimeSchema.nullable().default(null),
  /** Whether THIS caller may sever the pair (or allow it again when severed). */
  canSever: z.boolean().default(false),
});
export type AgentDmBox = z.infer<typeof AgentDmBoxSchema>;

/**
 * Who acted when a pair was severed, which is also who may lift it (SPEC
 * "Direct conversations → Severing"): an `org` sever (by an org owner/admin)
 * can be lifted only by an org owner/admin; an `agent-owner` sever can be
 * lifted by an owner of either agent as well.
 */
export const AgentDmSeverAuthoritySchema = z.enum(['org', 'agent-owner']);
export type AgentDmSeverAuthority = z.infer<typeof AgentDmSeverAuthoritySchema>;

/** The durable record of a severed agent↔agent pair. */
export const AgentDmSeverSchema = z.object({
  roomId: z.string(),
  orgId: z.string(),
  agents: z.tuple([AgentRefSchema, AgentRefSchema]),
  severedBy: HumanRefSchema,
  authority: AgentDmSeverAuthoritySchema,
  severedAt: IsoDateTimeSchema,
});
export type AgentDmSever = z.infer<typeof AgentDmSeverSchema>;

/** `POST /orgs/:orgId/agent-dms/:roomId/sever` → the durable record it wrote. */
export const SeverAgentDmResponseSchema = z.object({ sever: AgentDmSeverSchema });
export type SeverAgentDmResponse = z.infer<typeof SeverAgentDmResponseSchema>;

/**
 * `POST /orgs/:orgId/agent-dms/:roomId/allow` — clears the sever. The pair is
 * only permitted again, never re-opened: the agents must re-ensure the DM and
 * pass the ordinary eligibility gate.
 */
export const AllowAgentDmResponseSchema = z.object({ roomId: z.string(), allowed: z.literal(true) });
export type AllowAgentDmResponse = z.infer<typeof AllowAgentDmResponseSchema>;

/**
 * `GET /orgs/:orgId/agent-dms` — every agent↔agent DM box the caller may watch
 * in the org, newest activity first. A plain list (not a transcript): the set
 * is bounded by the agents the caller can see, and each box is itself the
 * pageable surface (its `messages` sub-route).
 */
export const ListAgentDmsResponseSchema = z.object({
  items: z.array(AgentDmBoxSchema),
});
export type ListAgentDmsResponse = z.infer<typeof ListAgentDmsResponseSchema>;

/** The email medium's name for {@link AgentRefSchema} — the same shape. */
export const EmailAgentRefSchema = AgentRefSchema;
export type EmailAgentRef = AgentRef;

/**
 * One row of `GET /orgs/:orgId/email/approvals` — every `quarantined` and `held`
 * email, ascending `createdAt`. `verification` is null on an outbound hold;
 * `judge` is null when no automatic review ran.
 */
export const EmailApprovalItemSchema = z.object({
  email: EmailPreviewSchema,
  thread: EmailThreadRefSchema,
  agent: EmailAgentRefSchema,
  verification: EmailVerificationSchema.nullable(),
  judge: EmailJudgeSchema.nullable(),
});
export type EmailApprovalItem = z.infer<typeof EmailApprovalItemSchema>;

/**
 * An email address, scoped to one org, that belongs to no principal. A layer-1
 * concept (the third rung of the trust ladder), carried with a durable trust
 * state; contacts confer nothing — no login, no visibility, no room membership.
 * `trust: null` is unknown. Contacts are never deleted by approve/deny.
 */
export const ExternalContactSchema = z.object({
  id: z.string(),
  email: z.string(),
  /** The latest `From:` display name seen for this address. */
  displayName: z.string().nullable(),
  trust: ContactTrustSchema.nullable(),
  firstSeenAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  resolvedBy: HumanRefSchema.nullable(),
});
export type ExternalContact = z.infer<typeof ExternalContactSchema>;

/* ---- Agent surfaces (`/me/email/*`, agent key) ---- */

/**
 * `GET /me/email/address` (and its org-scoped twin): the DERIVATION for one
 * agent. The medium's on/off is `GET /capabilities`, not this route — with the
 * medium off it `404`s along with the rest of `/me/email/*`.
 */
export const EmailAddressResponseSchema = z.object({
  address: z.string(),
  domain: z.string(),
  orgId: z.string(),
  agentId: z.string(),
});
export type EmailAddressResponse = z.infer<typeof EmailAddressResponseSchema>;

/**
 * `GET /me/email/threads` and its org twin — a TRANSCRIPT: newest-first by
 * `lastEmailAt`, paged with `before=<eth_id>` / `nextBefore`. Items are FULL
 * threads (`unreadCount`, `participants`, `lastDisposition`) because a triage
 * list that cannot show unread or who is on a thread is not a triage list, and
 * enriching it row-by-row costs one request per row. `EmailThreadRef` stays the
 * shape wherever a thread rides ALONG with something else — work items, inbox
 * items, `email.*` events.
 */
export const ListEmailThreadsQuerySchema = TranscriptQuerySchema;
export type ListEmailThreadsQuery = z.infer<typeof ListEmailThreadsQuerySchema>;

export const ListEmailThreadsResponseSchema = transcriptResponseSchema(EmailThreadSchema);
export type ListEmailThreadsResponse = z.infer<typeof ListEmailThreadsResponseSchema>;

/**
 * `GET .../email/threads/:threadId` — the thread plus its emails, ascending,
 * paged. Quarantined/held/rejected emails ARE included so the agent can see what
 * did not go out. A peek: writes no read state.
 */
export const GetEmailThreadResponseSchema = z.object({
  thread: EmailThreadSchema,
  items: z.array(EmailSchema),
  nextCursor: z.string().nullable(),
});
export type GetEmailThreadResponse = z.infer<typeof GetEmailThreadResponseSchema>;

/** `GET /me/email/emails/:emailId` / `GET /orgs/:orgId/email/emails/:emailId`. */
export const GetEmailResponseSchema = z.object({ email: EmailSchema });
export type GetEmailResponse = z.infer<typeof GetEmailResponseSchema>;

/** `GET /me/email/emails/:emailId` query (`?peek=` never writes read state). */
export const ReadEmailQuerySchema = z.object({ peek: BoolishSchema.optional() });
export type ReadEmailQuery = z.infer<typeof ReadEmailQuerySchema>;

/**
 * `POST /me/email/threads/:threadId/reply` body. The subject and the base
 * recipient set come from the thread — you write only the body; `cc` adds
 * people. The thread must have ≥1 inbound email, else `400`.
 */
export const ReplyEmailRequestSchema = z.object({
  text: z.string().min(1),
  cc: z.array(z.string().email()).max(EMAIL_RECIPIENTS_MAX).optional(),
  attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS).optional(),
});
export type ReplyEmailRequest = z.infer<typeof ReplyEmailRequestSchema>;

/**
 * `POST /me/email/send` body — starts a NEW thread. `to` + `cc` together are
 * capped at {@link EMAIL_RECIPIENTS_MAX}; `subject` is trimmed and capped at the
 * RFC line limit. There is no `bcc` field in v4.
 */
export const SendEmailRequestSchema = z
  .object({
    to: z.array(z.string().email()).min(1).max(EMAIL_RECIPIENTS_MAX),
    cc: z.array(z.string().email()).max(EMAIL_RECIPIENTS_MAX).optional(),
    subject: z.string().trim().max(EMAIL_SUBJECT_MAX),
    text: z.string().min(1),
    attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS).optional(),
  })
  .refine((v) => v.to.length + (v.cc?.length ?? 0) <= EMAIL_RECIPIENTS_MAX, {
    message: `at most ${EMAIL_RECIPIENTS_MAX} recipients (to + cc)`,
    path: ['to'],
  });
export type SendEmailRequest = z.infer<typeof SendEmailRequestSchema>;

/**
 * `{ email }` — the reply (`201`/`202`), retry (`202`), approve/deny (`200`)
 * envelope. The disposition on the returned email says what happened.
 */
export const EmailMutationResponseSchema = z.object({ email: EmailSchema });
export type EmailMutationResponse = z.infer<typeof EmailMutationResponseSchema>;

/** `POST /me/email/send` response: the email plus the thread it opened. */
export const SendEmailResponseSchema = z.object({
  email: EmailSchema,
  thread: EmailThreadRefSchema,
});
export type SendEmailResponse = z.infer<typeof SendEmailResponseSchema>;

/* ---- Human / org surfaces (session) ---- */

/** `GET /orgs/:orgId/email/approvals` query (`?agent=&direction=&limit=&cursor=`). */
export const ListEmailApprovalsQuerySchema = PageQuerySchema.extend({
  agent: z.string().optional(),
  direction: EmailDirectionSchema.optional(),
});
export type ListEmailApprovalsQuery = z.infer<typeof ListEmailApprovalsQuerySchema>;

export const ListEmailApprovalsResponseSchema = pagedResponseSchema(EmailApprovalItemSchema);
export type ListEmailApprovalsResponse = z.infer<typeof ListEmailApprovalsResponseSchema>;

/**
 * `POST /orgs/:orgId/email/emails/:emailId/approve` body. Approving is the only
 * way trust is created, and it is DURABLE by default: the thread is marked
 * trusted, and unless `trustSender: false` the counterpart contact becomes
 * `approved`.
 */
export const ApproveEmailRequestSchema = z.object({
  trustSender: z.boolean().default(true),
});
export type ApproveEmailRequest = z.infer<typeof ApproveEmailRequestSchema>;

/**
 * `POST /orgs/:orgId/email/emails/:emailId/deny` body. Blocking is opt-in; a
 * blocked contact short-circuits every trust rung, past thread trust included.
 * A deny never clears the thread's `trusted` flag.
 */
export const DenyEmailRequestSchema = z.object({
  blockSender: z.boolean().default(false),
});
export type DenyEmailRequest = z.infer<typeof DenyEmailRequestSchema>;

/**
 * `GET /orgs/:orgId/email/contacts` query. `?trust=unknown` selects the rows
 * whose trust is `null`, so the filter has three values where the field has two
 * plus null. `?q=` is an address prefix.
 */
export const ListContactsQuerySchema = PageQuerySchema.extend({
  trust: z.enum(['approved', 'blocked', 'unknown']).optional(),
  q: z.string().optional(),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuerySchema>;

export const ListContactsResponseSchema = pagedResponseSchema(ExternalContactSchema);
export type ListContactsResponse = z.infer<typeof ListContactsResponseSchema>;

/**
 * `PATCH /orgs/:orgId/email/contacts/:contactId` body — `null` returns a contact
 * to unknown. Forward-looking: already-delivered email is never withdrawn.
 */
export const UpdateContactRequestSchema = z.object({
  trust: ContactTrustSchema.nullable(),
});
export type UpdateContactRequest = z.infer<typeof UpdateContactRequestSchema>;

export const UpdateContactResponseSchema = z.object({ contact: ExternalContactSchema });
export type UpdateContactResponse = z.infer<typeof UpdateContactResponseSchema>;

/* ---- The inbound seam (`POST /email/inbound`) ---- */

/** A party as the mail edge reports it — an address and an optional display name. */
export const InboundPartySchema = z.object({
  email: z.string().min(1),
  name: z.string().nullable().optional(),
});
export type InboundParty = z.infer<typeof InboundPartySchema>;

/** The SMTP envelope, when the edge reports one. */
export const InboundEnvelopeSchema = z.object({
  mailFrom: z.string(),
  rcptTo: z.array(z.string()),
});
export type InboundEnvelope = z.infer<typeof InboundEnvelopeSchema>;

/**
 * The NORMALIZED parsed email `POST /email/inbound` accepts. Parsing, MIME
 * decoding, and SPF/DKIM/DMARC verification all happen at the edge; the core
 * consumes verdicts and never touches a raw RFC 5322 stream.
 *
 * `rfcMessageId` is normalized to include the angle brackets and compared
 * case-sensitively. `date` is advisory — `emails.created_at` is server time. Any
 * `bcc` key is **rejected** (`400`): Bcc must not reach the core.
 */
export const InboundEmailPayloadSchema = z.object({
  rfcMessageId: z.string().min(1),
  inReplyTo: z.string().nullable().default(null),
  references: z.array(z.string()).default([]),
  date: z.string().nullable().default(null),
  from: InboundPartySchema,
  to: z.array(InboundPartySchema).min(1),
  cc: z.array(InboundPartySchema).default([]),
  /** May be `""`; a thread started by one is stored as `(no subject)`. */
  subject: z.string().max(EMAIL_SUBJECT_MAX),
  /** Required; derived from HTML upstream when the message carried none. */
  text: z.string(),
  html: z.string().nullable().default(null),
  attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS).default([]),
  verification: EmailVerificationSchema,
  envelope: InboundEnvelopeSchema.nullable().default(null),
  /**
   * Never present. Declared so a payload carrying Bcc is a schema violation
   * (`400`) rather than a silently stripped key — Bcc must not reach the core.
   */
  bcc: z.undefined().optional(),
});
export type InboundEmailPayload = z.infer<typeof InboundEmailPayloadSchema>;

/** Per-anchor-agent outcome of one inbound message. */
export const InboundDeliveryStatusSchema = z.enum([
  'delivered',
  'quarantined',
  'rejected',
  'duplicate',
]);
export type InboundDeliveryStatus = z.infer<typeof InboundDeliveryStatusSchema>;

/**
 * The top-level summary an edge that wants one word reads: the most permissive
 * outcome present (`delivered` > `quarantined` > `rejected` > `duplicate`), or
 * `unknown-recipient` exactly when no recipient resolved and `deliveries` is
 * empty. `unknown-recipient` is spelled distinctly so an edge relay can reject
 * it at SMTP time rather than accept-and-drop.
 */
export const InboundStatusSchema = z.enum([
  'delivered',
  'quarantined',
  'rejected',
  'unknown-recipient',
  'duplicate',
]);
export type InboundStatus = z.infer<typeof InboundStatusSchema>;

/** One entry of `deliveries` — one per anchor agent, in routing order. */
export const InboundDeliverySchema = z.object({
  agentId: z.string(),
  emailId: z.string(),
  threadId: z.string(),
  status: InboundDeliveryStatusSchema,
  reason: EmailReasonSchema.nullable(),
});
export type InboundDelivery = z.infer<typeof InboundDeliverySchema>;

/**
 * `POST /email/inbound` response — always `202`, including for `rejected`: the
 * seam's contract is "I have taken custody of this message", not "I liked it".
 * `email` mirrors the FIRST delivery's refs (the single-recipient case, which is
 * almost all mail) and is `null` when there is none.
 */
export const InboundEmailResponseSchema = z.object({
  status: InboundStatusSchema,
  reason: EmailReasonSchema.nullable(),
  email: z.object({ id: z.string(), threadId: z.string() }).nullable(),
  deliveries: z.array(InboundDeliverySchema),
});
export type InboundEmailResponse = z.infer<typeof InboundEmailResponseSchema>;

/* ---- Outbound relay (`EMAIL_PROVIDER=webhook`) ---- */

/** The threading identity the core owns; a relay passes these through verbatim. */
export const OutboundEmailHeadersSchema = z.object({
  messageId: z.string(),
  inReplyTo: z.string().nullable().optional(),
  references: z.string().nullable().optional(),
});
export type OutboundEmailHeaders = z.infer<typeof OutboundEmailHeadersSchema>;

/**
 * The outbound webhook body (`EMAIL_WEBHOOK_URL`). v4 changes it from v3's
 * `{ to: string, subject, text }` — `to` is ALWAYS an array and a `headers`
 * object rides along, because v3's shape could not carry threading identity.
 * This is the ONLY outbound mail shape in the system: v4 sends no transactional
 * mail of its own. Any 2xx = accepted → `sent`; anything else → `send-failed`
 * with `reason: "relay-error"`.
 */
export const OutboundEmailWebhookPayloadSchema = z.object({
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  text: z.string(),
  html: z.string().nullable().optional(),
  headers: OutboundEmailHeadersSchema,
  attachments: z.array(AttachmentInputSchema).optional(),
});
export type OutboundEmailWebhookPayload = z.infer<typeof OutboundEmailWebhookPayloadSchema>;

/**
 * One captured outbound email under `EMAIL_PROVIDER=fake` — the in-process
 * loopback that never touches the network. Sends land in a bounded ring buffer
 * (last 100) and are readable through `GET /admin/email/outbox`.
 */
export const CapturedEmailSchema = z.object({
  email: EmailSchema,
  headers: OutboundEmailHeadersSchema,
  to: z.array(z.string()),
  raw: z.object({
    subject: z.string(),
    text: z.string(),
    html: z.string().nullable(),
  }),
});
export type CapturedEmail = z.infer<typeof CapturedEmailSchema>;

/** `GET /admin/email/outbox` (present ONLY under `EMAIL_PROVIDER=fake`). */
export const AdminEmailOutboxResponseSchema = listResponseSchema(CapturedEmailSchema);
export type AdminEmailOutboxResponse = z.infer<typeof AdminEmailOutboxResponseSchema>;

/* ================================================================== *
 * Unified attention (layer 3) — the work queue
 *
 * Layer 3 never carries payloads. Work items and activity entries are typed
 * REFS; bodies are fetched from the owning medium's routes.
 * ================================================================== */

/**
 * The compact room descriptor layer 3 carries wherever a chat item needs its
 * room — the pop work item and the chat variant of `GET /me/inbox`.
 * `counterpart` is present only on `kind: 'dm'` rooms.
 */
export const RoomRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  kind: RoomKindSchema,
  counterpart: DmCounterpartSchema.optional(),
});
export type RoomRef = z.infer<typeof RoomRefSchema>;

/** Historical name for {@link RoomRefSchema} — the same shape, one descriptor. */
export const InboxRoomRefSchema = RoomRefSchema;
export type InboxRoomRef = RoomRef;

/**
 * The discriminator of a work item. In registry order — which is also the
 * tie-break order of the one queue (chat before email).
 */
export const WorkItemTypeSchema = z.enum(['chat.message', 'email']);
export type WorkItemType = z.infer<typeof WorkItemTypeSchema>;

/** The chat medium's work item. */
export const ChatWorkItemSchema = z.object({
  type: z.literal('chat.message'),
  message: MessageSchema,
  room: RoomRefSchema,
});
export type ChatWorkItem = z.infer<typeof ChatWorkItemSchema>;

/** The email medium's work item — a `delivered` inbound email with no `read_at`. */
export const EmailWorkItemSchema = z.object({
  type: z.literal('email'),
  email: EmailSchema,
  thread: EmailThreadRefSchema,
});
export type EmailWorkItem = z.infer<typeof EmailWorkItemSchema>;

/**
 * One unit of attention handed to a principal by `POST /me/inbox/pop`. The
 * single agent loop drains work items regardless of which medium produced them.
 *
 * Clients MUST switch on `type` and MUST treat an unknown `type` as "not mine to
 * handle" — leaving it rather than erroring — so a v4 agent keeps working when a
 * later medium appears.
 */
export const WorkItemSchema = z.discriminatedUnion('type', [
  ChatWorkItemSchema,
  EmailWorkItemSchema,
]);
export type WorkItem = z.infer<typeof WorkItemSchema>;

/* ---- /me/inbox, /me/inbox/pop ---- */

/** GET /me/inbox query (`?org=&medium=&all=&limit=&cursor=`). */
export const MeInboxQuerySchema = PageQuerySchema.extend({
  org: z.string().optional(),
  /**
   * Narrows to one medium. Only the two mediums that produce inbox items are
   * accepted — voice owns no work items and no independent inbox.
   */
  medium: z.enum(['chat', 'email']).optional(),
  all: BoolishSchema.optional(),
});
export type MeInboxQuery = z.infer<typeof MeInboxQuerySchema>;

/** One principal-inbox chat item: the v3 InboxItem plus its room context. */
export const PrincipalInboxItemSchema = InboxItemSchema.extend({
  room: RoomRefSchema,
});
export type PrincipalInboxItem = z.infer<typeof PrincipalInboxItemSchema>;

/** The chat variant of `GET /me/inbox` — a principal inbox item, tagged. */
export const ChatInboxEntrySchema = PrincipalInboxItemSchema.extend({
  type: z.literal('chat.message'),
});
export type ChatInboxEntry = z.infer<typeof ChatInboxEntrySchema>;

/**
 * The compact thread object an email inbox entry carries (`{ id, subject,
 * lastEmailAt }`) — narrower than {@link EmailThreadRefSchema}, which the pop
 * work item and the `email.*` events carry.
 */
export const InboxThreadRefSchema = z.object({
  id: z.string(),
  subject: z.string(),
  lastEmailAt: IsoDateTimeSchema.nullable(),
});
export type InboxThreadRef = z.infer<typeof InboxThreadRefSchema>;

/**
 * The email variant of `GET /me/inbox` — exactly the medium's `EmailPreview`
 * plus the discriminator and its thread, so a client parses ONE preview shape
 * here, in the approvals queue, and in every `email.*` event.
 */
export const EmailInboxEntrySchema = EmailPreviewSchema.extend({
  type: z.literal('email'),
  thread: InboxThreadRefSchema,
});
export type EmailInboxEntry = z.infer<typeof EmailInboxEntrySchema>;

/**
 * One `GET /me/inbox` item — a `type`-discriminated union sharing a common
 * preview core (`type, id, subject, preview, truncated, attachmentCount,
 * status, createdAt`). Listing marks chat items `received` exactly as in v3 and
 * marks NOTHING on email items.
 */
export const InboxEntrySchema = z.discriminatedUnion('type', [
  ChatInboxEntrySchema,
  EmailInboxEntrySchema,
]);
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

export const MeInboxResponseSchema = pagedResponseSchema(InboxEntrySchema);
export type MeInboxResponse = z.infer<typeof MeInboxResponseSchema>;

/**
 * `POST /me/inbox/pop` response: `{ item: WorkItem | null }` — `item: null` on
 * an empty queue (never `404`). v3's `{ message, room }` response is GONE; the
 * discriminated union is the contract.
 *
 * `hints` (absent, never empty) rides ONLY the `item: null` response — the pause
 * at the end of a drain. A pop that HANDS BACK WORK never carries a hint: the
 * agent is about to start a task and must not be taught mid-stride.
 */
export const MeInboxPopResponseSchema = z.object({
  item: WorkItemSchema.nullable(),
  hints: z.array(HintSchema).optional(),
});
export type MeInboxPopResponse = z.infer<typeof MeInboxPopResponseSchema>;

/* ================================================================== *
 * Unified attention (layer 3) — the activity timeline
 * ================================================================== */

/**
 * The entry-type registry: `<medium>.<verb>`, closed and additive.
 * `voice.transcribed` is registered and UNUSED in v4 — a dictated message
 * already appears as `chat.message` with `origin: 'voice'`; the name is reserved
 * so a later voice medium (calls) does not collide.
 *
 * Readers MUST ignore entries whose `type` or `medium` they do not recognize.
 */
export const ActivityEntryTypeSchema = z.enum([
  'chat.message',
  'email.received',
  'email.sent',
  'email.quarantined',
  'email.held',
  'email.rejected',
  'email.resolved',
  'voice.transcribed',
  /* `system` — sparrow itself. Written when the hints engine attaches a hint to
   * an agent's response, so the owner sees what the system taught their agent. */
  'hint.delivered',
]);
export type ActivityEntryType = z.infer<typeof ActivityEntryTypeSchema>;

/** Who acted. `contact` is an external email sender; `system` is sparrow itself. */
export const ActivityActorKindSchema = z.enum(['human', 'agent', 'contact', 'system']);
export type ActivityActorKind = z.infer<typeof ActivityActorKindSchema>;

/**
 * The actor on an entry. `id` is a `usr_`/`agt_` principal id, an `ext_` contact
 * id, or `null` for `kind: 'system'`. `displayName` is FROZEN at append time
 * (unlike `MemberRef.displayName`, which renders live): a timeline is history
 * and must still read correctly after a rename or a deleted contact.
 */
export const ActivityActorSchema = z.object({
  kind: ActivityActorKindSchema,
  id: z.string().nullable(),
  displayName: z.string(),
});
export type ActivityActor = z.infer<typeof ActivityActorSchema>;

/**
 * The typed refs on an entry — only the keys its medium sets:
 * chat → `{ roomId, messageId }`; email → `{ emailThreadId, emailId }`;
 * voice → `{ roomId, messageId }`. The sender always rides on `actor`, never here.
 */
export const ActivityRefsSchema = z.object({
  roomId: z.string().optional(),
  messageId: z.string().optional(),
  emailThreadId: z.string().optional(),
  emailId: z.string().optional(),
});
export type ActivityRefs = z.infer<typeof ActivityRefsSchema>;

/**
 * The inline payload of a `hint.delivered` entry — the ONE exception to
 * "entries are refs": the `system` medium has no fetch route (a delivered hint
 * is not addressable anywhere else), so the small, immutable payload rides the
 * entry. `id` is the trigger id; `text` is the VERBATIM text conveyed to the
 * agent (bounded by the same {@link HINT_TEXT_MAX} the hint wire enforces),
 * which the web's Hint info box reveals on expand. The entry's `summary` holds
 * the trigger's human-framed `ownerLabel` ("Sparrow hinted the agent to …").
 */
export const ActivityHintSchema = z.object({
  id: z.string(),
  text: z.string().max(HINT_TEXT_MAX),
});
export type ActivityHint = z.infer<typeof ActivityHintSchema>;

/**
 * One typed, append-only journal row recording that something happened involving
 * a principal, in some medium. Entries are REFS, not payloads — clients fetch
 * bodies through the medium's own routes, and MUST tolerate a `404` from that
 * fetch (rendering the entry from `summary` alone). Entries are never marked
 * read, never popped, never mutated. (`hint.delivered` is the one payload
 * exception — see {@link ActivityHintSchema}.)
 *
 * `agent` is `null` for an org-level entry. `summary` is the subject or first
 * line, so a list renders without a medium fetch.
 */
export const ActivityEntrySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  medium: MediumSchema,
  type: ActivityEntryTypeSchema,
  agent: AgentRefSchema.nullable(),
  actor: ActivityActorSchema,
  summary: z.string().max(ACTIVITY_SUMMARY_MAX).nullable(),
  refs: ActivityRefsSchema,
  /** Present only on `hint.delivered` (and optional even there — old rows predate it). */
  hint: ActivityHintSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/**
 * `GET /me/activity` / `GET /orgs/:orgId/agents/:agentId/activity` — a
 * TRANSCRIPT: newest-first, paged backward with `before=<act_id>` / `nextBefore`,
 * exactly as room history is. A timeline reads backward from now.
 */
export const ListActivityResponseSchema = transcriptResponseSchema(ActivityEntrySchema);
export type ListActivityResponse = z.infer<typeof ListActivityResponseSchema>;

/**
 * `GET /me/activity` query. `?org=` restricts to one org (absent = all the
 * caller's orgs, interleaved in time order); `?medium=` filters and an unknown
 * value is a `bad_request`. There is no `?all=`, no read state, and no `peek` —
 * reading a timeline writes nothing, ever.
 */
export const MeActivityQuerySchema = TranscriptQuerySchema.extend({
  org: z.string().optional(),
  medium: MediumSchema.optional(),
});
export type MeActivityQuery = z.infer<typeof MeActivityQuerySchema>;

/** `GET /orgs/:orgId/agents/:agentId/activity` query (already org-scoped by path). */
export const AgentActivityQuerySchema = TranscriptQuerySchema.extend({
  medium: MediumSchema.optional(),
});
export type AgentActivityQuery = z.infer<typeof AgentActivityQuerySchema>;

/* ================================================================== *
 * Unified attention (layer 3) — the notification router
 * ================================================================== */

/** The canonical notification kinds in v4. */
export const NotificationKindSchema = z.enum([
  'chat.message',
  'email.received',
  'email.approval-needed',
  'email.resolved',
  'enrollment.requested',
  'room.invitation',
  'agent.shared',
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/**
 * What every medium hands to the notification router when it needs to reach a
 * human. v4 registers exactly one channel (`in-app`), which emits the
 * corresponding `/me/events` event and lets the client derive its badges; there
 * is deliberately no stored notification table, no routing preferences, and no
 * "mark notification read" surface — a notification's durable record is its
 * activity entry, and its unread state is the underlying item's.
 */
export const NotificationSchema = z.object({
  orgId: z.string(),
  to: z.object({ type: PrincipalKindSchema, id: z.string() }),
  kind: NotificationKindSchema,
  /** Channel-neutral. */
  title: z.string().max(NOTIFICATION_TITLE_MAX),
  /** Channel-neutral. */
  body: z.string().max(NOTIFICATION_BODY_MAX),
  /** The same ref shape as an activity entry. */
  refs: ActivityRefsSchema,
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * Response for the principal-scoped single-message routes:
 * `GET /me/messages/:messageId` (non-consuming fetch) and
 * `POST /me/messages/:messageId/read` (ack-by-id). Carries the full Message plus
 * its room context (like a pop result), so a caller that acked a watcher-shown id
 * learns which room to reply in without a second lookup.
 */
export const MeMessageResponseSchema = z.object({
  message: MessageSchema,
  room: InboxRoomRefSchema,
});
export type MeMessageResponse = z.infer<typeof MeMessageResponseSchema>;

/** One journaled `/me/events` frame projected for the non-streaming log read. */
export const MeEventsLogItemSchema = z.object({
  /** The journal cursor — the same value the live/replayed SSE frame carried as `id:`. */
  id: z.number(),
  /** The SSE event name (e.g. `message.new`). */
  event: z.string(),
  /**
   * The parsed stored payload — room events are room-wrapped `{ room, ...payload }`
   * exactly as the SSE `data:` would carry them, so a client can decode it with
   * the same path it uses for a live frame.
   */
  data: z.unknown(),
});
export type MeEventsLogItem = z.infer<typeof MeEventsLogItemSchema>;

/**
 * Response for `GET /me/events/log?since=<id>` — the non-streaming journal read
 * that backs the CLI's reconcile poll (a one-shot HTTP request that punches
 * through an SSE path stall). `events` are the principal's journaled frames
 * strictly after `since`; `latest` is the principal's newest journal cursor (`0`
 * when empty), so a client with no `since` learns its starting cursor cheaply.
 * `gap` mirrors the SSE `replay.gap`: the cursor predates retention, so replay is
 * known-incomplete and the client must reconcile (inbox drain). `more` is set
 * when the response was capped — poll again from the last returned id.
 */
export const MeEventsLogResponseSchema = z.object({
  events: z.array(MeEventsLogItemSchema),
  latest: z.number(),
  gap: z.boolean().optional(),
  more: z.boolean().optional(),
});
export type MeEventsLogResponse = z.infer<typeof MeEventsLogResponseSchema>;

/* ================================================================== *
 * Working status
 * ================================================================== */

/** State a member can advertise. `working` shows a transient indicator; `idle` clears it. */
export const StatusStateSchema = z.enum(['working', 'idle']);
export type StatusState = z.infer<typeof StatusStateSchema>;

/**
 * An active member status. Only `working` statuses are ever stored/returned.
 * `to` null = room-wide; set = scoped to one recipient. Upsert key `(memberId, to)`.
 */
export const MemberStatusSchema = z.object({
  memberId: z.string(),
  displayName: z.string(),
  state: z.literal('working'),
  note: z.string().nullable(),
  to: MemberRefSchema.nullable(),
  /** When the CURRENT status text (note) was set — for honest staleness display. */
  sinceAt: IsoDateTimeSchema,
  /** A sticky status carries no TTL (`expiresAt` is null); it persists until idle/clear/offline-horizon. */
  sticky: z.boolean(),
  /** Absolute expiry, or null for a sticky status. */
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

/**
 * POST /rooms/:roomId/status body. `sticky` and `ttlSeconds` are mutually
 * exclusive: a sticky `working` status persists through long tasks (no TTL);
 * a TTL'd status auto-expires (default {@link STATUS_TTL_DEFAULT}s).
 */
export const SetStatusRequestSchema = z
  .object({
    state: StatusStateSchema,
    note: z.string().max(STATUS_NOTE_MAX).optional(),
    to: z.string().min(1).optional(),
    ttlSeconds: z.number().int().min(STATUS_TTL_MIN).max(STATUS_TTL_MAX).optional(),
    sticky: z.boolean().optional(),
  })
  .refine((v) => !(v.sticky && v.ttlSeconds !== undefined), {
    message: 'sticky and ttlSeconds are mutually exclusive',
    path: ['sticky'],
  });
export type SetStatusRequest = z.infer<typeof SetStatusRequestSchema>;

/** POST /rooms/:roomId/status response: `{ status }` (`working`) or `{ status: null }` (`idle`). */
export const SetStatusResponseSchema = z.object({
  status: MemberStatusSchema.nullable(),
});
export type SetStatusResponse = z.infer<typeof SetStatusResponseSchema>;

/**
 * POST /me/presence body — mark the calling principal online until now+ttlSeconds
 * (org/room-wide, no socket required). `0` clears the mark. Capped at
 * {@link PRESENCE_TTL_MAX}s; over the cap is a 400.
 */
export const SetPresenceRequestSchema = z.object({
  ttlSeconds: z.number().int().min(0).max(PRESENCE_TTL_MAX),
});
export type SetPresenceRequest = z.infer<typeof SetPresenceRequestSchema>;

/** POST /me/presence response — when the mark lapses, or null when cleared. */
export const SetPresenceResponseSchema = z.object({
  onlineUntil: IsoDateTimeSchema.nullable(),
});
export type SetPresenceResponse = z.infer<typeof SetPresenceResponseSchema>;

/** Room presence snapshot: member ids currently holding an `/events` stream. */
export const PresenceSchema = z.object({
  online: z.array(z.string()),
});
export type Presence = z.infer<typeof PresenceSchema>;

/** GET /rooms/:roomId/status response: statuses visible to the caller + presence. */
export const ListStatusesResponseSchema = z.object({
  items: z.array(MemberStatusSchema),
  presence: PresenceSchema,
});
export type ListStatusesResponse = z.infer<typeof ListStatusesResponseSchema>;

/** Presence state — server-derived, never self-reported. */
export const PresenceStateSchema = z.enum(['online', 'offline']);
export type PresenceState = z.infer<typeof PresenceStateSchema>;

/* ================================================================== *
 * SSE events
 * ================================================================== */

/** `message.new` — to recipients. */
export const MessageNewEventSchema = z.object({
  messageId: z.string(),
  from: MemberRefSchema,
  preview: z.string(),
  kind: MessageKindSchema,
});
export type MessageNewEvent = z.infer<typeof MessageNewEventSchema>;

/**
 * `message.received` — to the sender; emitted once per recipient when delivery
 * marks `received` (a recipient who reads without ever being marked received
 * emits only `message.read`).
 */
export const MessageReceivedEventSchema = z.object({
  messageId: z.string(),
  by: MemberRefSchema,
  receivedAt: IsoDateTimeSchema,
});
export type MessageReceivedEvent = z.infer<typeof MessageReceivedEventSchema>;

/** `message.read` — to the sender. */
export const MessageReadEventSchema = z.object({
  messageId: z.string(),
  by: MemberRefSchema,
  readAt: IsoDateTimeSchema,
});
export type MessageReadEvent = z.infer<typeof MessageReadEventSchema>;

/**
 * `message.clawback` — to ALL room members: the sender pulled an UNREAD message
 * back (SPEC "Clawback"). The message is dead: drop it from every view and
 * queue, send no receipt, write no reply to it — for an agent that was nudged
 * by its `message.new`, this event turns that nudge into a no-op. A later
 * `GET` of the message 404s. Journaled like every room event, so reconnecting
 * watchers replay it.
 */
export const MessageClawbackEventSchema = z.object({
  messageId: z.string(),
  by: MemberRefSchema,
  clawedBackAt: IsoDateTimeSchema,
});
export type MessageClawbackEvent = z.infer<typeof MessageClawbackEventSchema>;

/**
 * `POST /rooms/:roomId/messages/:messageId/clawback` → `200 { message }` — the
 * sender retracts their own still-unread-by-everyone message. The full message
 * (body included) comes back so a client can restore it into the composer; the
 * row itself is dead from every other surface. Eligibility is the sender's
 * TRAILING UNREAD RUN, capped at {@link CLAWBACK_WINDOW}: `409 message_read`
 * when ANY recipient has read it, `409 behind_read` when a NEWER own message
 * was read (a read message is a hard stop — older unread mail behind it is
 * locked in), `409 outside_window` beyond the cap, `409 already_clawed_back`,
 * and `404` when it is not the caller's own message in that room.
 */
export const ClawbackMessageResponseSchema = z.object({ message: MessageSchema });
export type ClawbackMessageResponse = z.infer<typeof ClawbackMessageResponseSchema>;

/** How many of the sender's most recent messages in a room are clawback-eligible. */
export const CLAWBACK_WINDOW = 5;

/** `member.joined` — to all members. */
export const MemberJoinedEventSchema = z.object({ member: MemberSchema });
export type MemberJoinedEvent = z.infer<typeof MemberJoinedEventSchema>;

/** `member.updated` — to all members (role change, principal rename). */
export const MemberUpdatedEventSchema = z.object({ member: MemberSchema });
export type MemberUpdatedEvent = z.infer<typeof MemberUpdatedEventSchema>;

/** `member.removed` — to the remaining members (`{ id, displayName }` only). */
export const MemberRemovedEventSchema = z.object({
  member: z.object({ id: z.string(), displayName: z.string() }),
});
export type MemberRemovedEvent = z.infer<typeof MemberRemovedEventSchema>;

/** `room.updated` — to all members. */
export const RoomUpdatedEventSchema = z.object({
  room: z.object({
    id: z.string(),
    name: z.string(),
    archivedAt: IsoDateTimeSchema.nullable(),
  }),
  settings: RoomSettingsSchema,
});
export type RoomUpdatedEvent = z.infer<typeof RoomUpdatedEventSchema>;

/** `status.changed` — scoped to the recipient + setter, else all members. */
export const StatusChangedEventSchema = z.object({
  member: MemberRefSchema,
  state: StatusStateSchema,
  note: z.string().nullable(),
  to: MemberRefSchema.nullable(),
  /** When the current status text was set; null on `idle`. */
  sinceAt: IsoDateTimeSchema.nullable(),
  /** Whether the (working) status is sticky (no TTL). Always false on `idle`. */
  sticky: z.boolean(),
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type StatusChangedEvent = z.infer<typeof StatusChangedEventSchema>;

/** `presence.changed` — to all room members. */
export const PresenceChangedEventSchema = z.object({
  member: MemberRefSchema,
  state: PresenceStateSchema,
});
export type PresenceChangedEvent = z.infer<typeof PresenceChangedEventSchema>;

/** `enrollment.requested` — to an org's approvers (on `/me/events`). */
export const EnrollmentRequestedEventSchema = z.object({
  enrollment: EnrollmentSummarySchema,
});
export type EnrollmentRequestedEvent = z.infer<typeof EnrollmentRequestedEventSchema>;

/** `enrollment.resolved` — to an org's approvers (on `/me/events`). */
export const EnrollmentResolvedEventSchema = z.object({
  enrollmentId: z.string(),
  status: z.enum(['approved', 'denied']),
});
export type EnrollmentResolvedEvent = z.infer<typeof EnrollmentResolvedEventSchema>;

/** `room.invitation` — to the invited human (on `/me/events`). */
export const RoomInvitationEventSchema = z.object({
  invitation: RoomInvitationSchema,
});
export type RoomInvitationEvent = z.infer<typeof RoomInvitationEventSchema>;

/** `agent.shared` / `agent.unshared` — to the grantee (on `/me/events`). */
export const AgentSharedEventSchema = z.object({ agent: AgentSchema });
export type AgentSharedEvent = z.infer<typeof AgentSharedEventSchema>;

/**
 * `role.updated` — whenever an agent's role changes (set by the agent or by its
 * owner). One shape, two audiences: the AGENT itself (a nudge to re-read its
 * role via `GET /me`) and every HUMAN who can currently see the agent (so
 * sidebars refresh the org-visible title live — `agentId` says whose). Carries
 * only the title (or `null` when cleared) and the new `roleUpdatedAt` — NEVER
 * the private instructions. Journaled like every principal event, so it replays
 * on reconnect.
 */
export const RoleUpdatedEventSchema = z.object({
  agentId: z.string(),
  roleTitle: z.string().nullable(),
  roleUpdatedAt: IsoDateTimeSchema,
});
export type RoleUpdatedEvent = z.infer<typeof RoleUpdatedEventSchema>;

/**
 * `dm.severed` / `dm.allowed` — a human cut (or re-permitted) an agent↔agent
 * direct conversation. One shape, three audiences: BOTH agents of the pair
 * (their line moved) and every human who can currently see both (so an open
 * oversight view updates without a reload). `severedAt` is null on `dm.allowed`.
 */
export const DmSeveredEventSchema = z.object({
  roomId: z.string(),
  orgId: z.string(),
  agents: z.tuple([AgentRefSchema, AgentRefSchema]),
  severedAt: IsoDateTimeSchema.nullable(),
  by: HumanRefSchema,
});
export type DmSeveredEvent = z.infer<typeof DmSeveredEventSchema>;

/** `dm.allowed` — the same payload as `dm.severed`, with `severedAt: null`. */
export const DmAllowedEventSchema = DmSeveredEventSchema;
export type DmAllowedEvent = DmSeveredEvent;

/* ---- v4: the email medium's six unwrapped principal-level events ---- *
 *
 * Every payload that names an email carries an EmailPreview, never a body: the
 * stream nudges, the client fetches. Every `reason` is a Reasons slug, verbatim.
 */

/**
 * `email.received` — to the ANCHOR AGENT. Fires on delivery, whether immediate
 * or the result of an approval minutes later, so the agent's loop needs no
 * separate "your quarantined mail cleared" case.
 */
export const EmailReceivedEventSchema = z.object({
  email: EmailPreviewSchema,
  thread: EmailThreadRefSchema,
});
export type EmailReceivedEvent = z.infer<typeof EmailReceivedEventSchema>;

/** `email.sent` — to the sending agent. */
export const EmailSentEventSchema = z.object({
  email: EmailPreviewSchema,
  thread: EmailThreadRefSchema,
});
export type EmailSentEvent = z.infer<typeof EmailSentEventSchema>;

/**
 * `email.quarantined` (inbound parked) / `email.held` (outbound parked) — to the
 * anchor agent's OWNER **and** the org's owners/admins, mirroring
 * `enrollment.requested`, so the org-wide approvals list is live for whoever can
 * act on it.
 */
export const EmailQuarantinedEventSchema = z.object({
  email: EmailPreviewSchema,
  thread: EmailThreadRefSchema,
  agent: EmailAgentRefSchema,
  reason: EmailReasonSchema,
});
export type EmailQuarantinedEvent = z.infer<typeof EmailQuarantinedEventSchema>;

/** `email.held` — same audience and payload as `email.quarantined`. */
export const EmailHeldEventSchema = EmailQuarantinedEventSchema;
export type EmailHeldEvent = z.infer<typeof EmailHeldEventSchema>;

/**
 * `email.rejected` — same audience. NO body and no preview: a refusal is a
 * security record, and a rejected message is read deliberately, never pushed. It
 * exists because a hard spoof reject against an otherwise-trusted sender is the
 * most security-interesting thing this medium observes.
 */
export const EmailRejectedEventSchema = z.object({
  agentId: z.string(),
  from: PartySchema,
  direction: EmailDirectionSchema,
  reason: EmailReasonSchema,
});
export type EmailRejectedEvent = z.infer<typeof EmailRejectedEventSchema>;

/** How a pending email was resolved. */
export const EmailResolutionSchema = z.enum(['approved', 'denied', 'send-failed']);
export type EmailResolution = z.infer<typeof EmailResolutionSchema>;

/**
 * `email.resolved` — to the owner, the org's owners/admins, AND the anchor
 * agent. `by` is `null` when a judge or a send failure resolved the email. Two
 * approvers watching one row see it resolve in place rather than fighting over it.
 */
export const EmailResolvedEventSchema = z.object({
  email: EmailPreviewSchema,
  thread: EmailThreadRefSchema,
  resolution: EmailResolutionSchema,
  by: HumanRefSchema.nullable(),
});
export type EmailResolvedEvent = z.infer<typeof EmailResolvedEventSchema>;

/**
 * `activity.appended` — the live half of the timeline, delivered to the involved
 * agent's OWNER ONLY (the agent already received the underlying event, and
 * fanning it further would turn one message into an unbounded broadcast). A
 * non-owner permitted to read a timeline refetches instead.
 */
export const ActivityAppendedEventSchema = z.object({ entry: ActivityEntrySchema });
export type ActivityAppendedEvent = z.infer<typeof ActivityAppendedEventSchema>;

/**
 * `replay.gap` — a STRUCTURAL frame (not a journaled domain event) emitted first
 * on a `/me/events` reconnect whose requested cursor (`?since=`/`Last-Event-ID`)
 * has already been pruned from the per-principal event journal. It tells the
 * client that events between its cursor and the oldest retained one are gone, so
 * it must fall back to an inbox reconcile (drain) rather than trusting replay.
 * `since` echoes the cursor the client asked to resume from; `latest` (v4.1+) is
 * the principal's real newest cursor, so a client whose `since` is a STALE cursor
 * from a prior journal generation (post-wipe, ahead of `latest`) can re-seed to it
 * and stop filtering fresh, lower ids as already-seen. Optional for back-compat
 * with servers that predate it.
 */
export const ReplayGapEventSchema = z.object({ since: z.number(), latest: z.number().optional() });
export type ReplayGapEvent = z.infer<typeof ReplayGapEventSchema>;

/**
 * The room wrapper carried on every ROOM event of the `/me/events` fan-in
 * stream: `{ room: { id, name, orgId, kind }, ...payload }` (event name unchanged).
 */
export const EventRoomRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  kind: RoomKindSchema,
});
export type EventRoomRef = z.infer<typeof EventRoomRefSchema>;

/* ================================================================== *
 * Admin (X-Admin-Token)
 * ================================================================== */

/** GET /admin/orgs item: an org with human/agent/room counts. */
export const AdminOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  humanCount: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative(),
  roomCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
});
export type AdminOrg = z.infer<typeof AdminOrgSchema>;

export const ListAdminOrgsResponseSchema = listResponseSchema(AdminOrgSchema);
export type ListAdminOrgsResponse = z.infer<typeof ListAdminOrgsResponseSchema>;

/** GET /admin/rooms item: a room (incl. archived & DMs) with member/message counts. */
export const AdminRoomSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  kind: RoomKindSchema,
  archivedAt: IsoDateTimeSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
});
export type AdminRoom = z.infer<typeof AdminRoomSchema>;

export const ListAdminRoomsResponseSchema = listResponseSchema(AdminRoomSchema);
export type ListAdminRoomsResponse = z.infer<typeof ListAdminRoomsResponseSchema>;

/* ================================================================== *
 * Voice (STT & TTS)
 * ================================================================== */

/**
 * A cloud-injectable workspace switcher, advertised on `GET /capabilities` when
 * the instance is configured with a workspace directory service (config keys
 * `workspace.directoryUrl` / `workspace.createUrl`). The SPA fetches the user's
 * workspaces from `directoryUrl` browser-side (with credentials) and renders a
 * switcher in the leftnav org header. `null` on a plain self-hosted instance —
 * the SPA then shows a plain, non-interactive org label instead.
 */
export const WorkspaceSwitcherSchema = z.object({
  /** Directory service URL — `fetch`ed with credentials for `{ items: [...] }`. */
  directoryUrl: z.string(),
  /** "Create a workspace" target, or `null` when workspace creation is not offered. */
  createUrl: z.string().nullable(),
});
export type WorkspaceSwitcher = z.infer<typeof WorkspaceSwitcherSchema>;

/** One workspace in the directory response (`GET directoryUrl → { items }`). */
export const WorkspaceDirectoryEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  lastLoginAt: z.number().optional(),
});
export type WorkspaceDirectoryEntry = z.infer<typeof WorkspaceDirectoryEntrySchema>;

export const WorkspaceDirectoryResponseSchema = z.object({
  items: z.array(WorkspaceDirectoryEntrySchema),
});
export type WorkspaceDirectoryResponse = z.infer<typeof WorkspaceDirectoryResponseSchema>;

/** GET /capabilities: booleans derived from registered providers, never key material. */
export const CapabilitiesResponseSchema = z.object({
  voice: z.object({
    stt: z.boolean(),
    tts: z.boolean(),
  }),
  /**
   * The email medium's on/off — true iff `EMAIL_ORG_SUFFIX` is set AND an email
   * provider registers. This unauthenticated route, not `GET /me/email/address`,
   * is where a client learns the medium's on/off: clients gate render on it and
   * never discover a medium by taking a `404`. Defaulted so pre-email servers parse.
   */
  email: z.boolean().default(false),
  /**
   * Whether an automatic reviewer (an `LlmJudge`) is registered here. A `judge`
   * email policy on an instance without one degrades to approve, so an org admin
   * is told that plainly rather than the UI guessing. Independent of `email`: the
   * medium can be on with no reviewer. Defaulted so pre-reviewer servers parse.
   */
  emailReviewer: z.boolean().default(false),
  /**
   * The host suffix a fronting edge maps to org scope (env `ORG_HOST_SUFFIX`,
   * e.g. `.example.com` or `.localhost:8722`): a request whose host equals
   * `<slug><suffix>` is host-scoped to that org. Advertised so the SPA can
   * detect host scoping; `null` when unconfigured (path scoping — `/orgs/:slug/…`
   * — is always available). Defaulted so pre-suffix servers parse.
   */
  orgHostSuffix: z.string().nullable().default(null),
  /**
   * A cloud-injectable workspace switcher (config `workspace.directoryUrl` /
   * `workspace.createUrl`), or `null` on a plain self-hosted instance. Defaulted
   * so pre-switcher servers parse.
   */
  workspaceSwitcher: WorkspaceSwitcherSchema.nullable().default(null),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

/** POST /voice/transcriptions body. `audioBase64` decoded ≤ MAX_TRANSCRIPTION_AUDIO_BYTES. */
export const TranscriptionRequestSchema = z.object({
  audioBase64: z.string().min(1),
  contentType: z.string().min(1),
  language: z.string().optional(),
});
export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;

/** POST /voice/transcriptions response: the transcript, returned to the caller (never sent). */
export const TranscriptionResponseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
});
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema>;

/* ================================================================== *
 * Config (instance)
 * ================================================================== */

export const ConfigValueTypeSchema = z.enum(['boolean', 'string', 'string[]']);
export type ConfigValueType = z.infer<typeof ConfigValueTypeSchema>;

/** Declares one instance-config setting so the web UI can render it dynamically. */
export const ConfigDescriptorSchema = z.object({
  key: z.string(),
  type: ConfigValueTypeSchema,
  label: z.string(),
  description: z.string(),
  default: z.unknown(),
  envVar: z.string().optional(),
  secret: z.boolean().optional(),
});
export type ConfigDescriptor = z.infer<typeof ConfigDescriptorSchema>;

export const ConfigSourceSchema = z.enum(['db', 'env', 'default']);
export type ConfigSource = z.infer<typeof ConfigSourceSchema>;

/** One resolved config entry: descriptor + effective value + where it came from. */
export const ConfigEntrySchema = z.object({
  descriptor: ConfigDescriptorSchema,
  value: z.unknown(),
  source: ConfigSourceSchema,
});
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>;

/** GET /config. */
export const GetConfigResponseSchema = z.object({
  entries: z.array(ConfigEntrySchema),
});
export type GetConfigResponse = z.infer<typeof GetConfigResponseSchema>;

/** PUT /config body. */
export const PutConfigRequestSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});
export type PutConfigRequest = z.infer<typeof PutConfigRequestSchema>;

/* ================================================================== *
 * Misc
 * ================================================================== */

/** GET /healthz. */
export const HealthzResponseSchema = z.object({
  ok: z.literal(true),
  /** The PRODUCT version (root package.json), not `@sparrow/api`'s own. */
  version: z.string(),
  /** Build stamp `<yyyymmdd>.<sha>`; `null` when the build was never stamped. */
  build: z.string().nullable().optional(),
});
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;
