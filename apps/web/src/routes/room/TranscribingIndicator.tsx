/**
 * The in-flight "Transcribing…" affordance shown while a stopped recording is
 * being turned into text by the STT vendor (the seconds between stop and the
 * transcript arriving). Three staggered dots animate under `motion-safe` and
 * freeze under `prefers-reduced-motion`; the `role="status"` label carries the
 * accessible signal so the motion is purely decorative.
 */
export function TranscribingIndicator() {
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="transcribing-indicator"
      className="mt-1 inline-flex w-full items-center gap-2 text-xs text-[var(--sparrow-muted)]"
    >
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-[var(--sparrow-accent)] motion-safe:animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
      Transcribing…
    </span>
  );
}
