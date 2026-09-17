import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockedDir, readBlocked } from './await-blocked.js';

/* ==================================================================
 * `<state dir>/blocked/*.json` — "this session cannot take a turn".
 *
 * Written by the skill's Claude Code StopFailure hook when a turn died on a
 * blocking API error (a usage limit), and removed by its Notification hook when
 * the quota auto-resume fires. ONE FILE PER BLOCK, uniquely named, so a clear
 * can never delete a marker written after it. `sparrow await` only READS, and
 * never deletes.
 * ================================================================== */

let stateDir: string;
const env = (): Record<string, string | undefined> => ({ SPARROW_STATE_DIR: stateDir });

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-blocked-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

let seq = 0;
/** Write one marker file, the way the hook does, and return its path. */
function write(record: Record<string, unknown>, name = `marker-${seq++}.json`): string {
  fs.mkdirSync(blockedDir(env()), { recursive: true });
  const file = path.join(blockedDir(env()), name);
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

describe('readBlocked', () => {
  it('reads the hook’s record', () => {
    const at = new Date().toISOString();
    write({ version: 1, reason: 'rate_limit', at, session: 'sess-1', resumesAt: at });

    const b = readBlocked(env())!;
    expect(b.reason).toBe('rate_limit');
    expect(b.at).toBe(at);
    expect(b.session).toBe('sess-1');
    expect(b.resumesAt).toBe(at);
  });

  it('is absent when there is no directory, no file, or only junk', () => {
    expect(readBlocked(env())).toBeUndefined();
    fs.mkdirSync(blockedDir(env()), { recursive: true });
    expect(readBlocked(env())).toBeUndefined();
    write('not json' as any);
    fs.writeFileSync(path.join(blockedDir(env()), 'junk.json'), 'not json\n');
    expect(readBlocked(env())).toBeUndefined();
  });

  it('returns the NEWEST live marker when several are present', () => {
    write({ version: 1, reason: 'older', at: new Date(Date.now() - 60_000).toISOString() });
    write({ version: 1, reason: 'newest', at: new Date().toISOString() });
    write({ version: 1, reason: 'middle', at: new Date(Date.now() - 30_000).toISOString() });
    expect(readBlocked(env())!.reason).toBe('newest');
  });

  it('stays blocked while ANY live marker remains, and clears only when none do', () => {
    const a = write({ version: 1, reason: 'rate_limit', at: new Date().toISOString() });
    const b = write({ version: 1, reason: 'rate_limit', at: new Date().toISOString() });
    fs.rmSync(a); // the hook clears the one it saw…
    expect(readBlocked(env())).toBeDefined(); // …and the replacement still holds
    fs.rmSync(b);
    expect(readBlocked(env())).toBeUndefined();
  });

  it('ignores files that are not markers', () => {
    fs.mkdirSync(blockedDir(env()), { recursive: true });
    fs.writeFileSync(path.join(blockedDir(env()), 'README'), 'not a marker');
    expect(readBlocked(env())).toBeUndefined();
  });

  /* AGE IS NOT EVIDENCE that a quota recovered — only the resume hook (or a
   * human running `sparrow skill unblock`) knows that. A listener must never
   * put itself back online on the strength of a clock. */
  it('keeps blocking on an old marker: nothing about time says the limit lifted', () => {
    write({ version: 1, reason: 'rate_limit', at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
    expect(readBlocked(env())!.reason).toBe('rate_limit');
  });

  it('falls back to the file\u2019s mtime when `at` is missing or unparsable', () => {
    const file = write({ version: 1, reason: 'rate_limit' });
    expect(readBlocked(env())?.reason).toBe('rate_limit');
    const old = new Date(Date.now() - 5 * 24 * 3600_000);
    fs.utimesSync(file, old, old);
    expect(readBlocked(env())?.reason).toBe('rate_limit'); // still blocked
  });

  it('accepts any reason word the hook writes, and defaults to `blocked`', () => {
    write({ version: 1, reason: 'overloaded', at: new Date().toISOString() });
    expect(readBlocked(env())!.reason).toBe('overloaded');
    fs.rmSync(blockedDir(env()), { recursive: true, force: true });
    write({ version: 1, at: new Date().toISOString() });
    expect(readBlocked(env())!.reason).toBe('blocked');
  });

  it('sanitises a reason so it can never break the heartbeat stamp', () => {
    write({ version: 1, reason: 'rate limit\nawait fake', at: new Date().toISOString() });
    expect(readBlocked(env())!.reason).toBe('rate_limit_await_fake');
  });
});
