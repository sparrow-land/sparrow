/**
 * In-memory, TTL'd, room-scoped working-status store (SPEC "Working status").
 * Statuses are ephemeral (never persisted) so a crashed agent never leaves a
 * stale indicator. Upsert key is `(roomId, memberId, to)`; `to` null = room-wide,
 * set = scoped to one recipient member. Expiry fires `onExpire` (the route emits
 * a `status.changed idle`).
 *
 * Two flavours of `working` coexist:
 *  - **TTL'd** (the default) — auto-expires after `ttlSeconds`, so long tasks must
 *    re-up. A crashed agent's indicator lapses on its own.
 *  - **sticky** — carries no TTL (`expiresAt` null); it persists through a long
 *    task and clears only on an explicit idle/clear OR once its member has stayed
 *    offline past {@link STICKY_OFFLINE_HORIZON_SECONDS} (armed/cancelled by the
 *    hub on presence edges). This keeps a sticky status honest without forcing
 *    re-up ceremonies.
 *
 * `sinceAt` records when the CURRENT status text (note) was set — preserved
 * across a same-note re-up/refresh, reset when the note changes — so UIs can show
 * honest staleness.
 */
import { STICKY_OFFLINE_HORIZON_SECONDS } from '@sparrow/common-types';

/** One live `working` status (ids only — the route projects display names). */
export interface StatusRecord {
  roomId: string;
  memberId: string;
  note: string | null;
  /** The scoped recipient's member id, or null for a room-wide status. */
  toMemberId: string | null;
  /** When the current status text was set (ISO). Survives a same-note refresh. */
  sinceAt: string;
  /** Sticky statuses have no TTL — `expiresAt` is null and they persist. */
  sticky: boolean;
  /** Absolute expiry (ISO), or null for a sticky status. */
  expiresAt: string | null;
}

