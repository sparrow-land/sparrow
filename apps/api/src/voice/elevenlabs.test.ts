import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ElevenLabsVoiceProvider,
  ELEVENLABS_DEFAULT_VOICE_ID,
  type ElevenLabsOptions,
} from './elevenlabs.js';
import { VoiceVendorError } from './types.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const baseOpts = {
  apiKey: 'test-key',
  voiceId: '',
  ttsModelId: 'eleven_flash_v2_5',
  sttModelId: 'scribe_v2',
  sttRealtimeModelId: 'scribe_v2_realtime',
};

describe('ElevenLabsVoiceProvider.transcribe', () => {
  it('POSTs multipart to the STT endpoint with xi-api-key + model_id + file', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ text: 'hello world', language_code: 'en' }),
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, fetchImpl });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), 'audio/webm');

    expect(result).toEqual({ text: 'hello world', language: 'en' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('test-key');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model_id')).toBe('scribe_v2');
    const file = form.get('file') as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('audio/webm');
  });

  it('maps a non-2xx vendor response to VoiceVendorError (routes → 502)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('vendor error detail', { status: 500 }),
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, fetchImpl });
    await expect(provider.transcribe(Buffer.from('x'), 'audio/webm')).rejects.toBeInstanceOf(
      VoiceVendorError,
    );
  });
});

