import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFetch, restoreFetch, json, errorJson } from '../../test/apiStub.js';
import { CapabilitiesProvider } from '../../lib/capabilities.js';
import { MicButton } from './MicButton.js';

/**
 * MediaRecorder/getUserMedia are not in jsdom — stand up minimal fakes. The fake
 * recorder emits one chunk and fires `onstop` synchronously on `.stop()`, so a
 * record→stop click pair drives the whole transcribe path.
 */
class FakeMediaRecorder {
  static isTypeSupported(t: string) {
    return t === 'audio/webm;codecs=opus';
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? '';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audiodata'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const tracks = [{ stop: vi.fn() }];

function installMediaMocks(getUserMedia?: () => Promise<MediaStream>) {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia:
        getUserMedia ??
        vi.fn(async () => ({ getTracks: () => tracks }) as unknown as MediaStream),
    },
  });
}

/** Route the client's fetch: capabilities + transcription. */
function stubApi(sttEnabled: boolean, opts: { transcript?: string; transcribeStatus?: number } = {}) {
  useFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) {
      return json({ voice: { stt: sttEnabled, tts: false } });
    }
    if (url.includes('/voice/transcriptions') && method === 'POST') {
      if (opts.transcribeStatus) return errorJson('internal', opts.transcribeStatus);
      return json({ text: opts.transcript ?? 'hello from voice' });
    }
    return errorJson('not_found', 404);
  });
}

function renderMic(onTranscript = vi.fn()) {
  render(
    <CapabilitiesProvider>
      <MicButton onTranscript={onTranscript} />
    </CapabilitiesProvider>,
  );
  return { onTranscript };
}

beforeEach(() => {
  installMediaMocks();
});
afterEach(() => {
  restoreFetch();
  tracks[0]!.stop.mockClear();
});

describe('MicButton capability gating', () => {
  it('renders nothing when STT is disabled', async () => {
    stubApi(false);
    renderMic();
    await Promise.resolve();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the mic when STT is enabled', async () => {
    stubApi(true);
    renderMic();
    expect(await screen.findByRole('button', { name: /record voice/i })).toBeInTheDocument();
  });
});

