/**
 * Auto-reconnecting SSE runner — the reliability layer under `sparrow watch` and
 * `sparrow loop`. `client.consume()` (and thus `events`/`meEvents`) has NO reconnect
 * logic: a dropped stream (server restart, tunnel recycle) just resolves `closed`,
 * and for an agent that silently drops presence (presence = holding the stream
 * open). This orchestrates repeated (re)connects with jittered exponential
 * backoff on top of the unchanged client, so web/mcp keep the raw single-shot
 * semantics while the CLI gets resilience.
 *
 * Detection of a *successful* (re)connect rides the additive `onOpen` option the
 * client fires once the SSE response is established. The first `onOpen` is the
 * initial connect; every subsequent one is a reconnect (resets the backoff and
 * fires `onReconnect`).
 */
import type { EventStreamHandle } from '@sparrow/client';

export interface BackoffConfig {
  /** First-retry base delay (ms). */
  baseMs?: number;
  /** Upper bound on the pre-jitter delay (ms) — the "cap ~15-30s". */
  capMs?: number;
  /** Growth factor per consecutive failed attempt. */
  factor?: number;
}

export interface ReconnectRunnerOptions {
  /**
   * Open one stream, wiring `onOpen`/`onActivity` to the client's
   * {@link EventStreamOptions} so the runner learns when the connection is live
   * and when bytes (events OR heartbeats) arrive. Returns the handle.
   */
  open: (onOpen: () => void, onActivity: () => void) => EventStreamHandle;
  /** `false` restores the old single-shot behavior (return on first close). Default `true`. */
  reconnect?: boolean;
  /** Called after each SUCCESSFUL reconnect (never for the initial connect). */
  onReconnect?: () => void;
  /**
   * Cap (ms) on the CONTINUOUS-failure window (time since the last successful
   * connect, or since the first attempt if never connected). Exceeding it ends
   * with `exhausted`. Undefined = retry forever.
   */
  retryMaxMs?: number;
  backoff?: BackoffConfig;
  /**
   * Heartbeat watchdog: if NO bytes (events or heartbeats) arrive within this
   * window, force-close the (silently half-open) socket and reconnect.
   * Undefined disables the watchdog. This is what breaks a ZOMBIE stream — a
   * server replaced behind a tunnel leaves the client's socket half-open, so
   * `read()` blocks forever and no error/close ever fires. The window covers
   * the ESTABLISHMENT phase too: an attempt whose response stalls before
   * `onOpen` (a tunnel edge buffering the reply) is torn down and retried
   * just like a stalled live stream, instead of hanging with no timer armed.
   */
  staleMs?: number;
  /** Called when the watchdog trips (arg: the configured `staleMs`), before reconnecting. */
  onStale?: (staleMs: number) => void;
  /**
   * Belt-and-suspenders periodic re-initiation: unconditionally tear down and
   * re-establish the stream every this-many ms, even when healthy. Undefined
   * disables it.
   */
  maxStreamAgeMs?: number;
  /** Called when the max-age teardown trips, before re-establishing. */
  onMaxAge?: () => void;
  /**
   * Classify a stream error as TERMINAL — one no retry can clear, so the runner
   * ends with `error` instead of backing off and reconnecting forever. The case
   * it exists for is the server's client-version floor (`426
   * client_upgrade_required`): every reconnect re-sends the same version header,
   * so a retry loop just burns the connection budget while the agent stays deaf.
   * Undefined = every error is retryable (the prior behavior).
   */
  isFatal?: (error: unknown) => boolean;
  /** Stop signal (SIGINT). Aborting closes the active stream and ends with `stopped`. */
  signal: AbortSignal;
  // -------- injectables (tests) --------
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Schedule a one-shot timer; returns an opaque handle. Defaults to `setTimeout` (unref'd). */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a timer from {@link setTimer}. Defaults to `clearTimeout`. */
  clearTimer?: (timer: unknown) => void;
}

export type ReconnectResult =
  | { reason: 'stopped' } // aborted via the signal (Ctrl-C) — a clean exit
  | { reason: 'ended' } // stream closed and reconnect is disabled — a clean exit
  | { reason: 'exhausted' } // retryMax window elapsed while disconnected — a failure
  | { reason: 'error'; error: unknown }; // closed threw and reconnect is disabled — a failure

/** Resolve after `ms`, or immediately when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Equal-jitter backoff: half the computed delay plus up to half at random. */
function jitter(delay: number, random: () => number): number {
  return delay / 2 + random() * (delay / 2);
}

/**
 * Drive one logical stream across reconnects until stopped, exhausted, or (when
 * `reconnect` is false) the first close. Never throws — every outcome is a
 * {@link ReconnectResult}.
 */
export async function runReconnectingStream(opts: ReconnectRunnerOptions): Promise<ReconnectResult> {
  const reconnect = opts.reconnect ?? true;
  const baseMs = opts.backoff?.baseMs ?? 1_000;
  const capMs = opts.backoff?.capMs ?? 20_000;
  const factor = opts.backoff?.factor ?? 2;
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const setTimer =
    opts.setTimer ??
    ((cb: () => void, ms: number): unknown => {
      const t = setTimeout(cb, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
  const clearTimer = opts.clearTimer ?? ((t: unknown): void => clearTimeout(t as ReturnType<typeof setTimeout>));
  const { signal } = opts;

  let attempt = 0; // consecutive failed attempts (drives the backoff ladder)
  let everConnected = false;
  let retryWindowStart: number | undefined;

  for (;;) {
    if (signal.aborted) return { reason: 'stopped' };

    // Per-connection lifecycle: the watchdog + max-age timers, plus a `forced`
    // flag distinguishing an intentional teardown (reconnect at once, no backoff,
    // no retry-window penalty) from a genuine drop.
    let handle: EventStreamHandle | undefined;
    let staleTimer: unknown;
    let ageTimer: unknown;
    let forced = false;
    const clearLifecycleTimers = (): void => {
      if (staleTimer !== undefined) clearTimer(staleTimer);
      if (ageTimer !== undefined) clearTimer(ageTimer);
      staleTimer = undefined;
      ageTimer = undefined;
    };
    const armWatchdog = (): void => {
      if (opts.staleMs === undefined) return;
      if (staleTimer !== undefined) clearTimer(staleTimer);
      staleTimer = setTimer(() => {
        forced = true;
        opts.onStale?.(opts.staleMs!);
        handle?.close(); // abort the half-open socket → `closed` resolves → reconnect
      }, opts.staleMs);
    };

    // Arm before opening: the watchdog must cover the establishment phase (a
    // stalled response never fires onOpen/onActivity, and only this timer can
    // break out of a hung attempt).
    armWatchdog();
    handle = opts.open(
      () => {
        // A live connection: reset the backoff + retry window; a reconnect fires
        // the callback (the first connect does not).
        if (everConnected) opts.onReconnect?.();
        everConnected = true;
        attempt = 0;
        retryWindowStart = undefined;
        armWatchdog(); // treat "established" as fresh activity
        if (opts.maxStreamAgeMs !== undefined && ageTimer === undefined) {
          ageTimer = setTimer(() => {
            forced = true;
            opts.onMaxAge?.();
            handle?.close();
          }, opts.maxStreamAgeMs);
        }
      },
      () => armWatchdog(), // any byte (event or heartbeat) resets the watchdog
    );

    const onAbort = (): void => handle!.close();
    signal.addEventListener('abort', onAbort, { once: true });
    let closedError: unknown;
    try {
      await handle.closed;
    } catch (err) {
      closedError = err;
    } finally {
      signal.removeEventListener('abort', onAbort);
      clearLifecycleTimers();
    }

    if (signal.aborted) return { reason: 'stopped' };
    // A terminal failure (client below the server's version floor) short-circuits
    // reconnect entirely — it would fail identically forever.
    if (closedError !== undefined && opts.isFatal?.(closedError)) {
      return { reason: 'error', error: closedError };
    }
    if (!reconnect) {
      return closedError !== undefined ? { reason: 'error', error: closedError } : { reason: 'ended' };
    }

    // A forced teardown (watchdog/max-age) is intentional, not a failure:
    // reconnect immediately without backoff and without opening the retry window.
    if (forced) continue;

    if (retryWindowStart === undefined) retryWindowStart = now();
    if (opts.retryMaxMs !== undefined && now() - retryWindowStart >= opts.retryMaxMs) {
      return { reason: 'exhausted' };
    }

    const delay = jitter(Math.min(capMs, baseMs * factor ** attempt), random);
    attempt += 1;
    await sleep(delay, signal);
    if (signal.aborted) return { reason: 'stopped' };
  }
}
