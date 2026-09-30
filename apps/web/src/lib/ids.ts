/**
 * The id ⇄ URL boundary (v3). Wire/database ids carry a type prefix (`org_`,
 * `room_`, `agt_`); browser URLs show them BARE — the address bar reads
 * `/org/aPx7bDQoNrxk/rooms/V1StGXR8z5jd`. This module is the ONE place that
 * strips prefixes for links and restores them for API calls; every route, link,
 * redirect, and `navigate` goes through the path builders here, and every
 * `useParams` read is restored with {@link wire}. Ids are opaque to callers —
 * we only add/remove the known leading `{kind}_` token.
 */

import { matchPath } from 'react-router-dom';

const PREFIX = { org: 'org_', room: 'room_', agent: 'agt_' } as const;
export type IdKind = keyof typeof PREFIX;

/** Strip the wire prefix for display in a URL (`org_abc` → `abc`). */
export function bare(kind: IdKind, wireId: string): string {
  const p = PREFIX[kind];
  return wireId.startsWith(p) ? wireId.slice(p.length) : wireId;
}

/** Restore the wire prefix from a bare URL id (`abc` → `org_abc`). */
export function wire(kind: IdKind, bareId: string): string {
  const p = PREFIX[kind];
  return bareId.startsWith(p) ? bareId : p + bareId;
}

/* ---- Scoped mode ------------------------------------------------------- */

/**
 * Whether the SPA is running SCOPED to a single org (host `<slug><suffix>` or a
 * `/orgs/<slug>` path prefix). In scoped mode the org UI mounts WITHOUT the
 * `/org/:orgId` segment — react-router's basename (`/orgs/<slug>` or `/`) already
 * carries the scope — so the path builders below drop that segment. Unscoped
 * (the default), they emit the classic `/org/:orgId/…` URLs unchanged.
 *
 * A module singleton because scope is fixed for the page's lifetime; set ONCE
 * during boot (see App) before any link renders.
 */
let scoped = false;

/** Set (idempotently) whether the app is org-scoped. */
export function setScopedMode(value: boolean): void {
  scoped = value;
}

/** Whether the app is currently org-scoped. */
export function isScopedMode(): boolean {
  return scoped;
}

/* ---- Path builders (all produce bare-id URLs) ------------------------- */

/** The org-relative base: empty in scoped mode, `/org/:orgId` (bare) otherwise. */
function orgBase(orgWireId: string): string {
  return scoped ? '' : `/org/${bare('org', orgWireId)}`;
}

/** `/org/:orgId` (bare), optionally with a sub-path (must start with `/`). */
export function orgPath(orgWireId: string, sub = ''): string {
  return `${orgBase(orgWireId)}${sub}` || '/';
}

/** The org's workspace/broadcast conversation for one room. */
export function roomPath(orgWireId: string, roomWireId: string): string {
  return `${orgBase(orgWireId)}/rooms/${bare('room', roomWireId)}`;
}

/** A room's settings page. */
export function roomSettingsPath(orgWireId: string, roomWireId: string): string {
  return `${roomPath(orgWireId, roomWireId)}/settings`;
}

/** An agent's profile page. */
export function agentProfilePath(orgWireId: string, agentWireId: string): string {
  return `${orgBase(orgWireId)}/agents/${bare('agent', agentWireId)}`;
}

/**
 * An agent's profile page at a given tab. Tabs are a QUERY parameter, not a path
 * segment, so every agent link stays one route and `?tab=` is a view preference:
 * `/org/:orgId/agents/:agentId?tab=email`.
 */
export function agentTabPath(
  orgWireId: string,
  agentWireId: string,
  tab: 'overview' | 'activity' | 'email',
): string {
  const base = agentProfilePath(orgWireId, agentWireId);
  return tab === 'overview' ? base : `${base}?tab=${tab}`;
}

/**
 * The deep link into an agent's Email section AT ONE THREAD — the only place a
 * multi-party thread is fully navigable, and where an email card's "Open thread"
 * points. Thread ids have no URL-bare form (they are not an `org_`/`room_`/`agt_`
 * kind), so the wire id rides the query verbatim.
 */
export function agentEmailThreadPath(
  orgWireId: string,
  agentWireId: string,
  threadId: string,
): string {
  return `${agentProfilePath(orgWireId, agentWireId)}?tab=email&thread=${encodeURIComponent(threadId)}`;
}

/** The org admin page (owners/admins). */
export function orgAdminPath(orgWireId: string): string {
  return orgPath(orgWireId, '/admin');
}

/* ---- Active-room matching --------------------------------------------- */

/**
 * The active room's WIRE id from a router pathname, matching both the unscoped
 * `/org/:orgId/rooms/:roomId(/settings)` and the scoped `/rooms/:roomId(/settings)`
 * shapes (react-router strips the basename, so scoped paths arrive prefix-less).
 * Null when no room is open.
 */
export function activeRoomIdFromPath(pathname: string): string | null {
  const bareId =
    matchPath('/org/:orgId/rooms/:roomId', pathname)?.params.roomId ??
    matchPath('/org/:orgId/rooms/:roomId/settings', pathname)?.params.roomId ??
    matchPath('/rooms/:roomId', pathname)?.params.roomId ??
    matchPath('/rooms/:roomId/settings', pathname)?.params.roomId ??
    null;
  return bareId ? wire('room', bareId) : null;
}
