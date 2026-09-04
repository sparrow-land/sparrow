import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PCM_FRAME_MS, PCM_SAMPLE_RATE, startPcmCapture } from './pcmCapture.js';

/* ------------------------------------------------------------------ *
 * Web Audio fakes. jsdom has no audio graph at all, so the whole thing
 * is stood up by hand — enough to assert the wiring, the rate the
 * worklet is told to resample to, and teardown.
 * ------------------------------------------------------------------ */

class FakeNode {
  connected: unknown[] = [];
  disconnect = vi.fn();
  connect = vi.fn((n: unknown) => {
    this.connected.push(n);
    return n;
  });
}

class FakeWorkletNode extends FakeNode {
  static last: FakeWorkletNode | null = null;
  port = { onmessage: null as ((e: { data: unknown }) => void) | null, close: vi.fn() };
  constructor(
    readonly ctx: FakeAudioContext,
    readonly name: string,
    readonly options: { processorOptions?: Record<string, unknown> } = {},
  ) {
    super();
    FakeWorkletNode.last = this;
  }
  /** Drive one frame from the (real-browser) worklet thread. */
  emit(pcm: ArrayBuffer): void {
    this.port.onmessage?.({ data: pcm });
  }
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  /** What the browser actually gave us — overridden per test. */
  static grantedRate = PCM_SAMPLE_RATE;
  sampleRate: number;
  state = 'running';
  destination = new FakeNode();
  audioWorklet = { addModule: vi.fn(async () => {}) };
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  source = new FakeNode();
  gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  createGain = vi.fn(() => this.gain);
  constructor(readonly options?: { sampleRate?: number }) {
    this.sampleRate = FakeAudioContext.grantedRate;
    FakeAudioContext.last = this;
  }
}

const fakeStream = { getTracks: () => [] } as unknown as MediaStream;

beforeEach(() => {
  FakeAudioContext.grantedRate = PCM_SAMPLE_RATE;
  FakeAudioContext.last = null;
  FakeWorkletNode.last = null;
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode as unknown as typeof AudioWorkletNode);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:worklet'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => vi.unstubAllGlobals());

describe('startPcmCapture', () => {
  it('asks for a 16 kHz context and loads the inline worklet from a blob URL', async () => {
    await startPcmCapture(fakeStream, vi.fn());
    const ctx = FakeAudioContext.last!;
    expect(ctx.options?.sampleRate).toBe(PCM_SAMPLE_RATE);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('blob:worklet');
    // The module URL is a one-shot: released once registered.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:worklet');
  });

  it('wires mic → worklet and keeps the graph pulling through a silent gain node', async () => {
    await startPcmCapture(fakeStream, vi.fn());
    const ctx = FakeAudioContext.last!;
    const node = FakeWorkletNode.last!;
    expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(fakeStream);
    expect(ctx.source.connected).toContain(node);
    // Muted tap to the destination: a worklet with no downstream is not pulled
    // in every engine, and gain 0 means the mic is never echoed back.
    expect(node.connected).toContain(ctx.gain);
    expect(ctx.gain.gain.value).toBe(0);
    expect(ctx.gain.connect).toHaveBeenCalledWith(ctx.destination);
  });

  it('tells the worklet the granted rate so it downsamples when 16 kHz is refused', async () => {
    FakeAudioContext.grantedRate = 48_000;
    await startPcmCapture(fakeStream, vi.fn());
    const opts = FakeWorkletNode.last!.options.processorOptions!;
    expect(opts.contextRate).toBe(48_000);
    expect(opts.targetRate).toBe(PCM_SAMPLE_RATE);
    expect(opts.frameMs).toBe(PCM_FRAME_MS);
  });

  it('forwards every worklet frame to the caller', async () => {
    const onFrame = vi.fn();
    await startPcmCapture(fakeStream, onFrame);
    const a = new Int16Array([1, 2, 3]).buffer;
    const b = new Int16Array([4]).buffer;
    FakeWorkletNode.last!.emit(a);
    FakeWorkletNode.last!.emit(b);
    expect(onFrame).toHaveBeenNthCalledWith(1, a);
    expect(onFrame).toHaveBeenNthCalledWith(2, b);
  });

  it('drops frames that arrive after stop() — a closing graph must not keep talking', async () => {
    const onFrame = vi.fn();
    const capture = await startPcmCapture(fakeStream, onFrame);
    const node = FakeWorkletNode.last!;
    await capture.stop();
    node.emit(new Int16Array([1]).buffer);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('stop() disconnects the graph and closes the context', async () => {
    const capture = await startPcmCapture(fakeStream, vi.fn());
    const ctx = FakeAudioContext.last!;
    const node = FakeWorkletNode.last!;
    await capture.stop();
    expect(ctx.source.disconnect).toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
    // Idempotent: leaving the overlay may stop an already-stopped capture.
    await expect(capture.stop()).resolves.toBeUndefined();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('rejects when the engine has no AudioWorklet, so the caller can fall back', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    await expect(startPcmCapture(fakeStream, vi.fn())).rejects.toThrow(/worklet/i);
  });

  it('rejects (without leaking a context) when the worklet module fails to load', async () => {
    class Failing extends FakeAudioContext {
      override audioWorklet = {
        addModule: vi.fn(async () => {
          throw new Error('nope');
        }),
      };
    }
    vi.stubGlobal('AudioContext', Failing as unknown as typeof AudioContext);
    await expect(startPcmCapture(fakeStream, vi.fn())).rejects.toThrow();
    expect(FakeAudioContext.last!.close).toHaveBeenCalled();
  });
});
