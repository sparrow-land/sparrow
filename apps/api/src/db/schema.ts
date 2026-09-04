import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

/**
 * Drizzle table definitions mirroring the SPEC v3 data model. Timestamps are
 * stored as ISO-8601 UTC strings (lexicographically sortable), matching the wire
 * shapes. The authoritative DDL lives in `migrate.ts` (fresh databases only — v3
 * ships no migration chain); these declarations drive queries + row types.
 */

/* ------------------------------------------------------------------ *
 * Orgs & humans
 * ------------------------------------------------------------------ */

export const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /**
   * Was this slug CHOSEN by a person (`1`) or DERIVED from the org name (`0`)?
   *
   * Renaming an org regenerates a derived slug (nobody meant to live at
   * `alice-example-coms-org` forever) but never a chosen one — a chosen slug is
   * a published address, in links, in `<slug><ORG_HOST_SUFFIX>` hosts, in
   * bookmarks. Every row this code writes carries an explicit `0` or `1`.
   *
   * `null` = UNKNOWN: a row from a database that predates the column, where the
   * two cases are indistinguishable. Treated as CHOSEN (never regenerate), because
   * silently moving an address someone picked is the worse of the two mistakes.
   */
  slugCustom: integer('slug_custom'),
  /** JSON text of the org settings; '{}' means "all defaults". */
  settings: text('settings').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
});

export const orgMemberships = sqliteTable(
  'org_memberships',
  {
    orgId: text('org_id').notNull(),
    humanId: text('human_id').notNull(),
    role: text('role').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.humanId] }),
    humanIdx: index('org_memberships_human').on(t.humanId),
  }),
);

export const humans = sqliteTable('humans', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  /** scrypt `scrypt$N$r$p$salt$hash`; null for oauth-only accounts. */
  passwordHash: text('password_hash'),
  provider: text('provider').notNull(),
  /**
   * The content type (e.g. `image/png`) of an uploaded avatar image, or null when
   * none is uploaded. Non-null means the image bytes live on disk under the data
   * dir's `avatars/{humanId}` (same on-disk machinery as message attachments); it
   * is served by `GET /api/v1/avatars/:humanId`. An uploaded avatar always wins
   * over the provider photo / gravatar in the resolution chain.
   */
  avatarAttachment: text('avatar_attachment'),
  /** Photo URL supplied by an upstream identity provider at sign-in, or null. */
  providerAvatarUrl: text('provider_avatar_url'),
  /**
   * The human's UI theme preference (`auto` | `dark` | `light`), or null when
   * never set. Null is resolved to `auto` on the wire — the web UI follows the
   * OS `prefers-color-scheme` in that case. Purely presentational; per-human.
   */
  theme: text('theme'),
  createdAt: text('created_at').notNull(),
});

export const userSessions = sqliteTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    humanId: text('human_id').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    tokenHashIdx: index('user_sessions_token_hash').on(t.tokenHash),
    humanIdx: index('user_sessions_human').on(t.humanId),
  }),
);

/* ------------------------------------------------------------------ *
 * Agents & visibility
 * ------------------------------------------------------------------ */

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    ownerHumanId: text('owner_human_id').notNull(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    /**
     * Agent-level sharing mode: `room-members` (the default — any human
     * co-member of a shared non-DM, non-archived room), `selected` (explicit
     * grants only), or `org` (every human in the agent's org). See
     * `canAccessAgent` in agent-helpers.
     */
    sharing: text('sharing').notNull().default('room-members'),
    /**
     * The agent's ROLE — a persistent job description. `roleTitle` is a short,
     * org-visible label; `roleInstructions` is a private markdown body (owner + the
     * agent itself only); `roleUpdatedAt` is when either half last changed (drives
     * the re-read nudge and its hint re-arm). All null when the agent has no role.
     */
    roleTitle: text('role_title'),
    roleInstructions: text('role_instructions'),
    roleUpdatedAt: text('role_updated_at'),
    /** Null for a freshly minted agent that has never authenticated. */
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    keyHashIdx: index('agents_key_hash').on(t.keyHash),
    orgIdx: index('agents_org').on(t.orgId),
    ownerIdx: index('agents_owner').on(t.ownerHumanId),
  }),
);

