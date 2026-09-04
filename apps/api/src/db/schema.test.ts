import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from './index.js';

describe('fresh v3 schema', () => {
  let dir: string;
  let handle: DbHandle;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sparrow-schema-'));
    handle = openDb(dir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates every v3 table on a fresh database', () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    for (const t of [
      'orgs',
      'org_memberships',
      'humans',
      'user_sessions',
      'agents',
      'agent_visibility',
      'invites',
      'enrollments',
      'rooms',
      'members',
      // Governance: the durable "this agent↔agent pair is cut off" record.
      'agent_dm_severs',
      'room_invitations',
      'messages',
      'message_recipients',
      'attachments',
      'drafts',
      'config',
      // Unified attention (layer 3): the append-only timeline every medium writes.
      'activity_entries',
      // The email medium (layer 2).
      'external_contacts',
      'email_threads',
      'emails',
      // Quarantined/rejected inbound mail is physically segregated from legit
      // mail — its own table, so out-of-band SQL can never confuse the two.
      'email_quarantine',
      'email_attachments',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });

  it('creates the email medium tables to the spec fence', () => {
    const cols = (table: string): Set<string> =>
      new Set(
        (handle.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      );
    // `emails` carries the denormalized org/agent (single-table index scans for
    // the approvals + pop queues) and the two-valued read state (`read_at`).
    const emailCols = cols('emails');
    for (const c of [
      'id',
      'thread_id',
      'org_id',
      'agent_id',
      'direction',
      'rfc_message_id',
      'in_reply_to',
      'references_json',
      'participants',
      'subject',
      'text_body',
      'html_body',
      'verification',
      'disposition',
      'reason',
      'judge',
      'read_at',
      'created_at',
      'resolved_at',
    ]) {
      expect(emailCols.has(c)).toBe(true);
    }
    expect([...cols('email_threads')]).toEqual(
      expect.arrayContaining([
        'id',
        'org_id',
        'agent_id',
        'subject',
        'trusted',
        'created_at',
        'last_email_at',
      ]),
    );
    expect([...cols('external_contacts')]).toEqual(
      expect.arrayContaining([
        'id',
        'org_id',
        'email',
        'display_name',
        'trust',
        'first_seen_at',
        'resolved_by_human_id',
        'resolved_at',
      ]),
    );
    expect([...cols('email_attachments')]).toEqual(
      expect.arrayContaining(['id', 'email_id', 'filename', 'content_type', 'size_bytes', 'created_at']),
    );
  });

  it('makes rfc_message_id unique PER ANCHOR AGENT, not globally', () => {
    const insert = (id: string, agentId: string, rfc: string): void => {
      handle.sqlite
        .prepare(
          `INSERT INTO emails (id, thread_id, org_id, agent_id, direction, rfc_message_id,
             participants, subject, text_body, disposition, created_at)
           VALUES (?, 'eth_1', 'org_1', ?, 'in', ?, '{}', 's', 't', 'delivered', '2026-01-01T00:00:00Z')`,
        )
        .run(id, agentId, rfc);
    };
    // The same message cc'ing two org agents legitimately becomes two rows…
    insert('eml_1', 'agt_a', '<m1@example.net>');
    expect(() => insert('eml_2', 'agt_b', '<m1@example.net>')).not.toThrow();
    // …but one anchor holds it exactly once (the idempotency key).
    expect(() => insert('eml_3', 'agt_a', '<m1@example.net>')).toThrow();
  });

  it('scopes a contact address to one org (UNIQUE(org_id, email))', () => {
    const insert = (id: string, orgId: string, email: string): void => {
      handle.sqlite
        .prepare(
          `INSERT INTO external_contacts (id, org_id, email, first_seen_at)
           VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`,
        )
        .run(id, orgId, email);
    };
    insert('ext_1', 'org_1', 'dana@partner.example.com');
    expect(() => insert('ext_2', 'org_2', 'dana@partner.example.com')).not.toThrow();
    expect(() => insert('ext_3', 'org_1', 'dana@partner.example.com')).toThrow();
  });

  it('reopening the same database is idempotent', () => {
    handle.close();
    const again = openDb(dir);
    const n = again.sqlite
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get() as { n: number };
    expect(n.n).toBeGreaterThanOrEqual(15);
    again.close();
    handle = openDb(dir);
  });
});
