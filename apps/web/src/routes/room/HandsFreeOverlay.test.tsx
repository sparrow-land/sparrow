import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CapabilitiesResponse } from '@sparrow/common-types';
import { useFetch, restoreFetch, json, errorJson, binary } from '../../test/apiStub.js';
import { CapabilitiesProvider } from '../../lib/capabilities.js';
import { HandsFreeOverlay, type HandsFreeIncoming } from './HandsFreeOverlay.js';
import { WORKING_CUE_KEY } from '../../lib/workingCue.js';

/**
 * The working cue is tested for what it SOUNDS like in `lib/workingCue.test.ts`;
 * here the question is only when the overlay starts and stops it, so the module
 * is spied rather than run.
 */
const { cueStart, cueStop } = vi.hoisted(() => ({ cueStart: vi.fn(), cueStop: vi.fn() }));
vi.mock('../../lib/workingCue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/workingCue.js')>();
  return {
    ...actual,
    startWorkingCue: (_ctx: AudioContext, style: string) => {
      cueStart(style);
      return { stop: cueStop };
    },
  };
});

/* ================================================================== *
 * Browser fakes — jsdom has no media stack at all.
 * ================================================================== */

const trackStop = vi.fn();
const scrollIntoView = vi.fn();
const audioPlay = vi.fn(async () => {});
const audioPause = vi.fn();

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  onended: (() => void) | null = null;
  play = audioPlay;
  pause = audioPause;
  constructor() {
    FakeAudio.instances.push(this);
  }
  end(): void {
    this.onended?.();
  }
}

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
    this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

/** The streaming-STT socket. Opens on a microtask, records every frame sent. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }
  readyState = 0;
  sent: Array<string | ArrayBufferLike> = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string | ArrayBufferLike): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  /** Push a server frame. */
  say(frame: unknown): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
  /** Text frames only — the binary audio is the rest. */
  get textFrames(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string');
  }
  get audioFrames(): ArrayBufferLike[] {
    return this.sent.filter((f): f is ArrayBufferLike => typeof f !== 'string');
  }
}

/** Web Audio, enough for `startPcmCapture` to build its graph. */
class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  port: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(_ctx: unknown, _name: string, _opts: unknown) {
    FakeWorkletNode.last = this;
  }
  /** Hand one PCM frame up from the audio thread. */
  emit(buf: ArrayBuffer): void {
    this.port.onmessage?.({ data: buf });
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static last: FakeAudioContext | null = null;
  /** The CAPTURE context — the LevelMeter builds one of these too. */
  static get capture(): FakeAudioContext {
    return FakeAudioContext.instances.find((c) => c.audioWorklet.addModule.mock.calls.length > 0)!;
  }
  /** Set false to simulate an engine where the worklet module won't load. */
  static workletWorks = true;
  sampleRate = 16_000;
  state = 'running';
  destination = {};
  /** When set, `addModule` blocks on it — for testing an exit mid-handshake. */
  static moduleGate: Promise<void> | null = null;
  audioWorklet = {
    addModule: vi.fn(async () => {
      if (FakeAudioContext.moduleGate) await FakeAudioContext.moduleGate;
      if (!FakeAudioContext.workletWorks) throw new Error('no worklet here');
    }),
  };
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  constructor() {
    FakeAudioContext.instances.push(this);
    FakeAudioContext.last = this;
  }
}

const micStream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;

function installMedia(getUserMedia?: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: getUserMedia ?? vi.fn(async () => micStream) },
  });
}

/* ================================================================== *
 * Harness
 * ================================================================== */

function caps(voice: Partial<CapabilitiesResponse['voice']>): CapabilitiesResponse {
  return {
    email: false,
    emailReviewer: false,
    voice: { stt: true, tts: true, sttStreaming: true, ...voice },
    orgHostSuffix: null,
    workspaceSwitcher: null,
  };
}

interface Options {
  voice?: Partial<CapabilitiesResponse['voice']>;
  incoming?: HandsFreeIncoming[];
  onSend?: (text: string) => Promise<string | null>;
  onClose?: () => void;
  awaitingNote?: string | null;
  counterpartName?: string | null;
}

