/**
 * Deterministic offline voice provider (SPEC: `VOICE_PROVIDER=fake`). Used by
 * tests, scenarios, and keyless dev stacks: a fixed transcript and a tiny, valid,
 * byte-stable MP3 (silent MPEG-1 Layer III frame headers). Never touches the
 * network.
 */
import { SttStreamEmitter, type SttProvider, type SttStream, type TtsProvider } from './types.js';

/** A few silent MPEG frame headers — non-empty and stable across runs. */
export const FAKE_MP3: Buffer = Buffer.from(
  Array.from({ length: 16 }, () => [0xff, 0xfb, 0x90, 0x00]).flat(),
);

export const FAKE_TRANSCRIPT = 'fake transcript';

/**
 * What each successive `push()` recognizes. The last entry is the whole
 * transcript and repeats for every further chunk, so the words only ever GROW
 * — a scenario can drive any number of chunks and still assert one transcript.
 */
export const FAKE_PARTIAL_SCRIPT: readonly string[] = ['fake', FAKE_TRANSCRIPT];

/**
 * The offline streaming session: no timers, no network, no randomness — the
 * output is a pure function of how many chunks were pushed, which is what makes
 * the WS route testable and the `115-voice` scenario byte-stable.
 */
class FakeSttStream extends SttStreamEmitter implements SttStream {
  private pushes = 0;
  private closed = false;

  push(): void {
    if (this.closed) return;
    const idx = Math.min(this.pushes, FAKE_PARTIAL_SCRIPT.length - 1);
    this.pushes += 1;
    this.emitText('partial', FAKE_PARTIAL_SCRIPT[idx]!);
  }

  commit(): void {
    if (this.closed) return;
    this.emitText('committed', FAKE_TRANSCRIPT);
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeVoiceProvider implements SttProvider, TtsProvider {
  readonly id = 'fake';

  async transcribe(): Promise<{ text: string; language?: string }> {
    return { text: FAKE_TRANSCRIPT };
  }

  /**
   * A fresh, independent session per call — never shared state between them.
   * `language` is accepted and ignored: the fake speaks exactly one script.
   */
  stream(_opts?: { language?: string }): SttStream {
    return new FakeSttStream();
  }

  async synthesize(): Promise<{ audio: Buffer; contentType: string }> {
    return { audio: FAKE_MP3, contentType: 'audio/mpeg' };
  }
}
