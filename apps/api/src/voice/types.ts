/**
 * Voice provider seam (SPEC "Voice (STT & TTS)"). Mirrors the `AuthProvider`
 * pattern: providers are internal implementation details, never wire shapes. At
 * boot the server registers at most one {@link SttProvider} and one
 * {@link TtsProvider} into a {@link VoiceRegistry} (`elevenlabs` when a key
 * resolves, `fake` for offline dev/tests, or an injected test double).
 */

/**
 * One live streaming-STT session (SPEC `GET /voice/transcriptions/stream`).
 * Audio goes up in chunks, words come down as they are recognized: `partial`
 * is interim and REPLACES the previous partial, `committed` is final for a
 * segment. Every failure — vendor, transport, protocol — arrives as `error`
 * carrying a {@link VoiceVendorError}, so a route never leaks a vendor body.
 */
export interface SttStream {
  /** One chunk of raw PCM16 16 kHz mono audio. */
  push(pcm16: Buffer): void;
  /** "I'm done speaking — finalize what you have." */
  commit(): void;
  /** End the session. Idempotent, and never itself an `error`. */
  close(): void;
  on(ev: 'partial' | 'committed', cb: (text: string) => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
}

/** The events an {@link SttStream} emits. */
export type SttStreamEvent = 'partial' | 'committed' | 'error';

/**
 * The tiny typed emitter every {@link SttStream} implementation extends. Node's
 * `EventEmitter` would do, but its `on` is untyped and its `'error'` channel
 * THROWS when nothing is listening — exactly the wrong shape for a stream whose
 * error handler may attach a tick after construction.
 */
export class SttStreamEmitter {
  private readonly textHandlers: Record<'partial' | 'committed', ((text: string) => void)[]> = {
    partial: [],
    committed: [],
  };
  private readonly errorHandlers: ((err: Error) => void)[] = [];

  on(ev: 'partial' | 'committed', cb: (text: string) => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
  on(ev: SttStreamEvent, cb: ((text: string) => void) | ((err: Error) => void)): void {
    if (ev === 'error') this.errorHandlers.push(cb as (err: Error) => void);
    else this.textHandlers[ev].push(cb as (text: string) => void);
  }

  /** Emit `partial`/`committed`. Iterates a copy so a handler may register more. */
  protected emitText(ev: 'partial' | 'committed', text: string): void {
    for (const cb of [...this.textHandlers[ev]]) cb(text);
  }

  /** Emit `error`. Silent (not fatal) when nobody is listening yet. */
  protected emitError(err: Error): void {
    for (const cb of [...this.errorHandlers]) cb(err);
  }
}

/** Speech-to-text. */
export interface SttProvider {
  id: string; // 'elevenlabs' | 'fake'
  transcribe(
    audio: Buffer,
    contentType: string,
    opts?: { language?: string },
  ): Promise<{ text: string; language?: string }>;
  /**
   * Open a live transcription session. OPTIONAL and additive: a provider
   * without it is still a perfectly good one-shot STT provider, and
   * `capabilities.voice.sttStreaming` reports exactly whether this exists so
   * clients gate the live transcript instead of discovering it by `404`.
   */
  stream?(opts?: { language?: string }): SttStream;
}

/** Text-to-speech. */
export interface TtsProvider {
  id: string;
  synthesize(text: string): Promise<{ audio: Buffer; contentType: string }>;
  /**
   * OPTIONAL progressive synthesis: `audio/mpeg` bytes as the vendor produces
   * them, so a listener hears the first syllable before the last one exists.
   * `/speech` pipes it to the client while tee-ing it into the same cache file
   * the buffered path writes, so this changes latency and nothing else.
   * A provider without it is served by {@link TtsProvider.synthesize}.
   */
  synthesizeStream?(text: string): Promise<ReadableStream<Uint8Array> | NodeJS.ReadableStream>;
}

/** The registered voice providers (either may be absent). */
export interface VoiceRegistry {
  stt: SttProvider | null;
  tts: TtsProvider | null;
}

/**
 * A non-2xx / unreachable vendor response. Routes catch it (and any other
 * provider failure) and map to a `502` WITHOUT leaking the vendor's body.
 */
export class VoiceVendorError extends Error {
  constructor(message = 'voice vendor request failed') {
    super(message);
    this.name = 'VoiceVendorError';
  }
}
