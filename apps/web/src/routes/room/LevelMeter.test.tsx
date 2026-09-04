import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LevelMeter } from './LevelMeter.js';

/**
 * Web Audio is not in jsdom. Stand up a minimal AudioContext/AnalyserNode fake so
 * we can assert the meter wires an analyser onto the recorder's own stream and
 * tears the whole graph down when it unmounts (stop/cancel).
 */
class FakeAnalyser {
  fftSize = 2048;
  frequencyBinCount = 32;
  smoothingTimeConstant = 0;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData(arr: Uint8Array) {
    for (let i = 0; i < arr.length; i += 1) arr[i] = 96;
  }
  getByteTimeDomainData(arr: Uint8Array) {
    for (let i = 0; i < arr.length; i += 1) arr[i] = 160;
  }
}

class FakeSource {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'running' | 'closed' = 'running';
  source = new FakeSource();
  analyser = new FakeAnalyser();
  lastStream: unknown = null;
  createMediaStreamSource = vi.fn((stream: unknown) => {
    this.lastStream = stream;
    return this.source;
  });
  createAnalyser = vi.fn(() => this.analyser);
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

function installAudio() {
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  // Some engines only expose the prefixed constructor.
  vi.stubGlobal('webkitAudioContext', FakeAudioContext);
}

const fakeStream = { id: 'stream-1', getTracks: () => [] } as unknown as MediaStream;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LevelMeter', () => {
  it('renders bar elements while mounted', () => {
    installAudio();
    render(<LevelMeter stream={fakeStream} />);
    const meter = screen.getByTestId('voice-level-meter');
    expect(meter).toBeInTheDocument();
    expect(meter.querySelectorAll('[data-meter-bar]').length).toBeGreaterThan(1);
  });

  it('wires an analyser onto the SAME stream the recorder uses', () => {
    installAudio();
    render(<LevelMeter stream={fakeStream} />);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(fakeStream);
    expect(ctx.createAnalyser).toHaveBeenCalledTimes(1);
    // source → analyser is connected so the meter is driven by the live signal.
    expect(ctx.source.connect).toHaveBeenCalledWith(ctx.analyser);
  });

  it('tears the audio graph down on unmount (stop/cancel)', async () => {
    installAudio();
    const { unmount } = render(<LevelMeter stream={fakeStream} />);
    const ctx = FakeAudioContext.instances[0]!;
    unmount();
    expect(ctx.source.disconnect).toHaveBeenCalled();
    expect(ctx.analyser.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
  });

  it('degrades gracefully when AudioContext is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    // Must not throw, and the overlay still gets its (static) bars.
    render(<LevelMeter stream={fakeStream} />);
    expect(screen.getByTestId('voice-level-meter').querySelectorAll('[data-meter-bar]').length)
      .toBeGreaterThan(1);
  });

  it('sets up no audio graph when there is no stream yet', () => {
    installAudio();
    render(<LevelMeter stream={null} />);
    expect(FakeAudioContext.instances).toHaveLength(0);
    // Still renders (idle bars) without a stream.
    expect(screen.getByTestId('voice-level-meter')).toBeInTheDocument();
  });
});
