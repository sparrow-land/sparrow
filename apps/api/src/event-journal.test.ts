import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from './db/index.js';
import {
  EventJournal,
  JOURNAL_MAX_PER_PRINCIPAL,
  JOURNAL_RETENTION_MS,
} from './event-journal.js';

describe('EventJournal', () => {
  let dir: string;
  let handle: DbHandle;
  let journal: EventJournal;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sparrow-journal-'));
    handle = openDb(dir);
    journal = new EventJournal(handle.sqlite);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('append returns a strictly increasing global cursor', () => {
    const a = journal.append('human', 'usr_1', 'message.new', { a: 1 });
    const b = journal.append('agent', 'agt_2', 'message.new', { b: 2 });
    const c = journal.append('human', 'usr_1', 'message.read', { c: 3 });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('replaySince returns only this principal’s rows strictly after the cursor, ascending', () => {
    const id1 = journal.append('human', 'usr_1', 'message.new', { n: 1 });
    journal.append('human', 'usr_other', 'message.new', { n: 99 });
    const id2 = journal.append('human', 'usr_1', 'message.new', { n: 2 });
    const id3 = journal.append('human', 'usr_1', 'message.read', { n: 3 });

    const rows = journal.replaySince('human', 'usr_1', id1);
    expect(rows.map((r) => r.id)).toEqual([id2, id3]);
    // data is the exact stored JSON string (byte-identical replay).
    expect(rows[0]!.event).toBe('message.new');
    expect(rows[0]!.data).toBe(JSON.stringify({ n: 2 }));
  });

  it('replaySince from 0 replays everything retained for the principal', () => {
    const id1 = journal.append('human', 'usr_1', 'a', {});
    const id2 = journal.append('human', 'usr_1', 'b', {});
    expect(journal.replaySince('human', 'usr_1', 0).map((r) => r.id)).toEqual([id1, id2]);
  });

  it('prunes by per-principal cap and records a gap high-water mark', () => {
    const ids: number[] = [];
    for (let i = 0; i < JOURNAL_MAX_PER_PRINCIPAL + 5; i++) {
      ids.push(journal.append('human', 'usr_cap', 'e', { i }));
    }
    // Only the newest JOURNAL_MAX_PER_PRINCIPAL survive.
    const all = journal.replaySince('human', 'usr_cap', 0);
    expect(all).toHaveLength(JOURNAL_MAX_PER_PRINCIPAL);
    expect(all[0]!.id).toBe(ids[5]); // first 5 pruned
    // The oldest surviving id is ids[5]; the last pruned is ids[4].
    expect(journal.hasGap('human', 'usr_cap', ids[0]!)).toBe(true); // cursor before pruned events
    expect(journal.hasGap('human', 'usr_cap', ids[4]!)).toBe(false); // cursor == last pruned id → nothing after it lost
    expect(journal.hasGap('human', 'usr_cap', ids[5]!)).toBe(false); // cursor at oldest surviving
  });

  it('prunes rows older than the retention window on write', () => {
    const old = new Date(Date.now() - JOURNAL_RETENTION_MS - 60_000).toISOString();
    const staleId = journal.append('human', 'usr_t', 'old', {}, old);
    const freshId = journal.append('human', 'usr_t', 'new', {});
    const rows = journal.replaySince('human', 'usr_t', 0);
    expect(rows.map((r) => r.id)).toEqual([freshId]);
    // The stale row was pruned → a resume from before it reports a gap.
    expect(journal.hasGap('human', 'usr_t', staleId - 1)).toBe(true);
  });

  it('latestId returns the principal’s newest cursor, or 0 when it has none', () => {
    expect(journal.latestId('human', 'usr_l')).toBe(0);
    const a = journal.append('human', 'usr_l', 'e', {});
    const b = journal.append('human', 'usr_l', 'e', {});
    expect(journal.latestId('human', 'usr_l')).toBe(b);
    // Another principal's rows never bleed into this one's latest.
    journal.append('human', 'usr_other2', 'e', {});
    expect(journal.latestId('human', 'usr_l')).toBe(b);
    expect(b).toBeGreaterThan(a);
  });

  it('no gap when nothing has ever been pruned', () => {
    journal.append('human', 'usr_q', 'a', {});
    expect(journal.hasGap('human', 'usr_q', 0)).toBe(false);
    // A principal that never journaled anything: no gap either.
    expect(journal.hasGap('human', 'usr_never', 0)).toBe(false);
  });
});
