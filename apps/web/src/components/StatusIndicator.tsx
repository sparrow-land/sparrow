import type { PresenceDot } from '../lib/presence.js';
import { formatCompactAge } from '../lib/time.js';

/** A working status older than this reads as stale, so we surface its age. */
const STALE_AFTER_MS = 120_000;

/**
 * The age suffix ("25m") for a working status whose text was set more than
 * {@link STALE_AFTER_MS} ago — so a long-running (esp. sticky) status reads
 * honestly rather than looking freshly-set forever. Empty when fresh/unknown.
 */
function staleAge(sinceMs?: number, nowMs?: number): string {
  if (sinceMs === undefined || !Number.isFinite(sinceMs)) return '';
  const now = nowMs ?? Date.now();
  if (now - sinceMs < STALE_AFTER_MS) return '';
  return formatCompactAge(sinceMs, now);
}

/**
 * The "working — {note}" text shown in a conversation header next to the
 * partner's presence/busy glyph. The busy axis is carried by the glyph's
 * animated ring (see {@link PresenceGlyph}); this is just the label + optional
 * note (monospace). No glyph of its own — the ⚙ marker was replaced by the
 * ring. When the status text is stale (older than ~2m — common for a sticky
 * long-task status), a muted age suffix ("working — 25m") is appended.
 */
export function StatusIndicator({
  note,
  label,
  sinceMs,
  nowMs,
}: {
  note: string | null;
  label?: string;
  /** When the current status text was set (epoch ms) — drives the staleness suffix. */
  sinceMs?: number;
  /** "Now" for the age math (a ticking clock in the room view); defaults to Date.now(). */
  nowMs?: number;
}) {
  const age = staleAge(sinceMs, nowMs);
  const core = note ? `working — ${note}` : 'working';
  const aria = age ? `${core} — ${age}` : core;
  // With a label (project rooms) the note may be long and shares the row with the
  // member name, so it truncates within a min-width-0 flex. Without a label (DMs)
  // the markup is byte-for-byte the original — no extra layout classes.
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs text-[var(--sparrow-accent)]${label ? ' min-w-0' : ''}`}
      role="status"
      aria-label={label ? `${label} — ${aria}` : aria}
    >
      {label ? <span className="shrink-0 font-medium text-[var(--sparrow-text)]">{label}</span> : null}
      <span>working</span>
      {note ? (
        <>
          <span aria-hidden="true">—</span>
          <span className={label ? 'mono min-w-0 truncate' : 'mono'}>{note}</span>
        </>
      ) : null}
      {age ? (
        <>
          <span aria-hidden="true">—</span>
          <span className="shrink-0 text-[var(--sparrow-muted)]">{age}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * iMessage-style "working" indicator for the BOTTOM of a conversation (just above
 * the composer, in the message area): an animated three-dot typing bubble plus the
 * {@link StatusIndicator} label. The dots bounce (staggered) under `motion-safe`
 * and freeze under `prefers-reduced-motion`; the label carries the accessible
 * `role="status"` + `aria-label`, so the animation is decorative (aria-hidden).
 *
 * `label` names the working member — used in PROJECT rooms, where several agents
 * can be working at once, so each bubble must say WHO. In a DM the partner is
 * implicit, so no label is passed and the bubble stays name-less (byte-for-byte
 * the original DM rendering).
 */
export function WorkingBubble({
  note,
  label,
  sinceMs,
  nowMs,
}: {
  note: string | null;
  label?: string;
  /** When the current status text was set (epoch ms) — drives the staleness suffix. */
  sinceMs?: number;
  /** "Now" for the age math; defaults to Date.now(). */
  nowMs?: number;
}) {
  // A label (project rooms) constrains the row so a long note can truncate; DMs
  // pass no label and render exactly as before (no min-w-0 / shrink-0).
  return (
    <div className={`flex items-center gap-2${label ? ' min-w-0' : ''}`}>
      <span
        aria-hidden="true"
        className={`inline-flex items-center gap-1 rounded-2xl rounded-bl-sm border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3 py-2${label ? ' shrink-0' : ''}`}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-[var(--sparrow-muted)] motion-safe:animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
      <StatusIndicator note={note} label={label} sinceMs={sinceMs} nowMs={nowMs} />
    </div>
  );
}

const DOT_CLASS: Record<PresenceDot, string> = {
  // Muted terminal green (the same token as the human kind badge), not neon.
  online: 'bg-[var(--sparrow-good)]',
  // Dim/hollow — recently active but not holding a live stream.
  active: 'border border-[var(--sparrow-muted)] bg-transparent',
  // Grey — offline.
  offline: 'bg-[var(--sparrow-faint)]',
};

function dotWord(presence: PresenceDot, activeAgo?: string): string {
  if (presence === 'online') return 'online';
  if (presence === 'active') return activeAgo ? `active ${activeAgo}` : 'active';
  return 'offline';
}

/**
 * One composed glyph per member (sidebar list + conversation header) rendering
 * BOTH axes (SPEC "Presence & busy glyph"): the inner dot's fill is presence
 * (online/active/offline), the animated outer ring is the self-reported busy
 * axis (an active working status visible to the caller). The ring freezes under
 * `prefers-reduced-motion`; the full state is always in the label/tooltip so
 * colour is never the only signal.
 */
export function PresenceGlyph({
  presence,
  busy,
  activeAgo,
}: {
  presence: PresenceDot;
  busy: boolean;
  /** Short "3m ago" label folded into the tooltip for the active state. */
  activeAgo?: string;
}) {
  const label = busy ? `${dotWord(presence, activeAgo)} + working` : dotWord(presence, activeAgo);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center"
    >
      {busy && (
        <span
          aria-hidden="true"
          className="absolute inset-[-3px] rounded-full border border-[var(--sparrow-accent)] motion-safe:animate-pulse motion-reduce:animate-none"
        />
      )}
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[presence]}`} />
    </span>
  );
}

/**
 * Room-level "any member is busy" marker for a room row. Presence is a
 * per-member concept, so a room shows only the busy ring (same any-member rule
 * as before, rendered with the new glyph).
 */
export function RoomBusyGlyph() {
  return (
    <span
      role="img"
      aria-label="working"
      title="working"
      className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="absolute inset-[-3px] rounded-full border border-[var(--sparrow-accent)] motion-safe:animate-pulse motion-reduce:animate-none"
      />
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--sparrow-accent)]" />
    </span>
  );
}
