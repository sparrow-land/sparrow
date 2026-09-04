/**
 * Graceful shutdown.
 *
 * Without a signal handler `docker stop` was a 10-second hang followed by
 * SIGKILL of a live SQLite writer: nothing closed the database, so the WAL was
 * never checkpointed and a copied `sparrow.db` could be an empty database.
 * `app.close()` runs the Fastify `onClose` chain, which disposes the presence
 * timers and closes (and checkpoints) the database.
 *
 * The handler alone was not enough (issue #55): `close()` waits for in-flight
 * requests, and an SSE stream never finishes on its own — one `sparrow watch` or
 * one browser tab put us right back in the 10 s-then-SIGKILL hole. Ending open
 * streams is now part of closing (`preClose`, see `open-streams.ts`), and the
 * watchdog below is the last resort: if a close still outlives its cap we exit
 * NON-zero rather than let docker's countdown do it for us, so the failure is
 * visible in the exit code instead of silently costing the WAL.
 */

/** The logging surface shutdown uses (structurally satisfied by Fastify's `log`). */
export interface ShutdownLogger {
  info(obj: object, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** The subset of a Fastify instance shutdown needs. */
export interface Closable {
  close(): Promise<void>;
  log?: ShutdownLogger;
}

export interface ShutdownOptions {
  /** Signals to trap (default `SIGTERM`, `SIGINT`). */
  signals?: string[];
  /** Registration seam (default `process.on`). */
  on?: (signal: string, handler: () => void) => void;
  /** Exit seam (default `process.exit`). */
  exit?: (code: number) => void;
  /**
   * Hard cap on `close()` (default {@link CLOSE_TIMEOUT_MS}). Past it we exit
   * `1` ourselves — well inside docker's 10 s grace, so the container's own stop
   * is never the thing that kills us.
   */
  closeTimeoutMs?: number;
}

/** Default close cap: comfortably under docker's 10 s SIGKILL countdown. */
export const CLOSE_TIMEOUT_MS = 5000;

/**
 * Trap SIGTERM/SIGINT and close the app before exiting. A SECOND signal while a
 * close is already in flight exits immediately — an operator hitting Ctrl-C
 * twice, or docker's SIGKILL countdown, should never be made to wait.
 */
export function installShutdownHandlers(app: Closable, opts: ShutdownOptions = {}): void {
  const signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
  const on =
    opts.on ??
    ((signal: string, handler: () => void) => {
      process.on(signal as NodeJS.Signals, handler);
    });
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const closeTimeoutMs = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;

  let closing = false;

  const shutdown = (signal: string): void => {
    if (closing) {
      exit(1);
      return;
    }
    closing = true;
    app.log?.info({ signal }, 'sparrow API shutting down');
    // Unref'd so a clean close still exits the moment the loop drains.
    const watchdog = setTimeout(() => {
      app.log?.error({ signal, closeTimeoutMs }, 'sparrow API shutdown timed out; exiting');
      exit(1);
    }, closeTimeoutMs);
    (watchdog as { unref?: () => void }).unref?.();
    void app.close().then(
      () => {
        clearTimeout(watchdog);
        exit(0);
      },
      (err: unknown) => {
        clearTimeout(watchdog);
        app.log?.error(err, 'sparrow API shutdown failed');
        exit(1);
      },
    );
  };

  for (const signal of signals) on(signal, () => shutdown(signal));
}
