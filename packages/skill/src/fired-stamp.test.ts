/**
 * The firing-stamp READER, and the question the CLI actually needs answered
 * before it arms a listener: "are Codex's hooks firing FOR THIS THREAD?"
 *
 * Why the thread matters. Codex has two silent trust gates, and the failure they
 * produce is invisible: the hooks simply never run, nothing is logged, and a
 * `sparrow await` armed behind them has no Stop hook to catch it when it dies.
 * A stamp proves a hook fired — but a stamp from LAST WEEK'S session proves
 * nothing about the session asking now, which is exactly the state the
 * 2026-09-16 incident was in. So the stamp carries the thread that fired it
 * (from the hook payload's `session_id`), and verification is per-thread.
 *
 * The one concession is COMPATIBILITY: a stamp written by an older wrapper has
 * no thread at all. Refusing to arm on that would break every install that has
 * not re-run, so a thread-less runtime stamp still verifies — flagged `legacy`
 * so the caller can say which kind of proof it has.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hooksVerifiedForThread, readFiredStamp } from './provider-codex.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-stamp-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Write `<state dir>/hooks-fired/<event>` with `body`, aged `ageSeconds`. */
function stamp(event: string, body: string, ageSeconds = 0): void {
  const dir = path.join(stateDir, 'hooks-fired');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, event);
  fs.writeFileSync(f, `${body}\n`);
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(f, when, when);
}

describe('readFiredStamp', () => {
  it('reads kind, thread and age', () => {
    stamp('Stop', 'runtime abc-123', 42);
    const s = readFiredStamp(stateDir, 'Stop');
    expect(s?.kind).toBe('runtime');
    expect(s?.thread).toBe('abc-123');
    expect(s?.ageSeconds).toBeGreaterThanOrEqual(41);
    expect(s?.ageSeconds).toBeLessThanOrEqual(44);
  });

  it('reads a thread-less stamp exactly as before (no thread field)', () => {
    stamp('Stop', 'runtime');
    expect(readFiredStamp(stateDir, 'Stop')?.kind).toBe('runtime');
    expect(readFiredStamp(stateDir, 'Stop')?.thread).toBeUndefined();
  });

  it('reads a manual stamp, with or without a thread', () => {
    stamp('Stop', 'manual abc-123');
    expect(readFiredStamp(stateDir, 'Stop')).toMatchObject({ kind: 'manual', thread: 'abc-123' });
    stamp('Stop', 'manual');
    expect(readFiredStamp(stateDir, 'Stop')?.kind).toBe('manual');
  });

  it('treats an EMPTY stamp (any older CLI) as runtime, as it always did', () => {
    stamp('Stop', '');
    expect(readFiredStamp(stateDir, 'Stop')?.kind).toBe('runtime');
  });

  it('is undefined for an event that never fired', () => {
    expect(readFiredStamp(stateDir, 'Stop')).toBeUndefined();
  });
});

describe('hooksVerifiedForThread', () => {
  it('verifies on a runtime stamp naming this thread, and lists the events', () => {
    stamp('Stop', 'runtime abc-123');
    stamp('UserPromptSubmit', 'runtime abc-123');
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(true);
    if (v.verified) {
      expect(v.legacy).toBe(false);
      expect(v.events.sort()).toEqual(['Stop', 'UserPromptSubmit']);
    }
  });

  it('lists ONLY the events that named this thread', () => {
    stamp('Stop', 'runtime abc-123');
    stamp('UserPromptSubmit', 'runtime other-thread');
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(true);
    if (v.verified) expect(v.events).toEqual(['Stop']);
  });

  it('verifies a thread-less runtime stamp for compatibility, flagged legacy', () => {
    stamp('UserPromptSubmit', 'runtime');
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(true);
    if (v.verified) {
      expect(v.legacy).toBe(true);
      expect(v.events).toEqual(['UserPromptSubmit']);
    }
  });

  it('prefers the thread-matched proof over the legacy one', () => {
    stamp('UserPromptSubmit', 'runtime'); // older wrapper
    stamp('Stop', 'runtime abc-123'); // current one
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(true);
    if (v.verified) {
      expect(v.legacy).toBe(false);
      expect(v.events).toEqual(['Stop']);
    }
  });

  it('reports no-stamps when nothing has ever fired', () => {
    expect(hooksVerifiedForThread(stateDir, 'abc-123')).toEqual({
      verified: false,
      events: [],
      reason: 'no-stamps',
    });
  });

  it('reports manual-only when the only proof is a hand-run script check', () => {
    stamp('Stop', 'manual abc-123');
    stamp('SessionStart', 'manual');
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(false);
    if (!v.verified) {
      expect(v.reason).toBe('manual-only');
      expect(v.events.sort()).toEqual(['SessionStart', 'Stop']);
    }
  });

  it('reports other-thread when every runtime stamp names somebody else', () => {
    stamp('Stop', 'runtime older-session');
    stamp('SessionStart', 'runtime older-session');
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(false);
    if (!v.verified) {
      expect(v.reason).toBe('other-thread');
      expect(v.events.sort()).toEqual(['SessionStart', 'Stop']);
    }
  });

  it('calls a mix of manual and other-thread stamps other-thread (the stronger fact)', () => {
    stamp('Stop', 'runtime older-session');
    stamp('SessionStart', 'manual');
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(false);
    if (!v.verified) expect(v.reason).toBe('other-thread');
  });

  it('looks at the thread-bearing events and nothing else', () => {
    stamp('SomeOtherEvent', 'runtime abc-123');
    expect(hooksVerifiedForThread(stateDir, 'abc-123').verified).toBe(false);
    for (const e of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      fs.rmSync(path.join(stateDir, 'hooks-fired'), { recursive: true, force: true });
      stamp(e, 'runtime abc-123');
      expect(hooksVerifiedForThread(stateDir, 'abc-123').verified).toBe(true);
    }
  });

  /**
   * The tool events stamp a bare `<kind>` (the wrapper skips the payload parse
   * for them: they fire on every tool call and nothing downstream reads their
   * thread). A bare stamp would otherwise count as LEGACY proof for ANY thread,
   * so they are not thread evidence at all -- whatever an older wrapper wrote.
   */
  it.each(['PreToolUse', 'PostToolUse'])('ignores %s stamps for the thread question', (event) => {
    stamp(event, 'runtime');
    expect(hooksVerifiedForThread(stateDir, 'abc-123')).toEqual({
      verified: false,
      events: [],
      reason: 'no-stamps',
    });
    stamp(event, 'runtime abc-123'); // an older wrapper's threaded stamp
    expect(hooksVerifiedForThread(stateDir, 'abc-123').verified).toBe(false);
    stamp('Stop', 'runtime older-session');
    const v = hooksVerifiedForThread(stateDir, 'abc-123');
    expect(v.verified).toBe(false);
    if (!v.verified) expect(v.reason).toBe('other-thread');
  });

  it('matches a caller passing the RAW thread id, sanitised the wrapper way', () => {
    // The wrapper strips the id to [A-Za-z0-9_-]; a CLI holding the raw value
    // must still match, or every id with a stray character reads as another
    // thread's.
    stamp('Stop', 'runtime abc123');
    expect(hooksVerifiedForThread(stateDir, 'abc:123').verified).toBe(true);
  });

  it('never verifies on an empty thread argument', () => {
    stamp('Stop', 'runtime abc-123');
    const v = hooksVerifiedForThread(stateDir, '');
    expect(v.verified).toBe(false);
    if (!v.verified) expect(v.reason).toBe('other-thread');
  });
});
