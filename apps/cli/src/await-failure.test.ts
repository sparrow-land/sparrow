import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { awaitFailurePath, readAwaitFailure, writeAwaitFailure } from './await-failure.js';

/* ==================================================================
 * `<state dir>/await-last-failure.json` — why the listener is gone.
 *
 * A heartbeat stamped `killed:CODEX_QUEUE` says THAT the wake path broke; the
 * stderr line saying WHY scrolled past in a shell nobody is reading any more.
 * This is the same sentence, left where the next turn's status can find it.
 * ================================================================== */

let stateDir: string;
const env = (): Record<string, string | undefined> => ({ SPARROW_STATE_DIR: stateDir });

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-await-failure-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe('the last-failure record', () => {
  it('writes the shape a status reader expects', () => {
    writeAwaitFailure(env(), {
      nonce: 'f00dcafef00dcafe',
      thread: 'thread-root',
      error: new Error('direct app-server input is not allowed for unloaded spawned sub-agents'),
    });

    const r = readAwaitFailure(env())!;
    expect(r.version).toBe(1);
    expect(r.kind).toBe('codex-queue');
    expect(r.nonce).toBe('f00dcafef00dcafe');
    expect(r.thread).toBe('thread-root');
    expect(r.error).toBe('direct app-server input is not allowed for unloaded spawned sub-agents');
    expect(Date.now() - Date.parse(r.at)).toBeLessThan(5000);
  });

  it('keeps the FIRST line only, capped at 300 characters', () => {
    writeAwaitFailure(env(), {
      thread: 't',
      error: new Error(`${'x'.repeat(500)}\nstack frame one\nstack frame two`),
    });
    const r = readAwaitFailure(env())!;
    expect(r.error).toHaveLength(300);
    expect(r.error).not.toContain('stack frame');
  });

  it('takes a non-Error thrown value as it comes', () => {
    writeAwaitFailure(env(), { thread: 't', error: 'plain string failure' });
    expect(readAwaitFailure(env())!.error).toBe('plain string failure');
  });

  it('omits the nonce for an unfenced listener rather than inventing one', () => {
    writeAwaitFailure(env(), { thread: 't', error: 'x' });
    expect(readAwaitFailure(env())!.nonce).toBeUndefined();
  });

  it('is atomic and leaves no temp file', () => {
    writeAwaitFailure(env(), { thread: 't', error: 'x' });
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('never throws on an unwritable state dir', () => {
    const blocker = path.join(stateDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const broken = { SPARROW_STATE_DIR: path.join(blocker, 'nested') };
    expect(() => writeAwaitFailure(broken, { thread: 't', error: 'x' })).not.toThrow();
    expect(readAwaitFailure(broken)).toBeUndefined();
  });

  it('reads as absent when there is no record, or the file is junk', () => {
    expect(readAwaitFailure(env())).toBeUndefined();
    fs.writeFileSync(awaitFailurePath(env()), 'not json\n');
    expect(readAwaitFailure(env())).toBeUndefined();
  });
});
