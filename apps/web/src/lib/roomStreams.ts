import type {
  InboxItem,
  ListStatusesResponse,
  MessageNewEvent,
  PresenceChangedEvent,
  StatusChangedEvent,
} from '@sparrow/common-types';
import type { PrincipalEvent, SparrowEvent } from '@sparrow/client';
import { api } from './client.js';
import { unreadCounts } from './conversation.js';
import { applyStatusEvent, hydrateStatuses, pruneExpired, type StatusMap } from './status.js';
import { presenceStore, type PresenceStore } from './presenceStore.js';
import { meEvents } from './meEvents.js';

/**
 * RoomStreams — the router that turns the app's ONE multiplexed stream into
 * per-room state, so sidebar badges (room broadcast unread, per-DM unread
 * attributed to a principal, working state) update in real time for background
 * rooms too — never a full refetch per event. `presence.changed` events feed the
 * shared principal-keyed PresenceStore.
 *
 * **It owns no connection.** It used to hold one SSE connection per joined room
 * (`GET /rooms/:roomId/events`), which is what made a member of four rooms — or
 * two tabs with two rooms each — saturate the browser's ~6 HTTP/1.1 connections
 * per origin and wedge every subsequent request with no error anywhere
 * (issue #54). `GET /me/events` was already the server's multiplexed stream: it
 * fans in every membership, wrapping each room event `{ room, ...payload }`,
 * with the audience recomputed from the room's members on EVERY emit — so a
 * principal removed from a room stops receiving it mid-stream, and the journal
 * (and thus `?since=` replay) never crosses the boundary either. This class now
 * subscribes to {@link ../lib/meEvents.meEvents}, unwraps the `room` ref and
 * routes by room id. Same state, same fan-out, ZERO sockets of its own.
 *
 * Room-independence is still the point: the active room NEVER shapes the sidebar
 * lists (that was the v2 `deriveAgentEntries` bug). Each room's frames only feed
 * its OWN badge state, keyed by roomId; the shell attributes a DM room's unread
 * to its counterpart principal by mapping counterpartId → roomId.
 *
 * - lifecycle: `ensure(roomIds, activeRoomId)` sets the tracked room set;
 * - resilience: the shared stream's reconnect (and its cursor replay) is
 *   {@link ../lib/meEvents.MeEventStream}'s job; on a RE-connect this re-syncs
 *   every snapshotted room's unread + status from the API;
 * - fan-out: the active Room view subscribes via `subscribe(roomId, fn)` and
 *   receives the room's decoded events plus a synthetic `sync` after resync;
 * - authority hand-back: the active Room view marks messages read and reports
 *   its authoritative unread via `reportUnread` so counters never over-count.
 */

/**
 * Live badge state for one room's sidebar node. Presence is deliberately NOT
 * here: it is principal-level, so every frame feeds the shared
 * {@link PresenceStore} instead of a per-room set (a per-room copy is exactly
 * what let the sidebar and the chat header disagree).
 */
export interface RoomBadges {
  /** Unread counts keyed by conversation: 'all' (broadcasts) or sender member id. */
  unread: Record<string, number>;
  /** Active working statuses visible to this room's caller. */
  statuses: StatusMap;
}

/** Event delivered to per-room subscribers ('sync' = state was re-fetched). */
export type RoomStreamEvent = SparrowEvent | { type: 'sync'; data?: undefined };

/**
 * The per-room REST surface the manager needs (injectable for tests). No
 * `events()` any more — live frames arrive on the shared stream; these two are
 * the snapshot half, read once per room and again on every reconnect.
 */
export interface RoomConnection {
  /** Unread inbox previews (first page is plenty for badge counts). */
  listUnread(): Promise<InboxItem[]>;
  /** Full `GET /status`: active statuses + room presence for hydration. */
  getStatus(): Promise<ListStatusesResponse>;
}

