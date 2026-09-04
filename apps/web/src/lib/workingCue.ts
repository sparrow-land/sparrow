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
 * **One design, no setting.** Three candidates shipped briefly behind a picker
 * — a mechanical tick, a two-note chime, and this — and Jake chose the pulse
 * outright, so the other two and the preference went with them. A cue you have
 * to configure is a cue that was not good enough.
 *
 * The pulse: a 220 Hz sine swelling over 300 ms, every 2 s. Low and slow enough
 * to be felt more than heard, which is what keeps it from reading as an alert.
 * It peaks at {@link CUE_GAIN} with ramped edges — a gain that steps from 0 is
 * itself an audible click, which would defeat the point — and is synthesized
 * with Web Audio, so there is no asset to ship, cache or mis-cache.
 *
 * The caller supplies the `AudioContext`, because on iOS it has to be one
 * created inside a user gesture: the overlay makes it on the mic/Send tap and
 * hands it here.
 */

/** How often the swell repeats. */
export const CUE_INTERVAL_MS = 2_000;

/** Peak gain. Audible in a quiet room, inaudible over a speaking voice. */
export const CUE_GAIN = 0.08;

/** One swell, start to silence. */
const PULSE_S = 0.3;

/** The shortest release that is not itself a click. */
const RAMP_S = 0.012;

export interface WorkingCue {
  /** Stop repeating. Idempotent — every exit path from `awaiting` calls it. */
  stop(): void;
}

/**
 * Start the cue. Returns immediately with a handle whose `stop()` ends it; the
 * first swell is scheduled at once rather than after one interval, so the wait
 * is acknowledged the moment it begins.
 *
 * Never throws: a context that is closed, suspended or refusing to build nodes
 * is a cue that does not play, never a hands-free session that dies.
 */
export function startWorkingCue(ctx: AudioContext): WorkingCue {
  const play = () => {
    try {
      if (ctx.state === 'closed') return;
      playPulse(ctx, ctx.currentTime);
    } catch {
      /* the graph refused this beat; the next one may work, and neither matters
         enough to surface */
    }
  };

  play();
  const timer = setInterval(play, CUE_INTERVAL_MS);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** One low 220 Hz swell — slow in, slow out. */
function playPulse(ctx: AudioContext, at: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, at);

  // The envelope IS the design here: a long rise is what makes it read as a
  // breath rather than a beep, so the shape matters more than the pitch.
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(CUE_GAIN, at + PULSE_S * 0.35);
  gain.gain.linearRampToValueAtTime(0, at + PULSE_S);
  gain.connect(ctx.destination);

  osc.connect(gain);
  osc.start(at);
  osc.stop(at + PULSE_S + RAMP_S);
}
