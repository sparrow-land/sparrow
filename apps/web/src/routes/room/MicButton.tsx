import { useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { ApiError } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { useCapabilities } from '../../lib/capabilities.js';
import { RecordingOverlay } from './RecordingOverlay.js';
import { TranscribingIndicator } from './TranscribingIndicator.js';

/** MediaRecorder mime candidates, best first. Feature-detected at record time. */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

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

type State = 'idle' | 'recording' | 'transcribing';

/**
 * Dictation mic for the composer (v-voice). Rendered only when the instance
 * registers an STT provider (`capabilities.voice.stt`). Click to record; click
 * again to stop → the audio is transcribed and the transcript handed back via
 * `onTranscript` (the composer keeps it editable and flags provenance). Nothing
 * is ever sent here — transcription is principal-scoped; sending stays explicit.
 */
export function MicButton({
  onTranscript,
  disabled = false,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const { voice } = useCapabilities();
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef<string>('');
  const cancelledRef = useRef(false);

  if (!voice.stt) return null;

  function stopTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  function discard() {
    stopTracks();
    chunksRef.current = [];
    setState('idle');
  }

  async function start() {
    setError(null);
    cancelledRef.current = false;
    chunksRef.current = [];
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone unavailable — check browser permissions.');
      return;
    }
    streamRef.current = stream;
    const mime = pickMime();
    mimeRef.current = mime;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stopTracks();
      setError('Recording is not supported in this browser.');
      return;
    }
    recorderRef.current = recorder;
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      if (cancelledRef.current) {
        cancelledRef.current = false;
        discard();
        return;
      }
      void transcribe();
    };
    recorder.start();
    setState('recording');
  }

  async function transcribe() {
    // The recorder's own mimeType is authoritative once recording ran.
    const contentType = recorderRef.current?.mimeType || mimeRef.current || 'audio/webm';
    stopTracks();
    const blob = new Blob(chunksRef.current, { type: contentType });
    chunksRef.current = [];
    setState('transcribing');
    try {
      const audioBase64 = await blobToBase64(blob);
      const { text } = await api.transcribe({ audioBase64, contentType });
      if (text.trim()) onTranscript(text);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not transcribe audio. Please try again.');
    } finally {
      setState('idle');
    }
  }

  function stop() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else void transcribe();
  }

  /** Abandon the recording without sending anything to STT. */
  function cancel() {
    setError(null);
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    // `onstop` sees the cancel flag and discards; if the recorder never armed,
    // discard directly.
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else discard();
  }

  function onClick() {
    if (state === 'idle') void start();
    else if (state === 'recording') stop();
  }

  const recording = state === 'recording';
  const busy = state === 'transcribing';
  const label = recording ? 'Stop recording' : busy ? 'Transcribing…' : 'Record voice message';

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        aria-label={label}
        aria-pressed={recording}
        title={label}
        className={`inline-flex h-10 min-h-[40px] w-10 items-center justify-center rounded border text-sm transition-colors disabled:opacity-50 ${
          recording
            ? 'sparrow-recording border-[var(--sparrow-accent)] bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]'
            : 'border-[var(--sparrow-border-strong)] text-[var(--sparrow-muted)] hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]'
        }`}
      >
        {busy ? (
          <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin motion-reduce:animate-none" />
        ) : recording ? (
          <Square size={16} aria-hidden="true" />
        ) : (
          <Mic size={16} aria-hidden="true" />
        )}
      </button>
      {busy && <TranscribingIndicator />}
      {error && (
        <p role="alert" className="mt-1 w-full text-xs text-[var(--sparrow-danger)]">
          {error}
        </p>
      )}
      {recording && (
        <RecordingOverlay onStop={stop} onCancel={cancel} stream={streamRef.current} />
      )}
    </>
  );
}
