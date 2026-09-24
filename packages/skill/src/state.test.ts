/**
 * The heartbeat's TERMINAL stamps.
 *
 * A tracked `sparrow await` is a turn-based agent's only wake path, and the
 * harness kills its process tree whenever the human interrupts the session
 * (Esc / Ctrl-C) — SIGTERM/SIGHUP straight at the listener. The heartbeat it
 * left behind then stays FRESH for the whole 120s window, so every reader
 * (Stop hook, prompt nudge) believes a listener is alive while the agent is
 * deaf. Three production sessions ended silently that way in one day.
 *
 * The fix is that a dying listener says so: it stamps the heartbeat with
 * `killed:<signal>` / `stopped:<signal>` on its way out, which readers treat as
 * "no listener", freshness be damned.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  heartbeatAgeSeconds,
  heartbeatPath,
  homeStateDir,
  resolveStateDir,
  markHeartbeatBlocked,
  markHeartbeatDead,
  markHeartbeatOrphaned,
  markHeartbeatWord,
  readHeartbeatKind,
  readHeartbeatState,
  readJsonRecord,
  touchHeartbeat,
  __resetHeartbeatThrottle,
} from './state.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-state-'));
  __resetHeartbeatThrottle();
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const content = (): string => fs.readFileSync(heartbeatPath(stateDir), 'utf8').trim();

describe('markHeartbeatDead', () => {
  it('stamps `killed:SIGTERM` when the process tree is killed', () => {
    markHeartbeatDead(stateDir, 'killed', 'SIGTERM');
    expect(content()).toBe('killed:SIGTERM');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'killed', signal: 'SIGTERM' });
  });

  it('stamps `stopped:SIGINT` for a deliberate Ctrl-C', () => {
    markHeartbeatDead(stateDir, 'stopped', 'SIGINT');
    expect(content()).toBe('stopped:SIGINT');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'stopped', signal: 'SIGINT' });
  });

  it('omits the suffix when no signal is named, and still parses', () => {
    markHeartbeatDead(stateDir, 'killed');
    expect(content()).toBe('killed');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'killed' });
  });

  it('tags a LIVE claim the same way, and both readers see through the tag', () => {
    __resetHeartbeatThrottle();
    touchHeartbeat(stateDir, { kind: 'await:codex', generation: '4f2c9a01bb33cd10', force: true });
    expect(content()).toBe('await:codex 4f2c9a01bb33cd10');
    expect(readHeartbeatState(stateDir)).toEqual({
      state: 'await:codex',
      generation: '4f2c9a01bb33cd10',
    });
    // `readHeartbeatKind` answers "which listener?", tag or no tag.
    expect(readHeartbeatKind(stateDir)).toBe('await:codex');
    __resetHeartbeatThrottle();
    touchHeartbeat(stateDir, { kind: 'await', force: true }); // watch/loop-style, untagged
    expect(content()).toBe('await');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'await' });
  });

  /**
   * A stamp may name the `await` GENERATION that wrote it (see the CLI's
   * await-owner.ts): a superseded listener can be killed long after a
   * successor took over, and without the tag its `killed:` would describe the
   * live one. The FIRST token is deliberately unchanged, so every existing
   * reader still parses the stamp.
   */
  it('appends the writer generation as a second token, leaving the first intact', () => {
    markHeartbeatDead(stateDir, 'killed', 'SIGTERM', '4f2c9a01bb33cd10');
    expect(content()).toBe('killed:SIGTERM 4f2c9a01bb33cd10');
    expect(readHeartbeatState(stateDir)).toEqual({
      state: 'killed',
      signal: 'SIGTERM',
      generation: '4f2c9a01bb33cd10',
    });
  });

  it('tags a signal-less stamp too, and parses back without one', () => {
    markHeartbeatDead(stateDir, 'stopped', undefined, 'b0b0b0b0b0b0b0b0');
    expect(content()).toBe('stopped b0b0b0b0b0b0b0b0');
    expect(readHeartbeatState(stateDir)).toEqual({
      state: 'stopped',
      generation: 'b0b0b0b0b0b0b0b0',
    });
    markHeartbeatDead(stateDir, 'stopped', 'SIGINT');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'stopped', signal: 'SIGINT' });
  });

  it('BYPASSES the touch throttle — a dying listener gets exactly one chance', () => {
    touchHeartbeat(stateDir, { kind: 'await', force: true });
    expect(content()).toBe('await');
    markHeartbeatDead(stateDir, 'killed', 'SIGHUP'); // well inside the 15s throttle
    expect(content()).toBe('killed:SIGHUP');
  });

  it('stamps a fresh mtime (the CONTENT, not staleness, is what disqualifies it)', () => {
    markHeartbeatDead(stateDir, 'killed', 'SIGTERM');
    expect(heartbeatAgeSeconds(stateDir)).toBeLessThan(5);
  });

  it('creates the state dir and never throws on an unwritable one', () => {
    const nested = path.join(stateDir, 'deep', 'er');
    markHeartbeatDead(nested, 'stopped', 'SIGINT');
    expect(fs.readFileSync(heartbeatPath(nested), 'utf8').trim()).toBe('stopped:SIGINT');
    // A state dir that cannot exist (a regular file stands where a directory
    // would go) → ENOTDIR, swallowed: dying is not the moment to throw.
    const blocked = path.join(stateDir, 'not-a-dir');
    fs.writeFileSync(blocked, 'x');
    expect(() => markHeartbeatDead(path.join(blocked, 'sub'), 'killed', 'SIGTERM')).not.toThrow();
  });
});

