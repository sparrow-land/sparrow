import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventStreamHandle, PrincipalEvent } from '@sparrow/client';
import { MeEventStream } from './meEvents.js';

/**
 * The app's ONE `/me/events` connection. Every principal-level surface —
 * sidebar, DM activity pane, agent Activity/Email tabs, `/me/approvals`, org
 * email approvals — subscribes here instead of opening its own stream: on
 * HTTP/1.1 those extra fan-ins competed with RoomStreams' six room streams for
 * the browser's ~6 sockets per origin, and the sidebar's was the one that lost.
 */

interface FakeStream {
  onEvent: (ev: PrincipalEvent) => void;
  opts: { onOpen: () => void; since?: string };
  handle: EventStreamHandle;
  /** End this connection cleanly (the server ended the response). */
  drop: () => void;
  /** End this connection with an error (transport failure). */
  fail: () => void;
  closedByClient: boolean;
}

function fakeTransport() {
  const opened: FakeStream[] = [];
  const connect = (
    onEvent: (ev: PrincipalEvent) => void,
    opts: { onOpen: () => void; since?: string },
  ): EventStreamHandle => {
    let settle!: () => void;
    let reject!: () => void;
    const closed = new Promise<void>((res, rej) => {
      settle = res;
      reject = () => rej(new Error('stream error'));
    });
    const entry: FakeStream = {
      onEvent,
      opts,
      closedByClient: false,
      drop: () => settle(),
      fail: () => reject(),
      handle: {
        close: () => {
          entry.closedByClient = true;
          settle();
        },
        closed,
      },
    };
    opened.push(entry);
    // The real client fires onOpen once the response is established.
    opts.onOpen();
    return entry.handle;
  };
  return { opened, connect };
}

/** Flush microtasks so `closed` settlement handlers run under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const frame = (type: string, id?: string): PrincipalEvent =>
  ({ type, data: {}, ...(id ? { id } : {}) }) as PrincipalEvent;

describe('MeEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens ONE connection however many surfaces subscribe', () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect });
    const seen: string[][] = [[], [], []];
    s.subscribe((ev) => seen[0]!.push(ev.type));
    s.subscribe((ev) => seen[1]!.push(ev.type));
    s.subscribe((ev) => seen[2]!.push(ev.type));

    expect(t.opened).toHaveLength(1);
    t.opened[0]!.onEvent(frame('member.updated'));
    // One frame, fanned out to every subscriber.
    expect(seen).toEqual([['member.updated'], ['member.updated'], ['member.updated']]);
    s.dispose();
  });

  it('stays open while ANY subscriber remains, and closes after the last leaves', () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect, idleCloseMs: 250 });
    const offA = s.subscribe(() => {});
    const offB = s.subscribe(() => {});

    offA();
    vi.advanceTimersByTime(1_000);
    expect(s.connected).toBe(true);
    expect(t.opened[0]!.closedByClient).toBe(false);

    offB();
    vi.advanceTimersByTime(1_000);
    expect(s.connected).toBe(false);
    expect(t.opened[0]!.closedByClient).toBe(true);
    s.dispose();
  });

  it('a remount inside the idle window reuses the connection (no presence flap)', () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect, idleCloseMs: 250 });
    const off = s.subscribe(() => {});
    off();
    // React unmounts and remounts subtrees during navigation and in StrictMode;
    // tearing the socket down and back up would flap the principal's presence.
    vi.advanceTimersByTime(100);
    s.subscribe(() => {});
    vi.advanceTimersByTime(1_000);

    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]!.closedByClient).toBe(false);
    expect(s.connected).toBe(true);
    s.dispose();
  });

  it('reconnects after a drop and RESUMES from the last journal cursor', async () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect, reconnectMs: 2_000 });
    s.subscribe(() => {});
    expect(t.opened[0]!.opts.since).toBeUndefined();

    t.opened[0]!.onEvent(frame('message.new', '17'));
    t.opened[0]!.onEvent(frame('member.updated', '18'));
    t.opened[0]!.drop();

    // The drop settles a promise chain, so let microtasks flush before the ladder.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.opened).toHaveLength(2);
    // Resume, don't restart: the server replays 19.. rather than losing it.
    expect(t.opened[1]!.opts.since).toBe('18');
    s.dispose();
  });

  it('fires onReconnect on a RE-open only, never on the first open', async () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect, reconnectMs: 2_000 });
    const reconnects = vi.fn();
    s.subscribe(() => {});
    s.onReconnect(reconnects);
    // The first open is the caller's own mount load; nothing was missed.
    expect(reconnects).not.toHaveBeenCalled();

    t.opened[0]!.drop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.opened).toHaveLength(2);
    expect(reconnects).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('does not reconnect a stream nobody is listening to any more', async () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect, reconnectMs: 2_000, idleCloseMs: 0 });
    const off = s.subscribe(() => {});
    off();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.opened).toHaveLength(1);
    expect(s.connected).toBe(false);
    s.dispose();
  });

  it('a throwing handler cannot silence the other surfaces, or lose the cursor', async () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect });
    const seen: string[] = [];
    s.subscribe(() => {
      throw new Error('surface bug');
    });
    s.subscribe((ev) => seen.push(ev.type));

    // One shared connection: a defect in ANY subscriber must not cost the
    // sidebar its frames, nor the stream its resume point.
    expect(() => t.opened[0]!.onEvent(frame('member.updated', '42'))).not.toThrow();
    expect(seen).toEqual(['member.updated']);

    t.opened[0]!.drop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.opened[1]!.opts.since).toBe('42');
    s.dispose();
  });

  it('dispose() drops every subscriber, the cursor, and the connection', () => {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect });
    s.subscribe(() => {});
    s.dispose();
    expect(s.connected).toBe(false);
    expect(t.opened[0]!.closedByClient).toBe(true);

    // A fresh subscribe after dispose starts clean (no stale resume cursor).
    s.subscribe(() => {});
    expect(t.opened).toHaveLength(2);
    expect(t.opened[1]!.opts.since).toBeUndefined();
    s.dispose();
  });
});

/**
 * Reconnect scheduling — the presence-flap guard, inherited from RoomStreams
 * when this became the app's ONLY connection (issue #54). The server marks a
 * principal offline 30s (`PRESENCE_GRACE_SECONDS`) after its last stream drops,
 * and recycles every stream at the 15-min `STREAM_MAX_LIFETIME_SECONDS` cap, so
 * the schedule must keep every gap comfortably under the grace:
 * - a clean end of a stable stream (the lifetime recycle) reconnects
 *   immediately and synchronously (background-tab timer throttling can hold a
 *   0 ms setTimeout past the grace);
 * - errors retry on the ladder, first step 1 s, worst case 15 s < 30 s grace;
 * - a clean but instant close is NOT trusted (hot-loop guard) and backs off.
 */
