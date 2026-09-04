import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CUE_GAIN,
  CUE_INTERVALS_MS,
  WORKING_CUE_KEY,
  WORKING_CUE_STYLES,
  loadWorkingCueStyle,
  saveWorkingCueStyle,
  startWorkingCue,
  type WorkingCueStyle,
} from './workingCue.js';

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
  buffers: number[] = [];
  bufferSources: Array<{ started: number[] }> = [];
  filters: string[] = [];

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
  createBiquadFilter() {
    const self = this;
    return {
      _type: 'lowpass',
      get type() {
        return this._type;
      },
      set type(v: string) {
        this._type = v;
        self.filters.push(v);
      },
      frequency: param('frequency'),
      Q: param('Q'),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
  createBuffer(_ch: number, length: number, _rate: number) {
    this.buffers.push(length);
    return { getChannelData: () => new Float32Array(length), length };
  }
  createBufferSource() {
    const src = { started: [] as number[] };
    this.bufferSources.push(src);
    return {
      buffer: null as unknown,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: (t: number) => src.started.push(t),
      stop: vi.fn(),
      onended: null,
    };
  }
}

const ctx = () => FakeCtx.last!;
function makeCtx(): AudioContext {
  return new FakeCtx() as unknown as AudioContext;
}

/** How many separate sound events have been scheduled so far. */
function voices(): number {
  const c = ctx();
  return c.oscillators.length + c.bufferSources.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeCtx.last = null;
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ================================================================== *
 * The preference
 * ================================================================== */

describe('working cue preference', () => {
  it('defaults to tick — a wait with no sound at all is what Jake reported', () => {
    expect(loadWorkingCueStyle()).toBe('tick');
  });

  it('round-trips through localStorage, per browser', () => {
    saveWorkingCueStyle('chime');
    expect(localStorage.getItem(WORKING_CUE_KEY)).toBe('chime');
    expect(loadWorkingCueStyle()).toBe('chime');
  });

  it('ignores a stored value that is not a style we ship', () => {
    localStorage.setItem(WORKING_CUE_KEY, 'foghorn');
    expect(loadWorkingCueStyle()).toBe('tick');
  });

  it('survives a browser that refuses storage (private mode, blocked cookies)', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    try {
      expect(loadWorkingCueStyle()).toBe('tick');
      expect(() => saveWorkingCueStyle('pulse')).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('offers exactly off / tick / chime / pulse', () => {
    expect(WORKING_CUE_STYLES).toEqual(['off', 'tick', 'chime', 'pulse']);
  });
});

/* ================================================================== *
 * Scheduling
 * ================================================================== */

describe('startWorkingCue', () => {
  it('off schedules nothing, ever', () => {
    const cue = startWorkingCue(makeCtx(), 'off');
    vi.advanceTimersByTime(20_000);
    expect(voices()).toBe(0);
    cue.stop();
  });

  it.each([
    ['tick', 1_500],
    ['chime', 4_000],
    ['pulse', 2_000],
  ] as Array<[WorkingCueStyle, number]>)(
    '%s sounds immediately and then every %ims',
    (style, every) => {
      expect(CUE_INTERVALS_MS[style]).toBe(every);
      const cue = startWorkingCue(makeCtx(), style);
      // A wait you are told about at once, not after the first interval.
      const first = voices();
      expect(first).toBeGreaterThan(0);
      vi.advanceTimersByTime(every);
      expect(voices()).toBeGreaterThan(first);
      cue.stop();
    },
  );

  it('tick is a filtered click, not a tone', () => {
    const cue = startWorkingCue(makeCtx(), 'tick');
    expect(ctx().bufferSources.length).toBeGreaterThan(0); // noise burst
    expect(ctx().filters).toContain('bandpass');
    // Very short: a click, not a buzz.
    expect(ctx().buffers[0]! / ctx().sampleRate).toBeLessThan(0.05);
    cue.stop();
  });

  it('chime is two soft sine notes, 660 then 880', () => {
    const cue = startWorkingCue(makeCtx(), 'chime');
    const freqs = ctx().oscillators.flatMap((o) => o.freq.set.map(([v]) => v));
    expect(freqs).toContain(660);
    expect(freqs).toContain(880);
    expect(ctx().oscillators.every((o) => o.type === 'sine')).toBe(true);
    cue.stop();
  });

  it('pulse is one low 220 Hz swell', () => {
    const cue = startWorkingCue(makeCtx(), 'pulse');
    expect(ctx().oscillators).toHaveLength(1);
    expect(ctx().oscillators[0]!.freq.set.map(([v]) => v)).toContain(220);
    cue.stop();
  });

  it.each(['tick', 'chime', 'pulse'] as WorkingCueStyle[])(
    '%s stays quiet (peak ≈ %s) and ramps in and out so it never clicks',
    (style) => {
      const cue = startWorkingCue(makeCtx(), style);
      const g = ctx().gains[0]!;
      // Starts from silence…
      expect(g.set.some(([v]) => v === 0)).toBe(true);
      // …ramps up to the low ceiling, and back to (near) zero.
      const peak = Math.max(...g.ramps.map(([v]) => v));
      expect(peak).toBeLessThanOrEqual(CUE_GAIN);
      expect(peak).toBeGreaterThan(0);
      expect(g.ramps.length).toBeGreaterThan(1);
      cue.stop();
    },
  );

  it('stop() ends the repetition immediately', () => {
    const cue = startWorkingCue(makeCtx(), 'tick');
    const atStop = voices();
    cue.stop();
    vi.advanceTimersByTime(30_000);
    expect(voices()).toBe(atStop);
  });

  it('stop() is idempotent', () => {
    const cue = startWorkingCue(makeCtx(), 'pulse');
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
      createBuffer() {
        throw new Error('context is closed');
      },
      createBufferSource() {
        throw new Error('context is closed');
      },
      createBiquadFilter() {
        throw new Error('context is closed');
      },
    } as unknown as AudioContext;

    let cue!: ReturnType<typeof startWorkingCue>;
    expect(() => {
      cue = startWorkingCue(dead, 'chime');
    }).not.toThrow();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(() => cue.stop()).not.toThrow();
  });
});