export const agentVisibility = sqliteTable(
  'agent_visibility',
  {
    agentId: text('agent_id').notNull(),
    humanId: text('human_id').notNull(),
    grantedByHumanId: text('granted_by_human_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.humanId] }),
    humanIdx: index('agent_visibility_human').on(t.humanId),
  }),
);

/* ------------------------------------------------------------------ *
 * Invites & enrollment
 * ------------------------------------------------------------------ */

export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    /**
     * The issuing member. NULL only for an admin-provisioned **owner invite**
     * (an owner-pending org has no members to issue it): redeeming it makes the
     * caller the org's first `owner`.
     */
    inviterHumanId: text('inviter_human_id'),
    tokenHash: text('token_hash').notNull(),
    note: text('note'),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    tokenHashIdx: index('invites_token_hash').on(t.tokenHash),
    orgIdx: index('invites_org').on(t.orgId),
  }),
);

export const enrollments = sqliteTable(
  'enrollments',
  {
    id: text('id').primaryKey(),
    inviteId: text('invite_id').notNull(),
    /** Denormalized from the invite for direct org-scoped queries. */
    orgId: text('org_id').notNull(),
    kind: text('kind').notNull(),
    /** Human enrollments: the knocking account. Null for agent enrollments. */
    humanId: text('human_id'),
    /** Agent enrollments: the proposed agent name. */
    proposedName: text('proposed_name'),
    note: text('note'),
    /** sha256 of the `enr_` token (agent enrollments poll with it). */
    tokenHash: text('token_hash'),
    status: text('status').notNull(),
    /** Plaintext `agk_` key held from approval until the first delivery poll. */
    issuedKey: text('issued_key'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    orgIdx: index('enrollments_org').on(t.orgId),
    inviteIdx: index('enrollments_invite').on(t.inviteId),
    tokenHashIdx: index('enrollments_token_hash').on(t.tokenHash),
  }),
);

/* ------------------------------------------------------------------ *
 * Rooms & members
 * ------------------------------------------------------------------ */

export const rooms = sqliteTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    /** '' for DM rooms. */
    name: text('name').notNull(),
    kind: text('kind').notNull().default('project'),
    /** 'orgId|principalA|principalB' (ids sorted); set only for DM rooms. */
    dmKey: text('dm_key'),
    archivedAt: text('archived_at'),
    settings: text('settings').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    dmKeyIdx: uniqueIndex('rooms_dm_key').on(t.dmKey),
    orgIdx: index('rooms_org').on(t.orgId),
  }),
);

/**
 * A SEVERED agent↔agent DM (SPEC "Direct conversations → Severing"). One row
 * per severed DM room; the row's PRESENCE is the block, so lifting it is a
 * delete. `authority` records who cut the line, because that decides who may
 * lift it: an `org` sever (org owner/admin) outranks an `agent-owner` one.
 * Durable on purpose — a severed pair stays severed across room archive,
 * re-ensure, and restarts, exactly like a thread approval.
 */
export const agentDmSevers = sqliteTable(
  'agent_dm_severs',
  {
    roomId: text('room_id').primaryKey(),
    orgId: text('org_id').notNull(),
    severedByHumanId: text('severed_by_human_id').notNull(),
    /** 'org' | 'agent-owner'. */
    authority: text('authority').notNull(),
    severedAt: text('severed_at').notNull(),
  },
  (t) => ({
    orgIdx: index('agent_dm_severs_org').on(t.orgId),
  }),
);

export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    roomRole: text('room_role').notNull().default('member'),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    roomPrincipal: unique('members_room_principal').on(
      t.roomId,
      t.principalType,
      t.principalId,
    ),
    roomIdx: index('members_room').on(t.roomId),
    principalIdx: index('members_principal').on(t.principalId),
  }),
);

