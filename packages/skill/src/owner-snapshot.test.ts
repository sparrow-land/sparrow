/**
 * The owner snapshot and the failure record it gates. `status` reads the owner
 * record ONCE and derives every line from it; `readAwaitFailure` is the same
 * gate for a caller that has no snapshot yet.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerSnapshotOf, readAwaitFailure, readFailureFor, readOwnerSnapshot } from './owner-snapshot.js';

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-owner-snap-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const write = (name: string, body: unknown): void =>
  fs.writeFileSync(path.join(stateDir, name), typeof body === 'string' ? body : JSON.stringify(body));
const FAILURE = { nonce: 'f00d', thread: 'thr_1', at: '2026-09-17T09:12:00.000Z', kind: 'codex-queue', error: 'boom' };

describe('readOwnerSnapshot', () => {
  it('parses nonce and a valid harnessPid', () => {
    write('await-owner.json', { version: 1, nonce: 'f00d', pid: 1, harnessPid: 4242 });
    expect(readOwnerSnapshot(stateDir)).toEqual({ nonce: 'f00d', harnessPid: 4242 });
  });

  it('drops a harnessPid that is not a positive integer', () => {
    write('await-owner.json', { nonce: 'f00d', harnessPid: 0 });
    expect(readOwnerSnapshot(stateDir)).toEqual({ nonce: 'f00d' });
  });

  it('is undefined with no record or a malformed one', () => {
    expect(readOwnerSnapshot(stateDir)).toBeUndefined();
    write('await-owner.json', '{nope');
    expect(readOwnerSnapshot(stateDir)).toBeUndefined();
  });
});

describe('readAwaitFailure / readFailureFor', () => {
  it('returns the failure of the live generation', () => {
    write('await-owner.json', { nonce: 'f00d' });
    write('await-last-failure.json', FAILURE);
    const want = { thread: 'thr_1', at: '2026-09-17T09:12:00.000Z', kind: 'codex-queue', error: 'boom' };
    expect(readAwaitFailure(stateDir)).toEqual(want);
    expect(readFailureFor(stateDir, { nonce: 'f00d' })).toEqual(want);
  });

  it('says nothing for a superseded, untagged or ownerless record', () => {
    write('await-last-failure.json', FAILURE);
    expect(readAwaitFailure(stateDir)).toBeUndefined(); // no owner record
    write('await-owner.json', { nonce: 'b0b0' });
    expect(readAwaitFailure(stateDir)).toBeUndefined(); // superseded
    write('await-owner.json', { nonce: 'f00d' });
    write('await-last-failure.json', { ...FAILURE, nonce: undefined });
    expect(readAwaitFailure(stateDir)).toBeUndefined(); // untagged
    write('await-last-failure.json', { nonce: 'f00d' });
    expect(readAwaitFailure(stateDir)).toBeUndefined(); // no error text
  });

  it('judges against the SNAPSHOT it is given, not a fresh read', () => {
    write('await-owner.json', { nonce: 'b0b0' });
    write('await-last-failure.json', FAILURE);
    expect(readFailureFor(stateDir, { nonce: 'f00d' })?.error).toBe('boom');
  });
});

/* The ONE derivation of the shared fields, from a record already parsed — so a
 * caller that needs more of the record reads the file once, not twice. */
describe('ownerSnapshotOf', () => {
  it('derives exactly what readOwnerSnapshot derives from the file', () => {
    const records: unknown[] = [
      { nonce: 'f00d', harnessPid: 4242 },
      { nonce: '   ', harnessPid: 4242 },
      { nonce: 7 },
      { harnessPid: -1 },
      {},
    ];
    for (const r of records) {
      write('await-owner.json', r);
      expect(ownerSnapshotOf(r as Record<string, unknown>), JSON.stringify(r)).toEqual(readOwnerSnapshot(stateDir));
    }
  });

  it('a whitespace-only nonce is no nonce', () => {
    expect(ownerSnapshotOf({ nonce: '  ', harnessPid: 5 })).toEqual({ harnessPid: 5 });
  });
});
