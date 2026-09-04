import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers } from './shutdown.js';

function fakeApp(close: () => Promise<void> = async () => {}) {
  const info = vi.fn();
  const error = vi.fn();
  return { close: vi.fn(close), log: { info, error } };
}

/** A stand-in for `process.on` that records what got registered. */
function recorder() {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    on: (signal: string, handler: () => void) => {
      handlers.set(signal, handler);
    },
  };
}

describe('installShutdownHandlers', () => {
  it('registers SIGTERM and SIGINT', () => {
    const rec = recorder();
    installShutdownHandlers(fakeApp(), { on: rec.on, exit: () => {} });
    expect([...rec.handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('closes the app and exits 0 on SIGTERM (no 10s docker-stop hang)', async () => {
    const rec = recorder();
    const app = fakeApp();
    const exit = vi.fn();
    installShutdownHandlers(app, { on: rec.on, exit });
    rec.handlers.get('SIGTERM')!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(app.log.info).toHaveBeenCalled();
  });

  it('exits non-zero when close() rejects, and still logs', async () => {
    const rec = recorder();
    const app = fakeApp(async () => {
      throw new Error('boom');
    });
    const exit = vi.fn();
    installShutdownHandlers(app, { on: rec.on, exit });
    rec.handlers.get('SIGINT')!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(app.log.error).toHaveBeenCalled();
  });

  it('a second signal during a slow close forces the exit instead of closing twice', async () => {
    const rec = recorder();
    let release: (() => void) | undefined;
    const app = fakeApp(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const exit = vi.fn();
    installShutdownHandlers(app, { on: rec.on, exit });
    rec.handlers.get('SIGTERM')!();
    rec.handlers.get('SIGTERM')!();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    release?.();
  });

  describe('the close watchdog', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('exits instead of hanging when close() never settles', async () => {
      vi.useFakeTimers();
      const rec = recorder();
      const app = fakeApp(() => new Promise<void>(() => {}));
      const exit = vi.fn();
      installShutdownHandlers(app, { on: rec.on, exit, closeTimeoutMs: 5000 });
      rec.handlers.get('SIGTERM')!();
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      // A close that outlives the cap is a FAILED close (nothing checkpointed),
      // so the exit code must say so rather than pretending it went cleanly.
      expect(exit).toHaveBeenCalledWith(1);
      expect(app.log.error).toHaveBeenCalled();
    });

    it('does not fire (or hold the loop) once close() finishes', async () => {
      vi.useFakeTimers();
      const rec = recorder();
      const app = fakeApp();
      const exit = vi.fn();
      installShutdownHandlers(app, { on: rec.on, exit, closeTimeoutMs: 5000 });
      rec.handlers.get('SIGTERM')!();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });
});