export class StatusStore {
  private readonly records = new Map<string, StatusRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `(roomId, memberId)` → pending sticky-offline-horizon timer. */
  private readonly stickyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    /** Fired when a status TTL (or sticky offline horizon) elapses. */
    private readonly onExpire: (record: StatusRecord) => void,
    /** Offline horizon (ms) before a sticky status clears. Injectable for tests. */
    private readonly stickyHorizonMs: number = STICKY_OFFLINE_HORIZON_SECONDS * 1000,
  ) {}

  private static key(roomId: string, memberId: string, toMemberId: string | null): string {
    return `${roomId} ${memberId} ${toMemberId ?? ''}`;
  }

  private static memberKey(roomId: string, memberId: string): string {
    return `${roomId} ${memberId}`;
  }

  /**
   * Upsert a `working` status. A TTL'd status (re)schedules its expiry; a sticky
   * status carries no timer (`expiresAt` null) and lapses only via idle/clear or
   * the offline horizon. `sinceAt` is preserved when the note is unchanged from an
   * existing record, and reset to now otherwise. Returns the record.
   */
  upsert(input: {
    roomId: string;
    memberId: string;
    note: string | null;
    toMemberId: string | null;
    sticky: boolean;
    ttlSeconds: number;
  }): StatusRecord {
    const key = StatusStore.key(input.roomId, input.memberId, input.toMemberId);
    const prev = this.records.get(key);
    this.clearTimer(key);
    const now = Date.now();
    // The status TEXT is what "sinceAt" tracks — a same-note refresh keeps it.
    const sinceAt = prev && prev.note === input.note ? prev.sinceAt : new Date(now).toISOString();
    const record: StatusRecord = {
      roomId: input.roomId,
      memberId: input.memberId,
      note: input.note,
      toMemberId: input.toMemberId,
      sinceAt,
      sticky: input.sticky,
      expiresAt: input.sticky ? null : new Date(now + input.ttlSeconds * 1000).toISOString(),
    };
    this.records.set(key, record);
    if (!input.sticky) {
      const timer = setTimeout(() => {
        this.records.delete(key);
        this.timers.delete(key);
        this.onExpire(record);
      }, input.ttlSeconds * 1000);
      (timer as { unref?: () => void }).unref?.();
      this.timers.set(key, timer);
    }
    return record;
  }

  /**
   * Clear statuses for a member (an `idle`). With `toMemberId` set, clears only
   * that scoped entry; with it `undefined`, clears every status for the member in
   * the room. Returns the removed records (so the route can emit for each).
   */
  clear(roomId: string, memberId: string, toMemberId?: string | null): StatusRecord[] {
    const removed: StatusRecord[] = [];
    if (toMemberId !== undefined) {
      const key = StatusStore.key(roomId, memberId, toMemberId);
      const rec = this.records.get(key);
      if (rec) {
        this.records.delete(key);
        this.clearTimer(key);
        removed.push(rec);
      }
    } else {
      for (const [key, rec] of [...this.records]) {
        if (rec.roomId === roomId && rec.memberId === memberId) {
          this.records.delete(key);
          this.clearTimer(key);
          removed.push(rec);
        }
      }
    }
    // No sticky records left for this member ⇒ drop any armed offline timer.
    if (!this.memberHasSticky(roomId, memberId)) this.cancelStickyExpiry(roomId, memberId);
    return removed;
  }

  /**
   * Whether ANY of these member ids currently holds a live `working` status
   * (across every room). Used by the hint engine to detect an agent that is busy
   * but advertising no non-idle status anywhere. Expired TTL'd entries have
   * already been reaped by their timer, so a present record means live.
   */
  anyForMembers(memberIds: Iterable<string>): boolean {
    const set = memberIds instanceof Set ? memberIds : new Set(memberIds);
    for (const rec of this.records.values()) {
      if (set.has(rec.memberId)) return true;
    }
    return false;
  }

  /** All live statuses in a room (expired entries have already been reaped). */
  list(roomId: string): StatusRecord[] {
    const out: StatusRecord[] = [];
    for (const rec of this.records.values()) if (rec.roomId === roomId) out.push(rec);
    return out;
  }

  /**
   * Arm the sticky offline-horizon countdown for a member (called by the hub when
   * the member goes offline). A no-op unless the member holds a sticky status.
   * When it fires, every sticky status for the member is cleared and `onExpire`
   * runs for each (the route emits `status.changed idle`).
   */
  armStickyExpiry(roomId: string, memberId: string): void {
    if (!this.memberHasSticky(roomId, memberId)) return;
    const mkey = StatusStore.memberKey(roomId, memberId);
    const existing = this.stickyTimers.get(mkey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.stickyTimers.delete(mkey);
      for (const [key, rec] of [...this.records]) {
        if (rec.roomId === roomId && rec.memberId === memberId && rec.sticky) {
          this.records.delete(key);
          this.onExpire(rec);
        }
      }
    }, this.stickyHorizonMs);
    (timer as { unref?: () => void }).unref?.();
    this.stickyTimers.set(mkey, timer);
  }

  /** Cancel a member's sticky offline-horizon countdown (they came back online). */
  cancelStickyExpiry(roomId: string, memberId: string): void {
    const mkey = StatusStore.memberKey(roomId, memberId);
    const timer = this.stickyTimers.get(mkey);
    if (timer) {
      clearTimeout(timer);
      this.stickyTimers.delete(mkey);
    }
  }

  /** Drop every status in a room (used when a room is hard-deleted). */
  clearRoom(roomId: string): void {
    for (const [key, rec] of [...this.records]) {
      if (rec.roomId === roomId) {
        this.records.delete(key);
        this.clearTimer(key);
      }
    }
    for (const [mkey, timer] of [...this.stickyTimers]) {
      if (mkey.startsWith(`${roomId} `)) {
        clearTimeout(timer);
        this.stickyTimers.delete(mkey);
      }
    }
  }

  /** Cancel every pending timer (called at server shutdown). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.stickyTimers.values()) clearTimeout(timer);
    this.stickyTimers.clear();
    this.records.clear();
  }

  private memberHasSticky(roomId: string, memberId: string): boolean {
    for (const rec of this.records.values()) {
      if (rec.roomId === roomId && rec.memberId === memberId && rec.sticky) return true;
    }
    return false;
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
