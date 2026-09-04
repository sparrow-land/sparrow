import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Mic, Send, X } from 'lucide-react';
import { ApiError, openTranscriptionStream, type TranscriptionStream } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { useCapabilities } from '../../lib/capabilities.js';
import { startPcmCapture, type PcmCapture } from '../../lib/pcmCapture.js';
import {
  WORKING_CUE_LABELS,
  WORKING_CUE_STYLES,
  loadWorkingCueStyle,
  saveWorkingCueStyle,
  startWorkingCue,
  type WorkingCueStyle,
} from '../../lib/workingCue.js';
import { LevelMeter } from './LevelMeter.js';

/**
 * Hands-free mode (voice v2) — the full-viewport surface that turns dictation
 * into a conversation you can hold without looking at the keyboard. It replaces
 * `RecordingOverlay`, whose whole job was "one big stop target"; this one owns a
 * loop instead:
 *
 * ```
 * ready ──tap mic──▶ listening ──Send──▶ sending ──▶ awaiting ──reply──▶ speaking ──▶ ready
 *   ▲                  │Cancel                                  │ tap mic (interrupt)
 *   └──────────────────┘◀───────────────────────────────────────┘
 * ```
 *
 * The transcript NEVER lands in the composer: a spoken turn is posted by the
 * overlay (through `onSend`, which is the room's ordinary send path carrying
 * `origin:'voice'`) and the mode stays up for the answer. Drafts and
 * attachments are untouched — a voice turn is text and nothing else.
 *
 * Two capture paths behind one UI:
 * - `voice.sttStreaming` → 16 kHz PCM over the WebSocket route, words appearing
 *   as they are spoken (see {@link ../../lib/pcmCapture.startPcmCapture});
 * - otherwise → `MediaRecorder` + one-shot `POST /voice/transcriptions` after
 *   Stop. Same overlay, same buttons, no live words. A keyless-streaming
 *   instance is not a degraded feature, just a quieter one — and the streaming
 *   path itself falls back here if the audio worklet won't build.
 *
 * The `Audio` element is created and `play()`ed on a silent source INSIDE the
 * Send tap, then reused for every reply: mobile Safari only lets an element
 * play if it was first started from a user gesture, and the reply arrives
 * seconds later with no gesture anywhere near it.
 */

/**
 * One exchanged turn, as the overlay's conversation column renders it. Kept for
 * the life of the mode (a fresh mount is a fresh conversation) so the screen
 * after Send reads like a short chat you can glance at, instead of the blank
 * "waiting…" it used to be.
 */
export interface HandsFreeTurn {
  /** The message id — the send's own for a 'you' turn, the arrival's for 'them'. */
  id: string;
  who: 'you' | 'them';
  /** Sender's display name; only 'them' turns carry one. */
  name?: string;
  text: string;
}

/** A message from ANOTHER member that arrived while the mode was open. */
export interface HandsFreeIncoming {
  id: string;
  body: string;
  /** Sender's display name — for the awaiting line and the reply caption. */
  from: string;
}

export interface HandsFreeOverlayProps {
  /** The room a spoken turn is posted to (and whose `/speech` we fetch). */
  roomId: string;
  /** Leave the mode entirely (corner ✕ / Escape). */
  onClose: () => void;
  /**
   * Post the transcript through the room's ordinary send path with
   * `origin:'voice'`. Resolves with the new message id, or `null` when the send
   * failed — the overlay then stays put with the words intact so the turn can
   * be retried.
   */
  onSend: (text: string) => Promise<string | null>;
  /**
   * Messages from other members that arrived while the mode was open, oldest
   * first. The owner appends; the overlay dedupes by id and speaks in order,
   * so re-rendering the same list is free.
   */
  incoming?: HandsFreeIncoming[];
  /** The counterpart's live working note, shown while awaiting a reply. */
  awaitingNote?: string | null;
  /** Who we are talking to, for "Waiting for <name>…". */
  counterpartName?: string | null;
}

