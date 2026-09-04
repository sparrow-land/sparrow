/**
 * Deterministic offline voice provider (SPEC: `VOICE_PROVIDER=fake`). Used by
 * tests, scenarios, and keyless dev stacks: a fixed transcript and a tiny, valid,
 * byte-stable MP3 (silent MPEG-1 Layer III frame headers). Never touches the
 * network.
 */
import type { SttProvider, TtsProvider } from './types.js';

/** A few silent MPEG frame headers — non-empty and stable across runs. */
export const FAKE_MP3: Buffer = Buffer.from(
  Array.from({ length: 16 }, () => [0xff, 0xfb, 0x90, 0x00]).flat(),
);

export const FAKE_TRANSCRIPT = 'fake transcript';

export class FakeVoiceProvider implements SttProvider, TtsProvider {
  readonly id = 'fake';

  async transcribe(): Promise<{ text: string; language?: string }> {
    return { text: FAKE_TRANSCRIPT };
  }

  async synthesize(): Promise<{ audio: Buffer; contentType: string }> {
    return { audio: FAKE_MP3, contentType: 'audio/mpeg' };
  }
}