export const roomInvitations = sqliteTable(
  'room_invitations',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    humanId: text('human_id').notNull(),
    invitedByHumanId: text('invited_by_human_id').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => ({
    roomIdx: index('room_invitations_room').on(t.roomId),
    humanIdx: index('room_invitations_human').on(t.humanId),
  }),
);

/* ------------------------------------------------------------------ *
 * Messages & attachments
 * ------------------------------------------------------------------ */

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    /** The sender's member id. */
    senderId: text('sender_id').notNull(),
    /**
     * IDENTITY SNAPSHOT of the sender, captured at send time (SPEC "Messages").
     * `sender_id` names a per-room MEMBERSHIP, and membership is deleted when
     * someone leaves, is removed, or (for an agent) is destroyed — so it cannot
     * be the only record of who wrote a message. These three columns keep the
     * transcript truthful afterwards: `kind` and the principal id come back
     * exactly, and `display_name` is the last-resort name for a principal that
     * no longer exists at all (a destroyed agent). While the principal DOES
     * exist its live name still wins, so renames keep rendering on old messages.
     *
     * Nullable only because a database created before this column existed
     * carries nulls on old rows; those refs resolve to `kind: 'unknown'` rather
     * than being guessed into a human.
     */
    senderPrincipalType: text('sender_principal_type'),
    senderPrincipalId: text('sender_principal_id'),
    senderDisplayName: text('sender_display_name'),
    kind: text('kind').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    suggestedReplies: text('suggested_replies'),
    inReplyTo: text('in_reply_to'),
    replyValue: text('reply_value'),
    /** Message provenance: `'voice'` (dictated via STT) or null (typed). */
    origin: text('origin'),
    /**
     * When the sender clawed the message back (SPEC "Clawback"); null = live.
     * A clawed row is DEAD on every read surface (history, inboxes, pops,
     * by-id reads, counts, transcripts) — the row stays only so the clawback is
     * idempotently detectable and receipts need no cleanup.
     */
    clawedBackAt: text('clawed_back_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    roomIdx: index('messages_room').on(t.roomId),
    senderIdx: index('messages_sender').on(t.senderId),
  }),
);

export const messageRecipients = sqliteTable(
  'message_recipients',
  {
    messageId: text('message_id').notNull(),
    /** The recipient's member id. */
    recipientId: text('recipient_id').notNull(),
    /**
     * Identity snapshot of the recipient, captured at send time — the delivery-row
     * twin of `messages.sender_*`, so a message's `to` refs survive the recipient
     * leaving the room. Same nullability caveat.
     */
    recipientPrincipalType: text('recipient_principal_type'),
    recipientPrincipalId: text('recipient_principal_id'),
    recipientDisplayName: text('recipient_display_name'),
    /** Server-observed delivery (SPEC "Read state"); set once, never a client verb. */
    receivedAt: text('received_at'),
    readAt: text('read_at'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.recipientId] }),
    recipientIdx: index('message_recipients_recipient').on(t.recipientId),
  }),
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    messageIdx: index('attachments_message').on(t.messageId),
  }),
);

/**
 * Personal, room-scoped message drafts. Keyed for `(room_id, member_id)`
 * listing; `member_id` is the authoring member (drafts are private to their
 * author). Hard-capped per (room, member) by the route layer.
 */
export const drafts = sqliteTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    /** The authoring member id. */
    memberId: text('member_id').notNull(),
    text: text('text').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    roomMemberIdx: index('drafts_room_member').on(t.roomId, t.memberId),
  }),
);

export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/* ------------------------------------------------------------------ *
 * The email medium (layer 2)
 * ------------------------------------------------------------------ */

/**
 * An email address, scoped to one org, that belongs to no principal (SPEC v4
 * "The email medium → Data model"). Contacts carry the DURABLE trust state
 * (`approved` / `blocked` / null = unknown) that is the memory behind "you
 * already said yes to this person" — the third rung of the trust ladder. They
 * are never deleted by approve/deny: trust is the point of the row.
 */
