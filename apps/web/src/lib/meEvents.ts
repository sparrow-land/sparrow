import { useEffect, useRef } from 'react';
import type { EventStreamHandle, PrincipalEvent } from '@sparrow/client';
import { api } from './client.js';

/**
 * MeEventStream — the ONE SSE connection the web app holds, and the fan-out
 * every live surface subscribes to.
 *
 * `GET /me/events` is the server's MULTIPLEXED stream: the principal's
 * memberships fan in to it, room events arriving wrapped `{ room, ...payload }`
 * with membership recomputed on every emit, alongside the unwrapped
 * principal-level events. So one connection carries the whole tab — the sidebar,
 * every room's badges, the active room view, the agent panes and the approvals
 * queues.
 *
 * That was not always true of the CLIENT. Five surfaces once opened their own
 * `/me/events`, and {@link ../lib/roomStreams.RoomStreams} opened one stream PER
 * JOINED ROOM on top. A browser allows ~6 concurrent HTTP/1.1 connections per
 * origin and the self-host quick-start is plain HTTP/1.1, so a member of four
 * rooms — or two tabs with two rooms each — saturated the pool and every
 * subsequent request queued forever, with no error anywhere (issue #54). Now
 * everything shares this: ONE socket, ONE reconnect ladder, ONE journal cursor,
 * and ONE place a routing bug can live.
 *
 * **Resume, not just reconnect.** Every frame carries the per-principal journal
 * cursor as its SSE `id`. We remember the newest one and reopen with
 * `{ since }`, so a drop replays what was missed instead of silently losing it;
 * a cursor older than retention comes back as `replay.gap`, which the routing
 * tables treat as "refetch everything". `onReconnect` subscribers still fire as
 * the belt-and-braces reconcile.
 *
 * **Reconnect must never outlast the presence grace** (SPEC *Web UI*). The
 * server marks a principal offline `PRESENCE_GRACE_SECONDS` (30 s) after its
 * last stream drops and recycles every stream at `STREAM_MAX_LIFETIME_SECONDS`
 * (15 min), so a clean end is ROUTINE, not an incident. This discipline came
 * from RoomStreams, whose per-room connections it used to protect, and it moved
 * here when this became the only connection there is:
 *
 * - a clean end of a STABLE stream (the lifetime recycle) reconnects
 *   immediately and SYNCHRONOUSLY — not via `setTimeout`, because background-tab
 *   timer throttling can hold even a 0 ms timer past the 30 s grace;
 * - everything else (errors, and clean closes of short-lived streams, so an
 *   instantly-closing edge cannot induce a hot loop) walks the backoff ladder,
 *   capped WELL under the grace.
 */

/**
 * Reconnect delay for a dropped stream (the v3 backoff). Retained as the
 * single-step ladder callers get when they pass `reconnectMs` explicitly.
 */
export const RECONNECT_MS = 2_000;

/**
 * The backoff ladder for a stream that errored (or closed cleanly but instantly).
 * Capped at 15 s: a delay at or above the server's 30 s presence grace would
 * manufacture an online/offline flap for every burst of transient closes.
 */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** How long a stream must live before a clean end is trusted as the recycle. */
export const STABLE_AFTER_MS = 10_000;

/**
 * Grace before an idle (zero-subscriber) stream is actually closed. React
 * unmounts and remounts subtrees during navigation and in StrictMode; tearing
 * the connection down and back up on those would flap the principal's presence
 * (SPEC *Web UI → Reconnect must never outlast the grace*) for no reason.
 */
export const IDLE_CLOSE_MS = 250;

type Unsubscribe = () => void;

export interface MeEventStreamOptions {
  /** Injectable transport (tests); defaults to the real `/me/events` stream. */
  connect?: (
    onEvent: (ev: PrincipalEvent) => void,
    opts: { onOpen: () => void; since?: string },
  ) => EventStreamHandle;
  /**
   * A FIXED reconnect delay, collapsing the ladder to one step. Kept for callers
   * (and tests) that want a single predictable gap; omit it for the ladder.
   */
  reconnectMs?: number;
  /** The backoff ladder for errored/instant closes (overrides `reconnectMs`). */
  backoffMs?: number[];
  /** How long a stream must live before a clean end reconnects immediately. */
  stableAfterMs?: number;
  idleCloseMs?: number;
}

export class MeEventStream {
  private readonly opts: Required<Omit<MeEventStreamOptions, 'reconnectMs'>>;
  private subs = new Set<(ev: PrincipalEvent) => void>();
  private reconnectSubs = new Set<() => void>();
  private handle: EventStreamHandle | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private open = false;
  /** The first open is the caller's own mount load; only a RE-open missed frames. */
  private everOpened = false;
  /** Newest journal cursor seen, replayed from on reconnect. */
  private cursor: string | undefined;
  /** When the CURRENT connection was started (the stability test's clock). */
  private startedAt = 0;
  /** Consecutive unstable/failed attempts — the ladder index. */
  private attempts = 0;

