import { useEffect, useRef, useState } from 'react';
import { Square, Volume2 } from 'lucide-react';
import { ApiError } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { useCapabilities } from '../../lib/capabilities.js';

/**
 * Module-level "only one plays at a time": starting a new clip (or stopping the
 * current one) tears down whatever was playing and revokes its object URL.
 */
let current: { audio: HTMLAudioElement; url: string; stopReact: () => void } | null = null;

function tearDown() {
  if (!current) return;
  const c = current;
  current = null;
  c.audio.pause();
  URL.revokeObjectURL(c.url);
  c.stopReact();
}

type State = 'idle' | 'loading' | 'playing';

/**
 * Speak a message aloud (v-voice). Rendered only when the instance registers a
 * TTS provider (`capabilities.voice.tts`). Click fetches the synthesized speech
 * (`GET .../messages/:id/speech`), plays it through an `<audio>`, and toggles to
 * stop; a second clip stops the first. Fetch/vendor failures surface inline.
 */
export function SpeakerButton({ roomId, messageId }: { roomId: string; messageId: string }) {
  const { voice } = useCapabilities();
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const ownAudioRef = useRef<HTMLAudioElement | null>(null);

  // Stop our clip if this bubble unmounts mid-play.
  useEffect(() => {
    return () => {
      if (current && current.audio === ownAudioRef.current) tearDown();
    };
  }, []);

  if (!voice.tts) return null;

  function stop() {
    if (current && current.audio === ownAudioRef.current) tearDown();
    else setState('idle');
  }

  async function play() {
    setError(null);
    // Create the Audio element inside the click chain so playback is user-gestured.
    const audio = new Audio();
    ownAudioRef.current = audio;
    tearDown(); // stop any other clip first
    setState('loading');
    try {
      const { bytes, contentType } = await api.getMessageSpeech(roomId, messageId);
      const blob = new Blob([bytes as BlobPart], { type: contentType });
      const url = URL.createObjectURL(blob);
      audio.src = url;
      audio.onended = () => {
        if (current && current.audio === audio) tearDown();
      };
      current = { audio, url, stopReact: () => setState('idle') };
      setState('playing');
      await audio.play();
    } catch (e) {
      if (current && current.audio === audio) tearDown();
      setError(e instanceof ApiError ? e.message : 'Could not play audio. Please try again.');
      setState('idle');
    }
  }

  function onClick() {
    if (state === 'playing') stop();
    else if (state === 'idle') void play();
  }

  const playing = state === 'playing';
  const loading = state === 'loading';
  const label = playing ? 'Stop playback' : loading ? 'Loading audio…' : 'Play message aloud';

  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-label={label}
        aria-pressed={playing}
        title={label}
        className={`inline-flex h-10 min-h-[40px] w-10 items-center justify-center rounded border text-sm transition-colors disabled:opacity-50 md:h-4 md:min-h-0 md:w-4 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:text-xs ${
          playing
            ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]'
            : 'border-[var(--sparrow-border)] text-[var(--sparrow-muted)] hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]'
        }`}
      >
        {playing ? (
          <Square size={16} aria-hidden="true" className="md:h-3.5 md:w-3.5" />
        ) : loading ? (
          <span aria-hidden="true">…</span>
        ) : (
          <Volume2 size={16} aria-hidden="true" className="md:h-3.5 md:w-3.5" />
        )}
      </button>
      {error && (
        <span role="alert" className="mt-1 text-xs text-[var(--sparrow-danger)]">
          {error}
        </span>
      )}
    </span>
  );
}