/* ONE WRITER for every heartbeat word — the signal stamps, `blocked:<reason>`
 * and `orphaned` — next to the one reader of all of them. */
describe('markHeartbeatWord and its wrappers', () => {
  it('writes `<word> [generation]` with the mtime it was given', () => {
    const at = Date.parse('2026-09-01T00:00:00Z');
    markHeartbeatWord(stateDir, 'orphaned', 'abc123', at);
    expect(content()).toBe('orphaned abc123');
    expect(fs.statSync(heartbeatPath(stateDir)).mtimeMs).toBe(at);
    markHeartbeatWord(stateDir, 'orphaned');
    expect(content()).toBe('orphaned');
  });

  it('never throws on an unusable state dir', () => {
    const file = path.join(stateDir, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(() => markHeartbeatWord(path.join(file, 'sub'), 'orphaned')).not.toThrow();
  });

  it('markHeartbeatOrphaned writes a stamp readHeartbeatState reads back', () => {
    markHeartbeatOrphaned(stateDir, 'n2');
    expect(content()).toBe('orphaned n2');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'orphaned', generation: 'n2' });
    markHeartbeatOrphaned(stateDir);
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'orphaned' });
  });

  it('markHeartbeatBlocked writes blocked:<reason> (a word readers treat as unjudgeable)', () => {
    markHeartbeatBlocked(stateDir, 'rate_limit', 'n1');
    expect(content()).toBe('blocked:rate_limit n1');
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
  });
});

describe('readHeartbeatState', () => {
  it('reads a live listener kind', () => {
    touchHeartbeat(stateDir, { kind: 'watch', force: true });
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'watch' });
  });

  it('reads a Codex-bridged await listener while preserving plain await compatibility', () => {
    touchHeartbeat(stateDir, { kind: 'await:codex', force: true });
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'await:codex' });
    expect(readHeartbeatKind(stateDir)).toBe('await:codex');
    touchHeartbeat(stateDir, { kind: 'await', force: true });
    expect(readHeartbeatKind(stateDir)).toBe('await');
  });

  it('is undefined when absent, empty or unrecognized', () => {
    expect(readHeartbeatState(stateDir)).toBeUndefined();
    fs.writeFileSync(heartbeatPath(stateDir), '');
    expect(readHeartbeatState(stateDir)).toBeUndefined();
    fs.writeFileSync(heartbeatPath(stateDir), 'my-own-curl-loop\n');
    expect(readHeartbeatState(stateDir)).toBeUndefined();
  });

  it('reads an `orphaned` stamp (the CLI stood down: its Claude Code session is gone)', () => {
    fs.writeFileSync(heartbeatPath(stateDir), 'orphaned 4f2c9a01bb33cd10\n');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'orphaned', generation: '4f2c9a01bb33cd10' });
    fs.writeFileSync(heartbeatPath(stateDir), 'orphaned\n');
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'orphaned' });
    // It is a corpse, not a listener: the raw kind reader keeps answering undefined.
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
  });

  it('parses `orphaned` through the same word[:detail] grammar as the dead words', () => {
    fs.writeFileSync(heartbeatPath(stateDir), 'orphaned:gone 4f2c9a01bb33cd10\n');
    expect(readHeartbeatState(stateDir)).toEqual({
      state: 'orphaned',
      signal: 'gone',
      generation: '4f2c9a01bb33cd10',
    });
  });

  it('ignores a signal suffix on a listener kind (only the dead words carry one)', () => {
    fs.writeFileSync(heartbeatPath(stateDir), 'await:SIGTERM\n');
    expect(readHeartbeatState(stateDir)).toBeUndefined();
  });
});

describe('readHeartbeatKind (unchanged contract)', () => {
  it('reads `undefined` for a dead stamp — existing callers keep their meaning', () => {
    markHeartbeatDead(stateDir, 'killed', 'SIGTERM');
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
    markHeartbeatDead(stateDir, 'stopped', 'SIGINT');
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
  });
});

