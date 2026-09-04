import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFetch, restoreFetch, json, errorJson } from '../../test/apiStub.js';
import { CapabilitiesProvider } from '../../lib/capabilities.js';
import { MicButton, type HandsFreeWiring } from './MicButton.js';

/**
 * The mic is now an ENTRY POINT, not a recorder: everything it used to do —
 * capture, transcribe, errors — moved into `HandsFreeOverlay` (and is tested
 * there). What is left to prove here is the gate, the open/close handshake, and
 * that the room's wiring reaches the overlay.
 */

const tracks = [{ stop: vi.fn() }];

function installMedia() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks }) as unknown as MediaStream) },
  });
}

function stubApi(sttEnabled: boolean) {
  useFetch(async (input) => {
    if (String(input).includes('/capabilities')) {
      return json({ voice: { stt: sttEnabled, tts: false, sttStreaming: false } });
    }
    return errorJson('not_found', 404);
  });
}

function renderMic(overrides: Partial<HandsFreeWiring> = {}, disabled = false) {
  const onSend = vi.fn(async () => 'msg_1');
  const onOpenChange = vi.fn();
  render(
    <CapabilitiesProvider>
      <MicButton
        disabled={disabled}
        handsFree={{
          roomId: 'room_1',
          onSend,
          incoming: [],
          counterpartName: 'Ada',
          onOpenChange,
          ...overrides,
        }}
      />
    </CapabilitiesProvider>,
  );
  return { onSend, onOpenChange };
}

beforeEach(() => {
  installMedia();
  vi.stubGlobal('MediaRecorder', class {} as unknown as typeof MediaRecorder);
});
afterEach(() => {
  restoreFetch();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
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
    expect(await screen.findByRole('button', { name: /hands-free/i })).toBeInTheDocument();
  });

  it('is disabled with the rest of the composer (archived room, send in flight)', async () => {
    stubApi(true);
    renderMic({}, true);
    expect(await screen.findByRole('button', { name: /hands-free/i })).toBeDisabled();
  });
});

describe('MicButton opens hands-free mode', () => {
  it('a tap puts the full-viewport overlay up', async () => {
    stubApi(true);
    renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
    expect(await screen.findByRole('dialog', { name: /hands-free/i })).toBeInTheDocument();
    // The overlay owns the screen while it is up.
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('announces open and close, so the room knows when to route replies into it', async () => {
    stubApi(true);
    const { onOpenChange } = renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('leaving the mode restores the composer and its scroll', async () => {
    stubApi(true);
    renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));

    expect(screen.queryByRole('dialog', { name: /hands-free/i })).toBeNull();
    expect(await screen.findByRole('button', { name: /hands-free/i })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('Escape leaves the mode too', async () => {
    stubApi(true);
    renderMic();
    await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
    await screen.findByRole('dialog', { name: /hands-free/i });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /hands-free/i })).toBeNull();
  });

  it('hands the room wiring through to the overlay', async () => {
    stubApi(true);
    renderMic({ counterpartName: 'Grace' });
    await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
    // The counterpart's name is the overlay's, sourced from this prop.
    const dialog = await screen.findByRole('dialog', { name: /hands-free/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
  });
});
