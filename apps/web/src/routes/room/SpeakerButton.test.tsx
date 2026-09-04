import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFetch, restoreFetch, json, errorJson, binary } from '../../test/apiStub.js';
import { CapabilitiesProvider } from '../../lib/capabilities.js';
import { SpeakerButton } from './SpeakerButton.js';

const play = vi.fn(async () => {});
const pause = vi.fn();

class FakeAudio {
  src = '';
  onended: (() => void) | null = null;
  play = play;
  pause = pause;
}

/** Route the client's fetch: capabilities + message speech. */
function stubApi(ttsEnabled: boolean, opts: { speechStatus?: number } = {}) {
  useFetch(async (input) => {
    const url = String(input);
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: ttsEnabled } });
    if (url.includes('/speech')) {
      if (opts.speechStatus) return errorJson('internal', opts.speechStatus, 'vendor failure');
      return binary(new Uint8Array([1, 2, 3]), 'audio/mpeg');
    }
    return errorJson('not_found', 404);
  });
}

function renderSpeaker() {
  render(
    <CapabilitiesProvider>
      <SpeakerButton roomId="room_1" messageId="msg_1" />
    </CapabilitiesProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:mock') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  restoreFetch();
  play.mockClear();
  pause.mockClear();
});

describe('SpeakerButton capability gating', () => {
  it('renders nothing when TTS is disabled', async () => {
    stubApi(false);
    renderSpeaker();
    await Promise.resolve();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the speaker when TTS is enabled', async () => {
    stubApi(true);
    renderSpeaker();
    expect(await screen.findByRole('button', { name: /play message/i })).toBeInTheDocument();
  });
});

describe('SpeakerButton playback', () => {
  it('fetches speech and enters the playing state; a second click stops', async () => {
    stubApi(true);
    renderSpeaker();

    const btn = await screen.findByRole('button', { name: /play message/i });
    await userEvent.click(btn);

    const stopBtn = await screen.findByRole('button', { name: /stop playback/i });
    expect(play).toHaveBeenCalled();

    await userEvent.click(stopBtn); // toggle off
    expect(pause).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /play message/i })).toBeInTheDocument();
  });

  it('shows an inline error when the speech fetch fails (e.g. 502)', async () => {
    stubApi(true, { speechStatus: 502 });
    renderSpeaker();
    await userEvent.click(await screen.findByRole('button', { name: /play message/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/vendor failure/i);
    // Recovered: back to an idle, clickable play button.
    expect(screen.getByRole('button', { name: /play message/i })).toBeEnabled();
  });
});