function renderOverlay(opts: Options = {}) {
  // Real sends return a fresh message id per turn; the column keys on it.
  let sendSeq = 0;
  const onSend = opts.onSend ?? vi.fn(async () => `msg_sent_${++sendSeq}`);
  const onClose = opts.onClose ?? vi.fn();
  const view = render(
    <CapabilitiesProvider initial={caps(opts.voice ?? {})}>
      <HandsFreeOverlay
        roomId="room_1"
        onSend={onSend}
        onClose={onClose}
        incoming={opts.incoming ?? []}
        awaitingNote={opts.awaitingNote ?? null}
        counterpartName={opts.counterpartName ?? 'Ada'}
      />
    </CapabilitiesProvider>,
  );
  const rerenderWith = (incoming: HandsFreeIncoming[]) =>
    view.rerender(
      <CapabilitiesProvider initial={caps(opts.voice ?? {})}>
        <HandsFreeOverlay
          roomId="room_1"
          onSend={onSend}
          onClose={onClose}
          incoming={incoming}
          awaitingNote={opts.awaitingNote ?? null}
          counterpartName={opts.counterpartName ?? 'Ada'}
        />
      </CapabilitiesProvider>,
    );
  return { ...view, onSend, onClose, rerenderWith };
}

/** Default API routing: one-shot transcription + message speech. */
function stubApi(opts: { transcript?: string; transcribeStatus?: number; speechStatus?: number } = {}) {
  useFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/voice/transcriptions') && method === 'POST') {
      if (opts.transcribeStatus) return errorJson('internal', opts.transcribeStatus, 'vendor down');
      return json({ text: opts.transcript ?? 'one shot transcript' });
    }
    if (url.includes('/speech')) {
      if (opts.speechStatus) return errorJson('internal', opts.speechStatus, 'vendor down');
      return binary(new Uint8Array([1, 2, 3]), 'audio/mpeg');
    }
    return errorJson('not_found', 404);
  });
}

/**
 * Tap the mic and land in `listening` with the streaming capture fully up. The
 * buttons render the moment the phase flips, so waiting on them proves nothing
 * about the socket or the graph — wait for the worklet, then let the assignment
 * that follows it settle.
 */
async function startListening() {
  FakeWorkletNode.last = null;
  await userEvent.click(screen.getByRole('button', { name: /tap to talk|interrupt and talk/i }));
  await waitFor(() => expect(FakeWorkletNode.last).not.toBeNull());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  installMedia();
  FakeWebSocket.instances = [];
  FakeAudio.instances = [];
  FakeAudioContext.workletWorks = true;
  FakeAudioContext.moduleGate = null;
  FakeAudioContext.instances = [];
  FakeAudioContext.last = null;
  FakeWorkletNode.last = null;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode as unknown as typeof AudioWorkletNode);
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:mock'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  // Cleared HERE, not in `afterEach`: React Testing Library's own cleanup hook
  // unmounts the overlay after ours runs, and that unmount stops the cue — a
  // call that would otherwise be counted against the NEXT test.
  cueStart.mockClear();
  cueStop.mockClear();
  localStorage.clear();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  stubApi();
});

afterEach(() => {
  restoreFetch();
  vi.unstubAllGlobals();
  trackStop.mockClear();
  scrollIntoView.mockClear();
  audioPlay.mockClear();
  audioPause.mockClear();
  document.body.style.overflow = '';
});

/* ================================================================== *
 * The shell: a modal you can always get out of
 * ================================================================== */

