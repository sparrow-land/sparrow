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
  markHeartbeatDead,
  readHeartbeatKind,
  readHeartbeatState,
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

describe('readHeartbeatState', () => {
  it('reads a live listener kind', () => {
    touchHeartbeat(stateDir, { kind: 'watch', force: true });
    expect(readHeartbeatState(stateDir)).toEqual({ state: 'watch' });
  });

  it('is undefined when absent, empty or unrecognized', () => {
    expect(readHeartbeatState(stateDir)).toBeUndefined();
    fs.writeFileSync(heartbeatPath(stateDir), '');
    expect(readHeartbeatState(stateDir)).toBeUndefined();
    fs.writeFileSync(heartbeatPath(stateDir), 'my-own-curl-loop\n');
    expect(readHeartbeatState(stateDir)).toBeUndefined();
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
