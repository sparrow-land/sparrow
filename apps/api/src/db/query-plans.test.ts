/**
 * Query-plan guards for the room-open hot paths (SPEC "Messages"). Opening a
 * room fans out into four queries whose cost must not grow with the room's
 * message count: the history page, the room inbox, the principal-wide inbox and
 * the unread badge. This suite seeds a busy room, drives the REAL route
 * handlers, captures the exact SQL each one issued and asserts the plan SQLite
 * chose — a full `SCAN messages` (or a lost index) means room-open has quietly
 * gone linear again.
 *
 * There is deliberately NO timing assertion here: wall-clock on CI is not
 * deterministic enough to fail honestly, and the plan is the thing that actually
 * regresses.
 */
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  type TestServer,
  type SignedUpHuman,
} from '../test-helpers.js';

/** One statement better-sqlite3 executed, with the parameters it ran with. */
interface Executed {
  sql: string;
  params: unknown[];
}

const executed: Executed[] = [];

/**
 * Record every statement better-sqlite3 runs. Capturing the driver's SQL (rather
 * than re-deriving it in the test) is what keeps this suite honest: the SQL
 * explained below is byte-for-byte the SQL the route issued, so a query rewrite
 * cannot drift away from its plan guard without this file noticing.
 */
function installStatementRecorder(): () => void {
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function patched(this: Database.Database, ...args: unknown[]) {
    const stmt = (original as (...a: unknown[]) => any).apply(this, args);
    const sql = String(args[0]);
    // Never record the EXPLAIN statements this suite itself prepares.
    if (/^\s*EXPLAIN/i.test(sql)) return stmt;
    for (const method of ['all', 'get', 'run'] as const) {
      const bound = stmt[method].bind(stmt);
      stmt[method] = (...params: unknown[]) => {
        executed.push({ sql, params });
        return bound(...params);
      };
    }
    return stmt;
  } as typeof Database.prototype.prepare;
  return () => {
    Database.prototype.prepare = original;
  };
}

/** How many messages the seeded room holds — enough that a full scan is visible. */
const SEEDED_MESSAGES = 4000;

