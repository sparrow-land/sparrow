import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ActivityAppendedEvent,
  EmailApprovalItem,
  EnrollmentSummary,
  MeRoom,
  MemberJoinedEvent,
  MemberUpdatedEvent,
  PresenceChangedEvent,
  PresenceState,
  RoomInvitation,
  RoomUpdatedEvent,
  SidebarHuman,
  VisibilityAgent,
} from '@sparrow/common-types';
import type { PrincipalEvent } from '@sparrow/client';
import { api } from './client.js';
import { roomStreams, type RoomBadges } from './roomStreams.js';
import { presenceStore } from './presenceStore.js';
import { useMeEventStream } from './meEvents.js';
import { useAuth } from './auth.js';
import { useCapabilities } from './capabilities.js';
import { useOrg } from './org.js';

// Wake-reconcile throttle (leading edge), mirroring the Room view's: bursty
// visibility/focus/online signals collapse to one refetch pass.
const WAKE_RECONCILE_THROTTLE_MS = 5_000;

/**
 * Workspace data for one org: the three ROOM-INDEPENDENT sidebar sources
 * (humans, agents, rooms), pending room invitations + enrollment-approval count,
 * and live badge state routed out of the app’s one multiplexed SSE stream.
 *
 * This is the ONE store every workspace surface reads: the sidebar's three
 * sections, the top-nav crumb, the DM/conversation header, the pending pill and
 * the badges all render from it. Its live input is the app's SINGLE `/me/events`
 * connection, read through two subscribers:
 *
 *  - {@link roomStreams}, which routes the wrapped ROOM events back out per room
 *    for unread/working/presence badges (it opens no connection of its own —
 *    issue #54);
 *  - this provider's own subscription (via {@link useMeEventStream}), routed by
 *    {@link applyPrincipalEvent} — every event name the wire defines either
 *    patches a source IN PLACE or refetches exactly the source it invalidates
 *    (see {@link ME_EVENT_ROUTING}).
 *
 * Because those surfaces share this store rather than fetching their own copies,
 * one event moves all of them in the same render — the property a rename needs,
 * and the one whose absence made the sidebar, crumb and header go stale while
 * the message pane updated. Nothing here needs a page reload to become correct.
 */
export interface WorkspaceValue {
  humans: SidebarHuman[];
  agents: VisibilityAgent[];
  rooms: MeRoom[];
  invitations: RoomInvitation[];
  /**
   * Pending enrollments arriving through the caller's OWN invites — the live
   * source behind the approvals pill AND the invite modal's approvals list.
   * Refreshed on every `enrollment.requested` / `enrollment.resolved` event.
   */
  enrollments: EnrollmentSummary[];
  /** Convenience count of {@link enrollments} (the approvals pill). */
  approvals: number;
  /**
   * Pending email approvals in THIS org for agents the caller OWNS — the other
   * half of the pending pill (SPEC *Web UI → Top-nav pending pill*: "counting
   * pending enrollments from the caller's OWN invites **plus** email approvals
   * for agents the caller OWNS"). Always empty with `capabilities.email` false,
   * so the pill is exactly v3's there. `GET /orgs/:orgId/email/approvals` returns
   * EVERY agent's approvals to an org owner/admin, so the filter to owned agents
   * happens here — org-wide review lives in org admin, not the personal pill.
   */
  emailApprovals: EmailApprovalItem[];
  /**
   * agentId → unread EMAIL count, for the AGENTS badge fold (SPEC *Web UI →
   * Sidebar*).
   *
   * Derived from {@link VisibilityAgent.emailUnreadCount} on the agents list
   * itself, so the badge costs no extra request. That field is OWNER-ONLY: it
   * is `null` for an agent merely shared to the caller (mail is correspondence,
   * not room data) and `null` for everyone when the medium is off — and a
   * `null` is OMITTED here rather than folded in as a zero, so the map's keys
   * are exactly the agents whose mail the caller may count. With every count
   * null the badge is exactly v3's chat number.
   */
  emailUnread: Record<string, number>;
  /** Live per-room badges, keyed by roomId. */
  badges: Record<string, RoomBadges>;
  loading: boolean;
  reloadRooms(): Promise<MeRoom[]>;
  reloadHumans(): Promise<void>;
  reloadAgents(): Promise<void>;
  reloadInvitations(): Promise<void>;
  reloadApprovals(): Promise<void>;
  reloadEmailApprovals(): Promise<void>;
  /** Ensure (or reuse) the DM room with a principal; refreshes rooms; returns its id. */
  ensureDm(principalId: string): Promise<string>;
}