/**
 * WHERE the state lives. Three agents can share one unix user and one HOME while
 * working in different checkouts; a single `~/.sparrow` makes them share one
 * loop switch, one heartbeat and one pair of auto-status markers — so one
 * agent's `skill pause` silences the others and an idle listener in checkout A
 * makes checkout B's Stop hook complain. The state dir is therefore resolved
 * PER PROJECT: an explicit `$SPARROW_STATE_DIR`, else the nearest ancestor of
 * the cwd that looks like a Sparrow project (`.sparrow/loop-state`, or a
 * project-scope skill install), else `~/.sparrow`.
 */
describe('resolveStateDir', () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-proj-'));
  });
  afterEach(() => {
    for (const d of [home, project]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('honors $SPARROW_STATE_DIR over everything else', () => {
    fs.mkdirSync(path.join(project, '.sparrow'), { recursive: true });
    fs.writeFileSync(path.join(project, '.sparrow', 'loop-state'), 'engaged\n');
    expect(resolveStateDir({ HOME: home, SPARROW_STATE_DIR: '/tmp/explicit' }, project)).toBe(
      '/tmp/explicit',
    );
  });

  it('finds `<project>/.sparrow` by walking up from a nested cwd', () => {
    fs.mkdirSync(path.join(project, '.sparrow'), { recursive: true });
    fs.writeFileSync(path.join(project, '.sparrow', 'loop-state'), 'engaged\n');
    const nested = path.join(project, 'src', 'deep', 'er');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveStateDir({ HOME: home }, nested)).toBe(path.join(project, '.sparrow'));
  });

  it('accepts a project-scope skill install as the marker (state dir not created yet)', () => {
    fs.mkdirSync(path.join(project, '.claude', 'skills', 'sparrow'), { recursive: true });
    expect(resolveStateDir({ HOME: home }, project)).toBe(path.join(project, '.sparrow'));
  });

  /**
   * The Codex install marker. Without it, a Codex project whose `.sparrow` had
   * been deleted (or that has not run a hook yet) would resolve its state dir to
   * `~/.sparrow` — i.e. start reading, and pausing, the loop switch belonging to
   * whatever other agent shares this unix user.
   */
  it('accepts a Codex skill install (.agents/skills/sparrow) as the marker too', () => {
    fs.mkdirSync(path.join(project, '.agents', 'skills', 'sparrow'), { recursive: true });
    const nested = path.join(project, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveStateDir({ HOME: home }, nested)).toBe(path.join(project, '.sparrow'));
  });

  it('ignores a bare `.agents` directory that holds no sparrow skill', () => {
    fs.mkdirSync(path.join(project, '.agents', 'skills', 'other'), { recursive: true });
    expect(resolveStateDir({ HOME: home }, project)).toBe(path.join(home, '.sparrow'));
  });

  it('falls back to ~/.sparrow when no marker is found anywhere above the cwd', () => {
    expect(resolveStateDir({ HOME: home }, project)).toBe(path.join(home, '.sparrow'));
  });

  it('ignores a bare `.sparrow` directory with no loop-state (not a project install)', () => {
    fs.mkdirSync(path.join(project, '.sparrow'), { recursive: true });
    expect(resolveStateDir({ HOME: home }, project)).toBe(path.join(home, '.sparrow'));
  });

  it('picks the NEAREST project when checkouts are nested', () => {
    const inner = path.join(project, 'vendor', 'inner');
    fs.mkdirSync(path.join(project, '.sparrow'), { recursive: true });
    fs.writeFileSync(path.join(project, '.sparrow', 'loop-state'), 'engaged\n');
    fs.mkdirSync(path.join(inner, '.sparrow'), { recursive: true });
    fs.writeFileSync(path.join(inner, '.sparrow', 'loop-state'), 'paused\n');
    expect(resolveStateDir({ HOME: home }, inner)).toBe(path.join(inner, '.sparrow'));
  });

  it('homeStateDir is always the user scope, marker or not', () => {
    fs.mkdirSync(path.join(project, '.sparrow'), { recursive: true });
    fs.writeFileSync(path.join(project, '.sparrow', 'loop-state'), 'engaged\n');
    expect(homeStateDir({ HOME: home })).toBe(path.join(home, '.sparrow'));
  });
});

describe('readJsonRecord (the one fail-open small-JSON reader)', () => {
  it('returns the parsed object', () => {
    const f = path.join(stateDir, 'r.json');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(f, '{"a":"b","n":1}');
    expect(readJsonRecord(f)).toEqual({ a: 'b', n: 1 });
  });

  it('is undefined for a missing, malformed or non-object file, and never throws', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const f = path.join(stateDir, 'r.json');
    expect(readJsonRecord(f)).toBeUndefined();
    fs.writeFileSync(f, '{not json');
    expect(readJsonRecord(f)).toBeUndefined();
    fs.writeFileSync(f, '"a string"');
    expect(readJsonRecord(f)).toBeUndefined();
    fs.writeFileSync(f, 'null');
    expect(readJsonRecord(f)).toBeUndefined();
  });
});
