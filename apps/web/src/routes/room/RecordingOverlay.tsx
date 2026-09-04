import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, X } from 'lucide-react';
import { LevelMeter } from './LevelMeter.js';

/** Whole seconds → mm:ss (zero-padded, minutes uncapped). */
function formatElapsed(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Full-viewport recording overlay for dictation (v-voice). Portalled to the body
 * so it sits above everything on every screen size — its reason for existing is
 * that on mobile the tiny composer stop button is easy to miss. The ENTIRE
 * surface is one giant stop target: tap/click anywhere (or press the visible
 * copy) to stop and hand off to the existing transcribe flow. A clearly
 * separated corner Cancel discards without transcribing.
 *
 * Escape maps to Cancel (discard), matching the dialog-dismiss convention used by
 * the rest of the app (Modal/Lightbox) and erring against committing audio to the
 * STT vendor on a stray keypress. Background scroll is locked while open.
 */
export function RecordingOverlay({
  onStop,
  onCancel,
  stream = null,
}: {
  onStop: () => void;
  onCancel: () => void;
  /** The live capture stream, fed to the level meter so it tracks the real mic. */
  stream?: MediaStream | null;
}) {
  const [seconds, setSeconds] = useState(0);

  // Tick the elapsed readout once per second.
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Escape discards (safer than committing to STT on a stray key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Lock background scroll while the overlay is open; restore the prior value.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Recording voice message" className="fixed inset-0 z-50">
      {/* The whole surface is the stop target. */}
      <button
        type="button"
        onClick={onStop}
        aria-label="Stop and transcribe"
        className="absolute inset-0 flex h-full w-full flex-col items-center justify-center gap-6 bg-[var(--sparrow-bg)] px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center"
      >
        <span
          aria-hidden="true"
          className="flex h-28 w-28 items-center justify-center rounded-full bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)] ring-4 ring-[var(--sparrow-accent)] motion-safe:animate-pulse motion-reduce:animate-none"
        >
          <Mic size={56} />
        </span>
        {/* Live level meter — driven by the real mic signal so the speaker can
            see capture is working. Degrades to static bars without Web Audio. */}
        <LevelMeter stream={stream} />
        <span
          role="timer"
          aria-live="polite"
          className="mono text-4xl font-semibold tabular-nums text-[var(--sparrow-text)]"
        >
          {formatElapsed(seconds)}
        </span>
        <span className="text-lg font-medium text-[var(--sparrow-text)]">Tap anywhere to stop</span>
        <span className="max-w-xs text-sm text-[var(--sparrow-muted)]">
          Recording… your words become editable text in the composer.
        </span>
      </button>

      {/* Clearly separated secondary control: discard without transcribing. Sits
          above the big target (higher z-index; sibling, not nested — buttons can't
          nest), so a tap here cancels rather than stops. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        aria-label="Cancel recording"
        className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
      >
        <X size={16} aria-hidden="true" /> Cancel
      </button>
    </div>,
    document.body,
  );
}