/** The slice of {@link ../lib/meEvents.MeEventStream} this router consumes. */
export interface MultiplexedStream {
  subscribe(fn: (ev: PrincipalEvent) => void): () => void;
  onReconnect(fn: () => void): () => void;
}

export interface RoomStreamsOptions {
  connect?: (roomId: string) => RoomConnection;
  /** The multiplexed principal stream (the app singleton by default). */
  stream?: MultiplexedStream;
  /**
   * How many rooms get a REST snapshot (unread + status) on attach and on every
   * reconnect — a request budget, not a connection one. LIVE frames are routed
   * for every tracked room regardless: they cost nothing now that they all
   * arrive on one stream, which is why a room past this bound no longer misses
   * its badge updates the way it did under the old six-socket cap.
   */
  maxSnapshots?: number;
  /** The principal presence store live events feed (the singleton by default). */
  presence?: PresenceStore;
}

const DEFAULT_MAX_SNAPSHOTS = 6;

/** Same-origin REST reads for one room's badge snapshot (cookie-authed). */
export function defaultConnect(roomId: string): RoomConnection {
  return {
    listUnread: async () => (await api.listInbox(roomId, { limit: 100 })).items,
    getStatus: () => api.listStatuses(roomId),
  };
}

interface RoomState {
  conn: RoomConnection;
  /** Within the snapshot budget: this room re-reads its state on reconnect. */
  snapshotted: boolean;
  unread: Record<string, number>;
  statuses: StatusMap;
}

export class RoomStreams {
  private readonly opts: Required<RoomStreamsOptions>;
  private rooms = new Map<string, RoomState>();
  private subs = new Map<string, Set<(ev: RoomStreamEvent) => void>>();
  private changeListeners = new Set<() => void>();
  private unknownListeners = new Set<(roomId: string) => void>();
  /** Unknown room ids already reported — each is announced at most once. */
  private reportedUnknown = new Set<string>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Release of the shared-stream subscription, while any room is tracked. */
  private detach: (() => void) | null = null;

  constructor(opts: RoomStreamsOptions = {}) {
    this.opts = {
      connect: opts.connect ?? defaultConnect,
      stream: opts.stream ?? meEvents,
      maxSnapshots: opts.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS,
      presence: opts.presence ?? presenceStore,
    };
  }

  /** Reconcile tracked rooms with the wanted set (active room gets priority). */
  ensure(roomIds: string[], activeRoomId?: string | null): void {
    // The ACTIVE room is tracked even when it is absent from the caller's known
    // set. A room created out-of-band — the CLI's `sparrow dm` on another
    // machine — exists on the server before this tab's rooms list mentions it,
    // and the reader can already be standing in it (the sidebar routes there the
    // moment it learns of it). Tracking only what the cache knows left that view
    // subscribed to a room this router dropped every frame for: no messages, and
    // not even the synthetic `sync` that would have made it reconcile (#59).
    const ordered = activeRoomId
      ? [activeRoomId, ...roomIds.filter((id) => id !== activeRoomId)]
      : roomIds;
    const wanted = new Set(ordered);

    let changed = false;
    for (const roomId of [...this.rooms.keys()]) {
      if (!wanted.has(roomId)) {
        this.rooms.delete(roomId);
        changed = true;
      }
    }
    for (const roomId of ordered) {
      if (!this.rooms.has(roomId)) {
        this.rooms.set(roomId, { conn: this.opts.connect(roomId), snapshotted: false, unread: {}, statuses: {} });
        changed = true;
      }
      // Tracked again: forget that we ever reported it, so losing it a second
      // time reports it a second time.
      this.reportedUnknown.delete(roomId);
    }

    if (this.rooms.size === 0) this.release();
    else this.attach();

    // Snapshot the head of the ordered set (the active room first). A room that
    // BECAME eligible — because it just became the active one — snapshots now.
    for (const roomId of ordered.slice(0, this.opts.maxSnapshots)) {
      const st = this.rooms.get(roomId);
      if (!st || st.snapshotted) continue;
      st.snapshotted = true;
      void this.resync(roomId, st);
    }

    if (changed) this.notify();
  }

