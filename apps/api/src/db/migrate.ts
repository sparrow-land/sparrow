import type Database from 'better-sqlite3';

/**
 * Fresh v3 schema creation. **There is no migration path** (SPEC v3): a v3 server
 * creates a fresh database; pre-v3 databases are not readable. `CREATE TABLE IF
 * NOT EXISTS` keeps boot idempotent for a database this same v3 code created.
 * WAL is enabled for concurrent reads; foreign_keys are left OFF (the app owns
 * referential integrity + cascades explicitly, as the v2 line did).
 */
export function migrate(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      slug_custom INTEGER,
      settings    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS org_memberships (
      org_id     TEXT NOT NULL,
      human_id   TEXT NOT NULL,
      role       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, human_id)
    );
    CREATE INDEX IF NOT EXISTS org_memberships_human ON org_memberships(human_id);

    CREATE TABLE IF NOT EXISTS humans (
      id                  TEXT PRIMARY KEY,
      email               TEXT NOT NULL UNIQUE,
      display_name        TEXT NOT NULL,
      password_hash       TEXT,
      provider            TEXT NOT NULL,
      avatar_attachment   TEXT,
      provider_avatar_url TEXT,
      theme               TEXT,
      created_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id         TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      human_id   TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_sessions_token_hash ON user_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS user_sessions_human ON user_sessions(human_id);

    CREATE TABLE IF NOT EXISTS agents (
      id             TEXT PRIMARY KEY,
      org_id         TEXT NOT NULL,
      owner_human_id TEXT NOT NULL,
      name           TEXT NOT NULL,
      key_hash          TEXT NOT NULL,
      sharing           TEXT NOT NULL DEFAULT 'room-members',
      role_title        TEXT,
      role_instructions TEXT,
      role_updated_at   TEXT,
      last_seen_at      TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agents_org_name ON agents(org_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS agents_key_hash ON agents(key_hash);
    CREATE INDEX IF NOT EXISTS agents_org ON agents(org_id);
    CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner_human_id);

    CREATE TABLE IF NOT EXISTS agent_visibility (
      agent_id             TEXT NOT NULL,
      human_id             TEXT NOT NULL,
      granted_by_human_id  TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      PRIMARY KEY (agent_id, human_id)
    );
    CREATE INDEX IF NOT EXISTS agent_visibility_human ON agent_visibility(human_id);

    CREATE TABLE IF NOT EXISTS invites (
      id                TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      inviter_human_id  TEXT,
      token_hash        TEXT NOT NULL,
      note              TEXT,
      expires_at        TEXT NOT NULL,
      revoked_at        TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invites_token_hash ON invites(token_hash);
    CREATE INDEX IF NOT EXISTS invites_org ON invites(org_id);

    CREATE TABLE IF NOT EXISTS enrollments (
      id            TEXT PRIMARY KEY,
      invite_id     TEXT NOT NULL,
      org_id        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      human_id      TEXT,
      proposed_name TEXT,
      note          TEXT,
      token_hash    TEXT,
      status        TEXT NOT NULL,
      issued_key    TEXT,
      created_at    TEXT NOT NULL,
      resolved_at   TEXT,
      expires_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS enrollments_org ON enrollments(org_id);
    CREATE INDEX IF NOT EXISTS enrollments_invite ON enrollments(invite_id);
    CREATE INDEX IF NOT EXISTS enrollments_token_hash ON enrollments(token_hash);

    CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'project',
      dm_key      TEXT,
      archived_at TEXT,
      settings    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rooms_dm_key ON rooms(dm_key);
    CREATE INDEX IF NOT EXISTS rooms_org ON rooms(org_id);

    CREATE TABLE IF NOT EXISTS agent_dm_severs (
      room_id             TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL,
      severed_by_human_id TEXT NOT NULL,
      authority           TEXT NOT NULL,
      severed_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_dm_severs_org ON agent_dm_severs(org_id);

    CREATE TABLE IF NOT EXISTS members (
      id             TEXT PRIMARY KEY,
      room_id        TEXT NOT NULL,
      principal_type TEXT NOT NULL,
      principal_id   TEXT NOT NULL,
      room_role      TEXT NOT NULL DEFAULT 'member',
      last_seen_at   TEXT,
      created_at     TEXT NOT NULL,
      UNIQUE (room_id, principal_type, principal_id)
    );
    CREATE INDEX IF NOT EXISTS members_room ON members(room_id);
    CREATE INDEX IF NOT EXISTS members_principal ON members(principal_id);

    CREATE TABLE IF NOT EXISTS room_invitations (
      id                  TEXT PRIMARY KEY,
      room_id             TEXT NOT NULL,
      human_id            TEXT NOT NULL,
      invited_by_human_id TEXT NOT NULL,
      status              TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      resolved_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS room_invitations_room ON room_invitations(room_id);
    CREATE INDEX IF NOT EXISTS room_invitations_human ON room_invitations(human_id);

    CREATE TABLE IF NOT EXISTS messages (
      id                TEXT PRIMARY KEY,
      room_id           TEXT NOT NULL,
      sender_id         TEXT NOT NULL,
      sender_principal_type TEXT,
      sender_principal_id   TEXT,
      sender_display_name   TEXT,
      kind              TEXT NOT NULL,
      subject           TEXT,
      body              TEXT NOT NULL,
      suggested_replies TEXT,
      in_reply_to       TEXT,
      reply_value       TEXT,
      origin            TEXT,
      clawed_back_at    TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id);
    CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id);

    CREATE TABLE IF NOT EXISTS message_recipients (
      message_id   TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      recipient_principal_type TEXT,
      recipient_principal_id   TEXT,
      recipient_display_name   TEXT,
      received_at  TEXT,
      read_at      TEXT,
      PRIMARY KEY (message_id, recipient_id)
    );
    CREATE INDEX IF NOT EXISTS message_recipients_recipient ON message_recipients(recipient_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL,
      filename     TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);

    CREATE TABLE IF NOT EXISTS drafts (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      member_id  TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drafts_room_member ON drafts(room_id, member_id);

    CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- The email medium (layer 2). Same database file, same attachment store
    -- ($DATA_DIR/attachments/{id}); dormant unless the operator configures the
    -- medium (SPEC "The email medium → Data model").
    CREATE TABLE IF NOT EXISTS external_contacts (
      id                   TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL,
      email                TEXT NOT NULL,
      display_name         TEXT,
      trust                TEXT,
      first_seen_at        TEXT NOT NULL,
      resolved_by_human_id TEXT,
      resolved_at          TEXT,
      UNIQUE (org_id, email)
    );
    CREATE INDEX IF NOT EXISTS external_contacts_org_trust
      ON external_contacts(org_id, trust);

    CREATE TABLE IF NOT EXISTS email_threads (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      subject       TEXT NOT NULL,
      trusted       INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      last_email_at TEXT
    );
    CREATE INDEX IF NOT EXISTS email_threads_agent_last
      ON email_threads(agent_id, last_email_at);
    CREATE INDEX IF NOT EXISTS email_threads_org_last
      ON email_threads(org_id, last_email_at);

    CREATE TABLE IF NOT EXISTS emails (
      id              TEXT PRIMARY KEY,
      thread_id       TEXT NOT NULL,
      org_id          TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      direction       TEXT NOT NULL,
      rfc_message_id  TEXT NOT NULL,
      in_reply_to     TEXT,
      references_json TEXT,
      participants    TEXT NOT NULL,
      subject         TEXT NOT NULL,
      text_body       TEXT,
      html_body       TEXT,
      verification    TEXT,
      disposition     TEXT NOT NULL,
      reason          TEXT,
      judge           TEXT,
      read_at         TEXT,
      created_at      TEXT NOT NULL,
      resolved_at     TEXT,
      UNIQUE (agent_id, rfc_message_id)
    );
    CREATE INDEX IF NOT EXISTS emails_thread ON emails(thread_id, created_at, id);
    CREATE INDEX IF NOT EXISTS emails_org_disposition ON emails(org_id, disposition, created_at);
    CREATE INDEX IF NOT EXISTS emails_agent_read ON emails(agent_id, read_at, created_at);

    -- The quarantine side of the email trust boundary: inbound rows dispositioned
    -- 'quarantined' or 'rejected', physically segregated from 'emails' so an
    -- out-of-band SQL query can never confuse a stranger's message with legit
    -- mail. Same column shape as 'emails'; approval MOVES a row across (same id).
    CREATE TABLE IF NOT EXISTS email_quarantine (
      id              TEXT PRIMARY KEY,
      thread_id       TEXT NOT NULL,
      org_id          TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      direction       TEXT NOT NULL,
      rfc_message_id  TEXT NOT NULL,
      in_reply_to     TEXT,
      references_json TEXT,
      participants    TEXT NOT NULL,
      subject         TEXT NOT NULL,
      text_body       TEXT,
      html_body       TEXT,
      verification    TEXT,
      disposition     TEXT NOT NULL,
      reason          TEXT,
      judge           TEXT,
      read_at         TEXT,
      created_at      TEXT NOT NULL,
      resolved_at     TEXT,
      UNIQUE (agent_id, rfc_message_id)
    );
    CREATE INDEX IF NOT EXISTS email_quarantine_thread
      ON email_quarantine(thread_id, created_at, id);
    CREATE INDEX IF NOT EXISTS email_quarantine_org_disposition
      ON email_quarantine(org_id, disposition, created_at);

    CREATE TABLE IF NOT EXISTS email_attachments (
      id           TEXT PRIMARY KEY,
      email_id     TEXT NOT NULL,
      filename     TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_attachments_email ON email_attachments(email_id);

    -- Unified attention (layer 3): the append-only activity timeline every
    -- medium writes typed REF entries into. Never mutated, never read-marked.
    CREATE TABLE IF NOT EXISTS activity_entries (
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL,
      agent_id           TEXT,
      owner_human_id     TEXT,
      medium             TEXT NOT NULL,
      type               TEXT NOT NULL,
      actor_kind         TEXT NOT NULL,
      actor_principal_id TEXT,
      actor_contact_id   TEXT,
      actor_label        TEXT NOT NULL,
      summary            TEXT,
      room_id            TEXT,
      message_id         TEXT,
      email_thread_id    TEXT,
      email_id           TEXT,
      hint_id            TEXT,
      hint_text          TEXT,
      created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_entries_agent
      ON activity_entries(agent_id, created_at, id);
    CREATE INDEX IF NOT EXISTS activity_entries_owner
      ON activity_entries(owner_human_id, created_at, id);
    CREATE INDEX IF NOT EXISTS activity_entries_actor
      ON activity_entries(actor_principal_id, created_at, id);
    CREATE INDEX IF NOT EXISTS activity_entries_org
      ON activity_entries(org_id, created_at, id);

    CREATE TABLE IF NOT EXISTS me_event_journal (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      principal_type TEXT NOT NULL,
      principal_id   TEXT NOT NULL,
      event          TEXT NOT NULL,
      data           TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS me_event_journal_principal
      ON me_event_journal(principal_type, principal_id, id);
    CREATE INDEX IF NOT EXISTS me_event_journal_created_at
      ON me_event_journal(created_at);

    CREATE TABLE IF NOT EXISTS me_event_journal_marks (
      principal_type TEXT NOT NULL,
      principal_id   TEXT NOT NULL,
      max_pruned_id  INTEGER NOT NULL,
      PRIMARY KEY (principal_type, principal_id)
    );

    CREATE TABLE IF NOT EXISTS hint_deliveries (
      principal_type TEXT NOT NULL,
      principal_id   TEXT NOT NULL,
      hint_id        TEXT NOT NULL,
      delivered_at   TEXT NOT NULL,
      PRIMARY KEY (principal_type, principal_id, hint_id)
    );
    CREATE INDEX IF NOT EXISTS hint_deliveries_principal
      ON hint_deliveries(principal_type, principal_id);

    CREATE TABLE IF NOT EXISTS hint_preferences (
      principal_type TEXT NOT NULL,
      principal_id   TEXT NOT NULL,
      level          TEXT NOT NULL,
      PRIMARY KEY (principal_type, principal_id)
    );
  `);

  // Idempotent column adds for databases created by an earlier v3 build. v3 has
  // no migration chain, but dev/staging DBs predate the voice `origin` column,
  // so add it if absent (PRAGMA table_info guards against a duplicate ALTER).
  addColumnIfMissing(sqlite, 'messages', 'origin', 'TEXT');
  // Clawback (SPEC "Clawback") postdates the messages table; null = live.
  addColumnIfMissing(sqlite, 'messages', 'clawed_back_at', 'TEXT');
  // `received` delivery state (SPEC "Read state") postdates the message_recipients
  // table for dev/staging DBs, so add received_at if absent.
  addColumnIfMissing(sqlite, 'message_recipients', 'received_at', 'TEXT');
  // Sender/recipient IDENTITY SNAPSHOTS postdate the message tables. Without
  // them a message's `from`/`to` were resolved purely by joining the live
  // `members` row, so removing a member rewrote the authorship of every message
  // they had ever sent (see the columns' doc comments in schema.ts).
  addColumnIfMissing(sqlite, 'messages', 'sender_principal_type', 'TEXT');
  addColumnIfMissing(sqlite, 'messages', 'sender_principal_id', 'TEXT');
  addColumnIfMissing(sqlite, 'messages', 'sender_display_name', 'TEXT');
  addColumnIfMissing(sqlite, 'message_recipients', 'recipient_principal_type', 'TEXT');
  addColumnIfMissing(sqlite, 'message_recipients', 'recipient_principal_id', 'TEXT');
  addColumnIfMissing(sqlite, 'message_recipients', 'recipient_display_name', 'TEXT');
  backfillMessageIdentities(sqlite);
  // Avatar columns postdate the humans table for dev/staging DBs.
  addColumnIfMissing(sqlite, 'humans', 'avatar_attachment', 'TEXT');
  addColumnIfMissing(sqlite, 'humans', 'provider_avatar_url', 'TEXT');
  // Theme preference postdates the humans table for dev/staging DBs; null = auto.
  addColumnIfMissing(sqlite, 'humans', 'theme', 'TEXT');
  // Agent-level sharing mode postdates the agents table for dev/staging DBs;
  // existing rows default to `selected` (today's explicit-grant behavior).
  addColumnIfMissing(sqlite, 'agents', 'sharing', "TEXT NOT NULL DEFAULT 'selected'");
  // Agent roles (persistent job description) postdate the agents table; all
  // nullable — an agent without a role carries null in every column.
  addColumnIfMissing(sqlite, 'agents', 'role_title', 'TEXT');
  addColumnIfMissing(sqlite, 'agents', 'role_instructions', 'TEXT');
  addColumnIfMissing(sqlite, 'agents', 'role_updated_at', 'TEXT');
  // "Was this slug chosen or derived?" postdates the orgs table. Deliberately
  // NULLABLE with no default: rows written before the column exist are genuinely
  // unknown, and unknown must read as CHOSEN (never regenerate) rather than
  // silently moving an address the operator picked on their next rename. Every
  // row this code writes carries an explicit 0 or 1.
  addColumnIfMissing(sqlite, 'orgs', 'slug_custom', 'INTEGER');
  // The hint.delivered inline payload postdates activity_entries for
  // dev/staging DBs; old hint rows keep nulls (their box just isn't expandable).
  addColumnIfMissing(sqlite, 'activity_entries', 'hint_id', 'TEXT');
  addColumnIfMissing(sqlite, 'activity_entries', 'hint_text', 'TEXT');
  // The email_quarantine split postdates databases whose pre-split build wrote
  // quarantined/rejected inbound rows into `emails`. Move them across — safe on
  // EVERY boot (INSERT OR IGNORE dedupes on the primary key, the DELETE matches
  // nothing once moved) and atomic (a crash between the two statements rolls
  // back, so no row is ever lost mid-move). Prod has live data; the same-id
  // move keeps email_attachments and activity refs pointing at the right row.
  sqlite.exec(`
    BEGIN;
    INSERT OR IGNORE INTO email_quarantine
      (id, thread_id, org_id, agent_id, direction, rfc_message_id, in_reply_to,
       references_json, participants, subject, text_body, html_body, verification,
       disposition, reason, judge, read_at, created_at, resolved_at)
      SELECT id, thread_id, org_id, agent_id, direction, rfc_message_id, in_reply_to,
             references_json, participants, subject, text_body, html_body, verification,
             disposition, reason, judge, read_at, created_at, resolved_at
        FROM emails
       WHERE direction = 'in' AND disposition IN ('quarantined', 'rejected');
    DELETE FROM emails
     WHERE direction = 'in' AND disposition IN ('quarantined', 'rejected');
    COMMIT;
  `);
}

/**
 * Backfill the sender/recipient identity snapshots from whatever membership is
 * STILL live, for rows written before those columns existed. Safe on every boot
 * (it only touches rows whose snapshot is null, and matches nothing once done).
 *
 * A member removed before the upgrade is unrecoverable and stays null — such a
 * ref renders `kind: 'unknown'`, which is the honest answer. Newly written rows
 * always carry their snapshot, so this is strictly a one-time repair pass.
 */
function backfillMessageIdentities(sqlite: Database.Database): void {
  sqlite.exec(`
    UPDATE messages SET
      sender_principal_type = (SELECT m.principal_type FROM members m WHERE m.id = messages.sender_id),
      sender_principal_id   = (SELECT m.principal_id   FROM members m WHERE m.id = messages.sender_id)
    WHERE sender_principal_id IS NULL
      AND EXISTS (SELECT 1 FROM members m WHERE m.id = messages.sender_id);

    UPDATE messages SET sender_display_name = COALESCE(
      (SELECT h.display_name FROM humans h WHERE sender_principal_type = 'human' AND h.id = sender_principal_id),
      (SELECT a.name         FROM agents a WHERE sender_principal_type = 'agent' AND a.id = sender_principal_id)
    )
    WHERE sender_display_name IS NULL AND sender_principal_id IS NOT NULL;

    UPDATE message_recipients SET
      recipient_principal_type = (SELECT m.principal_type FROM members m WHERE m.id = message_recipients.recipient_id),
      recipient_principal_id   = (SELECT m.principal_id   FROM members m WHERE m.id = message_recipients.recipient_id)
    WHERE recipient_principal_id IS NULL
      AND EXISTS (SELECT 1 FROM members m WHERE m.id = message_recipients.recipient_id);

    UPDATE message_recipients SET recipient_display_name = COALESCE(
      (SELECT h.display_name FROM humans h WHERE recipient_principal_type = 'human' AND h.id = recipient_principal_id),
      (SELECT a.name         FROM agents a WHERE recipient_principal_type = 'agent' AND a.id = recipient_principal_id)
    )
    WHERE recipient_display_name IS NULL AND recipient_principal_id IS NOT NULL;
  `);
}

/** ALTER TABLE ... ADD COLUMN only when the column does not already exist. */
function addColumnIfMissing(
  sqlite: Database.Database,
  table: string,
  column: string,
  typeDecl: string,
): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
  }
}
