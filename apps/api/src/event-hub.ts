/**
 * Room-event fan-out + presence registry (SPEC "Events" / "Presence"). Two kinds
 * of live connection register here:
 *
 *  - a room stream (`GET /rooms/:roomId/events`) — receives that room's events
 *    (filtered by audience) raw;
 *  - a principal stream (`GET /me/events`) — receives every room it belongs to,
 *    each event wrapped `{ room, ...payload }`, membership computed live per emit
 *    so joins/leaves take effect immediately.
 *
 * The hub also owns presence: each open stream contributes to its (room,
 * principal) refcount and to the principal-wide online refcount, both grace-
 * windowed by {@link PresenceTracker}. Principal-level online feeds
 * `toAgent().online` and the sidebar.
 */
import { and, eq } from 'drizzle-orm';
import type {
  EventRoomRef,
  MemberRef,
  MePresence,
  PrincipalKind,
  SetPresenceResponse,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import { members, rooms } from './db/schema.js';
import { PRINCIPAL_ROOM, PresenceTracker } from './presence.js';
import { memberOf, membersOf, toMemberRef } from './room-helpers.js';

/** The audience of a room event: every member, or a specific set of member ids. */
export type Audience = 'all' | string[];

/** A live `GET /rooms/:roomId/events` connection. */
export interface RoomStream {
  principalType: PrincipalKind;
  principalId: string;
  roomId: string;
  memberId: string;
  send(event: string, data: unknown): void;
}

/** A live `GET /me/events` connection. */
export interface MeStream {
  principalType: PrincipalKind;
  principalId: string;
  /** Raw (principal-level) event, e.g. `agent.shared`; `id` is the journal cursor. */
  send(event: string, data: unknown, id?: number): void;
  /** Room event wrapped `{ room, ...payload }`; `id` is the journal cursor. */
  sendRoom(room: EventRoomRef, event: string, data: unknown, id?: number): void;
  /** Internal: the rooms this stream currently contributes presence to. */
  _presenceRooms: Set<string>;
}

function principalKey(type: PrincipalKind, id: string): string {
  return `${type}:${id}`;
}

export class RoomEventHub {
  private ctx!: AppContext;
  private disposed = false;
  private readonly presence: PresenceTracker;
  private readonly roomStreams = new Set<RoomStream>();
  private readonly meStreams = new Set<MeStream>();
  /** principalKey → pending heartbeat-mark expiry sweep (prompt `offline` at lapse). */
  private readonly ttlSweeps = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(graceSeconds: number) {
    this.presence = new PresenceTracker(graceSeconds * 1000, (roomId, pk, state) =>
      this.firePresence(roomId, pk, state),
    );
  }

  /** Late-bind the app context (the hub is created before ctx exists). */
  bind(ctx: AppContext): void {
    this.ctx = ctx;
  }

  /** Cancel pending presence timers + drop connections (server shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.ttlSweeps.values()) clearTimeout(timer);
    this.ttlSweeps.clear();
    this.presence.dispose();
    this.roomStreams.clear();
    this.meStreams.clear();
  }

  /* ------------------------------- room streams ---------------------- */

  /** Register a room stream; returns the unsubscribe/disconnect callback. */
  addRoomStream(stream: RoomStream): () => void {
    this.roomStreams.add(stream);
    const pk = principalKey(stream.principalType, stream.principalId);
    this.presence.add(stream.roomId, pk);
    this.presence.add(PRINCIPAL_ROOM, pk);
    return () => {
      this.roomStreams.delete(stream);
      this.presence.remove(stream.roomId, pk);
      this.presence.remove(PRINCIPAL_ROOM, pk);
    };
  }

  /* ------------------------------- me streams ------------------------ */

  /** Register a principal stream; returns the unsubscribe/disconnect callback. */
  addMeStream(stream: MeStream): () => void {
    this.meStreams.add(stream);
    const pk = principalKey(stream.principalType, stream.principalId);
    this.presence.add(PRINCIPAL_ROOM, pk);
    stream._presenceRooms = new Set(this.principalRoomIds(stream.principalType, stream.principalId));
    for (const roomId of stream._presenceRooms) this.presence.add(roomId, pk);
    return () => {
      this.meStreams.delete(stream);
      this.presence.remove(PRINCIPAL_ROOM, pk);
      for (const roomId of stream._presenceRooms) this.presence.remove(roomId, pk);
    };
  }

  /**
   * Recompute the presence contributions of a principal's open `/me/events`
   * streams after a membership change (join/leave) so the sidebar glyph and room
   * presence stay accurate while connected.
   */
  onMembershipChanged(principalType: PrincipalKind, principalId: string): void {
    const pk = principalKey(principalType, principalId);
    const current = new Set(this.principalRoomIds(principalType, principalId));
    for (const stream of this.meStreams) {
      if (stream.principalType !== principalType || stream.principalId !== principalId) continue;
      for (const roomId of current) {
        if (!stream._presenceRooms.has(roomId)) {
          this.presence.add(roomId, pk);
          stream._presenceRooms.add(roomId);
        }
      }
      for (const roomId of [...stream._presenceRooms]) {
        if (!current.has(roomId)) {
          this.presence.remove(roomId, pk);
          stream._presenceRooms.delete(roomId);
        }
      }
    }
  }

  /* ------------------------------- emit ------------------------------ */

  /**
   * Fan a room event out to the room's streams + every member's `/me/events`.
   * The `/me` fan-in is JOURNALED per receiving principal (every member in the
   * audience, connected or not) so a reconnecting client can replay it; each
   * live frame then carries its journal cursor as the SSE `id:`. Room streams
   * (`/rooms/:id/events`) are delivered raw — room-scoped replay is future work.
   */
  emitRoom(roomId: string, event: string, data: Record<string, unknown>, audience: Audience): void {
    const inAudience = (memberId: string): boolean =>
      audience === 'all' || audience.includes(memberId);

    for (const stream of this.roomStreams) {
      if (stream.roomId === roomId && inAudience(stream.memberId)) stream.send(event, data);
    }

    const roomRef = this.roomRef(roomId);
    if (!roomRef) return;
    // Journal once per receiving principal (dedupe across a principal's members),
    // capturing the cursor id so any live streams frame with the same id.
    const cursor = new Map<string, number>();
    for (const m of membersOf(this.ctx, roomId)) {
      if (!inAudience(m.id)) continue;
      const type = m.principalType as PrincipalKind;
      const key = principalKey(type, m.principalId);
      if (cursor.has(key)) continue;
      cursor.set(key, this.ctx.journal.append(type, m.principalId, event, { room: roomRef, ...data }));
    }
    for (const stream of this.meStreams) {
      const id = cursor.get(principalKey(stream.principalType, stream.principalId));
      if (id !== undefined) stream.sendRoom(roomRef, event, data, id);
    }
  }

  /* ------------------------------- presence queries ------------------ */

  /**
   * Whether a principal is effectively online — holds an open stream
   * (grace-windowed) OR an unexpired heartbeat mark. Feeds the sidebar glyph and
   * `toAgent().online`.
   */
  isPrincipalOnline(principalType: PrincipalKind, principalId: string): boolean {
    const pk = principalKey(principalType, principalId);
    return this.presence.isOnline(PRINCIPAL_ROOM, pk) || this.presence.ttlActive(pk);
  }

  /**
   * The same effective-online answer as {@link isPrincipalOnline}, but broken out
   * for the principal's OWN `GET /me`: which of the two sources carries it, and
   * (for a self-reported mark) when that mark lapses. A stream wins when both
   * hold — it is the stronger signal and has no expiry to report.
   */
  principalPresence(principalType: PrincipalKind, principalId: string): MePresence {
    const pk = principalKey(principalType, principalId);
    if (this.presence.isOnline(PRINCIPAL_ROOM, pk)) {
      return { online: true, via: 'stream', onlineUntil: null };
    }
    const expiry = this.presence.ttlExpiry(pk);
    if (expiry !== null) {
      return { online: true, via: 'mark', onlineUntil: new Date(expiry).toISOString() };
    }
    return { online: false, via: null, onlineUntil: null };
  }

  /**
   * The member ids currently online in a room (for `GET /rooms/:id/status`):
   * stream-online principals plus any holding a live heartbeat mark who are
   * members here.
   */
  onlineMemberIds(roomId: string): string[] {
    const keys = new Set([
      ...this.presence.onlinePrincipalKeys(roomId),
      ...this.presence.ttlMarkedKeys(),
    ]);
    const out: string[] = [];
    for (const pk of keys) {
      const [type, id] = pk.split(':') as [PrincipalKind, string];
      const member = memberOf(this.ctx, roomId, type, id);
      if (member) out.push(member.id);
    }
    return out;
  }

  /**
   * Set (or clear, with `ttlSeconds <= 0`) the caller's heartbeat presence mark
   * — org/room-wide online without a socket, for turn-based wake/act/sleep
   * agents. Fires `presence.changed` in every room the principal belongs to where
   * effective online actually flips (a room already held online by an open stream
   * emits nothing). A prompt `offline` at expiry is delivered by a scheduled sweep
   * (mirroring the status store's TTL timer); presence queries also reap the mark
   * lazily as a backstop.
   */
  setPresenceTtl(
    principalType: PrincipalKind,
    principalId: string,
    ttlSeconds: number,
  ): SetPresenceResponse {
    const pk = principalKey(principalType, principalId);
    const now = Date.now();
    const wasActive = this.presence.ttlActive(pk, now);

    const prior = this.ttlSweeps.get(pk);
    if (prior) {
      clearTimeout(prior);
      this.ttlSweeps.delete(pk);
    }

    if (ttlSeconds <= 0) {
      this.presence.clearTtl(pk);
      if (wasActive) this.reconcileMarkEdges(principalType, principalId, 'offline');
      return { onlineUntil: null };
    }

    const expiryMs = now + ttlSeconds * 1000;
    this.presence.markTtl(pk, expiryMs);
    if (!wasActive) this.reconcileMarkEdges(principalType, principalId, 'online');
    const timer = setTimeout(() => {
      this.ttlSweeps.delete(pk);
      if (this.disposed) return;
      // Not refreshed past expiry → the mark has lapsed; emit the offline edges.
      if (!this.presence.ttlActive(pk)) {
        this.reconcileMarkEdges(principalType, principalId, 'offline');
      }
    }, ttlSeconds * 1000);
    (timer as { unref?: () => void }).unref?.();
    this.ttlSweeps.set(pk, timer);
    return { onlineUntil: new Date(expiryMs).toISOString() };
  }

  /* ------------------------------- internals ------------------------ */

  /**
   * Emit the per-room presence edges for a principal-wide heartbeat mark
   * set/expiry. Skips rooms whose effective online is still pinned by an open
   * stream — those don't flip (and the stream's own grace timer will emit the
   * eventual `offline`).
   */
  private reconcileMarkEdges(
    principalType: PrincipalKind,
    principalId: string,
    state: 'online' | 'offline',
  ): void {
    if (this.disposed) return;
    const pk = principalKey(principalType, principalId);
    for (const roomId of this.principalRoomIds(principalType, principalId)) {
      if (this.presence.isOnline(roomId, pk)) continue; // stream holds it — no flip
      this.firePresence(roomId, pk, state);
    }
  }

  private firePresence(roomId: string, pk: string, state: 'online' | 'offline'): void {
    if (this.disposed) return; // a late grace/sweep timer after shutdown — DB is gone
    const [type, id] = pk.split(':') as [PrincipalKind, string];
    const member = memberOf(this.ctx, roomId, type, id);
    if (!member) return;
    const ref: MemberRef = toMemberRef(this.ctx, member);
    this.emitRoom(roomId, 'presence.changed', { member: ref, state }, 'all');
    // Sticky working statuses lapse only after a member stays offline for the
    // horizon; arm that countdown on offline, cancel it the moment they return.
    if (state === 'offline') this.ctx.statuses.armStickyExpiry(roomId, member.id);
    else this.ctx.statuses.cancelStickyExpiry(roomId, member.id);
  }

  private principalRoomIds(principalType: PrincipalKind, principalId: string): string[] {
    return this.ctx.db
      .select({ roomId: members.roomId })
      .from(members)
      .where(and(eq(members.principalType, principalType), eq(members.principalId, principalId)))
      .all()
      .map((r) => r.roomId);
  }

  private roomRef(roomId: string): EventRoomRef | undefined {
    const room = this.ctx.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
    if (!room) return undefined;
    return { id: room.id, name: room.name, orgId: room.orgId, kind: room.kind as EventRoomRef['kind'] };
  }
}
