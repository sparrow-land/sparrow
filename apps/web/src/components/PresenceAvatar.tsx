import type { PresenceDot } from '../lib/presence.js';
import { Avatar } from './Avatar.js';
import { PresenceGlyph } from './StatusIndicator.js';

/**
 * THE avatar + status-dot cluster: the identity {@link Avatar} with the
 * presence/busy {@link PresenceGlyph} tucked into its bottom-right corner —
 * 1px inset, ringed by a 2px panel-coloured halo so the dot reads against any
 * avatar art.
 *
 * Every surface that pairs an avatar with a live presence dot (sidebar
 * HUMANS/AGENTS rows, the DM chat header, the project-room member strip)
 * renders THIS component, so the dot geometry is identical everywhere by
 * construction. Do not re-compose Avatar + PresenceGlyph inline — per-surface
 * copies are exactly how the header grew a fatter ring than the sidebar.
 */
export function PresenceAvatar({
  kind,
  id,
  displayName,
  avatarUrl = null,
  size = 24,
  presence,
  busy,
  activeAgo,
  className = '',
}: {
  kind: 'human' | 'agent';
  /** Stable principal id (`usr_…`/`agt_…`) — seeds the deterministic avatar. */
  id: string;
  displayName: string;
  /** Human image URL; ignored for agents (they render the procedural bird). */
  avatarUrl?: string | null;
  /** Avatar pixel size; the dot geometry is size-independent. */
  size?: number;
  presence: PresenceDot;
  busy: boolean;
  /** Short "3m ago" label folded into the glyph tooltip for the active state. */
  activeAgo?: string;
  /** Extra classes for the wrapper (layout concerns of the host surface only). */
  className?: string;
}) {
  return (
    <span className={`relative inline-flex shrink-0 ${className}`.trim()}>
      <Avatar kind={kind} id={id} displayName={displayName} avatarUrl={avatarUrl} size={size} />
      <span className="absolute -bottom-px -right-px inline-flex rounded-full ring-2 ring-[var(--sparrow-panel)]">
        <PresenceGlyph presence={presence} busy={busy} activeAgo={activeAgo} />
      </span>
    </span>
  );
}