export const externalContacts = sqliteTable(
  'external_contacts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    /** Lowercased. */
    email: text('email').notNull(),
    /** The latest `From:` display name seen for this address. */
    displayName: text('display_name'),
    /** `approved` | `blocked` | null (unknown). */
    trust: text('trust'),
    firstSeenAt: text('first_seen_at').notNull(),
    resolvedByHumanId: text('resolved_by_human_id'),
    resolvedAt: text('resolved_at'),
  },
  (t) => ({
    orgEmail: unique('external_contacts_org_email').on(t.orgId, t.email),
    orgTrustIdx: index('external_contacts_org_trust').on(t.orgId, t.trust),
  }),
);

/**
 * A conversation, anchored to exactly ONE agent — threads NEVER span agents, by
 * construction (joining is evaluated within the anchor's own mail). `subject` is
 * the FIRST email's subject and never changes; `last_email_at` is bumped ONLY by
 * a delivered/sent email, so a thread whose only email was quarantined/held/
 * rejected stays null and invisible in listings (an unknown sender cannot push a
 * stranger's subject line into an agent's mailbox just by sending).
 */
export const emailThreads = sqliteTable(
  'email_threads',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    subject: text('subject').notNull(),
    /** 0/1 — a durable, human-granted approval on THIS conversation. */
    trusted: integer('trusted').notNull().default(0),
    createdAt: text('created_at').notNull(),
    lastEmailAt: text('last_email_at'),
  },
  (t) => ({
    agentLastIdx: index('email_threads_agent_last').on(t.agentId, t.lastEmailAt),
    orgLastIdx: index('email_threads_org_last').on(t.orgId, t.lastEmailAt),
  }),
);

/**
 * One email in a thread, `in` or `out`. `org_id`/`agent_id` are denormalized so
 * the approvals queue and the pop queue are single-table index scans, and
 * `rfc_message_id` is unique **per anchor agent** — an inbound message cc'ing two
 * org agents legitimately becomes two rows, and the pair is the idempotency key.
 * A `rejected` INBOUND row keeps metadata only (`text_body`/`html_body` NULL).
 */
export const emails = sqliteTable(
  'emails',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    /** Denormalized (the approvals queue). */
    orgId: text('org_id').notNull(),
    /** Denormalized — the anchor agent (the pop queue). */
    agentId: text('agent_id').notNull(),
    /** `in` | `out`. */
    direction: text('direction').notNull(),
    rfcMessageId: text('rfc_message_id').notNull(),
    inReplyTo: text('in_reply_to'),
    /** JSON array of rfc ids (inbound). */
    referencesJson: text('references_json'),
    /** JSON `{ from, to, cc, bcc }` of Party objects. */
    participants: text('participants').notNull(),
    subject: text('subject').notNull(),
    textBody: text('text_body'),
    /** ALREADY sanitized at ingest; the original is discarded. */
    htmlBody: text('html_body'),
    /** JSON verification block; always null on outbound. */
    verification: text('verification'),
    disposition: text('disposition').notNull(),
    /** A short stable slug — the ONE reason vocabulary. */
    reason: text('reason'),
    /** JSON `{ verdict, reason, provider }`; null when no judge ran. */
    judge: text('judge'),
    /** The anchor agent has popped/read it (inbound + delivered only). */
    readAt: text('read_at'),
    createdAt: text('created_at').notNull(),
    /** approve / deny / send time. */
    resolvedAt: text('resolved_at'),
  },
  (t) => ({
    agentRfc: unique('emails_agent_rfc').on(t.agentId, t.rfcMessageId),
    threadIdx: index('emails_thread').on(t.threadId, t.createdAt, t.id),
    orgDispositionIdx: index('emails_org_disposition').on(t.orgId, t.disposition, t.createdAt),
    agentReadIdx: index('emails_agent_read').on(t.agentId, t.readAt, t.createdAt),
  }),
);