describe('HandsFreeOverlay shell', () => {
  it('renders a modal dialog in the ready state and locks background scroll', () => {
    renderOverlay();
    const dialog = screen.getByRole('dialog', { name: /hands-free/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('Escape leaves the mode entirely and restores scroll', async () => {
    const { onClose, unmount } = renderOverlay();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('the corner ✕ leaves the mode entirely', async () => {
    const { onClose } = renderOverlay();
    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a denied microphone inline and stays in ready', async () => {
    installMedia(() => Promise.reject(new Error('NotAllowedError')));
    renderOverlay();
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/microphone/i);
    expect(screen.getByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
  });
});

/* ================================================================== *
 * listening — the streaming path
 * ================================================================== */

describe('HandsFreeOverlay listening (streaming STT)', () => {
  it('puts Cancel on the left and Send on the right (Jake, first live session)', async () => {
    renderOverlay();
    await startListening();
    const cancel = screen.getByRole('button', { name: /cancel/i });
    const send = screen.getByRole('button', { name: /^send$/i });
    // DOM order is visual order in the flex row: Cancel must precede Send.
    expect(cancel.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('ready → listening: meter, timer, and the two big buttons', async () => {
    renderOverlay();
    await startListening();
    expect(screen.getByTestId('voice-level-meter')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled();
    // Nothing said yet — Send has nothing to send.
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  it('opens the streaming socket and pushes captured PCM as binary frames', async () => {
    renderOverlay();
    await startListening();
    const ws = FakeWebSocket.last;
    expect(ws.url).toMatch(/^wss?:\/\/.*\/api\/v1\/voice\/transcriptions\/stream$/);
    const frame = new Int16Array([1, 2, 3]).buffer;
    await act(async () => {
      FakeWorkletNode.last!.emit(frame);
    });
    expect(ws.audioFrames).toContain(frame);
  });

  it('renders committed words plainly and the live partial muted, announced politely', async () => {
    renderOverlay();
    await startListening();
    const ws = FakeWebSocket.last;
    ws.say({ type: 'committed', text: 'hello there' });
    ws.say({ type: 'partial', text: 'general' });

    const transcript = await screen.findByTestId('hands-free-transcript');
    expect(transcript).toHaveAttribute('aria-live', 'polite');
    expect(transcript).toHaveTextContent('hello there');
    const partial = within(transcript).getByTestId('hands-free-partial');
    expect(partial).toHaveTextContent('general');
    expect(partial.className).toMatch(/muted/);
  });

  it('enables Send once there is any text', async () => {
    renderOverlay();
    await startListening();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    FakeWebSocket.last.say({ type: 'partial', text: 'words' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
  });

  it('Cancel returns to ready, tears the capture down, and sends nothing', async () => {
    const { onSend } = renderOverlay();
    await startListening();
    FakeWebSocket.last.say({ type: 'committed', text: 'never mind' });
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(await screen.findByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(FakeWebSocket.last.closed).toBe(true);
    expect(FakeAudioContext.capture.close).toHaveBeenCalled();
    // The abandoned words do not survive into the next turn.
    expect(screen.queryByText(/never mind/)).toBeNull();
  });

  it('surfaces a server error frame inline without losing the words so far', async () => {
    renderOverlay();
    await startListening();
    FakeWebSocket.last.say({ type: 'committed', text: 'half a sentence' });
    FakeWebSocket.last.say({ type: 'error', message: 'transcription failed' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/transcription failed/i);
    expect(screen.getByTestId('hands-free-transcript')).toHaveTextContent('half a sentence');
  });

  it('a stream error ends the capture instead of leaving the mic hot', async () => {
    renderOverlay();
    await startListening();
    FakeWebSocket.last.say({ type: 'committed', text: 'half a sentence' });
    FakeWebSocket.last.say({ type: 'error', message: 'transcription failed' });

    await screen.findByRole('alert');
    // The vendor is gone: nothing should still be recording into it.
    await waitFor(() => expect(FakeWebSocket.last.closed).toBe(true));
    expect(trackStop).toHaveBeenCalled();
    expect(FakeAudioContext.capture.close).toHaveBeenCalled();
    // The words that did land are kept, and the turn can still be sent.
    expect(screen.getByTestId('hands-free-transcript')).toHaveTextContent('half a sentence');
    expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled();
  });

  it('falls back to recording when the worklet cannot be built', async () => {
    FakeAudioContext.workletWorks = false;
    renderOverlay();
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    // No live words: the one-shot Stop target is what we get instead of Send.
    expect(await screen.findByRole('button', { name: /^stop$/i })).toBeInTheDocument();
  });
});

/* ================================================================== *
 * Leaving mid-handshake. Capture is two awaits deep (getUserMedia, then
 * the worklet module); an exit landing between them used to leave the
 * mic hot and a vendor session running to its ten-minute cap.
 * ================================================================== */

describe('HandsFreeOverlay abandons a capture it started', () => {
  it('leaving while the mic permission is pending releases it and opens no stream', async () => {
    let grant!: (s: MediaStream) => void;
    installMedia(() => new Promise<MediaStream>((res) => (grant = res)));
    renderOverlay();

    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));

    // The permission resolves into a mode that is already gone.
    await act(async () => {
      grant(micStream);
      await Promise.resolve();
    });
    expect(trackStop).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('leaving while the worklet is loading closes the socket and the context', async () => {
    let load!: () => void;
    FakeAudioContext.moduleGate = new Promise<void>((res) => (load = res));
    renderOverlay();

    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));

    await act(async () => {
      load();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(trackStop).toHaveBeenCalled();
    expect(FakeWebSocket.last.closed).toBe(true);
    expect(FakeAudioContext.capture.close).toHaveBeenCalled();
  });
});

/* ================================================================== *
 * listening — the buffered fallback (sttStreaming: false)
 * ================================================================== */

describe('HandsFreeOverlay listening (buffered fallback)', () => {
  const fallback = { voice: { sttStreaming: false } };

  it('records instead of streaming — no socket, no live words', async () => {
    renderOverlay(fallback);
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    expect(await screen.findByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull();
  });

  it('Stop transcribes once and shows the text for review, then Send posts it', async () => {
    stubApi({ transcript: 'buffered words' });
    const { onSend } = renderOverlay(fallback);
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^stop$/i }));

    const send = await screen.findByRole('button', { name: /^send$/i });
    expect(screen.getByTestId('hands-free-transcript')).toHaveTextContent('buffered words');
    expect(trackStop).toHaveBeenCalled(); // capture released before the round trip
    await userEvent.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('buffered words'));
  });

  it('Cancel while recording discards without transcribing', async () => {
    let transcribed = false;
    useFetch(async (input, init) => {
      if (String(input).includes('/voice/transcriptions') && init?.method === 'POST') {
        transcribed = true;
        return json({ text: 'should not happen' });
      }
      return errorJson('not_found', 404);
    });
    const { onSend } = renderOverlay(fallback);
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));
    expect(await screen.findByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
    expect(transcribed).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Cancel during transcription discards the late transcript', async () => {
    let deliver!: (r: Response) => void;
    const pending = new Promise<Response>((res) => (deliver = res));
    useFetch(async (input, init) => {
      if (String(input).includes('/voice/transcriptions') && init?.method === 'POST') return pending;
      return errorJson('not_found', 404);
    });
    renderOverlay(fallback);
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^stop$/i }));
    await screen.findByTestId('transcribing-indicator');

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(await screen.findByRole('button', { name: /tap to talk/i })).toBeInTheDocument();

    // The vendor answers a turn the speaker abandoned: it must not surface here,
    // and above all must not be waiting in the NEXT turn's transcript.
    await act(async () => {
      deliver(json({ text: 'words from a cancelled turn' }));
      await Promise.resolve();
    });
    expect(screen.queryByText(/cancelled turn/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    expect(screen.queryByText(/cancelled turn/)).toBeNull();
  });

  it('surfaces a failed one-shot transcription inline', async () => {
    stubApi({ transcribeStatus: 502 });
    renderOverlay(fallback);
    await userEvent.click(screen.getByRole('button', { name: /tap to talk/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^stop$/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

/* ================================================================== *
 * sending → awaiting
 * ================================================================== */

describe('HandsFreeOverlay sending and awaiting', () => {
  it('Send commits, takes the final committed text, closes the stream, and posts it', async () => {
    const { onSend } = renderOverlay();
    await startListening();
    const ws = FakeWebSocket.last;
    ws.say({ type: 'partial', text: 'hello' });

    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(ws.textFrames).toContain('{"type":"commit"}');
    // The vendor's last word beats the partial we were showing.
    ws.say({ type: 'committed', text: 'hello world' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello world'));
    expect(ws.closed).toBe(true);
    expect(trackStop).toHaveBeenCalled();
  });

  it('keeps ONE unlocked audio element across the whole session (mobile autoplay)', async () => {
    renderOverlay();
    await startListening();
    // Already unlocked by the mic tap; Send must not mint a second element —
    // only the one that has been played from a gesture is allowed to speak.
    expect(FakeAudio.instances).toHaveLength(1);
    FakeWebSocket.last.say({ type: 'partial', text: 'unlock me' });

    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(FakeAudio.instances).toHaveLength(1);
    expect(audioPlay).toHaveBeenCalled();
  });

  it('awaiting names the counterpart while the reply is pending', async () => {
    renderOverlay({ counterpartName: 'Ada' });
    await startListening();
    await speakAndSend('are you there');
    expect(await screen.findByTestId('hands-free-awaiting')).toHaveTextContent(/waiting for ada/i);
  });

  it('awaiting shows the counterpart working note when the room has one', async () => {
    renderOverlay({ counterpartName: 'Ada', awaitingNote: 'reading the logs' });
    await startListening();
    await speakAndSend('status?');
    expect(await screen.findByTestId('hands-free-awaiting')).toHaveTextContent(/reading the logs/i);
  });

  it('Send with nothing to send says so rather than silently returning', async () => {
    const { onSend } = renderOverlay();
    await startListening();
    // Words appear, then the vendor takes them all back on commit.
    FakeWebSocket.last.say({ type: 'partial', text: 'mmm' });
    await userEvent.click(await screen.findByRole('button', { name: /^send$/i }));
    FakeWebSocket.last.say({ type: 'committed', text: '   ' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing to send/i);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a rejected send surfaces inline and stays out of awaiting', async () => {
    const onSend = vi.fn(async () => null);
    renderOverlay({ onSend });
    await startListening();
    await speakAndSend('undeliverable');
    expect(await screen.findByRole('alert')).toHaveTextContent(/send/i);
    expect(screen.queryByTestId('hands-free-awaiting')).toBeNull();
    // The words survive so the turn can be retried.
    expect(screen.getByTestId('hands-free-transcript')).toHaveTextContent('undeliverable');
  });
});

/* ================================================================== *
 * speaking
 * ================================================================== */

const reply = (id: string, body: string): HandsFreeIncoming => ({ id, body, from: 'Ada' });

/**
 * Speak `text` and tap Send. The vendor's final `committed` arrives AFTER the
 * tap — that ordering is exactly what the commit grace window is for.
 */
async function speakAndSend(text: string) {
  FakeWebSocket.last.say({ type: 'partial', text });
  await userEvent.click(await screen.findByRole('button', { name: /^send$/i }));
  FakeWebSocket.last.say({ type: 'committed', text });
}

/** Drive one full turn so the overlay is in `awaiting` with an unlocked Audio. */
async function sendOneTurn() {
  await startListening();
  await speakAndSend('a question');
  await screen.findByTestId('hands-free-awaiting');
}

describe('HandsFreeOverlay speaking', () => {
  it('speaks an arriving reply through the unlocked element and returns to ready', async () => {
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();

    rerenderWith([reply('msg_a', 'the answer is yes')]);
    await waitFor(() => expect(audioPlay).toHaveBeenCalledTimes(2)); // unlock + the clip
    const audio = FakeAudio.instances[0]!;
    expect(FakeAudio.instances).toHaveLength(1); // reused, never a second element
    expect(audio.src).toBe('blob:mock');

    await act(async () => audio.end());
    expect(await screen.findByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
    // The last thing said is kept visible in ready.
    expect(screen.getByTestId('hands-free-last-reply')).toHaveTextContent('the answer is yes');
  });

  it('queues replies and speaks them in arrival order', async () => {
    const spoken: string[] = [];
    useFetch(async (input) => {
      const url = String(input);
      const m = /messages\/([^/]+)\/speech/.exec(url);
      if (m) {
        spoken.push(m[1]!);
        return binary(new Uint8Array([1]), 'audio/mpeg');
      }
      return errorJson('not_found', 404);
    });
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();

    rerenderWith([reply('msg_a', 'first'), reply('msg_b', 'second')]);
    await waitFor(() => expect(spoken).toEqual(['msg_a']));
    await act(async () => FakeAudio.instances[0]!.end());
    await waitFor(() => expect(spoken).toEqual(['msg_a', 'msg_b']));
  });

  it('never speaks the same message twice, however often the list re-renders', async () => {
    const spoken: string[] = [];
    useFetch(async (input) => {
      const m = /messages\/([^/]+)\/speech/.exec(String(input));
      if (m) {
        spoken.push(m[1]!);
        return binary(new Uint8Array([1]), 'audio/mpeg');
      }
      return errorJson('not_found', 404);
    });
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();

    const one = [reply('msg_a', 'only once')];
    rerenderWith(one);
    await waitFor(() => expect(spoken).toEqual(['msg_a']));
    await act(async () => FakeAudio.instances[0]!.end());
    rerenderWith(one);
    rerenderWith([...one]);
    await new Promise((r) => setTimeout(r, 10));
    expect(spoken).toEqual(['msg_a']);
  });

  it('tapping the mic while speaking stops the audio and starts the next turn', async () => {
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();
    rerenderWith([reply('msg_a', 'a long answer')]);
    const interrupt = await screen.findByRole('button', { name: /interrupt and talk/i });

    await userEvent.click(interrupt);
    expect(audioPause).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });

  it('unlocks the audio element on the MIC tap, so a reply before any Send can play', async () => {
    // `speaking` is reachable straight from `ready` — the counterpart can answer
    // an earlier turn before this one is sent. iOS only lets an element play if
    // it was first started from a gesture, and the mic tap is one.
    const { rerenderWith } = renderOverlay();
    await startListening();
    expect(FakeAudio.instances).toHaveLength(1);
    expect(audioPlay).toHaveBeenCalledTimes(1); // the silent unlock
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await screen.findByRole('button', { name: /tap to talk/i });

    rerenderWith([reply('msg_a', 'answered already')]);
    await waitFor(() => expect(audioPlay).toHaveBeenCalledTimes(2));
    expect(FakeAudio.instances).toHaveLength(1); // the SAME, unlocked element
  });

  it('with TTS off the reply is shown as text and the mode returns to ready', async () => {
    let speechFetched = false;
    useFetch(async (input, init) => {
      const url = String(input);
      if (url.includes('/speech')) {
        speechFetched = true;
        return binary(new Uint8Array([1]), 'audio/mpeg');
      }
      if (url.includes('/voice/transcriptions') && init?.method === 'POST') {
        return json({ text: 'x' });
      }
      return errorJson('not_found', 404);
    });
    const { rerenderWith } = renderOverlay({ voice: { tts: false } });
    await sendOneTurn();

    rerenderWith([reply('msg_a', 'read this instead')]);
    expect(await screen.findByTestId('hands-free-last-reply')).toHaveTextContent(
      'read this instead',
    );
    expect(await screen.findByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
    expect(speechFetched).toBe(false);
  });

  it('a failed speech fetch does not strand the mode', async () => {
    stubApi({ speechStatus: 502 });
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();
    rerenderWith([reply('msg_a', 'unspeakable')]);
    expect(await screen.findByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
    expect(screen.getByTestId('hands-free-last-reply')).toHaveTextContent('unspeakable');
  });
});

/* ================================================================== *
 * The conversation column
 * ================================================================== */

/** Every turn currently in the column, oldest first. */
function turns(): HTMLElement[] {
  return screen.queryAllByTestId('hands-free-turn');
}

describe('HandsFreeOverlay conversation column', () => {
  it('a successful send moves the spoken words up into the column as a "you" turn', async () => {
    renderOverlay();
    await startListening();
    expect(turns()).toHaveLength(0);
    await speakAndSend('ship the release');

    await waitFor(() => expect(turns()).toHaveLength(1));
    expect(turns()[0]).toHaveTextContent('ship the release');
    expect(turns()[0]).toHaveAttribute('data-who', 'you');
    // It left the live slot: the in-progress transcript is empty again.
    expect(screen.queryByTestId('hands-free-partial')).toBeNull();
  });

  it('a send that failed leaves the column untouched', async () => {
    renderOverlay({ onSend: vi.fn(async () => null) });
    await startListening();
    await speakAndSend('undeliverable');
    await screen.findByRole('alert');
    expect(turns()).toHaveLength(0);
  });

  it('a reply becomes a "them" turn as it is QUEUED, and is flagged while it speaks', async () => {
    // Readable while it is being read aloud — the point of the column.
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();
    rerenderWith([reply('msg_a', 'the release is out')]);

    const them = await waitFor(() => {
      const t = turns().find((el) => el.getAttribute('data-who') === 'them');
      expect(t).toBeDefined();
      return t!;
    });
    expect(them).toHaveTextContent('the release is out');
    expect(them).toHaveTextContent('Ada');
    await waitFor(() => expect(them).toHaveAttribute('data-speaking', 'true'));

    await act(async () => FakeAudio.instances[0]!.end());
    await waitFor(() => expect(them).not.toHaveAttribute('data-speaking', 'true'));
  });

  it('keeps three turns in the order they happened', async () => {
    const { rerenderWith } = renderOverlay();
    await startListening();
    await speakAndSend('first question');
    await screen.findByTestId('hands-free-awaiting');

    rerenderWith([reply('msg_a', 'an answer')]);
    await waitFor(() => expect(turns()).toHaveLength(2));
    await act(async () => FakeAudio.instances[0]!.end());

    await startListening();
    await speakAndSend('second question');
    await waitFor(() => expect(turns()).toHaveLength(3));

    expect(turns().map((t) => t.getAttribute('data-who'))).toEqual(['you', 'them', 'you']);
    expect(turns()[0]).toHaveTextContent('first question');
    expect(turns()[1]).toHaveTextContent('an answer');
    expect(turns()[2]).toHaveTextContent('second question');
  });

  it('scrolls the column to the newest turn on every append', async () => {
    const { rerenderWith } = renderOverlay();
    await startListening();
    await speakAndSend('scroll me');
    await waitFor(() => expect(turns()).toHaveLength(1));
    const afterSend = scrollIntoView.mock.calls.length;
    expect(afterSend).toBeGreaterThan(0);

    rerenderWith([reply('msg_a', 'and again')]);
    await waitFor(() => expect(turns()).toHaveLength(2));
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(afterSend);
  });

  it('awaiting shows the sent turn AND the waiting line — never a blank screen', async () => {
    renderOverlay({ counterpartName: 'Ada' });
    await startListening();
    await speakAndSend('are you there');

    const awaiting = await screen.findByTestId('hands-free-awaiting');
    expect(awaiting).toHaveTextContent(/waiting for ada/i);
    // The words that were just sent are still on screen above it.
    expect(turns()).toHaveLength(1);
    expect(turns()[0]).toHaveTextContent('are you there');
  });

  it('a new session starts with an empty column (close/reopen)', async () => {
    const first = renderOverlay();
    await startListening();
    await speakAndSend('from the last session');
    await waitFor(() => expect(turns()).toHaveLength(1));

    // Closing the mode unmounts the overlay (MicButton renders it conditionally),
    // so reopening is a fresh mount — and must be a fresh conversation.
    first.unmount();
    renderOverlay();
    expect(turns()).toHaveLength(0);
    expect(screen.queryByText(/from the last session/)).toBeNull();
  });

  it('the control bar keeps the big mic, Send and Cancel exactly where they were', async () => {
    renderOverlay();
    // ready: the big mic.
    expect(screen.getByRole('button', { name: /tap to talk/i })).toBeInTheDocument();
    await startListening();
    // listening: meter, timer, Send + Cancel — none of it shrank into the column.
    expect(screen.getByTestId('voice-level-meter')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
    const bar = screen.getByTestId('hands-free-controls');
    expect(within(bar).getByRole('button', { name: /^send$/i })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });
});

describe('HandsFreeOverlay at 390px', () => {
  it('cannot scroll sideways, and long unbroken words wrap inside a turn', async () => {
    const { rerenderWith } = renderOverlay();
    const dialog = screen.getByRole('dialog', { name: /hands-free/i });
    expect(dialog.className).toContain('overflow-x-hidden');

    await sendOneTurn();
    rerenderWith([
      reply('msg_a', 'https://example.com/a/very/long/unbreakable/url/that/would/overflow'),
    ]);
    const them = await screen.findByTestId('hands-free-last-reply');
    // A pasted URL read aloud is still a URL on screen; it must wrap, not push
    // the column past the viewport.
    expect(them.className).toContain('break-words');
  });

  it('lets the control bar shrink with the viewport instead of forcing a width', () => {
    renderOverlay();
    const bar = screen.getByTestId('hands-free-controls');
    // `w-full` + a max, never a min: at 390px the max simply does not apply.
    expect(bar.className).toContain('w-full');
    expect(bar.className).not.toMatch(/\bmin-w-\[/);
  });
});

/* ================================================================== *
 * The working cue — "is it thinking, or is it broken?"
 * ================================================================== */

describe('HandsFreeOverlay working cue', () => {
  it('sounds while awaiting a reply, in the stored style', async () => {
    renderOverlay();
    expect(cueStart).not.toHaveBeenCalled(); // silence until there is a wait
    await sendOneTurn();
    expect(cueStart).toHaveBeenCalledWith('tick'); // the default
  });

  it('stops the moment the reply starts speaking — it never talks over the voice', async () => {
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();
    expect(cueStop).not.toHaveBeenCalled();

    rerenderWith([reply('msg_a', 'here it is')]);
    await waitFor(() => expect(cueStop).toHaveBeenCalled());
  });

  it('stops when the wait is abandoned by tapping the mic', async () => {
    renderOverlay();
    await sendOneTurn();
    await startListening();
    expect(cueStop).toHaveBeenCalled();
  });

  it('stops when the mode is left', async () => {
    const { unmount } = renderOverlay();
    await sendOneTurn();
    unmount();
    expect(cueStop).toHaveBeenCalled();
  });

  it('never starts for a send that failed — there is nothing to wait for', async () => {
    renderOverlay({ onSend: vi.fn(async () => null) });
    await startListening();
    await speakAndSend('undeliverable');
    await screen.findByRole('alert');
    expect(cueStart).not.toHaveBeenCalled();
  });

  it('"Off" schedules nothing at all', async () => {
    localStorage.setItem(WORKING_CUE_KEY, 'off');
    renderOverlay();
    await sendOneTurn();
    expect(cueStart).not.toHaveBeenCalled();
  });

  it('offers a Working sound selector, and remembers the choice per browser', async () => {
    const first = renderOverlay();
    const group = screen.getByRole('radiogroup', { name: /working sound/i });
    expect(within(group).getByRole('radio', { name: 'Tick' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await userEvent.click(within(group).getByRole('radio', { name: 'Chime' }));
    expect(localStorage.getItem(WORKING_CUE_KEY)).toBe('chime');

    // A later session restores it.
    first.unmount();
    renderOverlay();
    await sendOneTurn();
    expect(cueStart).toHaveBeenCalledWith('chime');
  });

  it('changing the style mid-wait swaps the cue rather than layering it', async () => {
    renderOverlay();
    await sendOneTurn();
    expect(cueStart).toHaveBeenCalledWith('tick');

    const group = screen.getByRole('radiogroup', { name: /working sound/i });
    await userEvent.click(within(group).getByRole('radio', { name: 'Pulse' }));
    expect(cueStop).toHaveBeenCalled();
    expect(cueStart).toHaveBeenLastCalledWith('pulse');
  });
});

/* ================================================================== *
 * exit cleanup
 * ================================================================== */

describe('HandsFreeOverlay exit cleanup', () => {
  it('leaving mid-listen stops the tracks, the graph, and the socket', async () => {
    const { onClose } = renderOverlay();
    await startListening();
    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));

    expect(onClose).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(FakeAudioContext.capture.close).toHaveBeenCalled();
    await waitFor(() => expect(FakeWebSocket.last.closed).toBe(true));
  });

  it('leaving mid-speech stops the audio and releases its blob URL', async () => {
    const { rerenderWith } = renderOverlay();
    await sendOneTurn();
    rerenderWith([reply('msg_a', 'mid sentence')]);
    await waitFor(() => expect(audioPlay).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));
    expect(audioPause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('unmounting while listening releases everything too', async () => {
    const { unmount } = renderOverlay();
    await startListening();
    unmount();
    expect(trackStop).toHaveBeenCalled();
    expect(document.body.style.overflow).toBe('');
    await waitFor(() => expect(FakeWebSocket.last.closed).toBe(true));
  });
});
