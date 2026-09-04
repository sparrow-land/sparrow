/**
 * Voice provider seam (SPEC "Voice (STT & TTS)"). Mirrors the `AuthProvider`
 * pattern: providers are internal implementation details, never wire shapes. At
 * boot the server registers at most one {@link SttProvider} and one
 * {@link TtsProvider} into a {@link VoiceRegistry} (`elevenlabs` when a key
 * resolves, `fake` for offline dev/tests, or an injected test double).
 */

/** Speech-to-text. */
export interface SttProvider {
  id: string; // 'elevenlabs' | 'fake'
  transcribe(
    audio: Buffer,
    contentType: string,
    opts?: { language?: string },
  ): Promise<{ text: string; language?: string }>;
}

/** Text-to-speech. */
export interface TtsProvider {
  id: string;
  synthesize(text: string): Promise<{ audio: Buffer; contentType: string }>;
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