  constructor(opts: MeEventStreamOptions = {}) {
    this.opts = {
      connect: opts.connect ?? ((onEvent, o) => api.meEvents(onEvent, o)),
      backoffMs:
        opts.backoffMs ?? (opts.reconnectMs !== undefined ? [opts.reconnectMs] : RECONNECT_BACKOFF_MS),
      stableAfterMs: opts.stableAfterMs ?? STABLE_AFTER_MS,
      idleCloseMs: opts.idleCloseMs ?? IDLE_CLOSE_MS,
    };
  }

  /** Receive every frame. The first subscriber opens the connection. */
  subscribe(fn: (ev: PrincipalEvent) => void): Unsubscribe {
    this.subs.add(fn);
    this.ensureOpen();
    return () => {
      this.subs.delete(fn);
      this.maybeClose();
    };
  }

  /**
   * Called on a RE-connect (never the first open): frames may have been missed
   * beyond what the journal could replay, so the surface should reconcile.
   */
  onReconnect(fn: () => void): Unsubscribe {
    this.reconnectSubs.add(fn);
    this.ensureOpen();
    return () => {
      this.reconnectSubs.delete(fn);
      this.maybeClose();
    };
  }

  /** True while a connection is held (tests; also the "am I live" probe). */
  get connected(): boolean {
    return this.open;
  }

  /** Tear everything down immediately (tests; the app never disposes). */
  dispose(): void {
    this.subs.clear();
    this.reconnectSubs.clear();
    this.cursor = undefined;
    this.everOpened = false;
    this.attempts = 0;
    this.startedAt = 0;
    this.close();
  }

  /* ------------------------------ internals ------------------------------ */

  private get wanted(): boolean {
    return this.subs.size > 0 || this.reconnectSubs.size > 0;
  }

  private ensureOpen(): void {
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    if (this.open || this.retry) return;
    this.start();
  }

  private maybeClose(): void {
    if (this.wanted || this.idle) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (!this.wanted) this.close();
    }, this.opts.idleCloseMs);
  }

  private close(): void {
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    this.open = false;
    const h = this.handle;
    this.handle = null;
    h?.close();
  }

  private start(): void {
    if (!this.wanted) return;
    this.open = true;
    this.startedAt = Date.now();
    const h = this.opts.connect(
      (ev) => {
        // Remember the journal cursor BEFORE dispatch: a handler that throws
        // must not cost us the resume point.
        if (ev.id !== undefined) this.cursor = ev.id;
        // Handlers are ISOLATED. One shared connection means one buggy surface
        // could otherwise silence every other subscriber — including the
        // sidebar — for the rest of the session.
        for (const fn of [...this.subs]) {
          try {
            fn(ev);
          } catch {
            /* a surface's own defect is not this stream's to propagate */
          }
        }
      },
      {
        onOpen: () => {
          if (!this.everOpened) {
            this.everOpened = true;
            return;
          }
          for (const fn of [...this.reconnectSubs]) fn();
        },
        ...(this.cursor !== undefined ? { since: this.cursor } : {}),
      },
    );
    this.handle = h;
    void h.closed.then(
      () => this.onClosed(h, /* clean */ true),
      () => this.onClosed(h, /* clean */ false),
    );
  }

  /**
   * Schedule the reconnect for a connection that just ended. `clean` = the
   * server ended the response without error — notably the 15-min
   * `STREAM_MAX_LIFETIME_SECONDS` recycle, which every long-lived tab hits.
   * See the reconnect note in this file's header for why a clean end of a
   * stable stream must not go through a timer at all.
   */
  private onClosed(h: EventStreamHandle, clean: boolean): void {
    // A close we initiated (or a stale handle from a previous cycle) is not a
    // drop — only reconnect for the connection we currently hold.
    if (this.handle !== h) return;
    this.handle = null;
    this.open = false;
    if (!this.wanted) return;

    const stable = Date.now() - this.startedAt >= this.opts.stableAfterMs;
    if (stable) this.attempts = 0;
    if (clean && stable) {
      this.start();
      return;
    }
    const ladder = this.opts.backoffMs;
    const delay = ladder[Math.min(this.attempts, ladder.length - 1)]!;
    this.attempts += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.start();
    }, delay);
  }
}

/** App-wide singleton — the app's one principal-level stream. */
export const meEvents = new MeEventStream();

/**
 * React binding for {@link meEvents}. Handlers are read through refs, so a
 * caller may pass fresh closures on every render without touching the stream
 * (subscribing is free; only the LAST unsubscribe can close a connection).
 */
export function useMeEventStream({
  enabled,
  onEvent,
  onReconnect,
}: {
  /** `false` subscribes to nothing — a pane with no counterpart wants no frames. */
  enabled: boolean;
  onEvent: (ev: PrincipalEvent) => void;
  /** A RE-connect (never the first open): frames may have been missed. */
  onReconnect: () => void;
}): void {
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;

  useEffect(() => {
    if (!enabled) return;
    const offEvent = meEvents.subscribe((ev) => eventRef.current(ev));
    const offReconnect = meEvents.onReconnect(() => reconnectRef.current());
    return () => {
      offEvent();
      offReconnect();
    };
  }, [enabled]);
}