describe('ElevenLabsVoiceProvider.synthesize', () => {
  it('POSTs JSON to the TTS endpoint (default voice) and returns audio/mpeg', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(
      async () => new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, fetchImpl });

    const result = await provider.synthesize('say this');

    expect(result.contentType).toBe('audio/mpeg');
    expect([...result.audio]).toEqual([1, 2, 3, 4]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE_ID}`);
    expect(init.headers['xi-api-key']).toBe('test-key');
    expect(JSON.parse(init.body)).toEqual({ text: 'say this', model_id: 'eleven_flash_v2_5' });
  });

  it('uses the configured voice id when set', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array([0]), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, voiceId: 'my-voice', fetchImpl });
    await provider.synthesize('hi');
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/my-voice');
  });

  it('maps a non-2xx vendor response to VoiceVendorError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 429 }),
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, fetchImpl });
    await expect(provider.synthesize('hi')).rejects.toBeInstanceOf(VoiceVendorError);
  });
});

/* ------------------------- Realtime (streaming) STT ------------------- */

/**
 * A mock of the `ws` client the provider opens against ElevenLabs: records the
 * constructor arguments and every frame sent, and lets a test drive the vendor
 * side (`open`/`message`/`error`/`close`) by hand.
 */
class MockSocket {
  static last: MockSocket | undefined;
  static constructed: { url: string; options: { headers?: Record<string, string> } }[] = [];
  readonly sent: string[] = [];
  closedWith: number | undefined;
  private readonly handlers = new Map<string, ((arg?: unknown) => void)[]>();

  constructor(
    readonly url: string,
    readonly options: { headers?: Record<string, string> } = {},
  ) {
    MockSocket.last = this;
    MockSocket.constructed.push({ url, options });
  }

  on(ev: string, cb: (arg?: unknown) => void): this {
    const list = this.handlers.get(ev) ?? [];
    list.push(cb);
    this.handlers.set(ev, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }

  /* --- vendor-side drivers --- */
  fire(ev: string, arg?: unknown): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(arg);
  }
  vendorSays(payload: unknown): void {
    this.fire('message', Buffer.from(JSON.stringify(payload)));
  }
  get frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function streamOpts(extra: Partial<ElevenLabsOptions> = {}): ElevenLabsOptions {
  return {
    ...baseOpts,
    sttRealtimeModelId: 'scribe_v2_realtime',
    webSocketImpl: MockSocket as unknown as ElevenLabsOptions['webSocketImpl'],
    ...extra,
  };
}

/** Open a stream and start collecting its three channels. */
function openStream(extra: Partial<ElevenLabsOptions> = {}, streamArgs?: { language?: string }) {
  const provider = new ElevenLabsVoiceProvider(streamOpts(extra));
  const stream = provider.stream!(streamArgs);
  const partials: string[] = [];
  const committed: string[] = [];
  const errors: Error[] = [];
  stream.on('partial', (t) => partials.push(t));
  stream.on('committed', (t) => committed.push(t));
  stream.on('error', (e) => errors.push(e));
  const socket = MockSocket.last!;
  return { stream, socket, partials, committed, errors };
}

describe('ElevenLabsVoiceProvider.stream', () => {
  beforeEach(() => {
    MockSocket.last = undefined;
    MockSocket.constructed = [];
  });

  it('opens the realtime endpoint with the configured model and the xi-api-key header', () => {
    const { socket } = openStream();
    expect(socket.url).toBe(
      'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime',
    );
    expect(socket.options.headers).toEqual({ 'xi-api-key': 'test-key' });
  });

  it('honors a configured realtime model id', () => {
    const { socket } = openStream({ sttRealtimeModelId: 'scribe_v3_realtime' });
    expect(socket.url).toContain('model_id=scribe_v3_realtime');
  });

  it('sends input_audio_chunk frames with base64 audio at 16 kHz, commit:false', () => {
    const { stream, socket } = openStream();
    socket.fire('open');
    stream.push(Buffer.from([0x01, 0x02, 0x03]));
    expect(socket.frames).toEqual([
      {
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from([0x01, 0x02, 0x03]).toString('base64'),
        sample_rate: 16000,
        commit: false,
      },
    ]);
  });

  it('queues frames pushed before the socket opens and flushes them in order on open', () => {
    const { stream, socket } = openStream();
    stream.push(Buffer.from([0xaa]));
    stream.push(Buffer.from([0xbb]));
    expect(socket.sent).toEqual([]);
    socket.fire('open');
    expect(socket.frames.map((f) => f.audio_base_64)).toEqual([
      Buffer.from([0xaa]).toString('base64'),
      Buffer.from([0xbb]).toString('base64'),
    ]);
  });

  it('commit() sends an empty chunk with commit:true', () => {
    const { stream, socket } = openStream();
    socket.fire('open');
    stream.commit();
    expect(socket.frames).toEqual([
      { message_type: 'input_audio_chunk', audio_base_64: '', sample_rate: 16000, commit: true },
    ]);
  });

  it('maps partial_transcript → partial and committed_transcript → committed', () => {
    const { socket, partials, committed } = openStream();
    socket.fire('open');
    socket.vendorSays({ message_type: 'partial_transcript', text: 'hello' });
    socket.vendorSays({ message_type: 'partial_transcript', text: 'hello world' });
    socket.vendorSays({ message_type: 'committed_transcript', text: 'hello world.' });
    expect(partials).toEqual(['hello', 'hello world']);
    expect(committed).toEqual(['hello world.']);
  });

  it('ignores unknown vendor message types and unparseable frames', () => {
    const { socket, partials, committed, errors } = openStream();
    socket.fire('open');
    socket.vendorSays({ message_type: 'session_started', session_id: 'x' });
    socket.fire('message', Buffer.from('not json'));
    expect([partials, committed, errors]).toEqual([[], [], []]);
  });

  it('maps input_error to a VoiceVendorError and closes the socket', () => {
    const { socket, errors } = openStream();
    socket.fire('open');
    socket.vendorSays({ message_type: 'input_error', error: 'bad audio' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(VoiceVendorError);
    // The vendor's own words never reach the client.
    expect(errors[0]!.message).toBe('voice vendor request failed');
    expect(socket.closedWith).toBeDefined();
  });

  it('maps a socket error to a VoiceVendorError (once)', () => {
    const { socket, errors } = openStream();
    socket.fire('error', new Error('ECONNRESET'));
    socket.fire('error', new Error('ECONNRESET'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(VoiceVendorError);
  });

  it('maps a vendor-initiated close to a VoiceVendorError', () => {
    const { socket, errors } = openStream();
    socket.fire('open');
    socket.fire('close', 1006);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(VoiceVendorError);
  });

  it('a close() we asked for is NOT an error, and is idempotent', () => {
    const { stream, socket, errors } = openStream();
    socket.fire('open');
    stream.close();
    stream.close();
    socket.fire('close', 1000);
    expect(errors).toEqual([]);
  });

  it('stops sending after close() or after a failure', () => {
    const { stream, socket } = openStream();
    socket.fire('open');
    stream.close();
    stream.push(Buffer.from([0x01]));
    stream.commit();
    expect(socket.sent).toEqual([]);
  });

  it('passes a requested language through as language_code', () => {
    const { socket } = openStream({}, { language: 'en' });
    expect(socket.url).toBe(
      'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=en',
    );
  });
});

describe('ElevenLabsVoiceProvider.synthesizeStream', () => {
  it('POSTs to the /stream endpoint and hands back the response body', async () => {
    const body = new Response(new Uint8Array([9, 8, 7]), { status: 200 }).body!;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, voiceId: 'my-voice', fetchImpl });

    const stream = await provider.synthesizeStream!('say this');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/my-voice/stream');
    expect(init.headers['xi-api-key']).toBe('test-key');
    expect(init.headers.accept).toBe('audio/mpeg');
    expect(JSON.parse(init.body)).toEqual({ text: 'say this', model_id: 'eleven_flash_v2_5' });
    // The bytes flow through unbuffered — the route pipes them straight out.
    const chunks: Uint8Array[] = [];
    for await (const c of stream as AsyncIterable<Uint8Array>) chunks.push(c);
    expect([...Buffer.concat(chunks.map((c) => Buffer.from(c)))]).toEqual([9, 8, 7]);
  });

  it('maps a non-2xx vendor response to VoiceVendorError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, fetchImpl });
    await expect(provider.synthesizeStream!('hi')).rejects.toBeInstanceOf(VoiceVendorError);
  });

  it('maps an empty body to VoiceVendorError rather than an empty audio file', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({ ...baseOpts, fetchImpl });
    await expect(provider.synthesizeStream!('hi')).rejects.toBeInstanceOf(VoiceVendorError);
  });
});
