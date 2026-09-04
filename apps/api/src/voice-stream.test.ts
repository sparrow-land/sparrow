import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  makeTestServer,
  listen,
  signup,
  firstOrgId,
  makeAgent,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { FAKE_TRANSCRIPT } from './voice/fake.js';
import {
  VOICE_STREAM_MAX_AUDIO_BYTES,
  VOICE_STREAM_MAX_SECONDS,
} from './routes/voice.js';
import { SttStreamEmitter, type SttStream, VoiceVendorError } from './voice/types.js';

/**
 * `GET /api/v1/voice/transcriptions/stream` — the hands-free transport (SPEC
 * *Voice*). Audio up as binary frames, words down as JSON. These tests drive it
 * with a real `ws` client against a listening server, because the whole point of
 * the route is the upgrade: `app.inject` would never exercise it.
 */

/** A live client: collects inbound JSON frames and the close code. */
class StreamClient {
  readonly frames: Record<string, unknown>[] = [];
  closeCode: number | undefined;
  readonly closed: Promise<void>;
  private readonly waiters: {
    predicate: (f: Record<string, unknown>) => boolean;
    resolve: (f: Record<string, unknown>) => void;
  }[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.predicate(frame)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
    });
    this.closed = new Promise<void>((resolve) => {
      socket.on('close', (code) => {
        this.closeCode = code;
        resolve();
      });
    });
  }

  /** Connect, resolving on the upgrade; rejects with the HTTP status on refusal. */
  static open(url: string, headers?: Record<string, string>): Promise<StreamClient> {
    const socket = new WebSocket(url, { headers });
    const client = new StreamClient(socket);
    return new Promise<StreamClient>((resolve, reject) => {
      socket.on('open', () => resolve(client));
      socket.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
      socket.on('error', (err) => reject(err));
    });
  }

  waitFor(
    predicate: (f: Record<string, unknown>) => boolean,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const seen = this.frames.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`waitFor timed out; saw ${JSON.stringify(this.frames)}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  pcm(bytes: number): void {
    this.socket.send(Buffer.alloc(bytes, 7), { binary: true });
  }
  text(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }
}

/** The HTTP status a refused upgrade reported (`open` rejects with it). */
async function refusalStatus(url: string, headers?: Record<string, string>): Promise<string> {
  try {
    const client = await StreamClient.open(url, headers);
    client.socket.close();
    return 'upgraded';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('GET /voice/transcriptions/stream', () => {
  let ts: TestServer;
  let base: string;
  let wsBase: string;
  let owner: SignedUpHuman;
  const open: StreamClient[] = [];

  async function boot(overrides = {}): Promise<void> {
    ts = await makeTestServer({ voiceProvider: 'fake', ...overrides });
    base = await listen(ts);
    wsBase = `${base.replace('http://', 'ws://')}/api/v1/voice/transcriptions/stream`;
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
  }

  const connect = async (query = '', headers?: Record<string, string>): Promise<StreamClient> => {
    const client = await StreamClient.open(`${wsBase}${query}`, headers);
    open.push(client);
    return client;
  };

  afterEach(async () => {
    for (const c of open.splice(0)) c.socket.close();
    await ts.close();
  });

  /* ------------------------------ Auth ----------------------------- */

  it('?token= (session) upgrades, exactly like /me/events', async () => {
    await boot();
    const client = await connect(`?token=${owner.token}`);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('a session cookie upgrades too (a browser WebSocket cannot set a header)', async () => {
    await boot();
    const client = await connect('', { cookie: `sparrow_session=${owner.token}` });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('an agent key streams too — voice is principal-scoped, not human-only', async () => {
    await boot();
    const orgId = await firstOrgId(ts.app, owner.token);
    const agent = await makeAgent(ts.app, owner.token, orgId, 'scribe-bot');
    const client = await connect(`?token=${agent.key}`);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('401 before the upgrade when unauthenticated', async () => {
    await boot();
    expect(await refusalStatus(wsBase)).toBe('http 401');
  });

  it('401 on a bogus token', async () => {
    await boot();
    expect(await refusalStatus(`${wsBase}?token=ses_nope`)).toBe('http 401');
  });

  /* --------------------------- No provider ------------------------- */

  it('404 before the upgrade with no STT provider at all', async () => {
    await boot({ voiceProvider: undefined });
    expect(await refusalStatus(`${wsBase}?token=${owner.token}`)).toBe('http 404');
  });

  it('404 before the upgrade when the STT provider cannot stream', async () => {
    // The one-shot route still works on this instance; only the socket 404s.
    await boot({
      voiceProvider: undefined,
      voice: { stt: { id: 'buffered', transcribe: async () => ({ text: 'x' }) }, tts: null },
    });
    expect(await refusalStatus(`${wsBase}?token=${owner.token}`)).toBe('http 404');
  });

  /* ---------------------------- Round trip ------------------------- */

  it('binary audio → partial frames; {"type":"commit"} → a committed frame', async () => {
    await boot();
    const client = await connect(`?token=${owner.token}`);

    client.pcm(320);
    expect(await client.waitFor((f) => f.type === 'partial')).toEqual({
      type: 'partial',
      text: 'fake',
    });

    client.pcm(320);
    await client.waitFor((f) => f.type === 'partial' && f.text === FAKE_TRANSCRIPT);

    client.text({ type: 'commit' });
    expect(await client.waitFor((f) => f.type === 'committed')).toEqual({
      type: 'committed',
      text: FAKE_TRANSCRIPT,
    });

    // Committing is not ending: the socket stays open for the next utterance.
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('{"type":"close"} ends the session cleanly (no error frame)', async () => {
    await boot();
    const client = await connect(`?token=${owner.token}`);
    client.pcm(64);
    await client.waitFor((f) => f.type === 'partial');
    client.text({ type: 'close' });
    await client.closed;
    expect(client.frames.some((f) => f.type === 'error')).toBe(false);
    expect(client.closeCode).toBe(1000);
  });

  it('ignores unparseable and unknown text frames rather than dropping the session', async () => {
    await boot();
    const client = await connect(`?token=${owner.token}`);
    client.socket.send('not json at all');
    client.text({ type: 'wat' });
    client.pcm(64);
    await client.waitFor((f) => f.type === 'partial');
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  /* ------------------------------ Errors --------------------------- */

  it('a vendor failure becomes one error frame (never the vendor body) then close 1011', async () => {
    // A provider whose session fails on the first chunk — the shape of a
    // realtime socket that the vendor drops mid-utterance.
    class FailingStream extends SttStreamEmitter implements SttStream {
      push(): void {
        this.emitError(new VoiceVendorError());
      }
      commit(): void {}
      close(): void {}
    }
    await boot({
      voiceProvider: undefined,
      voice: {
        stt: {
          id: 'failing',
          transcribe: async () => ({ text: '' }),
          stream: () => new FailingStream(),
        },
        tts: null,
      },
    });
    const client = await connect(`?token=${owner.token}`);
    client.pcm(64);
    expect(await client.waitFor((f) => f.type === 'error')).toEqual({
      type: 'error',
      message: 'voice vendor request failed',
    });
    await client.closed;
    expect(client.closeCode).toBe(1011);
  });

  /* ------------------------------- Caps ---------------------------- */

  it('the shipped caps are the specified 20 MB / 10 minutes', () => {
    expect(VOICE_STREAM_MAX_AUDIO_BYTES).toBe(20 * 1024 * 1024);
    expect(VOICE_STREAM_MAX_SECONDS).toBe(600);
  });

  it('too much audio → an error frame and a close, mid-session', async () => {
    await boot({ voiceStreamMaxAudioBytes: 1024 });
    const client = await connect(`?token=${owner.token}`);
    client.pcm(512);
    await client.waitFor((f) => f.type === 'partial');
    client.pcm(1024); // 1536 > 1024
    const err = await client.waitFor((f) => f.type === 'error');
    expect(err.message).toBe('transcription session audio limit reached');
    await client.closed;
  });

  it('too long a session → an error frame and a close', async () => {
    await boot({ voiceStreamMaxSeconds: 0.25 });
    const client = await connect(`?token=${owner.token}`);
    const err = await client.waitFor((f) => f.type === 'error');
    expect(err.message).toBe('transcription session time limit reached');
    await client.closed;
  });

  it('a client that just disappears closes the vendor session', async () => {
    let closes = 0;
    class CountingStream extends SttStreamEmitter implements SttStream {
      push(): void {}
      commit(): void {}
      close(): void {
        closes += 1;
      }
    }
    await boot({
      voiceProvider: undefined,
      voice: {
        stt: {
          id: 'counting',
          transcribe: async () => ({ text: '' }),
          stream: () => new CountingStream(),
        },
        tts: null,
      },
    });
    const client = await connect(`?token=${owner.token}`);
    client.socket.terminate();
    await new Promise((r) => setTimeout(r, 150));
    expect(closes).toBeGreaterThanOrEqual(1);
  });
});