describe('room-open query plans', () => {
  let ts: TestServer;
  let restore: () => void;
  let sqlite: Database.Database;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let roomId: string;
  /** The four captured hot-path statements, by name. */
  const captured = new Map<string, Executed>();

  /** `EXPLAIN QUERY PLAN` rows for one captured statement, as detail strings. */
  function plan(name: string): string[] {
    const stmt = captured.get(name);
    if (!stmt) throw new Error(`no captured statement named ${name}`);
    return (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).all(...(stmt.params as never[])) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
  }

  /** The last recorded statement matching every predicate. */
  function pick(name: string, match: (sql: string) => boolean): void {
    const hit = [...executed].reverse().find((e) => match(e.sql.toLowerCase()));
    if (!hit) throw new Error(`no executed statement matched ${name}`);
    captured.set(name, hit);
  }

  beforeAll(async () => {
    restore = installStatementRecorder();
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: alice.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(alice.token),
    });

    // Seed a busy room directly. Sending through the route would take minutes
    // and prove nothing extra: the plans depend on the row counts, not on how
    // the rows arrived.
    sqlite = new Database(`${ts.dataDir}/sparrow.db`);
    const memberRows = sqlite
      .prepare('SELECT id, principal_id FROM members WHERE room_id = ?')
      .all(roomId) as { id: string; principal_id: string }[];
    const ownerMember = memberRows.find((m) => m.principal_id === owner.userId)!;
    const aliceMember = memberRows.find((m) => m.principal_id === alice.userId)!;
    const insertMessage = sqlite.prepare(
      `INSERT INTO messages (id, room_id, sender_id, sender_principal_type, sender_principal_id,
         sender_display_name, kind, body, created_at)
       VALUES (?, ?, ?, 'human', ?, 'Owner', 'broadcast', ?, ?)`,
    );
    const insertRecipient = sqlite.prepare(
      `INSERT INTO message_recipients (message_id, recipient_id, recipient_principal_type,
         recipient_principal_id, recipient_display_name, read_at)
       VALUES (?, ?, 'human', ?, 'Alice', ?)`,
    );
    sqlite.transaction(() => {
      for (let i = 0; i < SEEDED_MESSAGES; i += 1) {
        const id = `msg_seed_${String(i).padStart(6, '0')}`;
        const createdAt = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
        insertMessage.run(id, roomId, ownerMember.id, owner.userId, `seeded ${i}`, createdAt);
        // Most of the history is already read: the unread tail is what the
        // recipient/read index has to isolate out of thousands of rows.
        insertRecipient.run(id, aliceMember.id, alice.userId, i < SEEDED_MESSAGES - 5 ? createdAt : null);
      }
    })();

    // Drive the four hot paths, then capture the SQL each one issued.
    executed.length = 0;
    const history = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages?limit=50`,
      headers: auth(alice.token),
    });
    expect(history.statusCode).toBe(200);
    // The second page: same shape plus the keyset `before` predicate.
    const page2 = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages?limit=50&before=${history.json().nextBefore}`,
      headers: auth(alice.token),
    });
    expect(page2.statusCode).toBe(200);
    const roomInbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/inbox`,
      headers: auth(alice.token),
    });
    expect(roomInbox.statusCode).toBe(200);
    const meInbox = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      headers: auth(alice.token),
    });
    expect(meInbox.statusCode).toBe(200);
    // Sending is what computes the unread badge (`SendMessageResponse.unreadCount`).
    const sent = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(alice.token),
      payload: { body: 'hello' },
    });
    expect(sent.statusCode).toBe(201);

    const isHistory = (sql: string) =>
      sql.includes('from "messages"') &&
      sql.includes('"clawed_back_at" is null') &&
      sql.includes('order by "messages"."created_at" desc');
    pick('history', (sql) => isHistory(sql) && !sql.includes('rowid <'));
    pick('historyBefore', (sql) => isHistory(sql) && sql.includes('rowid <'));
    pick(
      'roomInbox',
      (sql) =>
        sql.includes('from "message_recipients"') &&
        sql.includes('"recipient_id" = ?') &&
        sql.includes('"read_at" is null') &&
        sql.includes('order by') &&
        !sql.includes('inner join "rooms"'),
    );
    pick(
      'principalInbox',
      (sql) =>
        sql.includes('from "message_recipients"') &&
        sql.includes('inner join "rooms"') &&
        sql.includes('"read_at" is null') &&
        sql.includes('order by'),
    );
    pick(
      'unreadCount',
      (sql) =>
        sql.startsWith('select "message_recipients"."message_id" from "message_recipients"') &&
        sql.includes('"read_at" is null') &&
        sql.includes('"clawed_back_at" is null'),
    );
  }, 60_000);

  afterAll(async () => {
    sqlite?.close();
    restore?.();
    await ts?.close();
  });

  it('the room history page walks messages_room_created in order — no scan, no sort', () => {
    const detail = plan('history');
    expect(detail.join('\n')).toContain('USING INDEX messages_room_created');
    // (room_id, created_at) + the implicit rowid tail is exactly the route's
    // `ORDER BY created_at DESC, rowid DESC`, so SQLite reads the index backwards
    // and stops at LIMIT instead of sorting the whole room.
    expect(detail.join('\n')).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    expect(detail.some((d) => /^SCAN messages\b/.test(d))).toBe(false);
  });

  it('the `before` page of history keeps the same plan (the keyset stays a keyset)', () => {
    const detail = plan('historyBefore');
    expect(detail.join('\n')).toContain('USING INDEX messages_room_created');
    expect(detail.join('\n')).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    expect(detail.some((d) => /^SCAN messages\b/.test(d))).toBe(false);
  });

  it('the room inbox isolates unread rows through message_recipients_recipient_read', () => {
    const detail = plan('roomInbox');
    expect(detail.join('\n')).toContain('USING INDEX message_recipients_recipient_read');
    expect(detail.some((d) => /^SCAN messages\b/.test(d))).toBe(false);
    expect(detail.some((d) => /^SCAN message_recipients\b/.test(d))).toBe(false);
    // The ORDER BY is on the JOINED table (`messages.created_at`), so a sort step
    // survives by construction — but it now sorts only the caller's UNREAD rows,
    // a number bounded by their attention span rather than by room size.
  });

  it('the principal-wide inbox uses the same index across memberships', () => {
    const detail = plan('principalInbox');
    expect(detail.join('\n')).toContain('USING INDEX message_recipients_recipient_read');
    expect(detail.some((d) => /^SCAN messages\b/.test(d))).toBe(false);
    expect(detail.some((d) => /^SCAN message_recipients\b/.test(d))).toBe(false);
  });

  it('the unread badge counts through the index instead of the table', () => {
    const detail = plan('unreadCount');
    expect(detail.join('\n')).toContain('USING INDEX message_recipients_recipient_read');
    expect(detail.some((d) => /^SCAN messages\b/.test(d))).toBe(false);
    expect(detail.some((d) => /^SCAN message_recipients\b/.test(d))).toBe(false);
  });
});