/**
 * The QUARANTINE side of the trust boundary — inbound rows whose disposition is
 * `quarantined` or `rejected`, physically segregated from `emails` (Jake's
 * rule: strangers' messages get their own table, so even an out-of-band SQL
 * query can never confuse quarantined mail with legit mail). Same column shape
 * as `emails`; a row's `id` is stable across the boundary — approval MOVES the
 * row into `emails` (disposition `delivered`), a deny leaves it here forever
 * (disposition `rejected`, body wiped). `emails` itself holds ONLY delivered
 * inbound plus the agent's own outbound rows, whatever their fate.
 */
export const emailQuarantine = sqliteTable(
  'email_quarantine',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** Always `in` — outbound mail is never quarantine-side. */
    direction: text('direction').notNull(),
    rfcMessageId: text('rfc_message_id').notNull(),
    inReplyTo: text('in_reply_to'),
    referencesJson: text('references_json'),
    participants: text('participants').notNull(),
    subject: text('subject').notNull(),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    verification: text('verification'),
    /** `quarantined` | `rejected`. */
    disposition: text('disposition').notNull(),
    reason: text('reason'),
    judge: text('judge'),
    /** Always null here — read state exists only for delivered mail. */
    readAt: text('read_at'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => ({
    agentRfc: unique('email_quarantine_agent_rfc').on(t.agentId, t.rfcMessageId),
    threadIdx: index('email_quarantine_thread').on(t.threadId, t.createdAt, t.id),
    orgDispositionIdx: index('email_quarantine_org_disposition').on(
      t.orgId,
      t.disposition,
      t.createdAt,
    ),
  }),
);

/** Email attachment metadata; bytes share chat's store (`$DATA_DIR/attachments/{id}`). */
export const emailAttachments = sqliteTable(
  'email_attachments',
  {
    id: text('id').primaryKey(),
    emailId: text('email_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    emailIdx: index('email_attachments_email').on(t.emailId),
  }),
);

/* ------------------------------------------------------------------ *
 * Unified attention (layer 3) — the activity timeline
 * ------------------------------------------------------------------ */

/**
 * The append-only record every medium writes typed entries into (SPEC v4 "Data
 * model" + "Unified attention → The activity timeline"). Entries are REFS, never
 * payloads: `summary` renders a list without a medium fetch, and the typed ref
 * columns point at the owning medium's row.
 *
 * A record, not a mailbox: rows are never marked read, never popped, never
 * mutated. `agent_id` is the anchor (layer 3 journals only what involves an
 * agent) and is nullable so org-level entries can be added without a schema
 * change; `owner_human_id` is denormalized so a human's timeline is one indexed
 * read; `actor_label` is FROZEN at append time so history still reads correctly
 * after a rename.
 */
export const activityEntries = sqliteTable(
  'activity_entries',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    /** The agent this entry involves; null for a (future) org-level entry. */
    agentId: text('agent_id'),
    /** The owner of `agent_id` at append time — the per-owner read key. */
    ownerHumanId: text('owner_human_id'),
    /** `chat` | `email` | `voice`. */
    medium: text('medium').notNull(),
    /** The registry type, `<medium>.<verb>`. */
    type: text('type').notNull(),
    /** `human` | `agent` | `contact` | `system`. */
    actorKind: text('actor_kind').notNull(),
    /** `usr_`/`agt_` principal id; null for a contact or system actor. */
    actorPrincipalId: text('actor_principal_id'),
    /** `ext_` external contact id (email senders); null otherwise. */
    actorContactId: text('actor_contact_id'),
    /** The actor's display string, frozen at append time. */
    actorLabel: text('actor_label').notNull(),
    /** Subject or first line, ≤ 240 — list rendering without a medium fetch. */
    summary: text('summary'),
    roomId: text('room_id'),
    messageId: text('message_id'),
    emailThreadId: text('email_thread_id'),
    emailId: text('email_id'),
    /**
     * `hint.delivered` only — the ONE inline payload (SPEC: entries are refs,
     * hints are the exception because the `system` medium has no fetch route).
     * `hint_id` is the trigger id; `hint_text` the verbatim text conveyed to
     * the agent. Null on every other type, and on hint rows that predate it.
     */
    hintId: text('hint_id'),
    hintText: text('hint_text'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    agentIdx: index('activity_entries_agent').on(t.agentId, t.createdAt, t.id),
    ownerIdx: index('activity_entries_owner').on(t.ownerHumanId, t.createdAt, t.id),
    actorIdx: index('activity_entries_actor').on(t.actorPrincipalId, t.createdAt, t.id),
    orgIdx: index('activity_entries_org').on(t.orgId, t.createdAt, t.id),
  }),
);