describe('MeEventStream reconnect schedule', () => {
  const STABLE_MS = 10_000;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function live() {
    const t = fakeTransport();
    const s = new MeEventStream({ connect: t.connect, stableAfterMs: STABLE_MS });
    s.subscribe(() => {});
    return { t, s };
  }

  it('reconnects immediately (no timer) on a clean end of a stable stream', async () => {
    const { t, s } = live();
    expect(t.opened).toHaveLength(1);
    vi.advanceTimersByTime(15 * 60_000); // the server-side lifetime cap elapses
    t.opened[0]!.drop(); // clean server end
    await flush();
    // Reconnected synchronously — without any timer advance.
    expect(t.opened).toHaveLength(2);
    // …and it RESUMES rather than restarting (the cursor survives the recycle).
    s.dispose();
  });

  it('retries an errored stream after 1s (first ladder step)', async () => {
    const { t, s } = live();
    vi.advanceTimersByTime(60_000);
    t.opened[0]!.fail();
    await flush();
    expect(t.opened).toHaveLength(1); // not yet
    vi.advanceTimersByTime(999);
    await flush();
    expect(t.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(t.opened).toHaveLength(2);
    s.dispose();
  });

  it('caps the backoff at 15s — always under the 30s presence grace', async () => {
    const { t, s } = live();
    const gaps: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const before = t.opened.length;
      t.opened[t.opened.length - 1]!.fail();
      await flush();
      let waited = 0;
      while (t.opened.length === before && waited < 60_000) {
        vi.advanceTimersByTime(500);
        waited += 500;
        await flush();
      }
      expect(t.opened.length).toBe(before + 1);
      gaps.push(waited);
    }
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15_000);
    expect(gaps[gaps.length - 1]).toBe(15_000);
    s.dispose();
  });

  it('does not hot-loop on clean-but-instant closes: backs off like an error', async () => {
    const { t, s } = live();
    t.opened[0]!.drop(); // clean, but the stream lived < stableAfterMs
    await flush();
    expect(t.opened).toHaveLength(1); // no synchronous reconnect
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(t.opened).toHaveLength(2); // first ladder step instead
    s.dispose();
  });

  it('resets the ladder after a stable stream', async () => {
    const { t, s } = live();
    // Climb the ladder a bit with two instant failures.
    t.opened[0]!.fail();
    await flush();
    vi.advanceTimersByTime(1_000);
    await flush();
    t.opened[1]!.fail();
    await flush();
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(t.opened).toHaveLength(3);
    // Now the stream stays up past stableAfterMs, then errors: back to 1s.
    vi.advanceTimersByTime(STABLE_MS);
    t.opened[2]!.fail();
    await flush();
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(t.opened).toHaveLength(4);
    s.dispose();
  });

  it('the 15-min recycle resumes from the cursor — no gap in a long-lived tab', async () => {
    const { t, s } = live();
    t.opened[0]!.onEvent({ type: 'message.new', data: {}, id: '512' } as PrincipalEvent);
    vi.advanceTimersByTime(15 * 60_000);
    t.opened[0]!.drop();
    await flush();
    expect(t.opened[1]!.opts.since).toBe('512');
    s.dispose();
  });
});
