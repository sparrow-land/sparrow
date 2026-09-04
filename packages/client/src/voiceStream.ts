/**
 * Streaming speech-to-text transport (voice v2, hands-free mode).
 *
 * `POST /voice/transcriptions` stays the one-shot path; this is the *live* one:
 * a WebSocket at `GET /api/v1/voice/transcriptions/stream` carrying raw PCM up
 * and words down, so a speaker sees the transcript form as they talk. It is
 * bidirectional by nature — audio up, partials down — which is exactly what SSE
 * cannot do without a second channel per chunk, and the vendor side is a
 * WebSocket too.
 *
 * Wire (see SPEC / docs/design/hands-free-v2.md):
 * - client → server: **binary** frames = raw PCM16, 16 kHz, mono, little-endian;
 *   **text** frames = `{"type":"commit"}` (finalize) / `{"type":"close"}`.
 * - server → client: `{"type":"partial","text"}`, `{"type":"committed","text"}`,
 *   `{"type":"error","message"}` (then the server closes).
 *
 * Auth matches `/me/events`: a browser rides the same-origin session cookie, an
 * agent key travels as `?token=` (a WebSocket handshake carries no
 * `Authorization` header, which is why the query parameter exists at all).
 *
 * This module is deliberately DOM-lib-free: it talks to a structural
 * {@link WebSocketLike}, so it typechecks under the package's `lib: ES2022` and
 * a test can drive a fake socket by hand.
 */

/** The route, under the API's `/api/v1` prefix. */
export const VOICE_STREAM_PATH = '/api/v1/voice/transcriptions/stream';

/** The slice of the browser/Node `WebSocket` this helper actually uses. */
export interface WebSocketLike {
  readyState: number;
  send(data: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

/** Frames the caller cares about; everything else on the socket is ignored. */
export interface TranscriptionStreamHandlers {
  /** The in-flight guess for what is being said right now (replaces the last). */
  onPartial?: (text: string) => void;
  /** A finalized segment — append it to the transcript. */
  onCommitted?: (text: string) => void;
  /** A server error frame, or a transport failure. The stream is over. */
  onError?: (message: string) => void;
  /** The socket is open and queued audio has been flushed. */
  onOpen?: () => void;
  /** Fired exactly once, whoever closed it. */
  onClose?: () => void;
}

export interface TranscriptionStream {
  /** Push one PCM16 frame (binary). Buffered until the socket opens. */
  send(pcm16: ArrayBuffer): void;
  /** "I'm done speaking" — ask the vendor to finalize; a `committed` follows. */
  commit(): void;
  /** Close politely (close frame, then the socket). Idempotent. */
  close(): void;
  /** True until {@link close} or a transport failure. */
  readonly open: boolean;
}

export interface OpenTranscriptionStreamOptions {
  /** Socket factory — the global `WebSocket` by default; a fake in tests. */
  createSocket?: (url: string) => WebSocketLike;
}

/**
 * Build the `ws(s)://…/voice/transcriptions/stream` URL for a server origin.
 * `http` → `ws`, `https` → `wss`; an empty origin (the web app, served BY the
 * API at the same origin) resolves against the page's own location.
 */
export function voiceStreamUrl(server: string, opts: { token?: string } = {}): string {
  const origin = server.replace(/\/+$/, '') || pageOrigin();
  const ws = origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const query = opts.token ? `?token=${encodeQuery(opts.token)}` : '';
  return `${ws}${VOICE_STREAM_PATH}${query}`;
}

function pageOrigin(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin ?? '';
}

/** `URLSearchParams`-compatible encoding (space → `+`), no DOM types needed. */
function encodeQuery(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function defaultSocket(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('WebSocket is not available in this runtime');
  return new Ctor(url);
}

/**
 * Open a streaming-transcription session. Audio pushed before the handshake
 * completes is QUEUED and flushed on open — capture starts the moment the user
 * taps, and the first quarter-second of speech must not be the price of a
 * round-trip.
 */
export function openTranscriptionStream(
  url: string,
  handlers: TranscriptionStreamHandlers = {},
  opts: OpenTranscriptionStreamOptions = {},
): TranscriptionStream {
  const socket = (opts.createSocket ?? defaultSocket)(url);
  let opened = false;
  let done = false;
  let closeReported = false;
  /** A commit asked for before the handshake landed — flushed on open. */
  let pendingCommit = false;
  const queue: ArrayBuffer[] = [];

  const reportClose = () => {
    if (closeReported) return;
    closeReported = true;
    handlers.onClose?.();
  };

  socket.onopen = () => {
    opened = true;
    if (done) return; // closed before the handshake landed — drop the queue
    for (const buf of queue.splice(0)) {
      try {
        socket.send(buf);
      } catch {
        /* the socket died mid-flush; onerror/onclose carry the news */
      }
    }
    // A short phrase and a fast Send can beat the handshake. The commit belongs
    // AFTER the audio it finalizes, so it rides out here rather than being
    // dropped — otherwise the vendor never finalizes and the utterance is lost
    // with nothing on screen to explain it.
    if (pendingCommit) {
      pendingCommit = false;
      try {
        socket.send('{"type":"commit"}');
      } catch {
        /* ditto */
      }
    }
    handlers.onOpen?.();
  };

  socket.onmessage = (ev) => {
    const frame = parseFrame(ev.data);
    if (!frame) return;
    if (frame.type === 'partial') handlers.onPartial?.(frame.text);
    else if (frame.type === 'committed') handlers.onCommitted?.(frame.text);
    else {
      done = true;
      handlers.onError?.(frame.message);
    }
  };

  socket.onerror = () => {
    if (done) return;
    done = true;
    handlers.onError?.('Voice connection failed. Please try again.');
  };

  socket.onclose = () => {
    done = true;
    reportClose();
  };

  return {
    get open() {
      return !done;
    },
    send(pcm16: ArrayBuffer) {
      if (done) return;
      if (!opened) {
        queue.push(pcm16);
        return;
      }
      try {
        socket.send(pcm16);
      } catch {
        /* closing underneath us; onclose reports it */
      }
    },
    commit() {
      if (done) return;
      if (!opened) {
        pendingCommit = true;
        return;
      }
      try {
        socket.send('{"type":"commit"}');
      } catch {
        /* ditto */
      }
    },
    close() {
      // `done` is also set by a transport failure and by the server's own
      // close, and in the first of those the socket is still ours to release —
      // a failed WebSocket nobody closes keeps the vendor session alive to its
      // cap. So always attempt the close; `closeReported` keeps it idempotent.
      const first = !done;
      done = true;
      pendingCommit = false;
      queue.length = 0;
      if (first) {
        try {
          if (opened) socket.send('{"type":"close"}');
        } catch {
          /* already gone */
        }
      }
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      reportClose();
    },
  };
}

type Frame =
  | { type: 'partial'; text: string }
  | { type: 'committed'; text: string }
  | { type: 'error'; message: string };

/** Decode one server frame; anything unrecognized (or non-JSON) yields null. */
function parseFrame(data: unknown): Frame | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as { type?: unknown; text?: unknown; message?: unknown };
  if ((o.type === 'partial' || o.type === 'committed') && typeof o.text === 'string') {
    return { type: o.type, text: o.text };
  }
  if (o.type === 'error') {
    return {
      type: 'error',
      message: typeof o.message === 'string' ? o.message : 'Transcription failed.',
    };
  }
  return null;
}
