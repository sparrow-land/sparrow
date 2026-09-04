import { describe, expect, it, vi } from 'vitest';
import { SparrowClient } from './client.js';
import {
  VOICE_STREAM_PATH,
  openTranscriptionStream,
  voiceStreamUrl,
  type WebSocketLike,
} from './voiceStream.js';

/* ------------------------------------------------------------------ *
 * A minimal fake WebSocket: records every frame, lets the test drive
 * open/message/error/close by hand.
 * ------------------------------------------------------------------ */

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | null = null;
  readonly url: string;
  readyState = 0; // CONNECTING
  sent: Array<string | ArrayBufferLike> = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  send(data: string | ArrayBufferLike): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason });
  }

  /* test drivers */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }
  fail(): void {
    this.onerror?.({});
  }
}

function openStream(handlers: Parameters<typeof openTranscriptionStream>[1] = {}) {
  const stream = openTranscriptionStream('ws://x/stream', handlers, {
    createSocket: (url) => new FakeSocket(url),
  });
  return { stream, socket: FakeSocket.last! };
}

/* ================================================================== *
 * URL building
 * ================================================================== */

describe('voiceStreamUrl', () => {
  it('maps http → ws and appends the streaming path', () => {
    expect(voiceStreamUrl('http://localhost:8722')).toBe(
      `ws://localhost:8722${VOICE_STREAM_PATH}`,
    );
  });

  it('maps https → wss', () => {
    expect(voiceStreamUrl('https://sparrow.example.com')).toBe(
      `wss://sparrow.example.com${VOICE_STREAM_PATH}`,
    );
  });

  it('tolerates a trailing slash on the server origin', () => {
    expect(voiceStreamUrl('https://sparrow.example.com/')).toBe(
      `wss://sparrow.example.com${VOICE_STREAM_PATH}`,
    );
  });

  it('passes an agent key as ?token= (a browser rides the session cookie instead)', () => {
    expect(voiceStreamUrl('http://localhost:8722', { token: 'agk_a b' })).toBe(
      `ws://localhost:8722${VOICE_STREAM_PATH}?token=agk_a+b`,
    );
  });

  it('falls back to the page origin when the server is empty (same-origin web app)', () => {
    vi.stubGlobal('location', { origin: 'https://app.example.com' });
    try {
      expect(voiceStreamUrl('')).toBe(`wss://app.example.com${VOICE_STREAM_PATH}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is exposed on the client, carrying its configured server and credential', () => {
    const anon = new SparrowClient({ server: 'https://sparrow.example.com' });
    expect(anon.voiceStreamUrl()).toBe(`wss://sparrow.example.com${VOICE_STREAM_PATH}`);
    const authed = new SparrowClient({ server: 'http://localhost:8722', token: 'agk_k' });
    expect(authed.voiceStreamUrl()).toBe(`ws://localhost:8722${VOICE_STREAM_PATH}?token=agk_k`);
  });
});

/* ================================================================== *
 * The stream helper
 * ================================================================== */

describe('openTranscriptionStream', () => {
  it('opens a socket at the given URL', () => {
    const { socket } = openStream();
    expect(socket.url).toBe('ws://x/stream');
  });

  it('queues audio pushed before the socket opens and flushes it in order', () => {
    const { stream, socket } = openStream();
    const a = new Uint8Array([1, 2]).buffer;
    const b = new Uint8Array([3, 4]).buffer;
    stream.send(a);
    stream.send(b);
    expect(socket.sent).toHaveLength(0); // nothing lost, nothing thrown
    socket.open();
    expect(socket.sent).toEqual([a, b]);
  });

  it('sends audio straight through once open', () => {
    const { stream, socket } = openStream();
    socket.open();
    const buf = new Uint8Array([9]).buffer;
    stream.send(buf);
    expect(socket.sent).toEqual([buf]);
  });

  it('commit() sends the commit text frame', () => {
    const { stream, socket } = openStream();
    socket.open();
    stream.commit();
    expect(socket.sent).toEqual(['{"type":"commit"}']);
  });

  it('close() sends the close frame and closes the socket', () => {
    const { stream, socket } = openStream();
    socket.open();
    stream.close();
    expect(socket.sent).toEqual(['{"type":"close"}']);
    expect(socket.closed).not.toBeNull();
  });

  it('flushes a commit issued before the socket opened, right after the audio', () => {
    // A short phrase and a fast Send: the tap can beat the handshake. Dropping
    // the commit there loses the whole utterance with nothing on screen to say
    // so — the vendor never finalizes and no `committed` ever comes back.
    const { stream, socket } = openStream();
    const audio = new Uint8Array([7]).buffer;
    stream.send(audio);
    stream.commit();
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent).toEqual([audio, '{"type":"commit"}']);
  });

  it('close() after a transport failure still closes the socket, and stays idempotent', () => {
    const onClose = vi.fn();
    const { stream, socket } = openStream({ onClose });
    socket.open();
    socket.fail(); // the stream is over as far as the caller is concerned
    stream.close();
    // The socket itself must still be released — a failed WebSocket that is
    // never closed keeps the vendor session (and its 10-minute cap) alive.
    expect(socket.closed).not.toBeNull();
    stream.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() before the socket opened still closes it and drops queued audio', () => {
    const { stream, socket } = openStream();
    stream.send(new Uint8Array([1]).buffer);
    stream.close();
    expect(socket.closed).not.toBeNull();
    socket.open();
    // Nothing is flushed after an explicit close.
    expect(socket.sent).toEqual([]);
  });

  it('routes partial / committed / error frames to their callbacks', () => {
    const onPartial = vi.fn();
    const onCommitted = vi.fn();
    const onError = vi.fn();
    const { socket } = openStream({ onPartial, onCommitted, onError });
    socket.open();
    socket.deliver({ type: 'partial', text: 'fake' });
    socket.deliver({ type: 'committed', text: 'fake transcript' });
    socket.deliver({ type: 'error', message: 'vendor exploded' });
    expect(onPartial).toHaveBeenCalledWith('fake');
    expect(onCommitted).toHaveBeenCalledWith('fake transcript');
    expect(onError).toHaveBeenCalledWith('vendor exploded');
  });

  it('ignores malformed and unknown frames rather than throwing', () => {
    const onPartial = vi.fn();
    const onError = vi.fn();
    const { socket } = openStream({ onPartial, onError });
    socket.open();
    expect(() => socket.deliver('not json at all')).not.toThrow();
    expect(() => socket.deliver({ type: 'weather', text: 'rain' })).not.toThrow();
    expect(() => socket.deliver({ type: 'partial' })).not.toThrow();
    expect(onPartial).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a transport failure through onError', () => {
    const onError = vi.fn();
    const { socket } = openStream({ onError });
    socket.fail();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/connection/i));
  });

  it('calls onClose once, whoever closed it', () => {
    const onClose = vi.fn();
    const { stream, socket } = openStream({ onClose });
    socket.open();
    stream.close();
    socket.close(); // a late server close must not double-report
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('send/commit after close are inert (no throw, nothing sent)', () => {
    const { stream, socket } = openStream();
    socket.open();
    stream.close();
    const before = socket.sent.length;
    expect(() => {
      stream.send(new Uint8Array([1]).buffer);
      stream.commit();
    }).not.toThrow();
    expect(socket.sent).toHaveLength(before);
  });
});
