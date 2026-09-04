/**
 * The "still working" cue for hands-free mode.
 *
 * After Send, the overlay waits for a counterpart that may take a while — and a
 * silent wait, eyes-free, is indistinguishable from a dead app (Jake's first
 * live session: "I couldn't tell whether it was thinking or broken"). So the
 * awaiting state gets a quiet, repeating sound. It is a heartbeat, not a
 * notification: the interesting event is the reply speaking, and this must
 * never compete with it.
 *
 * Everything is synthesized with Web Audio — no assets to ship, cache or
 * mis-cache, and the whole cue is a few nodes per tick.
 *
 * Three designs, because "pleasant" is a matter of taste and Jake wanted to try
 * them (`off` is the fourth option and a real answer):
 * - **tick** — a 12 ms band-passed noise click every 1.5 s. Mechanical, like a
 *   clock in the room; the least like a notification of the three.
 * - **chime** — two soft sine notes, 660 Hz then 880 Hz, ~120 ms total, every
 *   4 s. Warmer and more musical, and the sparsest.
 * - **pulse** — a 220 Hz sine swelling over 300 ms every 2 s. Low and felt more
 *   than heard; the closest thing to a breath.
 *
 * All three peak at {@link CUE_GAIN} with a ramped attack and release — a gain
 * that jumps from 0 is itself an audible click, which would defeat the point.
 *
 * The caller supplies the `AudioContext`, because on iOS it has to be one
 * created inside a user gesture: the overlay makes it on the mic/Send tap and
 * hands it here.
 */

export type WorkingCueStyle = 'off' | 'tick' | 'chime' | 'pulse';

/** In menu order; `off` first because it is the opt-out, not a fallback. */
export const WORKING_CUE_STYLES: WorkingCueStyle[] = ['off', 'tick', 'chime', 'pulse'];

/** Human labels for the selector. */
export const WORKING_CUE_LABELS: Record<WorkingCueStyle, string> = {
  off: 'Off',
  tick: 'Tick',
  chime: 'Chime',
  pulse: 'Pulse',
};

/** Per-browser preference (localStorage; there is no server-side voice profile). */
export const WORKING_CUE_KEY = 'sparrow.handsfree.workingCue';

/** How often each style repeats. */
export const CUE_INTERVALS_MS: Record<WorkingCueStyle, number> = {
  off: 0,
  tick: 1_500,
  chime: 4_000,
  pulse: 2_000,
};

/** Peak gain. Audible in a quiet room, inaudible over a speaking voice. */
export const CUE_GAIN = 0.08;

/** The shortest ramp that is not itself a click. */
const RAMP_S = 0.012;

export interface WorkingCue {
  /** Stop repeating. Idempotent — every exit path from `awaiting` calls it. */
  stop(): void;
}

const NO_CUE: WorkingCue = { stop() {} };

function isStyle(v: unknown): v is WorkingCueStyle {
  return typeof v === 'string' && (WORKING_CUE_STYLES as string[]).includes(v);
}

/** The stored preference, or `tick`. Storage can throw outright in private mode. */
export function loadWorkingCueStyle(): WorkingCueStyle {
  try {
    const raw = localStorage.getItem(WORKING_CUE_KEY);
    return isStyle(raw) ? raw : 'tick';
  } catch {
    return 'tick';
  }
}

export function saveWorkingCueStyle(style: WorkingCueStyle): void {
  try {
    localStorage.setItem(WORKING_CUE_KEY, style);
  } catch {
    /* a browser that refuses storage still gets the sound, just not the memory */
  }
}

/**
 * Start the cue. Returns immediately with a handle whose `stop()` ends it; the
 * first sound is scheduled at once rather than after one interval, so the wait
 * is acknowledged the moment it begins.
 *
 * Never throws: a context that is closed, suspended or refusing to build nodes
 * is a cue that does not play, never a hands-free session that dies.
 */
export function startWorkingCue(ctx: AudioContext, style: WorkingCueStyle): WorkingCue {
  if (style === 'off') return NO_CUE;

  const play = () => {
    try {
      if (ctx.state === 'closed') return;
      const at = ctx.currentTime;
      if (style === 'tick') playTick(ctx, at);
      else if (style === 'chime') playChime(ctx, at);
      else playPulse(ctx, at);
    } catch {
      /* the graph refused this beat; the next one may work, and neither matters
         enough to surface */
    }
  };

  play();
  const timer = setInterval(play, CUE_INTERVALS_MS[style]);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** An envelope from silence, to `peak`, back to silence — never a step. */
function envelope(ctx: AudioContext, at: number, peak: number, hold: number) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + RAMP_S);
  gain.gain.linearRampToValueAtTime(0, at + hold);
  gain.connect(ctx.destination);
  return gain;
}

/** A 12 ms band-passed noise burst: a click with a body, not a pop. */
function playTick(ctx: AudioContext, at: number): void {
  const seconds = 0.012;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // Decaying noise — the decay is what stops it reading as static.
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(2_000, at);
  band.Q.setValueAtTime(1.2, at);

  const gain = envelope(ctx, at, CUE_GAIN, seconds);
  source.connect(band);
  band.connect(gain);
  source.start(at);
}

/** Two soft sine notes, 660 → 880 Hz, 60 ms each. */
function playChime(ctx: AudioContext, at: number): void {
  const note = 0.06;
  [660, 880].forEach((hz, i) => {
    const start = at + i * note;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz, start);
    const gain = envelope(ctx, start, CUE_GAIN, note);
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + note + RAMP_S);
  });
}

/** One low 220 Hz swell over 300 ms — slow in, slow out. */
function playPulse(ctx: AudioContext, at: number): void {
  const seconds = 0.3;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, at);

  // A longer attack than the others: this one should feel like a breath, so the
  // envelope is the design rather than the pitch.
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(CUE_GAIN, at + seconds * 0.35);
  gain.gain.linearRampToValueAtTime(0, at + seconds);
  gain.connect(ctx.destination);

  osc.connect(gain);
  osc.start(at);
  osc.stop(at + seconds + RAMP_S);
}