type Phase = 'ready' | 'listening' | 'sending' | 'awaiting' | 'speaking';
/** What the listening state is doing (the fallback path has more steps). */
type Capture = 'streaming' | 'recording' | 'transcribing' | 'review';

/** `MediaRecorder` mime candidates for the fallback path, best first. */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** How long Send waits for the vendor's final `committed` before giving up. */
const COMMIT_GRACE_MS = 1_500;

/**
 * A zero-sample WAV. Playing it costs nothing audible and is enough to mark the
 * element as user-started, which is the whole point.
 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

function pickMime(): string {
  const supported = (t: string): boolean =>
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(t);
  return MIME_CANDIDATES.find(supported) ?? '';
}

/** Blob → base64 (no data-URL prefix) via FileReader — jsdom-friendly. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/** Whole seconds → mm:ss (zero-padded, minutes uncapped). */
function formatElapsed(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function joinWords(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

export function HandsFreeOverlay({
  roomId,
  onClose,
  onSend,
  incoming = [],
  awaitingNote = null,
  counterpartName = null,
}: HandsFreeOverlayProps) {
  const { voice } = useCapabilities();
  const streaming = voice.sttStreaming ?? false;

  const [phase, setPhase] = useState<Phase>('ready');
  const [capture, setCapture] = useState<Capture>('streaming');
  const [committed, setCommitted] = useState('');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  /** The session's conversation, oldest first. */
  const [turns, setTurns] = useState<HandsFreeTurn[]>([]);
  /** Which turn is being read aloud right now (a subtle marker, not a state). */
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  /** The audible "still working" heartbeat during `awaiting` (per-browser choice). */
  const [cueStyle, setCueStyle] = useState<WorkingCueStyle>(loadWorkingCueStyle);

  // Live capture handles. Refs, not state: teardown must be able to run from an
  // unmount cleanup, where no render will follow.
  const streamRef = useRef<MediaStream | null>(null);
  const pcmRef = useRef<PcmCapture | null>(null);
  const sttRef = useRef<TranscriptionStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const cancelledRef = useRef(false);

  // Transcript mirrors, so the send path reads the text the vendor just sent
  // rather than whatever React had rendered when the tap happened.
  const committedRef = useRef('');
  const partialRef = useRef('');
  /** Resolver armed by Send, fired by the first `committed` frame after it. */
  const commitWaiterRef = useRef<(() => void) | null>(null);

  // Playback. ONE element for the life of the overlay (see the autoplay note).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  /**
   * The cue's AudioContext. Built in the same tap as the `Audio` element and for
   * the same reason: iOS only lets a context started from a gesture make sound,
   * and the wait it fills begins long after the last one.
   */
  const cueCtxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<HandsFreeIncoming[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const speakingRef = useRef(false);

  /**
   * Which capture RUN is current. Bringing a microphone up is two awaits deep
   * (`getUserMedia`, then the worklet module), and the reader can leave — or
   * Cancel, or Send — in either gap. Every teardown bumps this counter, and
   * anything resuming after an await bails unless its generation is still the
   * live one, releasing whatever it just built. Without it an exit mid-handshake
   * left the mic recording, a vendor session running to its ten-minute cap, and
   * an AudioContext open, all owned by a component that no longer exists.
   */
  const runRef = useRef(0);
  /** The sentinel the column scrolls to whenever a turn lands. */
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const addTurn = useCallback((turn: HandsFreeTurn) => {
    setTurns((cur) => (cur.some((t) => t.id === turn.id) ? cur : [...cur, turn]));
  }, []);

  // Keep the newest turn in view. Scrolling on `length` rather than on the array
  // means a re-render that only re-flags what is speaking does not yank the
  // column while someone is reading further up it.
  useEffect(() => {
    if (turns.length === 0) return;
    // Optional call: an engine without `scrollIntoView` (jsdom, some embedded
    // webviews) must lose the scroll, never the overlay.
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length]);

  /* ---------------------------------------------------------------- *
   * Teardown primitives
   * ---------------------------------------------------------------- */

  const stopCapture = useCallback(() => {
    // Anything still in flight for the run we are ending is now stale.
    runRef.current += 1;
    recorderRef.current = null;
    const pcm = pcmRef.current;
    pcmRef.current = null;
    void pcm?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setMicStream(null);
  }, []);

  const closeStt = useCallback(() => {
    const stt = sttRef.current;
    sttRef.current = null;
    stt?.close();
    commitWaiterRef.current?.();
    commitWaiterRef.current = null;
  }, []);

  const stopAudio = useCallback(() => {
    speakingRef.current = false;
    setSpeakingId(null);
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.pause();
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  /**
   * Create (once) and unlock the playback element. MUST run synchronously
   * inside a tap: on iOS Safari an element that has never been played from a
   * gesture will refuse `play()` forever, and the reply we want to speak
   * arrives seconds later with no gesture near it.
   *
   * Both taps do it. Send is the obvious one, but `speaking` is reachable
   * straight from `ready` too — the counterpart can answer an EARLIER turn
   * before this one is sent — and the mic tap is the gesture that covers it.
   */
  const unlockAudio = useCallback(() => {
    if (audioRef.current) return;
    const audio = new Audio();
    audioRef.current = audio;
    audio.src = SILENT_WAV;
    void Promise.resolve(audio.play()).catch(() => {
      /* a browser that refuses the silent frame will refuse the clip too */
    });

    // Same gesture, same reason: the working cue needs a context that was born
    // inside a tap. It is tiny and idle until `awaiting` asks it for a sound.
    if (cueCtxRef.current) return;
    try {
      const Ctor = (globalThis as unknown as { AudioContext?: new () => AudioContext })
        .AudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      cueCtxRef.current = ctx;
      void Promise.resolve(ctx.resume?.()).catch(() => {});
    } catch {
      /* no Web Audio here — the mode works, just silently */
    }
  }, []);

  const resetTranscript = useCallback(() => {
    committedRef.current = '';
    partialRef.current = '';
    setCommitted('');
    setPartial('');
  }, []);

  /* ---------------------------------------------------------------- *
   * Modal behaviours: scroll lock, Escape, unmount cleanup
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // One cleanup for every way out — the ✕, Escape, or the owner unmounting us.
  useEffect(
    () => () => {
      stopCapture();
      closeStt();
      stopAudio();
    },
    [stopCapture, closeStt, stopAudio],
  );

  const exit = useCallback(() => {
    stopCapture();
    closeStt();
    stopAudio();
    onClose();
  }, [stopCapture, closeStt, stopAudio, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      exit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [exit]);

  // The listening timer, so a long turn is visibly still capturing.
  useEffect(() => {
    if (phase !== 'listening') return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  /* ---------------------------------------------------------------- *
   * listening
   * ---------------------------------------------------------------- */

  const startRecorder = useCallback((stream: MediaStream, transcribe: () => void) => {
    const mime = pickMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      setError('Recording is not supported in this browser.');
      setPhase('ready');
      return false;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];
    cancelledRef.current = false;
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      if (cancelledRef.current) {
        cancelledRef.current = false;
        return;
      }
      transcribe();
    };
    recorder.start();
    setCapture('recording');
    return true;
  }, []);

  /** Fallback path: one recording → one `POST /voice/transcriptions`. */
  const transcribeRecording = useCallback(() => {
    const contentType = recorderRef.current?.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: contentType });
    chunksRef.current = [];
    // The mic is done the moment we stop; do not hold it through the round trip.
    stopCapture();
    // Taken AFTER the teardown bump: this is the turn the vendor is answering,
    // and a Cancel or an exit while it is in flight must discard its answer
    // rather than let it surface in the next turn.
    const gen = runRef.current;
    setCapture('transcribing');
    void (async () => {
      try {
        const audioBase64 = await blobToBase64(blob);
        const { text } = await api.transcribe({ audioBase64, contentType });
        if (gen !== runRef.current) return;
        committedRef.current = text.trim();
        setCommitted(committedRef.current);
        setCapture('review');
      } catch (e) {
        if (gen !== runRef.current) return;
        setError(
          e instanceof ApiError ? e.message : 'Could not transcribe audio. Please try again.',
        );
        setCapture('review');
      }
    })();
  }, [stopCapture]);

  const startListening = useCallback(() => {
    // The tap is our one guaranteed gesture — spend it before anything async.
    unlockAudio();
    setError(null);
    stopAudio();
    resetTranscript();
    setSeconds(0);
    setPhase('listening');
    setCapture(streaming ? 'streaming' : 'recording');
    // Claim this run. `stopCapture` (Cancel, Send, ✕, Escape, unmount) bumps the
    // counter, so everything below can tell whether it is still wanted.
    const gen = ++runRef.current;
    const stale = () => gen !== runRef.current;

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (stale()) return;
        setError('Microphone unavailable — check browser permissions.');
        setPhase('ready');
        return;
      }
      if (stale()) {
        // The mode was left while the permission prompt was up. Nobody else
        // holds this stream, so nobody else will release it.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setMicStream(stream);

      if (streaming) {
        let stt: TranscriptionStream | null = null;
        try {
          stt = openTranscriptionStream(api.voiceStreamUrl(), {
            onPartial: (text) => {
              if (stale()) return;
              partialRef.current = text;
              setPartial(text);
            },
            onCommitted: (text) => {
              if (stale()) return;
              committedRef.current = joinWords(committedRef.current, text.trim());
              partialRef.current = '';
              setCommitted(committedRef.current);
              setPartial('');
              commitWaiterRef.current?.();
              commitWaiterRef.current = null;
            },
            onError: (message) => {
              if (stale()) return;
              setError(message);
              // The vendor side is over. Leaving the mic hot would keep pushing
              // audio into a dead session, so end the capture and keep whatever
              // words did land — the turn is still sendable.
              const words = joinWords(committedRef.current, partialRef.current).trim();
              stopCapture();
              closeStt();
              if (words) setCapture('review');
              else setPhase('ready');
            },
          });
          const pcm = await startPcmCapture(stream, (buf) => stt!.send(buf));
          if (stale()) {
            // Left (or Cancelled) while the worklet module was loading: release
            // the graph and the vendor session we just opened, and the mic.
            void pcm.stop();
            stt.close();
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          sttRef.current = stt;
          pcmRef.current = pcm;
          setCapture('streaming');
          return;
        } catch {
          // No worklet (or the graph refused): the buffered path still works,
          // and a turn the user can complete beats an error they can't act on.
          stt?.close();
          sttRef.current = null;
          if (stale()) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
        }
      }
      startRecorder(stream, transcribeRecording);
    })();
  }, [
    streaming,
    unlockAudio,
    stopAudio,
    resetTranscript,
    stopCapture,
    closeStt,
    startRecorder,
    transcribeRecording,
  ]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else transcribeRecording();
  }, [transcribeRecording]);

  const cancelListening = useCallback(() => {
    setError(null);
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stopCapture();
    closeStt();
    resetTranscript();
    setPhase('ready');
  }, [stopCapture, closeStt, resetTranscript]);

  /* ---------------------------------------------------------------- *
   * sending
   * ---------------------------------------------------------------- */

  const doSend = useCallback(() => {
    unlockAudio();
    setError(null);
    setPhase('sending');

    void (async () => {
      const stt = sttRef.current;
      if (stt) {
        stt.commit();
        // Give the vendor a moment to turn the last partial into a committed
        // segment — but never hold the send hostage to it.
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(finish, COMMIT_GRACE_MS);
          commitWaiterRef.current = finish;
        });
        commitWaiterRef.current = null;
      }
      closeStt();
      stopCapture();

      const text = joinWords(committedRef.current, partialRef.current).trim();
      if (!text) {
        // The words we were showing were only ever a partial, and the vendor
        // took them back on commit. Silently landing in `ready` reads as the
        // app dropping the turn; say so, and leave the mic one tap away.
        setError('Nothing to send — try again.');
        setCapture('review');
        setPhase('listening');
        return;
      }
      const id = await onSend(text);
      if (!id) {
        setError('Failed to send. Please try again.');
        setCapture('review');
        setPhase('listening');
        return;
      }
      // The words move out of the live slot and into the column — same place on
      // screen, now part of the conversation rather than in progress.
      addTurn({ id, who: 'you', text });
      resetTranscript();
      setPhase('awaiting');
    })();
  }, [unlockAudio, closeStt, stopCapture, onSend, resetTranscript, addTurn]);

  /* ---------------------------------------------------------------- *
   * speaking
   * ---------------------------------------------------------------- */

  const speak = useCallback(
    (message: HandsFreeIncoming) => {
      speakingRef.current = true;
      setPhase('speaking');

      // No TTS registered: the reply is READ, not heard, and the turn ends. Its
      // text is already in the column, which is the whole affordance here.
      if (!voice.tts) {
        speakingRef.current = false;
        setPhase('ready');
        return;
      }
      setSpeakingId(message.id);

      void (async () => {
        try {
          const { bytes, contentType } = await api.getMessageSpeech(roomId, message.id);
          if (!speakingRef.current) return; // interrupted / left while fetching
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
          audioUrlRef.current = url;
          const audio = audioRef.current ?? new Audio();
          audioRef.current = audio;
          audio.src = url;
          audio.onended = () => {
            stopAudio();
            setSpeakingId(null);
            setPhase((p) => (p === 'speaking' ? 'ready' : p));
          };
          await audio.play();
        } catch {
          // A vendor failure must not strand the mode: the text is on screen and
          // the mic is one tap away.
          stopAudio();
          setSpeakingId(null);
          setPhase((p) => (p === 'speaking' ? 'ready' : p));
        }
      })();
    },
    [roomId, voice.tts, stopAudio],
  );

  // Queue every unseen arrival, then speak when the floor is free. `ready` and
  // `awaiting` are the only states where the reader is not mid-turn — we never
  // talk over someone who is dictating.
  useEffect(() => {
    for (const m of incoming) {
      if (seenRef.current.has(m.id)) continue;
      seenRef.current.add(m.id);
      queueRef.current.push(m);
      // Readable as soon as it is queued — before, and while, it is spoken.
      addTurn({ id: m.id, who: 'them', name: m.from, text: m.body });
    }
    if (speakingRef.current) return;
    if (phase !== 'ready' && phase !== 'awaiting') return;
    const next = queueRef.current.shift();
    if (next) speak(next);
  }, [incoming, phase, speak, addTurn]);

  /**
   * The cue runs for exactly as long as the wait does. Scoping it to the phase
   * means every way OUT of `awaiting` — the reply speaking, tapping the mic to
   * start another turn, an error, leaving the mode, unmounting — stops it
   * through the same cleanup, with no exit path left to forget.
   */
  useEffect(() => {
    if (phase !== 'awaiting' || error || cueStyle === 'off') return;
    const ctx = cueCtxRef.current;
    if (!ctx) return;
    const cue = startWorkingCue(ctx, cueStyle);
    return () => cue.stop();
  }, [phase, error, cueStyle]);

  // Release the cue's context with the overlay (the capture graph has its own).
  useEffect(
    () => () => {
      const ctx = cueCtxRef.current;
      cueCtxRef.current = null;
      if (ctx && ctx.state !== 'closed') void Promise.resolve(ctx.close?.()).catch(() => {});
    },
    [],
  );

  const chooseCue = useCallback((style: WorkingCueStyle) => {
    setCueStyle(style);
    saveWorkingCueStyle(style);
  }, []);

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const transcriptText = joinWords(committed, partial).trim();
  const hasText = transcriptText.length > 0;
  const listening = phase === 'listening';
  const showTranscript = (listening || phase === 'sending') && (hasText || capture === 'review');

  const bigMic = (label: string, onClick: () => void, pulsing = false) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`flex h-32 w-32 items-center justify-center rounded-full bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)] ring-4 ring-[var(--sparrow-accent)] transition-transform hover:scale-105 ${
        pulsing ? 'motion-safe:animate-pulse motion-reduce:animate-none' : ''
      }`}
    >
      <Mic size={56} aria-hidden="true" />
    </button>
  );

  /** The newest 'them' turn — what "the last thing said" means on screen. */
  const lastThemId = [...turns].reverse().find((t) => t.who === 'them')?.id ?? null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Hands-free voice mode"
      className="fixed inset-0 z-50 flex flex-col overflow-x-hidden bg-[var(--sparrow-bg)] px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <button
        type="button"
        onClick={exit}
        aria-label="Leave hands-free mode"
        className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
      >
        <X size={16} aria-hidden="true" /> Done
      </button>

      {/* The conversation. Fills everything above the controls and scrolls, so a
          long session stays glanceable instead of collapsing to "waiting…".
          Older turns recede; the newest reads at full contrast. The live region
          is NOT here — it stays on the in-progress transcript below, so a screen
          reader hears the words forming once, not the whole column again. */}
      <div
        data-testid="hands-free-conversation"
        className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-end gap-3 overflow-y-auto pb-4 pt-16 text-left"
      >
        {turns.map((turn, i) => {
          const newest = i === turns.length - 1;
          const speaking = turn.id === speakingId;
          return (
            <div
              key={turn.id}
              data-testid="hands-free-turn"
              data-who={turn.who}
              {...(speaking ? { 'data-speaking': 'true' } : {})}
              className={turn.who === 'you' ? 'self-end text-right' : 'self-start'}
            >
              <p
                className={`text-[11px] font-medium uppercase tracking-wide ${
                  speaking ? 'text-[var(--sparrow-accent)]' : 'text-[var(--sparrow-muted)]'
                }`}
              >
                {turn.who === 'you' ? 'You' : (turn.name ?? 'Them')}
                {speaking && (
                  <span
                    data-testid="hands-free-speaking"
                    className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--sparrow-accent)] align-middle motion-safe:animate-pulse motion-reduce:animate-none"
                  >
                    <span className="sr-only">speaking</span>
                  </span>
                )}
              </p>
              <p
                {...(turn.who === 'them' && turn.id === lastThemId
                  ? { 'data-testid': 'hands-free-last-reply' }
                  : {})}
                className={`max-w-full whitespace-pre-wrap break-words leading-snug sm:max-w-xl ${
                  newest
                    ? 'text-lg text-[var(--sparrow-text)]'
                    : 'text-sm text-[var(--sparrow-muted)]'
                }`}
              >
                {turn.text}
              </p>
            </div>
          );
        })}

        {/* The turn in progress: the live transcript sits at the BOTTOM of the
            column, exactly where it will settle once Send lands. */}
        {listening && (
          <div className="self-end text-right">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--sparrow-accent)]">
              You
            </p>
            <p
              data-testid="hands-free-transcript"
              aria-live="polite"
              className="min-h-[2rem] max-w-full break-words text-lg leading-snug text-[var(--sparrow-text)] sm:max-w-xl"
            >
              {committed}
              {partial && (
                <span data-testid="hands-free-partial" className="text-[var(--sparrow-muted)]">
                  {committed ? ' ' : ''}
                  {partial}
                </span>
              )}
              {!showTranscript && capture !== 'review' && (
                <span className="text-[var(--sparrow-muted)]">
                  {capture === 'recording' ? 'Recording…' : 'Listening…'}
                </span>
              )}
            </p>
          </div>
        )}

        {phase === 'sending' && showTranscript && (
          <div className="self-end text-right">
            <p
              data-testid="hands-free-transcript"
              aria-live="polite"
              className="max-w-full break-words text-lg leading-snug text-[var(--sparrow-text)] sm:max-w-xl"
            >
              {transcriptText}
            </p>
          </div>
        )}

        {/* Waiting sits UNDER the turn just sent, not instead of it. */}
        {phase === 'awaiting' && (
          <p
            data-testid="hands-free-awaiting"
            role="status"
            aria-live="polite"
            className="self-end text-right text-sm text-[var(--sparrow-muted)]"
          >
            {awaitingNote
              ? `${counterpartName ?? 'They'} — ${awaitingNote}`
              : `Waiting for ${counterpartName ?? 'a reply'}…`}
          </p>
        )}

        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {error && (
        <p role="alert" className="mx-auto max-w-2xl pb-2 text-center text-sm text-[var(--sparrow-danger)]">
          {error}
        </p>
      )}

      {/* The controls. Unchanged in size, placement and labels — the column grew
          above them, nothing here shrank to make room. */}
      <div
        data-testid="hands-free-controls"
        className="mx-auto flex w-full max-w-md shrink-0 flex-col items-center justify-center gap-4 pb-4 pt-2 text-center"
      >
        {phase === 'ready' && (
          <>
            {bigMic('Tap to talk', startListening)}
            <span className="text-lg font-medium text-[var(--sparrow-text)]">Tap to talk</span>
          </>
        )}

        {listening && (
          <>
            <LevelMeter stream={micStream} />
            <span
              role="timer"
              aria-live="off"
              className="mono text-2xl font-semibold tabular-nums text-[var(--sparrow-text)]"
            >
              {formatElapsed(seconds)}
            </span>
            <div className="flex w-full items-center justify-center gap-3">
              {capture === 'recording' ? (
                <button
                  type="button"
                  onClick={stopRecording}
                  className="flex-1 rounded-lg bg-[var(--sparrow-accent)] px-6 py-4 text-lg font-semibold text-black"
                >
                  Stop
                </button>
              ) : capture === 'transcribing' ? (
                <span
                  role="status"
                  data-testid="transcribing-indicator"
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--sparrow-border-strong)] px-6 py-4 text-lg text-[var(--sparrow-muted)]"
                >
                  <Loader2
                    size={18}
                    aria-hidden="true"
                    className="motion-safe:animate-spin motion-reduce:animate-none"
                  />
                  Transcribing…
                </span>
              ) : (
                <button
                  type="button"
                  onClick={doSend}
                  disabled={!hasText}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--sparrow-accent)] px-6 py-4 text-lg font-semibold text-black disabled:opacity-50"
                >
                  <Send size={18} aria-hidden="true" /> Send
                </button>
              )}
              <button
                type="button"
                onClick={cancelListening}
                className="flex-1 rounded-lg border border-[var(--sparrow-border-strong)] px-6 py-4 text-lg font-semibold text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {phase === 'sending' && (
          <span role="status" className="text-lg text-[var(--sparrow-muted)]">
            Sending…
          </span>
        )}

        {phase === 'awaiting' && bigMic('Tap to talk', startListening)}

        {phase === 'speaking' && (
          <>
            {bigMic('Interrupt and talk', startListening, true)}
            <span className="text-sm text-[var(--sparrow-muted)]">
              Speaking… tap the mic to reply
            </span>
          </>
        )}
      </div>

      {/* The cue's style, parked below the controls: a preference you set once
          and then never look at, so it gets the smallest type on the screen and
          none of the tap targets' room. */}
      <div
        role="radiogroup"
        aria-label="Working sound"
        data-testid="hands-free-cue-picker"
        className="mx-auto flex w-full max-w-md shrink-0 flex-wrap items-center justify-center gap-1 pb-2 text-[11px]"
      >
        <span className="mr-1 text-[var(--sparrow-muted)]" aria-hidden="true">
          Working sound
        </span>
        {WORKING_CUE_STYLES.map((style) => {
          const on = style === cueStyle;
          return (
            <button
              key={style}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => chooseCue(style)}
              className={`rounded-full px-2 py-1 transition-colors ${
                on
                  ? 'bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]'
                  : 'text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
              }`}
            >
              {WORKING_CUE_LABELS[style]}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
