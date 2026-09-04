import { useEffect, useRef } from 'react';

/** How many vertical bars the meter draws. Small: a compact composer-scale glyph. */
const BAR_COUNT = 7;
/** FFT size → BAR_COUNT bins after averaging. 64 gives 32 usable frequency bins. */
const FFT_SIZE = 64;
/** Resting scale so idle bars are visible (a faint baseline), never fully collapsed. */
const MIN_SCALE = 0.12;

type AudioCtor = typeof AudioContext;

/** The AudioContext constructor, prefixed fallback included; null when unavailable. */
function audioContextCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Live microphone level meter (v-voice). Attaches a Web Audio `AnalyserNode` to
 * the SAME `MediaStream` the recorder is capturing and paints a compact bar-set
 * that responds to the real input level — so the speaker can see capture is
 * working, not a canned animation. A `requestAnimationFrame` loop drives the bars
 * directly via refs (no per-frame React re-render).
 *
 * Decorative: the recording state + timer already carry the accessible signal, so
 * the meter is `aria-hidden`. Degrades gracefully — if `AudioContext` is missing
 * (or the graph fails to build) the static baseline bars render and the overlay
 * behaves exactly as before. The whole graph (source, analyser, context) is torn
 * down on unmount, which for this overlay is stop/cancel — no leaked contexts.
 */
export function LevelMeter({ stream }: { stream: MediaStream | null }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (!stream) return;
    const Ctor = audioContextCtor();
    if (!Ctor) return; // Graceful degradation: static baseline bars, no graph.

    let ctx: AudioContext;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      ctx = new Ctor();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
    } catch {
      return; // Same graceful fallback if the graph can't be built.
    }

    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    const perBar = Math.max(1, Math.floor(bins / BAR_COUNT));
    let raf = 0;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      for (let b = 0; b < BAR_COUNT; b += 1) {
        let sum = 0;
        const from = b * perBar;
        const to = Math.min(from + perBar, bins);
        for (let i = from; i < to; i += 1) sum += data[i] ?? 0;
        const avg = to > from ? sum / (to - from) / 255 : 0;
        // Center bars a touch taller than the edges so it reads as a level shape.
        const shaped = Math.min(1, avg * (1.1 - Math.abs(b - (BAR_COUNT - 1) / 2) * 0.08));
        const scale = MIN_SCALE + (1 - MIN_SCALE) * shaped;
        const el = barsRef.current[b];
        if (el) el.style.transform = `scaleY(${scale.toFixed(3)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* already torn down */
      }
      if (ctx.state !== 'closed') void ctx.close();
    };
  }, [stream]);

  return (
    <span
      aria-hidden="true"
      data-testid="voice-level-meter"
      className="flex h-16 items-center justify-center gap-1.5"
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          data-meter-bar
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          style={{ transform: `scaleY(${MIN_SCALE})`, transformOrigin: 'center' }}
          className="h-14 w-2 rounded-full bg-[var(--sparrow-accent)] opacity-70 transition-none will-change-transform"
        />
      ))}
    </span>
  );
}
