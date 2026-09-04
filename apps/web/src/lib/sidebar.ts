import type { MeRoom, SidebarHuman, VisibilityAgent } from '@sparrow/common-types';
import type { RoomBadges } from './roomStreams.js';
import { readAvatarUrl } from './avatar.js';

/**
 * Sidebar derivation (v3). The three sections come from ROOM-INDEPENDENT,
 * org-scoped sources — the active room NEVER shapes these lists (the bug the v2
 * `deriveAgentEntries` active-room source caused; see scenario 110):
 *
 *  - HUMANS  ← `GET /orgs/:orgId/me/humans` (principal-level presence)
 *  - AGENTS  ← `GET /orgs/:orgId/me/agents` (the visibility list)
 *  - ROOMS   ← `GET /me/rooms?org=` (project rooms; DM rooms are hidden)
 *
 * Live signals (unread, busy) are layered on from per-room SSE badges: a
 * principal's DM room (if one exists) supplies its unread + working state,
 * mapped by counterpart id. Presence comes from the shared principal-keyed
 * store snapshot (see {@link ../lib/presenceStore}) — the SAME truth the chat
 * header renders — falling back to the source's room-independent `online` flag
 * for principals the store has not learned yet.
 */

/** A HUMANS/AGENTS row: identity + live signals + where a click routes. */
export interface PrincipalEntry {
  key: string;
  /** `usr_...` or `agt_...`. */
  principalId: string;
  displayName: string;
  /**
   * The human's uploaded/provider/gravatar image, or null (→ generated avatar).
   * Always null for agents, which render the procedural bird instead.
   */
  avatarUrl: string | null;
  /** Presence dot — principal-level, room-independent (from the source). */
  online: boolean;
  /**
   * Offline AND never active: no live stream and a null `lastSeenAt` (e.g. an org
   * member just added by email who has not signed in / shared a room). Rendered
   * dimmed so "exists but never here" reads apart from "offline but has been".
   */
  neverSeen: boolean;
  /** Busy ring — an active working status in the principal's DM room. */
  busy: boolean;
  /**
   * Unread attributed to this principal — for an agent this is the FOLD (chat +
   * email); see {@link AgentEntry.emailUnread}.
   */
  unread: number;
  /** The existing DM room id, or null (click ensures one lazily). */
  dmRoomId: string | null;
}

/** An AGENTS row plus governance affordances (owned vs shared). */
export interface AgentEntry extends PrincipalEntry {
  agentId: string;
  /** True when the caller owns the agent (vs shared-to-them). */
  owned: boolean;
  /** The owner's display name (shown on shared agents). */
  ownerName: string;
  /**
   * The agent's ORG-VISIBLE role title (v4), or `null` when it has no role.
   * Carried so the sidebar row can fold it into its tooltip; the private role
   * instructions never reach this derivation.
   */
  roleTitle: string | null;
  /**
   * The agent's derived email address (v4), or `null` when the email medium is
   * off for this instance — which is what the API sends today. Carried here so
   * the email wave can render it behind `capabilities.email` (render is gated,
   * discovery never is) without another pass through this derivation. NOTHING
   * renders it yet: with the medium off there is no address to show.
   */
  emailAddress: string | null;
  /** The chat half of the {@link PrincipalEntry.unread} fold (the DM room). */
  chatUnread: number;
  /**
   * The email half of the fold: unread email involving this agent (v4). SPEC
   * *Web UI → Sidebar*: "Unread email folds into the agent's existing unread
   * badge in AGENTS: one number per agent = unread chat + unread email involving
   * that agent". Fed from `VisibilityAgent.emailUnreadCount` on the agents list
   * (via `WorkspaceValue.emailUnread`), which the server sends for OWNED agents
   * only. Zero for an agent shared to the caller, and zero everywhere when the
   * email medium is off — both of which leave the badge at exactly v3's number.
   */
  emailUnread: number;
}

/** A ROOMS row (project rooms only). */
export interface RoomEntry {
  roomId: string;
  name: string;
  unread: number;
  busy: boolean;
  archivedAt: string | null;
}

/** A DM room and its live badges. */
interface DmEntry {
  roomId: string;
  badges: RoomBadges | undefined;
}

/** counterpartPrincipalId → its DM room + live badges. */
export type DmMap = Map<string, DmEntry>;

/** Build the map from DM memberships (counterpart principal id → room). */
export function buildDmMap(rooms: MeRoom[], badges: Record<string, RoomBadges>): DmMap {
  const map: DmMap = new Map();
  for (const r of rooms) {
    if (r.room.kind !== 'dm' || !r.room.counterpart) continue;
    map.set(r.room.counterpart.id, {
      roomId: r.room.id,
      badges: badges[r.room.id],
    });
  }
  return map;
}

function badgeSignals(badges: RoomBadges | undefined): { unread: number; busy: boolean } {
  if (!badges) return { unread: 0, busy: false };
  const unread = Object.values(badges.unread).reduce((a, b) => a + b, 0);
  const busy = Object.keys(badges.statuses).length > 0;
  return { unread, busy };
}

/** The shared-store presence map (principal id → online); see lib/presenceStore. */
export type PresenceSnapshot = ReadonlyMap<string, boolean>;

const NO_PRESENCE: PresenceSnapshot = new Map();

