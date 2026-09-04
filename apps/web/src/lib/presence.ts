import type { PresenceChangedEvent } from '@sparrow/common-types';

/**
 * Client-side model of the presence axis (server-derived; see **Presence** in
 * SPEC v3). Online-ness is a plain `Set<string>` of MEMBER ids so it is trivial
 * to hydrate from `GET /status` (`presence.online`) and reduce over
 * `presence.changed` SSE events. The busy/working axis lives separately in
 * {@link ./status.ts}; a member glyph composes the two.
 */

/** A member counts as "recently active" if seen within this window (not online). */
export const RECENT_ACTIVE_MS = 5 * 60_000;

/** The presence axis rendered as the glyph's dot fill. */
export type PresenceDot = 'online' | 'active' | 'offline';

/** Reduce a `presence.changed` event into the online-id set (immutably). */
export function applyPresenceEvent(
  online: ReadonlySet<string>,
  ev: PresenceChangedEvent,
): Set<string> {
  const next = new Set(online);
  if (ev.state === 'online') next.add(ev.member.id);
  else next.delete(ev.member.id);
  return next;
}

/**
 * The presence dot for one member: solid green when online (holds a live
 * `/events` stream), a dim/hollow "active" when `lastSeenAt` is within
 * {@link RECENT_ACTIVE_MS} (but not online), grey otherwise.
 */
export function presenceDot(
  isOnline: boolean,
  lastSeenAt: string | null,
  nowMs: number,
): PresenceDot {
  if (isOnline) return 'online';
  if (!lastSeenAt) return 'offline';
  const then = Date.parse(lastSeenAt);
  if (!Number.isNaN(then) && nowMs - then <= RECENT_ACTIVE_MS) return 'active';
  return 'offline';
}
