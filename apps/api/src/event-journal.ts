/**
 * Per-principal `/me/events` journal — the server side of SSE resume. Every
 * event delivered on a principal's `/me/events` stream is persisted here with a
 * global AUTOINCREMENT cursor (the SSE `id:` value). A reconnecting client that
 * passes `?since=<cursor>` (or `Last-Event-ID`) replays the rows it missed
 * before the stream goes live, byte-for-byte identical to the original frames.
 *
 * Retention is bounded on every write: rows older than {@link JOURNAL_RETENTION_MS}
 * OR beyond the newest {@link JOURNAL_MAX_PER_PRINCIPAL} for a principal are
 * pruned, and the largest pruned cursor is recorded so a resume from before it
 * can be answered with a structural `replay.gap` (the client then reconciles via
 * an inbox drain instead of trusting replay).
 *
 * v1 journals ONLY the `/me/events` fan-in stream. Room-scoped
 * `/rooms/:id/events` replay can layer on the same mechanism later.
 */
import type Database from 'better-sqlite3';
import { nowIso } from './context.js';

/** Keep journaled events for 24h (older rows are pruned on write). */
export const JOURNAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Hard cap of retained events per principal (newest win). */
export const JOURNAL_MAX_PER_PRINCIPAL = 1000;

/** A journaled row projected for replay: the cursor, event name, and raw JSON. */
export interface JournalRow {
  id: number;
  event: string;
  /** The exact JSON string the live frame carried (byte-identical replay). */
  data: string;
}

export class EventJournal {
  private readonly insertStmt: Database.Statement;
  private readonly replayStmt: Database.Statement;
  private readonly markStmt: Database.Statement;
  private readonly latestStmt: Database.Statement;

  // The prune predicate: a row is prunable when it is past the retention window
  // OR not among the newest N ids for its principal. Bound args:
  // (type, id, cutoff, type, id, cap).
  private static readonly PRUNE_WHERE =
    'principal_type = ? AND principal_id = ? AND (created_at < ? OR id NOT IN (' +
    'SELECT id FROM me_event_journal WHERE principal_type = ? AND principal_id = ? ' +
    'ORDER BY id DESC LIMIT ?))';

  constructor(private readonly sqlite: Database.Database) {
    this.insertStmt = sqlite.prepare(
      'INSERT INTO me_event_journal (principal_type, principal_id, event, data, created_at) ' +
        'VALUES (?, ?, ?, ?, ?)',
    );
    this.replayStmt = sqlite.prepare(
      'SELECT id, event, data FROM me_event_journal ' +
        'WHERE principal_type = ? AND principal_id = ? AND id > ? ORDER BY id ASC',
    );
    this.markStmt = sqlite.prepare(
      'SELECT max_pruned_id AS m FROM me_event_journal_marks ' +
        'WHERE principal_type = ? AND principal_id = ?',
    );
    this.latestStmt = sqlite.prepare(
      'SELECT MAX(id) AS m FROM me_event_journal WHERE principal_type = ? AND principal_id = ?',
    );
  }

  /**
   * Persist an event for a principal and return its cursor id. `data` is the
   * exact object the live frame serialized (room events already wrapped
   * `{ room, ...payload }`). Prunes the principal's journal after the insert.
   */
  append(
    principalType: string,
    principalId: string,
    event: string,
    data: unknown,
    now: string = nowIso(),
  ): number {
    const info = this.insertStmt.run(
      principalType,
      principalId,
      event,
      JSON.stringify(data),
      now,
    );
    const id = Number(info.lastInsertRowid);
    this.prune(principalType, principalId, now);
    return id;
  }

  /** The principal's journaled rows with `id` strictly greater than `since`, ascending. */
  replaySince(principalType: string, principalId: string, since: number): JournalRow[] {
    return this.replayStmt.all(principalType, principalId, since) as JournalRow[];
  }

  /** The principal's newest retained journal cursor, or `0` when it has none. */
  latestId(principalType: string, principalId: string): number {
    const row = this.latestStmt.get(principalType, principalId) as { m: number | null };
    return row.m ?? 0;
  }

  /**
   * Whether a resume from `since` provably cannot be honored — the client must
   * reconcile (inbox drain) and re-seed its cursor instead of trusting replay.
   * Two independent reasons:
   *
   *  1. PRUNED: the principal's largest pruned cursor is greater than `since` (an
   *     event with id > since was received and then pruned — retention lost it).
   *  2. GENERATION MISMATCH: `since` is GREATER than the principal's newest id.
   *     Cursor ids are a global AUTOINCREMENT, so a live cursor is always ≤ the
   *     principal's latest; a cursor AHEAD of it names events that never existed in
   *     THIS journal — a stale cursor from a PRIOR generation (the DB/journal was
   *     wiped and ids restarted low). Without this, such a resume replays nothing,
   *     never trips (1) (the fresh journal has no pruned mark), and silently
   *     black-holes every fresh id — the client filters them as "already seen".
   *
   * `since === latest` is the normal caught-up case and is NOT a gap.
   */
  hasGap(principalType: string, principalId: string, since: number): boolean {
    const row = this.markStmt.get(principalType, principalId) as { m: number } | undefined;
    if (row !== undefined && since < row.m) return true; // (1) pruned
    return since > this.latestId(principalType, principalId); // (2) generation mismatch
  }

  /** Prune the principal's journal (age + cap) and advance its pruned high-water mark. */
  private prune(principalType: string, principalId: string, now: string): void {
    const cutoff = new Date(Date.parse(now) - JOURNAL_RETENTION_MS).toISOString();
    const args = [
      principalType,
      principalId,
      cutoff,
      principalType,
      principalId,
      JOURNAL_MAX_PER_PRINCIPAL,
    ] as const;
    const max = this.sqlite
      .prepare(`SELECT MAX(id) AS m FROM me_event_journal WHERE ${EventJournal.PRUNE_WHERE}`)
      .get(...args) as { m: number | null };
    if (max.m == null) return;
    this.sqlite
      .prepare(`DELETE FROM me_event_journal WHERE ${EventJournal.PRUNE_WHERE}`)
      .run(...args);
    this.sqlite
      .prepare(
        'INSERT INTO me_event_journal_marks (principal_type, principal_id, max_pruned_id) ' +
          'VALUES (?, ?, ?) ON CONFLICT(principal_type, principal_id) ' +
          'DO UPDATE SET max_pruned_id = MAX(max_pruned_id, excluded.max_pruned_id)',
      )
      .run(principalType, principalId, max.m);
  }
}
