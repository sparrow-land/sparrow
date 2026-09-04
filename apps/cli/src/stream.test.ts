import { describe, expect, it } from 'vitest';
import type { EventStreamHandle } from '@sparrow/client';
import { runReconnectingStream, type ReconnectResult } from './stream.js';

/**
 * A fake stream whose lifetime the test controls: `open` records the runner's
 * `onOpen`, and the test resolves/rejects `closed` to simulate a live-then-dropped
 * or a never-connected attempt.
 */
interface FakeStream {
  onOpen: () => void;
  onActivity: () => void;
  handle: EventStreamHandle;
  end: () => void; // resolve closed (natural end / drop after connecting)
  fail: (err: unknown) => void; // reject closed (never connected)
  closedCalled: boolean;
}

function fakeFactory(): {
  open: (onOpen: () => void, onActivity: () => void) => EventStreamHandle;
  streams: FakeStream[];
} {
  const streams: FakeStream[] = [];
  const open = (onOpen: () => void, onActivity: () => void = () => {}): EventStreamHandle => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const closed = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const stream: FakeStream = {
      onOpen,
      onActivity,
      end: () => resolve(),
      fail: (err) => reject(err),
      closedCalled: false,
      handle: {
        close: () => resolve(),
        closed,
      },
    };
    streams.push(stream);
    return stream.handle;
  };
  return { open, streams };
}

/**
 * A manually-driven timer registry: `setTimer`/`clearTimer` inject into the
 * runner so a test can `fire` a watchdog/max-age timer deterministically (no
 * real wall-clock waits, no fake global clock).
 */