/** The refetchers the `/me/events` dispatcher drives (the sidebar's sources). */
export type PrincipalEventReloads = Pick<
  WorkspaceValue,
  | 'reloadHumans'
  | 'reloadAgents'
  | 'reloadRooms'
  | 'reloadInvitations'
  | 'reloadApprovals'
  | 'reloadEmailApprovals'
>;

/**
 * The IN-PLACE half of the routing table: mutations the store can make from the
 * event payload alone, with no request. Preferred over a refetch whenever the
 * frame already carries the data — it is both cheaper and atomic (every surface
 * reading the store moves in the same render, which is what a rename needs).
 */
export interface PrincipalEventPatches {
  /**
   * A principal's display name (and, for a human, effective avatar) changed.
   * Patches EVERY source that carries a copy: the HUMANS list, the AGENTS
   * visibility list, and each DM room's `counterpart` — which is what the
   * top-nav crumb and the DM header render.
   */
  renamePrincipal(principalId: string, displayName: string, avatarUrl: string | null): void;
  /** A room's name / archived state changed — patch the ROOMS source in place. */
  updateRoom(room: { id: string; name: string; archivedAt: string | null }): void;
  /** A live presence transition, for the shared principal-keyed presence store. */
  applyPresence(principalId: string | undefined, state: PresenceState): void;
}

/**
 * The COMPLETE routing table for `/me/events`, as documentation and as a test
 * fixture: every event name the wire defines maps to exactly one line here. A
 * value starting `ignored:` states WHY the workspace does nothing with it (it is
 * always because another live mechanism already owns that state) — silence has
 * to be a decision, not an omission, which is how the reported rename bug hid.
 *
 * `apps/web`'s table test asserts these keys are exactly the event names
 * `@sparrow/common-types` defines, so a new server event cannot ship without the
 * web deciding what it means.
 */
export const ME_EVENT_ROUTING: Record<string, string> = {
  'message.new': 'ignored: RoomStreams routes the wrapped frame into that room’s unread badge, without a refetch',
  'message.read': 'ignored: sender-side receipts, rendered by the active room view only',
  'message.clawback':
    'ignored: RoomStreams re-counts the room’s unread badge and the active room view drops the bubble, both off this same frame',
  'message.received': 'ignored: sender-side receipts, rendered by the active room view only',
  'member.joined':
    'refetch: rooms + humans + agents when the membership is ours, else the joiner’s list',
  'member.updated': 'store: rename/avatar patch across humans, agents and DM counterparts',
  'member.removed': 'refetch: rooms + humans + agents',
  'room.updated': 'store: patch the room row name + archived state',
  'status.changed': 'ignored: RoomStreams owns the working/busy glyph, per room',
  'presence.changed': 'store: feed the shared presence store, keyed by principal',
  'enrollment.requested': 'refetch: approvals',
  'enrollment.resolved': 'refetch: approvals',
  'room.invitation': 'refetch: invitations',
  'agent.shared': 'refetch: agents (a grant changes sharedBy/rooms/sharedWith, not just a name)',
  'agent.unshared': 'refetch: agents',
  'role.updated':
    'refetch: agents (fans out to every human who can SEE the agent — its org-visible roleTitle moved)',
  'activity.appended': 'refetch: agents, for an EMAIL entry only (a chat entry fires per message)',
  'dm.severed':
    'ignored: the agent↔agent DM oversight cards reload their own list off this frame; no sidebar row moves (the severed room is not ours)',
  'dm.allowed':
    'ignored: same as dm.severed — the oversight cards own this state, the sidebar has no row for it',
  'email.received': 'refetch: agents (emailUnreadCount moved)',
  'email.sent': 'refetch: agents (emailUnreadCount moved)',
  'email.quarantined': 'refetch: emailApprovals + agents',
  'email.held': 'refetch: emailApprovals + agents',
  'email.resolved': 'refetch: emailApprovals + agents',
  'email.rejected':
    'ignored: a refusal is a security record — nothing was delivered, so no count moved',
  'replay.gap': 'refetch: every source (our cursor predates retention, so state is unknown)',
};

