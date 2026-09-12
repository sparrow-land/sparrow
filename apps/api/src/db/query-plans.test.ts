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
  makeAgent,
  recordStatements,
  type StatementLog,
  type TestServer,
  type SignedUpHuman,
} from '../test-helpers.js';

/** How many messages the seeded room holds — enough that a full scan is visible. */
const SEEDED_MESSAGES = 4000;

describe('room-open query plans', () => {
  let ts: TestServer;
  let log: StatementLog;
  let sqlite: Database.Database;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let roomId: string;
  /** The four captured hot-path statements, by name. */
  const captured = new Map<string, { sql: string; params: unknown[] }>();

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
    const hit = [...log.statements].reverse().find((e) => match(e.sql.toLowerCase()));
    if (!hit) throw new Error(`no executed statement matched ${name}`);
    captured.set(name, hit);
  }

  beforeAll(async () => {
    log = recordStatements();
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
    log.reset();
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
    log?.restore();
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

/**
 * The hint delivery ledger is append-only — one row per delivery EVENT — so it
 * only grows, and both of its lookups are asked on hot paths: the cooldown
 * question on every pause, and the by-id resolution question once per distinct
 * delivery on every timeline page. Before the primary key moved onto `id`, the
 * by-id lookup had no index at all and SQLite scanned the whole ledger for each
 * one. Same idiom as the room-open guards above: drive the real routes, capture
 * the SQL they issued, and assert the plan.
 */
describe('hint-ledger query plans', () => {
  let ts: TestServer;
  let log: StatementLog;
  let sqlite: Database.Database;
  const captured = new Map<string, { sql: string; params: unknown[] }>();

  function plan(name: string): string[] {
    const stmt = captured.get(name);
    if (!stmt) throw new Error(`no captured statement named ${name}`);
    return (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).all(...(stmt.params as never[])) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
  }

  function pick(name: string, match: (sql: string) => boolean): void {
    const hit = [...log.statements].reverse().find((e) => match(e.sql.toLowerCase()));
    if (!hit) throw new Error(`no executed statement matched ${name}`);
    captured.set(name, hit);
  }

  beforeAll(async () => {
    log = recordStatements();
    ts = await makeTestServer();
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const agent = await makeAgent(ts.app, owner.token, orgId, 'deploy-bot');

    // A pause delivers a hint (the agent is offline, so `start-listening` fires),
    // which writes the ledger row the timeline then asks about.
    const paused = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(agent.key),
      payload: {},
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().hints?.[0]?.id).toBe('start-listening');

    log.reset();
    const timeline = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}/activity`,
      headers: auth(owner.token),
    });
    expect(timeline.statusCode).toBe(200);
    pick(
      'resolutionById',
      (sql) => sql.includes('from "hint_deliveries"') && sql.includes('"id" = ?'),
    );

    log.reset();
    const second = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(agent.key),
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    pick(
      'cooldownLookup',
      (sql) =>
        sql.includes('from "hint_deliveries"') &&
        sql.includes('"hint_id" = ?') &&
        sql.includes('order by'),
    );
    // `control-your-hints` asks how many DISTINCT hints this principal has ever
    // been told, and it asks on every pause. The ledger is append-only, so that
    // question must be answered BY THE DATABASE off the index: reading every
    // historical row back into JS to de-duplicate it there is a read that grows
    // for the life of the agent.
    pick(
      'metaCount',
      (sql) =>
        sql.includes('from "hint_deliveries"') &&
        sql.includes('"hint_id"') &&
        !sql.includes('"hint_id" = ?') &&
        !sql.includes('"id" = ?') &&
        !sql.includes('"resolved_at"'),
    );

    sqlite = new Database(`${ts.dataDir}/sparrow.db`);
  }, 30_000);

  afterAll(async () => {
    sqlite?.close();
    log?.restore();
    await ts?.close();
  });

  it('the by-id resolution lookup SEEKS the primary key — never a ledger scan', () => {
    const detail = plan('resolutionById');
    expect(detail.some((d) => /^SEARCH hint_deliveries\b/.test(d))).toBe(true);
    expect(detail.some((d) => /^SCAN hint_deliveries\b/.test(d))).toBe(false);
  });

  it('the cooldown lookup walks hint_deliveries_principal_hint to the newest row', () => {
    const detail = plan('cooldownLookup');
    expect(detail.join('\n')).toContain('USING INDEX hint_deliveries_principal_hint');
    expect(detail.some((d) => /^SCAN hint_deliveries\b/.test(d))).toBe(false);
    // (principal_type, principal_id, hint_id, delivered_at) + the index's implicit
    // rowid tail IS the ordering the cooldown asks for, so SQLite reads the index
    // backwards and stops at the first row instead of sorting every telling.
    expect(detail.join('\n')).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('the meta count de-duplicates in SQL — it never materializes the whole ledger', () => {
    // The regression this guards is the one append-only introduced: the rows
    // crossing into JS went from one per DISTINCT ledger key to one per
    // TELLING, forever. DISTINCT puts that back. It does NOT make the database
    // side constant — SQLite still walks this principal's entries — so what is
    // asserted here is the shape of the read, never a cost bound.
    expect(captured.get('metaCount')!.sql.toLowerCase()).toContain('select distinct');
    const detail = plan('metaCount');
    expect(detail.join('\n')).toContain('hint_deliveries_principal_hint');
    expect(detail.some((d) => /^SCAN hint_deliveries\b/.test(d))).toBe(false);
  });
});