/**
 * Sort: alphanumerical by display name ONLY — case-insensitive and numeric-aware
 * (`bot-2` before `bot-10`). Live signals (unread, presence) deliberately do NOT
 * participate: signal-driven ordering made rows jump around as SSE events landed.
 */
function byName<T extends { displayName: string }>(a: T, b: T): number {
  return a.displayName.localeCompare(b.displayName, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function humanEntries(
  humans: SidebarHuman[],
  dm: DmMap,
  presence: PresenceSnapshot = NO_PRESENCE,
): PrincipalEntry[] {
  return humans
    .map((h): PrincipalEntry => {
      const d = dm.get(h.human.id);
      const sig = badgeSignals(d?.badges);
      const online = presence.get(h.human.id) ?? h.online;
      return {
        key: `human:${h.human.id}`,
        principalId: h.human.id,
        displayName: h.human.displayName,
        avatarUrl: readAvatarUrl(h.human),
        online,
        neverSeen: !online && h.lastSeenAt === null,
        busy: sig.busy,
        unread: sig.unread,
        dmRoomId: d?.roomId ?? null,
      };
    })
    .sort(byName);
}

/**
 * AGENTS rows. `emailUnread` (agentId → count, derived from each visibility
 * entry's owner-only `emailUnreadCount`) folds into each row's badge, so an
 * owner sees ONE "this agent needs you" number. An agent missing from the map —
 * shared to the caller, or any agent on an instance with `capabilities.email`
 * false — keeps exactly v3's chat count, as does omitting the map entirely.
 *
 * Approvals NEVER count here: they belong to the top-nav pending pill (SPEC
 * *Web UI → Sidebar*).
 *
 * `presence` sits in the same slot it does on {@link humanEntries} — the shared
 * principal-keyed store snapshot, overriding the source's room-independent
 * `online` flag. Neither the fold nor presence affects ROW ORDER: rows are sorted
 * by name alone (see {@link byName}).
 */
export function agentEntries(
  agents: VisibilityAgent[],
  dm: DmMap,
  selfHumanId: string | null,
  presence: PresenceSnapshot = NO_PRESENCE,
  emailUnread: Record<string, number> = {},
): AgentEntry[] {
  return agents
    .map((a): AgentEntry => {
      const d = dm.get(a.agent.id);
      const sig = badgeSignals(d?.badges);
      const mail = emailUnread[a.agent.id] ?? 0;
      return {
        key: `agent:${a.agent.id}`,
        principalId: a.agent.id,
        agentId: a.agent.id,
        displayName: a.agent.name,
        avatarUrl: null, // agents render the procedural bird, never an image
        online: presence.get(a.agent.id) ?? a.agent.online,
        neverSeen: false,
        busy: sig.busy,
        chatUnread: sig.unread,
        emailUnread: mail,
        unread: sig.unread + mail,
        dmRoomId: d?.roomId ?? null,
        owned: selfHumanId !== null && a.owner.id === selfHumanId && a.sharedBy === null,
        ownerName: a.owner.displayName,
        roleTitle: a.agent.roleTitle,
        emailAddress: a.agent.emailAddress,
      };
    })
    .sort(byName);
}

/* -------------------------------------------------------------------------- */
/* Shell chrome copy — the two folded counts, broken down IN TEXT             */
/* -------------------------------------------------------------------------- */

/** `n thing` / `n things` — the counts here are never large enough to format. */
function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/**
 * The AGENTS badge tooltip: "3 unread — 1 message, 2 emails" (SPEC *Web UI →
 * Sidebar*). The v3 rule holds — a tooltip always carries its state in text —
 * so the fold is never a bare number the reader has to guess at. `null` when
 * nothing is unread (no badge renders either).
 */
export function unreadTooltip(chat: number, email: number): string | null {
  const total = chat + email;
  if (total <= 0) return null;
  const parts: string[] = [];
  if (chat > 0) parts.push(plural(chat, 'message'));
  if (email > 0) parts.push(plural(email, 'email'));
  return `${total} unread — ${parts.join(', ')}`;
}

/**
 * The top-nav pending pill's tooltip: "2 waiting — 1 enrollment, 1 email" (SPEC
 * *Web UI → Top-nav pending pill*). ONE number, one destination; the split lives
 * in the tooltip text. `null` when nothing is pending (no pill renders either).
 *
 * With `capabilities.email` false the pill counts enrollments only and keeps
 * v3's wording instead — this function is not used there.
 */
export function pendingTooltip(enrollments: number, emails: number): string | null {
  const total = enrollments + emails;
  if (total <= 0) return null;
  const parts: string[] = [];
  if (enrollments > 0) parts.push(plural(enrollments, 'enrollment'));
  if (emails > 0) parts.push(plural(emails, 'email'));
  return `${total} waiting — ${parts.join(', ')}`;
}

/** Project (non-DM) rooms as ROOMS rows, with broadcast unread + busy. */
export function roomEntries(rooms: MeRoom[], badges: Record<string, RoomBadges>): RoomEntry[] {
  return rooms
    .filter((r) => r.room.kind === 'project')
    .map((r): RoomEntry => {
      const b = badges[r.room.id];
      return {
        roomId: r.room.id,
        name: r.room.name,
        unread: b?.unread['all'] ?? 0,
        busy: b ? Object.keys(b.statuses).length > 0 : false,
        archivedAt: r.room.archivedAt,
      };
    });
}
