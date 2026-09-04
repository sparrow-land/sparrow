import { describe, expect, it, vi } from 'vitest';
import {
  ElevenLabsVoiceProvider,
  ELEVENLABS_DEFAULT_VOICE_ID,
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
