/**
 * 16 kHz PCM16 microphone capture for streaming STT (voice v2, hands-free mode).
 *
 * The streaming route wants raw signed-16-bit little-endian mono at 16 kHz —
 * what every realtime STT vendor eats — which `MediaRecorder` cannot produce
 * (it emits container-wrapped Opus). So the audio comes off a Web Audio graph
 * instead: `AudioContext({ sampleRate: 16000 })` → `MediaStreamAudioSourceNode`
 * → an `AudioWorkletNode` that packs float samples into Int16 frames of
 * {@link PCM_FRAME_MS} and posts each one to the main thread.
 *
 * Two things the worklet exists to handle:
 *
 * 1. **The browser may refuse 16 kHz.** Firefox and Safari happily hand back a
 *    48 kHz context whatever you ask for. The processor is told the rate it
 *    actually got and decimates to the target itself, so the wire format is the
 *    same everywhere.
 * 2. **Frames, not samples.** Posting every 128-sample render quantum would be
 *    ~375 messages a second per direction; a quarter second per frame is one
 *    WebSocket write per 4 kB and still feels live.
 *
 * The worklet source is inlined and loaded through a `Blob` URL: `addModule`
 * only takes a URL, and a separate `.js` asset would be one more thing to keep
 * in sync with the build. It runs in the audio thread's own realm — no imports,
 * no closure over this module.
 *
 * Callers that can't have a worklet (jsdom, an old Safari) get a rejected
 * promise and fall back to the record-then-transcribe path.
 */

/** The wire rate for `/voice/transcriptions/stream`. */
export const PCM_SAMPLE_RATE = 16_000;
/** How much audio each posted frame carries. */
export const PCM_FRAME_MS = 250;

const PROCESSOR_NAME = 'sparrow-pcm16';

export interface PcmCapture {
  /** Tear the graph down. Idempotent — leaving the overlay may double-stop. */
  stop(): Promise<void>;
}

/**
 * The audio-thread processor, as source text. Self-contained on purpose: it is
 * compiled in another realm, so it can reference nothing from this module.
 *
 * The resampler is a nearest-sample decimator walked with a fractional cursor
 * that CARRIES ACROSS render quanta (`this.pos`) — resetting it per block would
 * drift the phase every 128 samples and buzz. Speech at 16 kHz through a
 * vendor's own front-end does not want an anti-alias filter here; the mic's
 * hardware low-pass and the vendor's feature extractor both already assume it.
 */
const WORKLET_SOURCE = `
class SparrowPcm16 extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const target = o.targetRate || 16000;
    const context = o.contextRate || sampleRate;
    this.ratio = context / target;
    this.frame = Math.max(1, Math.round((target * (o.frameMs || 250)) / 1000));
    this.buf = new Int16Array(this.frame);
    this.n = 0;
    this.pos = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    let p = this.pos;
    while (p < channel.length) {
      let s = channel[p | 0];
      if (!(s === s)) s = 0;                 // NaN guard
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.frame) {
        const out = new Int16Array(this.buf);
        this.n = 0;
        this.port.postMessage(out.buffer, [out.buffer]);
      }
      p += this.ratio;
    }
    this.pos = p - channel.length;
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', SparrowPcm16);
`;

type AudioContextCtor = new (options?: { sampleRate?: number }) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Start capturing `stream` as 16 kHz PCM16, handing each frame to `onFrame` as
 * a transferable `ArrayBuffer` ready to go straight onto the WebSocket.
 *
 * Rejects when the engine has no `AudioWorklet` or the graph refuses to build —
 * both are "fall back to MediaRecorder", not "voice is broken".
 */
export async function startPcmCapture(
  stream: MediaStream,
  onFrame: (pcm: ArrayBuffer) => void,
): Promise<PcmCapture> {
  const Ctor = audioContextCtor();
  const WorkletNode = (globalThis as { AudioWorkletNode?: typeof AudioWorkletNode })
    .AudioWorkletNode;
  if (!Ctor || !WorkletNode) {
    throw new Error('Audio worklet capture is not available in this browser.');
  }

  const ctx = new Ctor({ sampleRate: PCM_SAMPLE_RATE });
  let stopped = false;

  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const source = ctx.createMediaStreamSource(stream);
    const node = new WorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: {
        targetRate: PCM_SAMPLE_RATE,
        // What we were actually granted — the worklet decimates from here.
        contextRate: ctx.sampleRate,
        frameMs: PCM_FRAME_MS,
      },
    });
    node.port.onmessage = (e: MessageEvent) => {
      // A frame can still be in flight from the audio thread while we tear the
      // graph down; a stopped capture is silent.
      if (!stopped) onFrame(e.data as ArrayBuffer);
    };

    // Keep the graph pulling: a worklet with nothing downstream is not
    // guaranteed to be rendered. Gain 0 so the mic is never echoed back.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        node.port.onmessage = null;
        try {
          source.disconnect();
          node.disconnect();
          sink.disconnect();
        } catch {
          /* already torn down */
        }
        if (ctx.state !== 'closed') await ctx.close().catch(() => {});
      },
    };
  } catch (e) {
    stopped = true;
    await ctx.close().catch(() => {});
    throw e;
  }
}
