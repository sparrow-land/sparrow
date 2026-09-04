/**
 * Open-stream registry (issue #55).
 *
 * A Server-Sent Events response is a request that never finishes: the route
 * hijacks the reply and keeps writing frames until the client goes away. Fastify's
 * `close()` waits for in-flight requests, so ONE open stream — a single
 * `sparrow watch`, a single browser tab — pinned the close forever: `docker stop`
 * burned its full 10 s grace and then SIGKILLed a live SQLite writer, which meant
 * the `onClose` chain (dispose timers → WAL checkpoint → close the database)
 * never ran and a `sparrow.db` copied afterwards silently lost every write since
 * the last automatic checkpoint.
 *
 * The fix lives here, at the socket/response layer, NOT in the event routes: the
 * server tracks every response it starts and, in Fastify's `preClose` hook (which
 * runs BEFORE the HTTP server stops), flushes a final comment to each still-open
 * event stream and ends it. Clients see a clean EOF and reconnect-with-resume the
 * way they already do for the stream lifetime cap; the close then proceeds
 * immediately to the database checkpoint.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

/** The last thing a stopping server says on a stream, before EOF. */
const GOODBYE_FRAME = ': shutdown\n\n';

/**
 * How long to let a socket half-close gracefully before destroying it. The peer
 * normally closes the moment it reads EOF (well under a millisecond on
 * loopback); this bounds the pathological case — a black-holed tunnel edge that
 * never acknowledges — so `server.close()` can never wait on it.
 */
const SOCKET_LINGER_MS = 250;

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * End every open SSE response (see {@link trackOpenStreams}) and return how
     * many were ended. Runs automatically in `preClose`; exposed for tests and
     * for a shutdown path that wants to log the count.
     */
    closeOpenStreams(): number;
  }
}

/**
 * Do these `writeHead()` arguments declare an event stream? Node's
 * `getHeader()`/`getHeaders()` are BLIND to headers passed straight to
 * `writeHead()` (they only report what `setHeader()` recorded), and the SSE
 * routes write their preamble that way — so the content type has to be read off
 * the call itself. Accepts both shapes: an object of headers, or the raw
 * `[name, value, ...]` array form.
 */
function declaresEventStream(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  if (Array.isArray(headers)) {
    return headers.some(
      (entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'),
    );
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() !== 'content-type') continue;
    return String(value).toLowerCase().includes('text/event-stream');
  }
  return false;
}

/**
 * End one streaming response: goodbye comment, `end()`, then a graceful
 * half-close of the socket with a hard destroy as the backstop. Every step is
 * best-effort — a connection that died mid-shutdown is exactly the outcome we
 * want anyway.
 */
function endStream(res: ServerResponse): void {
  try {
    res.write(GOODBYE_FRAME);
  } catch {
    /* connection already gone */
  }
  try {
    res.end();
  } catch {
    /* already ended */
  }
  // `res.end()` leaves a keep-alive socket idle-but-open, and `server.close()`
  // waits for open sockets. FIN it (queued behind the bytes above, so the client
  // still reads the final frame), then destroy if the peer never answers.
  const socket = res.socket;
  if (!socket || socket.destroyed) return;
  try {
    socket.end();
  } catch {
    /* already closing */
  }
  const linger = setTimeout(() => {
    try {
      socket.destroy();
    } catch {
      /* already destroyed */
    }
  }, SOCKET_LINGER_MS);
  linger.unref?.();
}

/**
 * Track this instance's in-flight responses and end the streaming ones when the
 * app closes. Call once, right after the Fastify instance is created — the
 * `onRequest` hook must be registered before any route runs.
 */
export function trackOpenStreams(app: FastifyInstance): void {
  const open = new Set<ServerResponse>();

  app.addHook('onRequest', (_request, reply, done) => {
    const res = reply.raw;
    // Registration happens at `writeHead()` time, so the set holds ONLY event
    // streams: an ordinary request is never at risk of being cut off by a
    // shutdown, and nothing is retained for the requests that make up ~all of
    // the traffic.
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
    res.writeHead = ((...args: unknown[]) => {
      // Any argument can be the headers (the `(status, headers)` and
      // `(status, statusMessage, headers)` overloads both exist).
      if (args.some((arg) => declaresEventStream(arg))) {
        open.add(res);
        // `close` fires for a finished response AND for a dropped connection,
        // so the set only ever holds live streams (no leak across a long uptime).
        res.on('close', () => open.delete(res));
      }
      return writeHead(...args);
    }) as ServerResponse['writeHead'];
    done();
  });

  app.decorate('closeOpenStreams', (): number => {
    let ended = 0;
    for (const res of open) {
      if (res.writableEnded) continue;
      endStream(res);
      ended += 1;
    }
    return ended;
  });

  // `preClose` runs before the HTTP server stops accepting/waiting; `onClose`
  // (where the database is closed) would be far too late.
  app.addHook('preClose', async () => {
    const ended = app.closeOpenStreams();
    if (ended > 0) app.log.info({ streams: ended }, 'ended open event streams for shutdown');
  });
}