/**
 * Route ONE `/me/events` frame to the sources it invalidates. Pure over its
 * context (no React), so the routing table is unit-testable without a stream.
 *
 * **Forward compatibility.** `/me/events` is an ADDITIVE fan-in: v4 added the
 * unwrapped principal-level events (`activity.appended` and the email family)
 * and later versions will add more. An unrecognized event — or a recognized one
 * whose payload this client cannot read — is DATA, not a defect: it is ignored
 * silently, never thrown and never logged. Only the cases below are allowed to
 * touch state.
 */
export function applyPrincipalEvent(
  ev: PrincipalEvent,
  ctx: {
    reloads: PrincipalEventReloads;
    /** In-place store mutations (omitted by callers that only test refetches). */
    patches?: PrincipalEventPatches;
    /** Rooms already in the sidebar (a member.joined elsewhere means we gained one). */
    knownRoomIds: Set<string>;
    /** The caller's own principal id, when signed in. */
    meId: string | undefined;
  },
): void {
  const r = ctx.reloads;
  const p = ctx.patches;
  switch (ev.type) {
    case 'enrollment.requested':
    case 'enrollment.resolved':
      void r.reloadApprovals();
      break;
    // v4: the email approvals queue is live for whoever may act on it. The
    // events fan out to the owner AND the org's owners/admins; the pill's own
    // filter (agents the caller owns) is applied on the refetched queue. The
    // agents list is refetched too — it carries `emailUnreadCount`, and a
    // quarantine/hold/resolution moves what an agent has waiting.
    case 'email.quarantined':
    case 'email.held':
    case 'email.resolved':
      void r.reloadEmailApprovals();
      void r.reloadAgents();
      break;
    // Delivery and sending change the unread count but never the approvals
    // queue. These two are delivered to the AGENT principal, not the owning
    // human, so a human session will rarely see them — they are wired anyway
    // because they are cheap and exactly right for an agent-key session.
    case 'email.received':
    case 'email.sent':
      void r.reloadAgents();
      break;
    // The generic timeline event, gated HARD on the medium: a chat entry fires
    // on every message in every room the caller can see, and refetching the
    // agents list on each one is not a cost the sidebar may take.
    case 'activity.appended': {
      const entry = (ev.data as ActivityAppendedEvent | undefined)?.entry;
      if (entry?.medium === 'email') void r.reloadAgents();
      break;
    }
    case 'room.invitation':
      void r.reloadInvitations();
      break;
    case 'agent.shared':
    case 'agent.unshared':
    // A role change fans out to every human who can see the agent; the list
    // carries the org-visible roleTitle, so refetch it.
    case 'role.updated':
      void r.reloadAgents();
      break;
    case 'member.joined': {
      // The API guarantees a wrapped member.joined to the GAINING principal
      // when a membership appears (a counterpart ensured a DM, an invitation
      // was accepted, an add/approval). If it's for a room we don't know yet
      // — or the new member IS us — refetch the sidebar sources so the new
      // room/counterpart appears (and starts being tracked via the rooms
      // effect) without any manual reload. The stream itself already carries
      // the new room: the server recomputes membership on every emit.
      const roomId = ev.room?.id;
      const member = (ev.data as MemberJoinedEvent | undefined)?.member;
      const gained =
        !roomId || !ctx.knownRoomIds.has(roomId) || member?.principalId === ctx.meId;
      if (gained) {
        void r.reloadRooms();
        void r.reloadHumans();
        void r.reloadAgents();
        break;
      }
      // A room we ALREADY have gained someone else. Our own memberships did not
      // change, but the principal lists can: an agent whose sharing mode is
      // `room-members` becomes reachable to us the moment it joins a room we
      // are in, and the HUMANS source is scoped by shared rooms too. Membership
      // changes are rare — far rarer than messages — so refetching the one
      // affected list here costs nothing and closes a fetch-once hole.
      if (member?.kind === 'agent') void r.reloadAgents();
      else void r.reloadHumans();
      break;
    }
    /**
     * A principal was renamed (or a human's avatar changed): SPEC `PATCH /me` —
     * "propagates live (members render names live) and emits `member.updated` in
     * every room the principal inhabits". The frame carries `principalId` and
     * the new `displayName`, so this is an IN-PLACE patch, never a refetch: the
     * sidebar row, the top-nav crumb and the DM header all read workspace
     * sources, and they must move in the SAME render or the reader sees the
     * split that made this a bug report (only the message pane updating).
     *
     * A role change rides the same event and touches nothing here — the room's
     * own member roster owns roomRole, and re-writing an unchanged name is a
     * no-op by identity (see {@link renameInHumans} and friends).
     */
    case 'member.updated': {
      const m = (ev.data as MemberUpdatedEvent | undefined)?.member;
      if (m?.principalId && typeof m.displayName === 'string') {
        p?.renamePrincipal(m.principalId, m.displayName, m.avatarUrl ?? null);
      }
      break;
    }
    // The mirror of member.joined: a membership disappeared. Agents are
    // refetched too — a `room-members` agent stops being reachable when it (or
    // we) leaves the last shared room, and an agent DELETED by its owner leaves
    // its rooms this way, which is the only signal a viewer gets for it.
    case 'member.removed':
      void r.reloadRooms();
      void r.reloadHumans();
      void r.reloadAgents();
      break;
    /**
     * A room was renamed, archived or restored by ANY member. The payload is the
     * whole of what the sidebar row shows, so patch it in place — before this,
     * a coworker archiving a room left it in the wrong sidebar group until a
     * reload.
     *
     * **Two shapes, one route.** `room.updated` is the ONE event whose payload
     * has a top-level `room` key, and `/me/events` wraps room events by
     * splicing its own `room` ref into the same object — so on the fan-in the
     * payload's room WINS the key and the client hands it back as `ev.room`
     * with `ev.data.room` gone. (The wrapper ref would not have parsed as one
     * anyway: it carries `archivedAt` and no `orgId`/`kind`.) The API's own
     * `/rooms/:id/events` still delivers the payload intact. Read whichever
     * arrived — both carry exactly the id/name/archivedAt this needs — rather
     * than honoring the event on one transport only. The collision itself is an
     * API/client wire defect and is reported as such; this read is correct
     * either way it is settled.
     */
    case 'room.updated': {
      const wrapped = ev.room as { id?: string; name?: string; archivedAt?: string | null } | undefined;
      const d = (ev.data as RoomUpdatedEvent | undefined)?.room ?? wrapped;
      if (d?.id && typeof d.name === 'string') {
        p?.updateRoom({ id: d.id, name: d.name, archivedAt: d.archivedAt ?? null });
      }
      break;
    }
    /**
     * Presence for every room the principal inhabits — including rooms past
     * RoomStreams' snapshot budget (under the old per-room-connection cap this
     * is where the sidebar showed a dot only a reload could correct). The store
     * is last-writer-wins and `apply` is idempotent, so overlapping with
     * RoomStreams' own routing of the same frame costs nothing.
     */
    case 'presence.changed': {
      const d = ev.data as PresenceChangedEvent | undefined;
      if (d?.member && d.state) p?.applyPresence(d.member.principalId, d.state);
      break;
    }
    /**
     * Our journal cursor predates retention: the replay is INCOMPLETE, so no
     * targeted invalidation can be trusted. Refetch everything — this is the one
     * path that legitimately costs a full pass.
     */
    case 'replay.gap':
      void r.reloadHumans();
      void r.reloadAgents();
      void r.reloadRooms();
      void r.reloadInvitations();
      void r.reloadApprovals();
      void r.reloadEmailApprovals();
      break;
    default:
      // Unknown to this client version — ignore it (see the note above).
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* In-place source patches (pure; the store's half of the routing table)       */
/* -------------------------------------------------------------------------- */

/**
 * Every patch below returns the SAME array when nothing actually changed. A
 * rename ripples `member.updated` into every room the principal inhabits, so one
 * rename can arrive several times over; identity-stable no-ops keep that from
 * re-rendering the whole shell once per room.
 */

/** Patch a human's display name + effective avatar in the HUMANS source. */
export function renameInHumans(
  humans: SidebarHuman[],
  principalId: string,
  displayName: string,
  avatarUrl: string | null,
): SidebarHuman[] {
  let changed = false;
  const next = humans.map((h) => {
    if (h.human.id !== principalId) return h;
    if (h.human.displayName === displayName && (h.human.avatarUrl ?? null) === avatarUrl) return h;
    changed = true;
    return { ...h, human: { ...h.human, displayName, avatarUrl } };
  });
  return changed ? next : humans;
}

/**
 * Patch an agent's name in the AGENTS visibility source.
 *
 * `agent.emailAddress` is DERIVED from the name server-side (a rename moves the
 * address), and `member.updated` does not carry the new address — so it is left
 * alone here rather than guessed at. Nothing in the shell renders it (see
 * {@link ../lib/sidebar.AgentEntry.emailAddress}); the agent page fetches its
 * own copy, and the next agents refetch restates it.
 */
export function renameInAgents(
  agents: VisibilityAgent[],
  principalId: string,
  displayName: string,
): VisibilityAgent[] {
  let changed = false;
  const next = agents.map((a) => {
    if (a.agent.id !== principalId || a.agent.name === displayName) return a;
    changed = true;
    return { ...a, agent: { ...a.agent, name: displayName } };
  });
  return changed ? next : agents;
}

/**
 * Patch a DM room's counterpart — the source behind the top-nav crumb AND the
 * conversation header. This is the one the bug report's screenshot showed
 * stale: the room view's own member roster refetches on `member.updated`, but
 * neither of those two surfaces reads it.
 */
export function renameInRooms(
  rooms: MeRoom[],
  principalId: string,
  displayName: string,
  avatarUrl: string | null,
): MeRoom[] {
  let changed = false;
  const next = rooms.map((r) => {
    const c = r.room.counterpart;
    if (!c || c.id !== principalId) return r;
    if (c.displayName === displayName && (c.avatarUrl ?? null) === avatarUrl) return r;
    changed = true;
    return { ...r, room: { ...r.room, counterpart: { ...c, displayName, avatarUrl } } };
  });
  return changed ? next : rooms;
}

/** Patch a room row's name + archived state from a `room.updated` frame. */
export function updateRoomRow(
  rooms: MeRoom[],
  room: { id: string; name: string; archivedAt: string | null },
): MeRoom[] {
  let changed = false;
  const next = rooms.map((r) => {
    if (r.room.id !== room.id) return r;
    if (r.room.name === room.name && r.room.archivedAt === room.archivedAt) return r;
    changed = true;
    return { ...r, room: { ...r.room, name: room.name, archivedAt: room.archivedAt } };
  });
  return changed ? next : rooms;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within <WorkspaceProvider>');
  return ctx;
}

export function WorkspaceProvider({
  activeRoomId,
  children,
}: {
  activeRoomId: string | null;
  children: ReactNode;
}) {
  const { orgId } = useOrg();
  const auth = useAuth();
  const caps = useCapabilities();
  const emailOn = caps.email;
  const [humans, setHumans] = useState<SidebarHuman[]>([]);
  const [agents, setAgents] = useState<VisibilityAgent[]>([]);
  const [rooms, setRooms] = useState<MeRoom[]>([]);
  const [invitations, setInvitations] = useState<RoomInvitation[]>([]);
  const [enrollments, setEnrollments] = useState<EnrollmentSummary[]>([]);
  const [emailQueue, setEmailQueue] = useState<EmailApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [badges, setBadges] = useState<Record<string, RoomBadges>>(() => roomStreams.snapshot());

  // The humans/agents sources carry the principal-level `online` snapshot;
  // every (re)fetch hydrates the shared presence store — the single truth the
  // sidebar AND the chat header render presence from.
  const reloadHumans = useCallback(async () => {
    const items = await api.orgMeHumans(orgId).catch(() => []);
    setHumans(items);
    presenceStore.hydrate(items.map((h) => ({ principalId: h.human.id, online: h.online })));
  }, [orgId]);
  const reloadAgents = useCallback(async () => {
    const items = await api.orgMeAgents(orgId).catch(() => []);
    setAgents(items);
    presenceStore.hydrate(items.map((a) => ({ principalId: a.agent.id, online: a.agent.online })));
  }, [orgId]);
  const reloadRooms = useCallback(async () => {
    const next = await api.meRooms({ org: orgId }).catch(() => [] as MeRoom[]);
    setRooms(next);
    return next;
  }, [orgId]);
  const reloadInvitations = useCallback(async () => {
    // Only invitations for rooms in THIS org are relevant here.
    const all = await api.meRoomInvitations().catch(() => [] as RoomInvitation[]);
    setInvitations(all.filter((i) => i.room.orgId === orgId));
  }, [orgId]);
  // The pending pill counts ONLY enrollments arriving through the caller's OWN
  // invites (never a coworker's). A plain member is already server-scoped to
  // their invites; owners/admins would see all, so filter by inviter here too.
  const meId = auth.user?.id;
  const reloadApprovals = useCallback(async () => {
    const items = await api.listEnrollments(orgId).catch(() => []);
    setEnrollments(meId ? items.filter((e) => e.inviter.id === meId) : []);
  }, [orgId, meId]);
  // The email half of the pill. Render is gated on `capabilities.email`, and so
  // is the FETCH here — with the medium off the route 404s and there is nothing
  // to count. The owned-agent filter is applied against the visibility list in
  // the value memo below (so it re-derives when either source moves).
  const reloadEmailApprovals = useCallback(async () => {
    if (!emailOn) {
      setEmailQueue([]);
      return;
    }
    const res = await api.listEmailApprovals(orgId).catch(() => null);
    setEmailQueue(res?.items ?? []);
  }, [orgId, emailOn]);

  // Initial + on-org-change load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      await Promise.all([
        reloadHumans(),
        reloadAgents(),
        reloadRooms(),
        reloadInvitations(),
        reloadApprovals(),
        reloadEmailApprovals(),
      ]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    reloadHumans,
    reloadAgents,
    reloadRooms,
    reloadInvitations,
    reloadApprovals,
    reloadEmailApprovals,
  ]);

  // Mirror the stream manager's badge state into React state.
  useEffect(() => roomStreams.onChange(() => setBadges(roomStreams.snapshot())), []);

  // Track every room in this org (active room prioritized) so its badges are
  // live. No connection is opened per room — RoomStreams routes the frames the
  // shared `/me/events` stream already carries (issue #54).
  const roomIds = rooms.map((r) => r.room.id);
  const roomsKey = roomIds.join(',');
  // Refs the long-lived /me/events handler reads (avoids stale closures): the
  // set of rooms we already know, and the caller's own principal id.
  const knownRoomIdsRef = useRef<Set<string>>(new Set());
  knownRoomIdsRef.current = new Set(roomIds);
  const meIdRef = useRef<string | undefined>(undefined);
  meIdRef.current = auth.user?.id;
  useEffect(() => {
    // Archived rooms are frozen (not tracked) unless they are the active room.
    const wanted = rooms
      .filter((r) => r.room.archivedAt === null || r.room.id === activeRoomId)
      .map((r) => r.room.id);
    roomStreams.ensure(wanted, activeRoomId);
    setBadges(roomStreams.snapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey, activeRoomId]);

  // `/me/events` — principal-level events + wrapped room events. The CONNECTION
  // is the app's shared one (lib/meEvents), which owns reconnect, cursor resume
  // and fan-out; this provider is just one of its subscribers. The refetchers
  // ride in a ref so a fresh closure per render never touches the stream.
  const reloadRef = useRef({
    reloadHumans,
    reloadAgents,
    reloadRooms,
    reloadInvitations,
    reloadApprovals,
    reloadEmailApprovals,
  });
  reloadRef.current = {
    reloadHumans,
    reloadAgents,
    reloadRooms,
    reloadInvitations,
    reloadApprovals,
    reloadEmailApprovals,
  };
  // The in-place half of the table. Stable for the provider's lifetime (the
  // setters are), so subscribing costs nothing per render.
  const patches = useMemo<PrincipalEventPatches>(
    () => ({
      renamePrincipal: (principalId, displayName, avatarUrl) => {
        setHumans((cur) => renameInHumans(cur, principalId, displayName, avatarUrl));
        setAgents((cur) => renameInAgents(cur, principalId, displayName));
        setRooms((cur) => renameInRooms(cur, principalId, displayName, avatarUrl));
      },
      updateRoom: (room) => setRooms((cur) => updateRoomRow(cur, room)),
      applyPresence: (principalId, state) => presenceStore.apply(principalId, state),
    }),
    [],
  );

  // ROOMS THE CACHE NEVER SAW CREATED (issue #59). `/me/rooms` is fetched once
  // per org; a room created out-of-band after that — `sparrow dm botty` run on
  // another machine — is invisible to it. Two things prove the list is stale,
  // and both land here:
  //
  //  - a WRAPPED frame for a room id we do not track. `/me/events` recomputes
  //    its audience from the room's members on every emit, so a frame reaching
  //    us is proof of a membership we hold; not knowing the room can only mean a
  //    list fetched before it existed. {@link roomStreams} reports each such id
  //    once (see `onUnknownRoom`);
  //  - the reader STANDING IN a room absent from `rooms` — the sidebar routed
  //    there off a principal row, and the DM header had no counterpart to name.
  //
  // Either way: refetch the rooms list. That fills the sidebar, names the DM's
  // counterpart in the crumb/header/composer, and (via the tracking effect
  // above) starts the room's badges. Once per unseen id, so a chatty membership
  // in ANOTHER org — this stream spans them all, the sidebar is scoped to one —
  // costs exactly one refetch and not one per message; an id that DID arrive is
  // forgotten again, so a later disappearance is news once more.
  const learntRef = useRef<Set<string>>(new Set());
  const learnRoom = useCallback((roomId: string) => {
    if (learntRef.current.has(roomId)) return;
    learntRef.current.add(roomId);
    void reloadRef.current.reloadRooms();
  }, []);
  useEffect(() => roomStreams.onUnknownRoom(learnRoom), [learnRoom]);
  useEffect(() => {
    for (const id of roomIds) learntRef.current.delete(id);
    if (activeRoomId && !roomIds.includes(activeRoomId)) learnRoom(activeRoomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey, activeRoomId, learnRoom]);

  // The app's ONE principal-level subscription (see lib/meEvents). A reconnect
  // resumes from the journal cursor, so the reconcile below is the safety net
  // for what replay could not cover, not the primary healing path.
  const reconcileAll = useCallback(() => {
    const r = reloadRef.current;
    void r.reloadHumans();
    void r.reloadAgents();
    void r.reloadRooms();
    void r.reloadInvitations();
    void r.reloadApprovals();
    void r.reloadEmailApprovals();
  }, []);
  useMeEventStream({
    enabled: auth.signedIn,
    onEvent: (ev) =>
      applyPrincipalEvent(ev, {
        reloads: reloadRef.current,
        patches,
        knownRoomIds: knownRoomIdsRef.current,
        meId: meIdRef.current,
      }),
    onReconnect: reconcileAll,
  });

  // Wake reconcile — the sidebar counterpart of the Room view's. While the tab
  // slept (or the network was down) every live event was missed and a hung
  // stream never settles its `closed` promise, so nothing resyncs on its own:
  // the sidebar kept showing pre-sleep presence while the active Room view
  // healed on ITS visibility reconcile — the gray-vs-green split. On the same
  // signals, refetch the principal-level presence sources (which hydrate the
  // shared presence store) and re-snapshot every tracked room. Leading-edge
  // throttled so focus-flapping can't hammer the API.
  const lastWakeRef = useRef(0);
  useEffect(() => {
    const reconcile = () => {
      const now = Date.now();
      if (now - lastWakeRef.current < WAKE_RECONCILE_THROTTLE_MS) return;
      lastWakeRef.current = now;
      const r = reloadRef.current;
      void r.reloadHumans();
      void r.reloadAgents();
      roomStreams.resyncAll();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconcile();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
    };
  }, []);

  const ensureDm = useCallback(
    async (principalId: string): Promise<string> => {
      const res = await api.ensureDm({ principal: principalId, orgId });
      await reloadRooms();
      return res.room.id;
    },
    [orgId, reloadRooms],
  );

  // The queue the API returns is org-wide for an owner/admin; the PERSONAL pill
  // counts only agents the caller owns (owner is me AND not shared to me).
  const ownedAgentIds = useMemo(
    () =>
      new Set(
        agents
          .filter((a) => meId !== undefined && a.owner.id === meId && a.sharedBy === null)
          .map((a) => a.agent.id),
      ),
    [agents, meId],
  );
  const emailApprovals = useMemo(
    () => emailQueue.filter((item) => ownedAgentIds.has(item.agent.id)),
    [emailQueue, ownedAgentIds],
  );

  // The AGENTS badge's email half, straight off the visibility list. A `null`
  // count (shared-to-me agent, or the medium off) is OMITTED, never zeroed —
  // "not countable here" and "nothing waiting" are different facts.
  const emailUnread = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of agents) {
      if (a.emailUnreadCount !== null) map[a.agent.id] = a.emailUnreadCount;
    }
    return map;
  }, [agents]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      humans,
      agents,
      rooms,
      invitations,
      enrollments,
      approvals: enrollments.length,
      emailApprovals,
      emailUnread,
      badges,
      loading,
      reloadRooms,
      reloadHumans,
      reloadAgents,
      reloadInvitations,
      reloadApprovals,
      reloadEmailApprovals,
      ensureDm,
    }),
    [
      humans,
      agents,
      rooms,
      invitations,
      enrollments,
      emailApprovals,
      emailUnread,
      badges,
      loading,
      reloadRooms,
      reloadHumans,
      reloadAgents,
      reloadInvitations,
      reloadApprovals,
      reloadEmailApprovals,
      ensureDm,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
