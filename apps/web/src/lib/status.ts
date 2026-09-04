import type { MemberStatus, StatusChangedEvent } from '@sparrow/common-types';

/**
 * Client-side model of active member statuses (the "working indicator"). Kept
 * as a plain map so it is trivial to reduce over SSE events and unit-test. Every
 * status here is already visible to the caller (the server only hydrates and
 * streams room-wide statuses, ones scoped to the caller, and the caller's own).
 */
export interface ActiveStatus {
  memberId: string;
  displayName: string;
  note: string | null;
  /** Recipient the status is scoped to, or null for room-wide. */
  toId: string | null;
  /** When the current status text was set, epoch ms — for honest staleness display. */
  sinceAtMs: number;
  /** A sticky status has no TTL — it never self-expires client-side (`expiresAtMs` is Infinity). */
  sticky: boolean;
  /** Absolute expiry, epoch milliseconds (`Infinity` for a sticky status). */
  expiresAtMs: number;
}

/** Statuses keyed by `${memberId} ${toId ?? ''}` so scoped + room-wide coexist. */
export type StatusMap = Record<string, ActiveStatus>;

export function statusKey(memberId: string, toId: string | null): string {
  return `${memberId} ${toId ?? ''}`;
}

function fromMemberStatus(s: MemberStatus): ActiveStatus {
  return {
    memberId: s.memberId,
    displayName: s.displayName,
    note: s.note,
    toId: s.to?.id ?? null,
    sinceAtMs: Date.parse(s.sinceAt),
    sticky: s.sticky,
    // Sticky statuses carry no wire expiry; they never self-expire client-side.
    expiresAtMs: s.expiresAt ? Date.parse(s.expiresAt) : Infinity,
  };
}

/** Build a fresh map from a `GET /status` hydrate payload. */
export function hydrateStatuses(list: MemberStatus[]): StatusMap {
  const map: StatusMap = {};
  for (const s of list) {
    const a = fromMemberStatus(s);
    map[statusKey(a.memberId, a.toId)] = a;
  }
  return map;
}

/** Reduce a `status.changed` SSE event into the map (idle/expiry removes). */
export function applyStatusEvent(map: StatusMap, ev: StatusChangedEvent): StatusMap {
  const key = statusKey(ev.member.id, ev.to?.id ?? null);
  const next = { ...map };
  // Only `idle` removes. A sticky `working` carries a null `expiresAt` yet must
  // stay in the map (it lives until an explicit idle or the server clears it).
  if (ev.state === 'idle') {
    delete next[key];
    return next;
  }
  next[key] = {
    memberId: ev.member.id,
    displayName: ev.member.displayName,
    note: ev.note,
    toId: ev.to?.id ?? null,
    sinceAtMs: ev.sinceAt ? Date.parse(ev.sinceAt) : Date.now(),
    sticky: ev.sticky,
    expiresAtMs: ev.expiresAt ? Date.parse(ev.expiresAt) : Infinity,
  };
  return next;
}

/** Drop statuses whose TTL has passed (client-side backup for missed idle events). */
export function pruneExpired(map: StatusMap, nowMs: number): StatusMap {
  let changed = false;
  const next: StatusMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (v.expiresAtMs > nowMs) next[k] = v;
    else changed = true;
  }
  return changed ? next : map;
}

/**
 * The active status a conversation partner is advertising to the caller —
 * room-wide or scoped specifically to the caller. Prefers latest-expiring.
 */
export function statusForPartner(
  map: StatusMap,
  selfId: string,
  partnerId: string,
  nowMs: number,
): ActiveStatus | null {
  let best: ActiveStatus | null = null;
  for (const v of Object.values(map)) {
    if (v.memberId !== partnerId) continue;
    if (v.expiresAtMs <= nowMs) continue;
    if (v.toId !== null && v.toId !== selfId) continue;
    if (!best || v.expiresAtMs > best.expiresAtMs) best = v;
  }
  return best;
}

/**
 * The active working statuses to surface in a PROJECT room's composer area: one
 * entry per member (latest-expiring wins when a member holds both a room-wide and
 * a caller-scoped status), the caller's own excluded, expired dropped. Ordered
 * deterministically (display name, then id) so the stacked bubbles don't reshuffle
 * on each tick. The map already only contains statuses the caller may see, so no
 * further visibility filtering is needed.
 */
export function activeRoomStatuses(map: StatusMap, selfId: string, nowMs: number): ActiveStatus[] {
  const best = new Map<string, ActiveStatus>();
  for (const v of Object.values(map)) {
    if (v.memberId === selfId) continue;
    if (v.expiresAtMs <= nowMs) continue;
    const cur = best.get(v.memberId);
    if (!cur || v.expiresAtMs > cur.expiresAtMs) best.set(v.memberId, v);
  }
  return [...best.values()].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.memberId.localeCompare(b.memberId),
  );
}

/** Ids of members that currently hold any active status (for roster markers). */
export function membersWithStatus(map: StatusMap, nowMs: number): Set<string> {
  const ids = new Set<string>();
  for (const v of Object.values(map)) {
    if (v.expiresAtMs > nowMs) ids.add(v.memberId);
  }
  return ids;
}
