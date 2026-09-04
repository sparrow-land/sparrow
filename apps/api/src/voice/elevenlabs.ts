/**
 * ElevenLabs STT + TTS provider (SPEC "Voice"). fetch-based — no SDK dependency
 * (Node 22 global `fetch`/`FormData`/`Blob`). One instance backs both the STT and
 * TTS registry slots. Any non-2xx vendor response becomes a {@link VoiceVendorError}
 * so routes can map it to `502` without leaking the vendor's body.
 */
import { type SttProvider, type TtsProvider, VoiceVendorError } from './types.js';

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
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
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class ElevenLabsVoiceProvider implements SttProvider, TtsProvider {
  readonly id = 'elevenlabs';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
