/**
 * The live {@link WorkSource} for `sparrow harness`: an auto-reconnecting
 * `/me/events` stream.
 *
 * Holding this stream is the whole reason harness mode makes an agent honestly
 * ONLINE — presence rides the socket, and the socket lives for the life of the
 * process rather than the life of a session. The events themselves are only a
 * PROMPT: the harness reads nothing out of them except a clawback, because the
 * inbox peek is the source of truth about what is waiting.
 *
 * Deliberately NOT sharing the `/me/events` cursor with `await`/`watch`/`loop`:
 * the harness re-peeks the inbox on every connect, so it can never miss work by
 * starting live, and a shared high-water mark between two listeners on one
 * profile is a way to lose events, not to save them.
 */
import type { EventStreamHandle, PrincipalEvent, SparrowClient } from '@sparrow/client';
import { runReconnectingStream } from '../stream.js';
import type { WorkSource } from './orchestrator.js';

export interface StreamSourceOptions {
  client: SparrowClient;
  /** Force a reconnect after this long with no bytes at all (0/undefined disables). */
  staleMs?: number;
  /** Re-establish the stream this often even when healthy. */
  maxStreamAgeMs?: number;
  /** Ask the inbox this often regardless of the stream, so a black-holed socket can't hide work. */
  pollMs?: number;
  /** Classify a stream error as unretryable (the 426 client-version floor). */
  isFatal?: (error: unknown) => boolean;
}

/** Build the default work source: `/me/events`, reconnecting, plus a floor poll. */
export function streamWorkSource(opts: StreamSourceOptions): WorkSource {
  return async (handlers, signal) => {
    const onEvent = (e: PrincipalEvent): void => {
      switch (e.type) {
        case 'message.new':
        case 'email.received':
        case 'replay.gap':
          handlers.onWork(e.type);
          return;
        case 'message.clawback': {
          const data = e.data as { messageId?: string };
          if (data?.messageId) handlers.onClawback(data.messageId);
          return;
        }
        default:
          return; // every other frame is somebody else's business
      }
    };

    let opened = false;
    const open = (onOpen: () => void, onActivity: () => void): EventStreamHandle =>
      opts.client.meEvents(onEvent, {
        // Quiet like the listener trio: presence/status frames are somebody
        // else's business and the server need not write them to us at all.
        quiet: ['presence', 'status'],
        onOpen: () => {
          onOpen();
          if (!opened) {
            opened = true;
            handlers.onOnline();
          }
        },
        onActivity,
      });

    // The floor: even a stream that has gone silently black-holed cannot delay
    // a reply by more than this, because the inbox is asked directly.
    const poll =
      opts.pollMs && opts.pollMs > 0
        ? setInterval(() => handlers.onWork('poll'), opts.pollMs)
        : undefined;
    (poll as unknown as { unref?: () => void } | undefined)?.unref?.();

    try {
      const result = await runReconnectingStream({
        open,
        signal,
        staleMs: opts.staleMs,
        maxStreamAgeMs: opts.maxStreamAgeMs,
        isFatal: opts.isFatal,
        onReconnect: () => handlers.onReconnect(),
        onStale: (ms) => handlers.onNote(`stale stream (no data for ${ms / 1000}s) — reconnecting`),
        onMaxAge: () => handlers.onNote('refreshing the events stream'),
      });
      if (result.reason === 'error') return { error: result.error };
      if (result.reason === 'exhausted') {
        return { error: new Error('lost the events stream and could not reconnect') };
      }
      return {};
    } finally {
      if (poll !== undefined) clearInterval(poll);
    }
  };
}