function fakeTimers() {
  let seq = 0;
  const timers = new Map<number, { cb: () => void; ms: number }>();
  return {
    setTimer: (cb: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimer: (t: unknown): void => {
      timers.delete(t as number);
    },
    has: (t: unknown): boolean => timers.has(t as number),
    /** Ids of currently-armed timers whose delay equals `ms`. */
    idsForMs: (ms: number): number[] =>
      [...timers.entries()].filter(([, t]) => t.ms === ms).map(([id]) => id),
    /** Fire (and consume) the first armed timer with the given delay. */
    fireMs: (ms: number): void => {
      for (const [id, t] of timers) {
        if (t.ms === ms) {
          timers.delete(id);
          t.cb();
          return;
        }
      }
      throw new Error(`no armed timer for ${ms}ms`);
    },
    /** Fire a specific timer id if still armed (else no-op). */
    fireId: (id: number): void => {
      const t = timers.get(id);
      if (!t) return;
      timers.delete(id);
      t.cb();
    },
  };
}

/** Poll until `pred` is true (fake timers aren't in play — everything is microtask-driven). */
async function until(pred: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('runReconnectingStream', () => {
  it('reconnects after a drop and fires onReconnect on each successful reconnect', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    const reconnects: number[] = [];

    const done: Promise<ReconnectResult> = runReconnectingStream({
      open,
      onReconnect: () => reconnects.push(Date.now()),
      signal: controller.signal,
      sleep: async () => {}, // no real backoff wait
      random: () => 0.5,
    });

    // First connect.
    await until(() => streams.length === 1, 'first stream');
    streams[0]!.onOpen();
    // Drop it → runner should reconnect.
    streams[0]!.end();
    await until(() => streams.length === 2, 'reconnect stream');
    // The reconnect establishes → onReconnect fires exactly once (not for the initial connect).
    streams[1]!.onOpen();
    await until(() => reconnects.length === 1, 'onReconnect');

    controller.abort();
    // Abort should close the active handle and resolve.
    const result = await done;
    expect(result).toEqual({ reason: 'stopped' });
    expect(reconnects).toHaveLength(1);
  });

  it('--no-reconnect: returns "ended" on the first natural close', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    const done = runReconnectingStream({
      open,
      reconnect: false,
      signal: controller.signal,
      sleep: async () => {},
    });
    await until(() => streams.length === 1, 'stream');
    streams[0]!.onOpen();
    streams[0]!.end();
    expect(await done).toEqual({ reason: 'ended' });
    expect(streams).toHaveLength(1); // no reconnect attempt
  });

  it('--no-reconnect: a stream error surfaces as "error"', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    const boom = new Error('stream boom');
    const done = runReconnectingStream({
      open,
      reconnect: false,
      signal: controller.signal,
      sleep: async () => {},
    });
    await until(() => streams.length === 1, 'stream');
    streams[0]!.fail(boom);
    expect(await done).toEqual({ reason: 'error', error: boom });
  });

  it('retryMaxMs: exhausts (non-zero exit) when the failure window elapses', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    let clock = 0;
    const done = runReconnectingStream({
      open,
      retryMaxMs: 100,
      signal: controller.signal,
      // each backoff advances the fake clock past the window.
      sleep: async () => {
        clock += 60;
      },
      now: () => clock,
      random: () => 0,
    });
    // Never connects: fail every attempt as it appears until the runner gives up.
    let settled = false;
    void done.then(() => (settled = true));
    let i = 0;
    while (!settled) {
      await until(() => streams.length > i || settled, `stream ${i}`);
      if (settled) break;
      streams[i]!.fail(new Error('down'));
      i += 1;
    }
    // Window (100ms) elapses after enough 60ms backoffs with no successful connect.
    expect(await done).toEqual({ reason: 'exhausted' });
  });

  it('a successful connect resets the retry window (long-lived stream never exhausts)', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    let clock = 0;
    const done = runReconnectingStream({
      open,
      retryMaxMs: 100,
      signal: controller.signal,
      sleep: async () => {
        clock += 60;
      },
      now: () => clock,
      random: () => 0,
    });
    await until(() => streams.length === 1, 's1');
    streams[0]!.onOpen(); // connects
    streams[0]!.end(); // then drops → window opens
    await until(() => streams.length === 2, 's2');
    streams[1]!.onOpen(); // reconnects → window resets
    streams[1]!.end();
    await until(() => streams.length === 3, 's3');
    // Still going (not exhausted) because each connect reset the window.
    controller.abort();
    expect(await done).toEqual({ reason: 'stopped' });
  });

  it('watchdog: a stale (no-activity) stream is forcibly reconnected', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    const timers = fakeTimers();
    const stale: number[] = [];
    const reconnects: number[] = [];
    const done = runReconnectingStream({
      open,
      signal: controller.signal,
      sleep: async () => {},
      staleMs: 1000,
      onStale: (ms) => stale.push(ms),
      onReconnect: () => reconnects.push(1),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await until(() => streams.length === 1, 's1');
    streams[0]!.onOpen(); // established → arms the watchdog
    expect(timers.idsForMs(1000)).toHaveLength(1);
    // No activity arrives → the watchdog fires.
    timers.fireMs(1000);
    await until(() => stale.length === 1, 'onStale');
    expect(stale[0]).toBe(1000);
    // …which force-closes the socket and reconnects from scratch.
    await until(() => streams.length === 2, 's2');
    streams[1]!.onOpen();
    await until(() => reconnects.length === 1, 'onReconnect after stale');

    controller.abort();
    expect(await done).toEqual({ reason: 'stopped' });
  });

  it('watchdog: activity resets the timer (a live-but-quiet stream is not torn down)', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    const timers = fakeTimers();
    const stale: number[] = [];
    const done = runReconnectingStream({
      open,
      signal: controller.signal,
      sleep: async () => {},
      staleMs: 1000,
      onStale: (ms) => stale.push(ms),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await until(() => streams.length === 1, 's1');
    streams[0]!.onOpen();
    const firstId = timers.idsForMs(1000)[0]!;
    // A heartbeat arrives → the old watchdog is cleared and a fresh one armed.
    streams[0]!.onActivity();
    expect(timers.has(firstId)).toBe(false);
    expect(timers.idsForMs(1000)).toHaveLength(1);
    // Firing the STALE (already-cleared) timer must do nothing.
    timers.fireId(firstId);
    expect(stale).toHaveLength(0);
    expect(streams).toHaveLength(1); // no reconnect

    controller.abort();
    expect(await done).toEqual({ reason: 'stopped' });
  });

  it('watchdog covers the establishment phase: a hung connect attempt is torn down and retried', async () => {
    // Regression (2026-08-28 prod): a reconnect attempt whose HTTP response
    // stalls at the tunnel edge never fires onOpen or onActivity — with the
    // watchdog armed only from onOpen, the attempt hung indefinitely while the
    // server (and its replay) was one fresh request away.
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    const timers = fakeTimers();
    const stale: number[] = [];
    const done = runReconnectingStream({
      open,
      signal: controller.signal,
      sleep: async () => {},
      staleMs: 1000,
      onStale: (ms) => stale.push(ms),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    // First attempt: the response never establishes (no onOpen, no bytes) —
    // a watchdog must already be armed for the establishment phase itself.
    await until(() => streams.length === 1, 's1 (hung attempt)');
    expect(timers.idsForMs(1000)).toHaveLength(1);
    timers.fireMs(1000); // hung → forced teardown, immediate retry
    await until(() => stale.length === 1, 'onStale for hung attempt');
    await until(() => streams.length === 2, 's2 (retried attempt)');
    // The retry's establishment phase is covered too.
    expect(timers.idsForMs(1000)).toHaveLength(1);
    // And a retry that DOES establish keeps normal watchdog behavior.
    streams[1]!.onOpen();
    expect(timers.idsForMs(1000)).toHaveLength(1);

    controller.abort();
    expect(await done).toEqual({ reason: 'stopped' });
  });

  it('max-age: the stream is torn down and re-established at the interval', async () => {
    const { open, streams } = fakeFactory();
    const controller = new AbortController();
    const timers = fakeTimers();
    const maxAge: number[] = [];
    const done = runReconnectingStream({
      open,
      signal: controller.signal,
      sleep: async () => {},
      maxStreamAgeMs: 5000,
      onMaxAge: () => maxAge.push(1),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await until(() => streams.length === 1, 's1');
    streams[0]!.onOpen(); // arms the max-age teardown
    expect(timers.idsForMs(5000)).toHaveLength(1);
    // Interval elapses → unconditional teardown + re-establish.
    timers.fireMs(5000);
    await until(() => maxAge.length === 1, 'onMaxAge');
    await until(() => streams.length === 2, 's2 (re-established)');

    controller.abort();
    expect(await done).toEqual({ reason: 'stopped' });
  });
});
