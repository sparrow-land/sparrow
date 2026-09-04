import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CUE_GAIN, CUE_INTERVAL_MS, startWorkingCue } from './workingCue.js';

/* ------------------------------------------------------------------ *
 * A Web Audio graph recorder. jsdom has none, and the point of these
 * tests is WHAT gets scheduled, not what it sounds like.
 * ------------------------------------------------------------------ */

interface Param {
  name: string;
  set: Array<[number, number]>;
  ramps: Array<[number, number]>;
}

function param(name: string): Param & {
  setValueAtTime: (v: number, t: number) => void;
  linearRampToValueAtTime: (v: number, t: number) => void;
  exponentialRampToValueAtTime: (v: number, t: number) => void;
  value: number;
} {
  const p: Param = { name, set: [], ramps: [] };
  return {
    ...p,
    value: 0,
    setValueAtTime: (v: number, t: number) => p.set.push([v, t]),
    linearRampToValueAtTime: (v: number, t: number) => p.ramps.push([v, t]),
    exponentialRampToValueAtTime: (v: number, t: number) => p.ramps.push([v, t]),
  };
}

class FakeCtx {
  static last: FakeCtx | null = null;
  currentTime = 0;
  state: AudioContextState = 'running';
  sampleRate = 48_000;
  destination = { connect: vi.fn(), disconnect: vi.fn() };
  oscillators: Array<{ type: string; freq: ReturnType<typeof param>; started: number[]; stopped: number[] }> = [];
  gains: ReturnType<typeof param>[] = [];

  constructor() {
    FakeCtx.last = this;
  }
  createOscillator() {
    const freq = param('frequency');
    const osc = { type: 'sine', freq, started: [] as number[], stopped: [] as number[] };
    this.oscillators.push(osc);
    return {
      get type() {
        return osc.type;
      },
      set type(v: string) {
        osc.type = v;
      },
      frequency: freq,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: (t: number) => osc.started.push(t),
      stop: (t: number) => osc.stopped.push(t),
      onended: null,
    };
  }
  createGain() {
    const gain = param('gain');
    this.gains.push(gain);
    return { gain, connect: vi.fn(), disconnect: vi.fn() };
  }
}

const ctx = () => FakeCtx.last!;
function makeCtx(): AudioContext {
  return new FakeCtx() as unknown as AudioContext;
}

/** How many separate swells have been scheduled so far. */
function voices(): number {
  return ctx().oscillators.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeCtx.last = null;
});
afterEach(() => {
  vi.useRealTimers();
});

/* ================================================================== *
 * Scheduling
 * ================================================================== */

describe('startWorkingCue', () => {
  it('sounds immediately, then every two seconds', () => {
    // Immediately, not after the first interval: the wait is acknowledged the
    // moment it starts, which is the entire point of the cue.
    expect(CUE_INTERVAL_MS).toBe(2_000);
    const cue = startWorkingCue(makeCtx());
    expect(voices()).toBe(1);
    vi.advanceTimersByTime(CUE_INTERVAL_MS);
    expect(voices()).toBe(2);
    vi.advanceTimersByTime(CUE_INTERVAL_MS);
    expect(voices()).toBe(3);
    cue.stop();
  });

  it('is one low 220 Hz sine swell, 300 ms long', () => {
    const cue = startWorkingCue(makeCtx());
    const osc = ctx().oscillators;
    expect(osc).toHaveLength(1);
    expect(osc[0]!.type).toBe('sine');
    expect(osc[0]!.freq.set.map(([v]) => v)).toContain(220);
    // Started and stopped around a 300 ms window — felt, not listened to.
    const [start] = osc[0]!.started;
    const [stop] = osc[0]!.stopped;
    expect(stop! - start!).toBeGreaterThanOrEqual(0.3);
    expect(stop! - start!).toBeLessThan(0.35);
    cue.stop();
  });

  it('stays quiet and ramps both edges, so it never clicks', () => {
    const cue = startWorkingCue(makeCtx());
    const g = ctx().gains[0]!;
    // Starts from silence…
    expect(g.set.some(([v]) => v === 0)).toBe(true);
    // …swells to the low ceiling and back down again.
    const peak = Math.max(...g.ramps.map(([v]) => v));
    expect(peak).toBe(CUE_GAIN);
    expect(CUE_GAIN).toBeLessThanOrEqual(0.08);
    expect(g.ramps.at(-1)![0]).toBe(0);
    // The rise is slower than the fall is abrupt — a breath, not a beep.
    expect(g.ramps.length).toBeGreaterThan(1);
    cue.stop();
  });

  it('stop() ends the repetition immediately', () => {
    const cue = startWorkingCue(makeCtx());
    const atStop = voices();
    cue.stop();
    vi.advanceTimersByTime(30_000);
    expect(voices()).toBe(atStop);
  });

  it('stop() is idempotent', () => {
    const cue = startWorkingCue(makeCtx());
    cue.stop();
    expect(() => cue.stop()).not.toThrow();
  });

  it('a closed or muted context never throws out of start/stop', () => {
    const dead = {
      state: 'closed' as AudioContextState,
      currentTime: 0,
      sampleRate: 48_000,
      destination: {},
      createOscillator() {
        throw new Error('context is closed');
      },
      createGain() {
        throw new Error('context is closed');
      },
    } as unknown as AudioContext;

    let cue!: ReturnType<typeof startWorkingCue>;
    expect(() => {
      cue = startWorkingCue(dead);
    }).not.toThrow();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(() => cue.stop()).not.toThrow();
  });
});