/* ------------------------------------------------------------------ *
 * Per-principal `/me/events` journal (SSE resume)
 * ------------------------------------------------------------------ */

/**
 * The events emitted on each principal's `/me/events` stream, persisted so a
 * reconnecting client can replay what it missed while disconnected. `id` is a
 * global AUTOINCREMENT cursor (the value written as the SSE `id:` field);
 * `data` is the exact JSON payload the frame carried (room events already
 * wrapped `{ room, ...payload }`). Pruned on write by age + per-principal cap.
 */
export const meEventJournal = sqliteTable(
  'me_event_journal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    event: text('event').notNull(),
    data: text('data').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    principalIdx: index('me_event_journal_principal').on(t.principalType, t.principalId, t.id),
    createdAtIdx: index('me_event_journal_created_at').on(t.createdAt),
  }),
);

/**
 * Per-principal high-water mark of pruned journal ids: the largest cursor ever
 * deleted for a principal. A resume `since` below this value provably lost an
 * event (that id > since was received and then pruned) → the route emits
 * `replay.gap`. Survives restarts so gap detection stays correct.
 */
export const meEventJournalMarks = sqliteTable(
  'me_event_journal_marks',
  {
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    maxPrunedId: integer('max_pruned_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.principalType, t.principalId] }),
  }),
);

/* ------------------------------------------------------------------ *
 * Hints — cooldown ledger + per-principal preference
 * ------------------------------------------------------------------ */

/**
 * Per-(principal, hint) delivery ledger. One row per hint id ever delivered to a
 * principal; `delivered_at` is the LAST delivery (upserted). Drives the re-fire
 * cooldown and — by row count — the `control-your-hints` meta-hint threshold.
 */
export const hintDeliveries = sqliteTable(
  'hint_deliveries',
  {
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    hintId: text('hint_id').notNull(),
    deliveredAt: text('delivered_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.principalType, t.principalId, t.hintId] }),
    principalIdx: index('hint_deliveries_principal').on(t.principalType, t.principalId),
  }),
);

/** Per-principal hint coaching level (`off` | `normal` | `aggressive`). */
export const hintPreferences = sqliteTable(
  'hint_preferences',
  {
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    level: text('level').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.principalType, t.principalId] }),
  }),
);

export type OrgRow = typeof orgs.$inferSelect;
export type OrgMembershipRow = typeof orgMemberships.$inferSelect;
export type HumanRow = typeof humans.$inferSelect;
export type UserSessionRow = typeof userSessions.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AgentVisibilityRow = typeof agentVisibility.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type EnrollmentRow = typeof enrollments.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type AgentDmSeverRow = typeof agentDmSevers.$inferSelect;
export type RoomInvitationRow = typeof roomInvitations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageRecipientRow = typeof messageRecipients.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;
export type ConfigRow = typeof config.$inferSelect;
export type ExternalContactRow = typeof externalContacts.$inferSelect;
export type EmailThreadRow = typeof emailThreads.$inferSelect;
export type EmailRow = typeof emails.$inferSelect;
/** Structurally identical to {@link EmailRow} — the same shape on either side. */
export type EmailQuarantineRow = typeof emailQuarantine.$inferSelect;
export type EmailAttachmentRow = typeof emailAttachments.$inferSelect;
export type ActivityEntryRow = typeof activityEntries.$inferSelect;
export type MeEventJournalRow = typeof meEventJournal.$inferSelect;
export type MeEventJournalMarkRow = typeof meEventJournalMarks.$inferSelect;
export type HintDeliveryRow = typeof hintDeliveries.$inferSelect;
export type HintPreferenceRow = typeof hintPreferences.$inferSelect;