describe('MicButton record → stop → transcribe', () => {
  it('records, stops, and transcribes with the recorded mime, handing back the text', async () => {
    stubApi(true, { transcript: 'hello from voice' });
    const { onTranscript } = renderMic();

    const btn = await screen.findByRole('button', { name: /record voice/i });
    await userEvent.click(btn); // start
    expect(await screen.findByRole('button', { name: /stop recording/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /stop recording/i })); // stop → transcribe

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('hello from voice'));
    // Tracks were released.
    expect(tracks[0]!.stop).toHaveBeenCalled();
  });

  it('sends the recorded mime as the transcription contentType', async () => {
    let seenContentType: string | undefined;
    useFetch(async (input, init) => {
      const url = String(input);
      if (url.includes('/capabilities')) return json({ voice: { stt: true, tts: false } });
      if (url.includes('/voice/transcriptions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { contentType?: string };
        seenContentType = body.contentType;
        return json({ text: 'ok' });
      }
      return errorJson('not_found', 404);
    });
    renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    await waitFor(() => expect(seenContentType).toBe('audio/webm;codecs=opus'));
  });

  it('opens the full-screen stop overlay while recording and stops via its big target', async () => {
    stubApi(true, { transcript: 'from the overlay' });
    const { onTranscript } = renderMic();

    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));

    // Overlay is up and locks background scroll.
    const dialog = await screen.findByRole('dialog', { name: /recording/i });
    expect(within(dialog).getByRole('timer')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    // Tapping the giant surface stops and runs the existing transcribe flow.
    await userEvent.click(within(dialog).getByRole('button', { name: /stop and transcribe/i }));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('from the overlay'));
    // Overlay is gone and scroll is restored.
    expect(screen.queryByRole('dialog', { name: /recording/i })).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('cancel discards the recording without transcribing', async () => {
    let transcribeCalled = false;
    useFetch(async (input) => {
      const url = String(input);
      if (url.includes('/capabilities')) return json({ voice: { stt: true, tts: false } });
      if (url.includes('/voice/transcriptions')) {
        transcribeCalled = true;
        return json({ text: 'should not happen' });
      }
      return errorJson('not_found', 404);
    });
    const onTranscript = vi.fn();
    renderMic(onTranscript);

    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    const dialog = await screen.findByRole('dialog', { name: /recording/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel recording/i }));

    // Back to an idle mic, nothing sent to STT, tracks released.
    expect(await screen.findByRole('button', { name: /record voice/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /recording/i })).toBeNull();
    expect(transcribeCalled).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(tracks[0]!.stop).toHaveBeenCalled();
  });

  it('Escape cancels (discards) the recording', async () => {
    let transcribeCalled = false;
    useFetch(async (input) => {
      const url = String(input);
      if (url.includes('/capabilities')) return json({ voice: { stt: true, tts: false } });
      if (url.includes('/voice/transcriptions')) {
        transcribeCalled = true;
        return json({ text: 'should not happen' });
      }
      return errorJson('not_found', 404);
    });
    const onTranscript = vi.fn();
    renderMic(onTranscript);

    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    await screen.findByRole('dialog', { name: /recording/i });
    await userEvent.keyboard('{Escape}');

    expect(await screen.findByRole('button', { name: /record voice/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /recording/i })).toBeNull();
    expect(transcribeCalled).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('shows an inline error when the mic permission is denied', async () => {
    stubApi(true);
    installMediaMocks(() => Promise.reject(new Error('NotAllowedError')));
    renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/microphone/i);
  });

  it('shows an animated "Transcribing…" indicator only during the in-flight STT window', async () => {
    // A transcription request we resolve by hand, so we own the pending window.
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      release = res;
    });
    useFetch(async (input) => {
      const url = String(input);
      if (url.includes('/capabilities')) return json({ voice: { stt: true, tts: false } });
      if (url.includes('/voice/transcriptions')) return pending;
      return errorJson('not_found', 404);
    });
    const onTranscript = vi.fn();
    renderMic(onTranscript);

    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop recording/i }));

    // In flight: the indicator is up and announced.
    const indicator = await screen.findByRole('status');
    expect(indicator).toHaveTextContent(/transcrib/i);

    // Resolve → indicator clears and the transcript is handed back.
    release(json({ text: 'done at last' }));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('done at last'));
    expect(screen.queryByTestId('transcribing-indicator')).toBeNull();
  });

  it('clears the Transcribing indicator when STT rejects', async () => {
    let reject!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      reject = res;
    });
    useFetch(async (input) => {
      const url = String(input);
      if (url.includes('/capabilities')) return json({ voice: { stt: true, tts: false } });
      if (url.includes('/voice/transcriptions')) return pending;
      return errorJson('not_found', 404);
    });
    renderMic();

    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    expect(await screen.findByTestId('transcribing-indicator')).toBeInTheDocument();

    reject(errorJson('internal', 502));
    // The indicator clears and the existing error affordance takes over.
    await screen.findByRole('alert');
    expect(screen.queryByTestId('transcribing-indicator')).toBeNull();
  });

  it('the Transcribing indicator honours prefers-reduced-motion (non-animated fallback)', async () => {
    const pending = new Promise<Response>(() => {});
    useFetch(async (input) => {
      const url = String(input);
      if (url.includes('/capabilities')) return json({ voice: { stt: true, tts: false } });
      if (url.includes('/voice/transcriptions')) return pending;
      return errorJson('not_found', 404);
    });
    renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop recording/i }));

    const indicator = await screen.findByTestId('transcribing-indicator');
    const dots = indicator.querySelectorAll('span.rounded-full');
    expect(dots.length).toBeGreaterThan(0);
    dots.forEach((d) => expect(d.className).toContain('motion-reduce:animate-none'));
  });

  it('shows an inline error when transcription fails (e.g. 502)', async () => {
    stubApi(true, { transcribeStatus: 502 });
    const { onTranscript } = renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    // The vendor failure surfaces inline; nothing is handed to the composer.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onTranscript).not.toHaveBeenCalled();
    // Recovered to an idle mic, ready to retry.
    expect(await screen.findByRole('button', { name: /record voice/i })).toBeInTheDocument();
  });
});
