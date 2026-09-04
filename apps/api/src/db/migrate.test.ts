import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';

describe('migrate: idempotent column adds', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sparrow-migrate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds messages.origin to a DB created from the old (origin-less) DDL', () => {
    const sqlite = new Database(path.join(dir, 'old.db'));
    // The pre-voice messages DDL — note: no `origin` column.
    sqlite.exec(`
      CREATE TABLE messages (
        id                TEXT PRIMARY KEY,
        room_id           TEXT NOT NULL,
        sender_id         TEXT NOT NULL,
        kind              TEXT NOT NULL,
        subject           TEXT,
        body              TEXT NOT NULL,
        suggested_replies TEXT,
        in_reply_to       TEXT,
        reply_value       TEXT,
        created_at        TEXT NOT NULL
      );
    `);
    const before = (sqlite.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(before).not.toContain('origin');

    migrate(sqlite);

    const after = (sqlite.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(after).toContain('origin');
    sqlite.close();
  });

  it('adds message_recipients.received_at to a DB created from the old (received-less) DDL', () => {
    const sqlite = new Database(path.join(dir, 'old-recips.db'));
    // The pre-receipts message_recipients DDL — note: no `received_at` column.
    sqlite.exec(`
      CREATE TABLE message_recipients (
        message_id   TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        read_at      TEXT,
        PRIMARY KEY (message_id, recipient_id)
      );
    `);
    const before = (
      sqlite.prepare('PRAGMA table_info(message_recipients)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(before).not.toContain('received_at');

    migrate(sqlite);

    const after = (
      sqlite.prepare('PRAGMA table_info(message_recipients)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(after).toContain('received_at');
    sqlite.close();
  });

  it('adds the sender/recipient identity snapshots and backfills them from live membership', () => {
    const sqlite = new Database(path.join(dir, 'old-identity.db'));
    // A pre-snapshot database: messages/message_recipients name a member id and
    // nothing else, so authorship lived entirely in the mutable `members` row.
    sqlite.exec(`
      CREATE TABLE messages (
        id                TEXT PRIMARY KEY,
        room_id           TEXT NOT NULL,
        sender_id         TEXT NOT NULL,
        kind              TEXT NOT NULL,
        subject           TEXT,
        body              TEXT NOT NULL,
        suggested_replies TEXT,
        in_reply_to       TEXT,
        reply_value       TEXT,
        created_at        TEXT NOT NULL
      );
      CREATE TABLE message_recipients (
        message_id   TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        read_at      TEXT,
        PRIMARY KEY (message_id, recipient_id)
      );
      INSERT INTO messages (id, room_id, sender_id, kind, body, created_at) VALUES
        ('msg_a', 'rm_1', 'mem_bot',  'broadcast', 'from the agent', '2026-01-01T00:00:00Z'),
        ('msg_b', 'rm_1', 'mem_gone', 'broadcast', 'sender long gone', '2026-01-01T00:00:01Z');
      INSERT INTO message_recipients (message_id, recipient_id) VALUES ('msg_a', 'mem_alice');
    `);
    migrate(sqlite);
    // Membership + principals as they exist at upgrade time. `mem_gone` was
    // already removed before the upgrade — unrecoverable by design.
    sqlite.exec(`
      INSERT INTO members (id, room_id, principal_type, principal_id, room_role, created_at) VALUES
        ('mem_bot',   'rm_1', 'agent', 'agt_1', 'member', '2026-01-01T00:00:00Z'),
        ('mem_alice', 'rm_1', 'human', 'usr_1', 'member', '2026-01-01T00:00:00Z');
      INSERT INTO agents (id, org_id, owner_human_id, name, key_hash, created_at)
        VALUES ('agt_1', 'org_1', 'usr_1', 'atlas', 'hash', '2026-01-01T00:00:00Z');
      INSERT INTO humans (id, email, display_name, provider, created_at)
        VALUES ('usr_1', 'alice@example.com', 'Alice', 'password', '2026-01-01T00:00:00Z');
    `);

    // Boot again — the backfill runs on every boot and is a no-op once done.
    migrate(sqlite);
    migrate(sqlite);

    const cols = (sqlite.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('sender_principal_type');
    expect(cols).toContain('sender_principal_id');
    expect(cols).toContain('sender_display_name');

    const a = sqlite
      .prepare('SELECT sender_principal_type t, sender_principal_id i, sender_display_name n FROM messages WHERE id = ?')
      .get('msg_a') as { t: string | null; i: string | null; n: string | null };
    expect(a).toEqual({ t: 'agent', i: 'agt_1', n: 'atlas' });

    // No live membership to recover from: stays null, which renders as the
    // honest `kind: 'unknown'` rather than being guessed into a human.
    const b = sqlite
      .prepare('SELECT sender_principal_type t, sender_principal_id i FROM messages WHERE id = ?')
      .get('msg_b') as { t: string | null; i: string | null };
    expect(b).toEqual({ t: null, i: null });

    const r = sqlite
      .prepare('SELECT recipient_principal_type t, recipient_principal_id i, recipient_display_name n FROM message_recipients WHERE message_id = ?')
      .get('msg_a') as { t: string | null; i: string | null; n: string | null };
    expect(r).toEqual({ t: 'human', i: 'usr_1', n: 'Alice' });
    sqlite.close();
  });

  it('adds agents.sharing (default selected) to a DB created from the old (sharing-less) DDL', () => {
    const sqlite = new Database(path.join(dir, 'old-agents.db'));
    // The pre-sharing agents DDL — note: no `sharing` column.
    sqlite.exec(`
      CREATE TABLE agents (
        id             TEXT PRIMARY KEY,
        org_id         TEXT NOT NULL,
        owner_human_id TEXT NOT NULL,
        name           TEXT NOT NULL,
        key_hash       TEXT NOT NULL,
        last_seen_at   TEXT,
        created_at     TEXT NOT NULL
      );
      INSERT INTO agents (id, org_id, owner_human_id, name, key_hash, created_at)
        VALUES ('agt_old', 'org_1', 'usr_1', 'legacy', 'hash', '2026-01-01T00:00:00Z');
    `);
    const before = (sqlite.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(before).not.toContain('sharing');

    migrate(sqlite);

    const after = (sqlite.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(after).toContain('sharing');
    // Existing rows backfill to the `selected` default (today's behavior).
    const row = sqlite.prepare('SELECT sharing FROM agents WHERE id = ?').get('agt_old') as {
      sharing: string;
    };
    expect(row.sharing).toBe('selected');
    sqlite.close();
  });

  it('moves pre-split inbound quarantined/rejected rows into email_quarantine, idempotently', () => {
    const sqlite = new Database(path.join(dir, 'split.db'));
    migrate(sqlite);
    // A pre-split build wrote EVERY disposition into `emails`. Recreate that
    // state, then boot again: the one-time move must sort the rows out.
    const insert = sqlite.prepare(
      `INSERT INTO emails (id, thread_id, org_id, agent_id, direction, rfc_message_id,
         participants, subject, text_body, disposition, reason, created_at)
       VALUES (?, 'eth_1', 'org_1', 'agt_1', ?, ?, '{}', 's', ?, ?, ?, '2026-01-01T00:00:00Z')`,
    );
    insert.run('eml_del', 'in', '<a@x>', 'body', 'delivered', null);
    insert.run('eml_quar', 'in', '<b@x>', 'body', 'quarantined', 'unrecognized-sender');
    insert.run('eml_rej', 'in', '<c@x>', null, 'rejected', 'spoof');
    insert.run('eml_sent', 'out', '<d@x>', 'body', 'sent', null);
    insert.run('eml_held', 'out', '<e@x>', 'body', 'held', 'unrecognized-recipient');
    insert.run('eml_deny', 'out', '<f@x>', 'body', 'rejected', 'denied');

    migrate(sqlite);

    const ids = (table: string): string[] =>
      (sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      );
    // `emails` keeps delivered inbound + ALL outbound (a denied send is the
    // agent's own composition); the stranger-side rows moved out whole.
    expect(ids('emails')).toEqual(['eml_del', 'eml_deny', 'eml_held', 'eml_sent']);
    expect(ids('email_quarantine')).toEqual(['eml_quar', 'eml_rej']);
    const moved = sqlite
      .prepare(`SELECT disposition, reason, text_body FROM email_quarantine WHERE id = 'eml_quar'`)
      .get() as { disposition: string; reason: string; text_body: string };
    expect(moved).toEqual({
      disposition: 'quarantined',
      reason: 'unrecognized-sender',
      text_body: 'body',
    });

    // Safe on every boot: a third run moves nothing and duplicates nothing.
    migrate(sqlite);
    expect(ids('emails')).toEqual(['eml_del', 'eml_deny', 'eml_held', 'eml_sent']);
    expect(ids('email_quarantine')).toEqual(['eml_quar', 'eml_rej']);
    sqlite.close();
  });

  it('is idempotent — a second migrate does not error or duplicate the column', () => {
    const sqlite = new Database(path.join(dir, 'fresh.db'));
    migrate(sqlite);
    migrate(sqlite);
    const cols = (sqlite.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).filter(
      (c) => c.name === 'origin',
    );
    expect(cols).toHaveLength(1);
    sqlite.close();
  });
});