  /** Per-room badge state (fresh objects per call). */
  snapshot(): Record<string, RoomBadges> {
    const out: Record<string, RoomBadges> = {};
    for (const [roomId, st] of this.rooms) {
      out[roomId] = {
        unread: { ...st.unread },
        statuses: st.statuses,
      };
    }
    return out;
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /**
   * A wrapped frame arrived for a room this router does not track — so the
   * caller's rooms list is STALE (issue #59). `/me/events` recomputes its
   * audience from the room's members on every emit, so a frame reaching us is
   * proof of a membership we hold; the only way not to know it is a rooms list
   * fetched before the room existed. The workspace answers by refetching its
   * rooms, which both fills the sidebar and makes the room trackable here.
   *
   * Reported ONCE per id (until the room is tracked again), so a room that is
   * legitimately never tracked — a chatty membership in ANOTHER org, since this
   * stream spans them all while the sidebar is scoped to one — costs exactly one
   * refetch, not one per message.
   */
  onUnknownRoom(fn: (roomId: string) => void): () => void {
    this.unknownListeners.add(fn);
    return () => this.unknownListeners.delete(fn);
  }

  subscribe(roomId: string, fn: (ev: RoomStreamEvent) => void): () => void {
    let set = this.subs.get(roomId);
    if (!set) {
      set = new Set();
      this.subs.set(roomId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(roomId);
    };
  }

  /** Authoritative unread from the active Room view (which marks messages read). */
  reportUnread(roomId: string, unread: Record<string, number>): void {
    const st = this.rooms.get(roomId);
    if (!st) return;
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(unread)) if (v > 0) next[k] = v;
    if (JSON.stringify(next) === JSON.stringify(st.unread)) return;
    st.unread = next;
    this.notify();
  }

  /**
   * Re-fetch every snapshotted room's unread/status — the sidebar's wake
   * reconcile. The shared stream resumes from its journal cursor, so this is the
   * safety net for what replay could not cover (a machine asleep longer than
   * retention, a stream that silently hung and never settled its `closed`
   * promise). The workspace calls it on visibility/focus/online regain, and the
   * shared stream's own `onReconnect` calls it too.
   */
  resyncAll(): void {
    for (const [roomId, st] of this.rooms) {
      if (st.snapshotted) void this.resync(roomId, st);
    }
  }

  dispose(): void {
    this.rooms.clear();
    this.release();
    this.changeListeners.clear();
    this.unknownListeners.clear();
    this.reportedUnknown.clear();
    this.subs.clear();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private attach(): void {
    if (this.detach) return;
    const offEvent = this.opts.stream.subscribe((ev) => this.handleFrame(ev));
    const offReconnect = this.opts.stream.onReconnect(() => this.resyncAll());
    this.detach = () => {
      offEvent();
      offReconnect();
    };
  }

  private release(): void {
    const off = this.detach;
    this.detach = null;
    off?.();
  }

  /**
   * Route ONE multiplexed frame. Principal-level frames (no `room`) belong to
   * the workspace's own routing table, not here; a wrapped frame for a room we
   * do not track carries no badge state we can trust, so it is dropped — but the
   * room id is REPORTED first (see {@link onUnknownRoom}), because not knowing
   * the room is itself the news.
   */
  private handleFrame(ev: PrincipalEvent): void {
    // Our cursor predates retention: the replay is incomplete, so no live patch
    // can be trusted. Re-read every room's snapshot.
    if (ev.type === 'replay.gap') {
      this.resyncAll();
      return;
    }
    const room = ev.room as { id?: string } | undefined;
    if (!room?.id) return;
    const st = this.rooms.get(room.id);
    if (!st) {
      this.reportUnknown(room.id);
      return;
    }
    this.handleEvent(room.id, st, { type: ev.type, data: roomPayload(ev, room) } as SparrowEvent);
  }

  private reportUnknown(roomId: string): void {
    if (this.reportedUnknown.has(roomId)) return;
    this.reportedUnknown.add(roomId);
    for (const fn of [...this.unknownListeners]) fn(roomId);
  }

  private async resync(roomId: string, st: RoomState): Promise<void> {
    try {
      const [inbox, status] = await Promise.all([
        st.conn.listUnread(),
        st.conn
          .getStatus()
          .catch(() => ({ items: [], presence: { online: [] } }) as ListStatusesResponse),
      ]);
      if (this.rooms.get(roomId) !== st) return;
      st.unread = unreadCounts(inbox);
      st.statuses = hydrateStatuses(status.items);
      this.ensurePruneTimer();
      this.notify();
      this.emit(roomId, { type: 'sync' });
    } catch {
      // Auth/network failure — the shared stream's reconnect drives the retry.
    }
  }

  private handleEvent(roomId: string, st: RoomState, ev: SparrowEvent): void {
    if (ev.type === 'message.new') {
      const d = ev.data as MessageNewEvent;
      const key = d.kind === 'broadcast' ? 'all' : d.from.id;
      st.unread = { ...st.unread, [key]: (st.unread[key] ?? 0) + 1 };
      this.notify();
    } else if (ev.type === 'status.changed') {
      st.statuses = applyStatusEvent(st.statuses, ev.data as StatusChangedEvent);
      this.ensurePruneTimer();
      this.notify();
    } else if (ev.type === 'presence.changed') {
      // Principal-level: feed the shared store (badges carry no presence).
      const d = ev.data as PresenceChangedEvent;
      this.opts.presence.apply(d.member.principalId, d.state);
    } else if (ev.type === 'message.clawback') {
      // The sender pulled a message back (SPEC "Clawback"). It may have been
      // counted unread here — the server only allows clawback while NO
      // recipient has read it — but the event carries neither the conversation
      // key nor the kind, so re-count from the unread page instead of guessing
      // a decrement: the server has already killed the row, so the listing is
      // exact, and the first page is all a badge ever needed. Cheap, idempotent,
      // and it can never go negative or strand a phantom badge.
      void st.conn
        .listUnread()
        .then((items) => {
          if (this.rooms.get(roomId) !== st) return;
          st.unread = unreadCounts(items);
          this.notify();
        })
        .catch(() => {
          // Transient failure: the next resync (reconnect/wake) restates it.
        });
    }
    this.emit(roomId, ev);
  }

  private emit(roomId: string, ev: RoomStreamEvent): void {
    const set = this.subs.get(roomId);
    if (!set) return;
    for (const fn of [...set]) fn(ev);
  }

  private notify(): void {
    for (const fn of [...this.changeListeners]) fn();
  }

  private ensurePruneTimer(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      let anyLeft = false;
      for (const st of this.rooms.values()) {
        const next = pruneExpired(st.statuses, now);
        if (next !== st.statuses) {
          st.statuses = next;
          changed = true;
        }
        if (Object.keys(st.statuses).length > 0) anyLeft = true;
      }
      if (!anyLeft && this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = null;
      }
      if (changed) this.notify();
    }, 1_000);
  }
}

/**
 * Restore the exact payload a per-room stream would have delivered.
 *
 * The fan-in builds its frame as `{ room: <ref>, ...payload }`, so for the ONE
 * event whose payload has its own top-level `room` key — `room.updated` — the
 * payload's room WINS the collision and the client hands it back as `ev.room`
 * with `ev.data.room` gone. (See the matching note in `workspace.tsx`; the
 * collision itself is an API/client wire defect, reported as such.) Splicing it
 * back keeps every room subscriber reading one shape, whichever it came from.
 */
function roomPayload(ev: PrincipalEvent, room: { id?: string }): unknown {
  if (ev.type !== 'room.updated') return ev.data;
  return { ...(ev.data as Record<string, unknown>), room };
}

/** App-wide singleton — the one router owning every room's live badge state. */
export const roomStreams = new RoomStreams();
