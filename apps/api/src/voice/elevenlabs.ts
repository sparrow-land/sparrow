/**
 * ElevenLabs STT + TTS provider (SPEC "Voice"). fetch-based — no SDK dependency
 * (Node 22 global `fetch`/`FormData`/`Blob`). One instance backs both the STT and
 * TTS registry slots. Any non-2xx vendor response becomes a {@link VoiceVendorError}
 * so routes can map it to `502` without leaking the vendor's body.
 */
import WsWebSocket from 'ws';
import {
  SttStreamEmitter,
  type SttProvider,
  type SttStream,
  type TtsProvider,
  VoiceVendorError,
} from './types.js';

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const STT_REALTIME_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
/** The vendor's realtime input contract: signed 16-bit LE mono at 16 kHz. */
const REALTIME_SAMPLE_RATE = 16000;
const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
/** ElevenLabs' stock default voice, used when no `voice.ttsVoiceId` is configured. */
export const ELEVENLABS_DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

export interface ElevenLabsOptions {
  apiKey: string;
  /** `voice.ttsVoiceId`; '' → the vendor default voice. */
  voiceId: string;
  /** `voice.ttsModelId` (default `eleven_flash_v2_5`). */
  ttsModelId: string;
  /** `voice.sttModelId` (default `scribe_v2`). */
  sttModelId: string;
  /** `voice.sttRealtimeModelId` (default `scribe_v2_realtime`). */
  sttRealtimeModelId: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable for tests; defaults to the `ws` client. NOT Node's global
   * `WebSocket`: the WHATWG constructor takes no request headers, and the
   * vendor authenticates the realtime socket with `xi-api-key` on the
   * handshake — there is nowhere else to put it.
   */
  webSocketImpl?: WebSocketCtor;
}

/**
 * The slice of a `ws`-style client this provider uses. Structural, so a test
 * can hand in a mock without pulling in the real socket.
 */
export interface WebSocketLike {
  on(ev: 'open' | 'message' | 'error' | 'close', cb: (arg?: never) => void): unknown;
  send(data: string): void;
  close(code?: number): void;
}

export type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

/**
 * One realtime STT session over the vendor's WebSocket.
 *
 * Two invariants keep the route simple: every failure path — an `input_error`
 * frame, a transport error, a close we did not ask for — collapses into ONE
 * {@link VoiceVendorError} on `error` (the vendor's own words never travel),
 * and a session that has failed or been closed sends nothing further.
 */
class ElevenLabsSttStream extends SttStreamEmitter implements SttStream {
  private readonly socket: WebSocketLike;
  /** Frames pushed before the handshake completes, replayed in order on open. */
  private readonly pending: string[] = [];
  private open = false;
  private closed = false;
  private failed = false;

  constructor(opts: {
    apiKey: string;
    modelId: string;
    language?: string;
    impl: WebSocketCtor;
  }) {
    super();
    const query = new URLSearchParams({ model_id: opts.modelId });
    if (opts.language) query.set('language_code', opts.language);
    this.socket = new opts.impl(`${STT_REALTIME_URL}?${query.toString()}`, {
      headers: { 'xi-api-key': opts.apiKey },
    });
    this.socket.on('open', (() => {
      this.open = true;
      for (const frame of this.pending.splice(0)) this.socket.send(frame);
    }) as (arg?: never) => void);
    this.socket.on('message', ((data: unknown) => this.receive(data)) as (arg?: never) => void);
    this.socket.on('error', (() => this.fail()) as (arg?: never) => void);
    // A close we did not ask for is a failure, not an ending: the client is
    // still holding a microphone open and deserves to be told.
    this.socket.on('close', (() => this.fail()) as (arg?: never) => void);
  }

  push(pcm16: Buffer): void {
    this.sendFrame(pcm16.toString('base64'), false);
  }

