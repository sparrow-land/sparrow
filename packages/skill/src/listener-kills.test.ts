/**
 * The listener-kill history and the harness-cap streak rule.
 *
 * Claude Code stops a tracked background task at its Bash call's timeout (30
 * min by default, at most 2 h). A turn-based agent's `sparrow await` IS such a
 * task, so an agent that armed it with a short timeout is stopped on a regular
 * clock while idle and spends a turn re-arming every time. The CLI records each
 * kill here; the prompt hook offers a one-time tip when the last few kills look
 * like a regular cap shorter than the maximum.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAP_STREAK_LENGTH,
  KILL_HISTORY_MAX,
  capStreakMinutes,
  listenerKillsPath,
  readListenerKills,
  recordListenerKill,
  resetListenerKills,
  type ListenerKill,
} from './listener-kills.js';

const MIN = 60_000;

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-kills-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Kills of the given lifetimes (minutes), back to back from a fixed epoch. */
function kills(...minutes: number[]): ListenerKill[] {
  let t = Date.UTC(2026, 9, 1);
  return minutes.map((m, i) => {
    const armedAt = t;
    const killedAt = t + Math.round(m * MIN);
    t = killedAt + 5_000;
    return { armedAt, killedAt, lifetimeSeconds: Math.round((killedAt - armedAt) / 1000), signal: 'SIGTERM', generation: `g${i}` };
  });
}

/** Record kills of the given lifetimes, in order, as the CLI would. */
function recordAll(...minutes: number[]): void {
  for (const k of kills(...minutes)) recordListenerKill(stateDir, k);
}

describe('capStreakMinutes — the streak rule (pure)', () => {
  it('three kills at ~10 min each form a streak, reported as ~10 min', () => {
    expect(capStreakMinutes(kills(10, 10, 10))).toBe(10);
    expect(capStreakMinutes(kills(9.6, 10, 10.4))).toBe(10);
  });

  it('fewer than three kills is no streak yet', () => {
    expect(CAP_STREAK_LENGTH).toBe(3);
    expect(capStreakMinutes(kills(10, 10))).toBeUndefined();
    expect(capStreakMinutes([])).toBeUndefined();
  });

  it('kills at the 2 h maximum are no streak — nothing better to suggest', () => {
    expect(capStreakMinutes(kills(120, 120, 120))).toBeUndefined();
    expect(capStreakMinutes(kills(116, 116, 116))).toBeUndefined();
  });

  it('a regular 30 min cap (the Claude Code default) is a streak', () => {
    expect(capStreakMinutes(kills(30, 30, 30))).toBe(30);
  });

  it('kills under ~5 min are interrupts, not a cap', () => {
    expect(capStreakMinutes(kills(2, 2, 2))).toBeUndefined();
  });

  it('mixed lifetimes are random interrupts, not a regular cap', () => {
    expect(capStreakMinutes(kills(10, 30, 10))).toBeUndefined();
    expect(capStreakMinutes(kills(10, 10, 13))).toBeUndefined(); // > 15% apart
  });

  it('only the LAST three count', () => {
    expect(capStreakMinutes(kills(45, 2, 10, 10, 10))).toBe(10);
    expect(capStreakMinutes(kills(10, 10, 10, 10, 40))).toBeUndefined();
  });
});

describe('recordListenerKill / readListenerKills — the bookkeeping', () => {
  it('reads an empty history when nothing was ever recorded (or the file is garbage)', () => {
    expect(readListenerKills(stateDir).kills).toEqual([]);
    fs.writeFileSync(listenerKillsPath(stateDir), 'not json');
    expect(readListenerKills(stateDir).kills).toEqual([]);
  });

  it('appends each kill and keeps only the last few', () => {
    recordAll(1, 2, 3, 4, 5, 6, 7);
    const h = readListenerKills(stateDir);
    expect(h.kills).toHaveLength(KILL_HISTORY_MAX);
    expect(h.kills.map((k) => Math.round(k.lifetimeSeconds / 60))).toEqual([3, 4, 5, 6, 7]);
    expect(h.lastGeneration).toBe('g6');
  });

  it('writes atomically: no temp file is left behind', () => {
    recordAll(10);
    expect(fs.readdirSync(stateDir)).toEqual(['listener-kills.json']);
  });

  it('never throws, even when the state dir cannot be written', () => {
    const blocker = path.join(stateDir, 'file');
    fs.writeFileSync(blocker, '');
    expect(() =>
      recordListenerKill(path.join(blocker, 'sub'), kills(10)[0]!),
    ).not.toThrow();
    expect(() => resetListenerKills(path.join(blocker, 'sub'))).not.toThrow();
  });

  it('3 kills at 10 min → a tip is due, with the observed lifetime', () => {
    recordAll(10, 10, 10);
    const h = readListenerKills(stateDir);
    expect(h.tipMinutes).toBe(10);
    expect(h.tipStreak).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('3 kills at 120 min → no tip', () => {
    recordAll(120, 120, 120);
    const h = readListenerKills(stateDir);
    expect(h.tipStreak).toBeUndefined();
    expect(h.tipMinutes).toBeUndefined();
  });

  it('mixed lifetimes → no tip', () => {
    recordAll(10, 47, 10);
    expect(readListenerKills(stateDir).tipStreak).toBeUndefined();
  });

  it('a streak that continues keeps ONE identity (so the tip is shown once)', () => {
    recordAll(10, 10, 10);
    const first = readListenerKills(stateDir).tipStreak;
    expect(first).toBeDefined();
    for (const k of kills(10, 10).map((k) => ({ ...k, armedAt: k.armedAt + 60 * MIN, killedAt: k.killedAt + 60 * MIN }))) {
      recordListenerKill(stateDir, k);
    }
    expect(readListenerKills(stateDir).tipStreak).toBe(first);
  });

  it('a wake (reset) between kills breaks the streak; a re-formed one is NEW', () => {
    recordAll(10, 10, 10);
    const first = readListenerKills(stateDir).tipStreak;
    resetListenerKills(stateDir);
    expect(fs.existsSync(listenerKillsPath(stateDir))).toBe(false);
    expect(readListenerKills(stateDir).kills).toEqual([]);

    // Two kills, a wake, two kills: never three in a row.
    recordAll(10, 10);
    resetListenerKills(stateDir);
    recordAll(10, 10);
    expect(readListenerKills(stateDir).tipStreak).toBeUndefined();

    // A third consecutive kill re-forms it, under a different identity.
    const later = kills(10)[0]!;
    recordListenerKill(stateDir, { ...later, armedAt: later.armedAt + 999 * MIN, killedAt: later.killedAt + 999 * MIN });
    const again = readListenerKills(stateDir).tipStreak;
    expect(again).toBeDefined();
    expect(again).not.toBe(first);
  });

  it('a kill that breaks the regularity ends the streak; the next one is new', () => {
    recordAll(10, 10, 10);
    const first = readListenerKills(stateDir).tipStreak;
    const odd = kills(40)[0]!;
    recordListenerKill(stateDir, { ...odd, armedAt: odd.armedAt + 100 * MIN, killedAt: odd.killedAt + 100 * MIN });
    expect(readListenerKills(stateDir).tipStreak).toBeUndefined();
    for (const [i, k] of kills(10, 10, 10).entries()) {
      recordListenerKill(stateDir, { ...k, armedAt: k.armedAt + (200 + i) * MIN, killedAt: k.killedAt + (200 + i) * MIN });
    }
    const again = readListenerKills(stateDir).tipStreak;
    expect(again).toBeDefined();
    expect(again).not.toBe(first);
  });
});