  commit(): void {
    this.sendFrame('', true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    try {
      this.socket.close(1000);
    } catch {
      /* already gone */
    }
  }

  private sendFrame(audioBase64: string, commit: boolean): void {
    if (this.closed || this.failed) return;
    const frame = JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: audioBase64,
      sample_rate: REALTIME_SAMPLE_RATE,
      commit,
    });
    if (this.open) this.socket.send(frame);
    else this.pending.push(frame);
  }

  /** Map one inbound vendor frame. Anything unrecognized is ignored, not fatal. */
  private receive(data: unknown): void {
    if (this.closed || this.failed) return;
    let payload: { message_type?: string; text?: string };
    try {
      payload = JSON.parse(String(data)) as { message_type?: string; text?: string };
    } catch {
      return; // a frame we cannot read is not a reason to drop the session
    }
    switch (payload.message_type) {
      case 'partial_transcript':
        this.emitText('partial', payload.text ?? '');
        return;
      case 'committed_transcript':
        this.emitText('committed', payload.text ?? '');
        return;
      case 'input_error':
        this.fail();
        return;
      default:
        return; // session_started, audio acks, future frames
    }
  }

  /** Collapse any failure into one `error` + a closed socket. */
  private fail(): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.pending.length = 0;
    try {
      this.socket.close(1011);
    } catch {
      /* already gone */
    }
    this.emitError(new VoiceVendorError());
  }
}

export class ElevenLabsVoiceProvider implements SttProvider, TtsProvider {
  readonly id = 'elevenlabs';
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl: WebSocketCtor;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.webSocketImpl = opts.webSocketImpl ?? (WsWebSocket as unknown as WebSocketCtor);
  }

  /** Open a realtime STT session (SPEC `GET /voice/transcriptions/stream`). */
  stream(opts?: { language?: string }): SttStream {
    return new ElevenLabsSttStream({
      apiKey: this.opts.apiKey,
      modelId: this.opts.sttRealtimeModelId,
      language: opts?.language,
      impl: this.webSocketImpl,
    });
  }

  async transcribe(
    audio: Buffer,
    contentType: string,
  ): Promise<{ text: string; language?: string }> {
    const form = new FormData();
    form.append('model_id', this.opts.sttModelId);
    form.append('file', new Blob([audio], { type: contentType }), 'audio');
    let res: Response;
    try {
      res = await this.fetchImpl(STT_URL, {
        method: 'POST',
        headers: { 'xi-api-key': this.opts.apiKey },
        body: form,
      });
    } catch {
      throw new VoiceVendorError();
    }
    if (!res.ok) throw new VoiceVendorError();
    const json = (await res.json()) as { text?: string; language_code?: string };
    return { text: json.text ?? '', language: json.language_code };
  }

  /**
   * Progressive TTS: the vendor's chunked `audio/mpeg` handed back unbuffered.
   * Same voice, model and body as {@link synthesize} — only the endpoint and
   * the arrival time differ.
   */
  async synthesizeStream(text: string): Promise<ReadableStream<Uint8Array>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${TTS_URL}/${this.opts.voiceId || ELEVENLABS_DEFAULT_VOICE_ID}/stream`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.opts.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: this.opts.ttsModelId }),
      });
    } catch {
      throw new VoiceVendorError();
    }
    // A 200 with no body would otherwise tee an EMPTY file into the cache and
    // poison every later listen — message bodies are immutable, so is the cache.
    if (!res.ok || !res.body) throw new VoiceVendorError();
    return res.body;
  }

  async synthesize(text: string): Promise<{ audio: Buffer; contentType: string }> {
    const voiceId = this.opts.voiceId || ELEVENLABS_DEFAULT_VOICE_ID;
    let res: Response;
    try {
      res = await this.fetchImpl(`${TTS_URL}/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.opts.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: this.opts.ttsModelId }),
      });
    } catch {
      throw new VoiceVendorError();
    }
    if (!res.ok) throw new VoiceVendorError();
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: 'audio/mpeg' };
  }
}
