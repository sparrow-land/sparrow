import { useState } from 'react';
import { Mic } from 'lucide-react';
import { useCapabilities } from '../../lib/capabilities.js';
import { HandsFreeOverlay, type HandsFreeIncoming } from './HandsFreeOverlay.js';

/**
 * Everything the room hands hands-free mode. It is one prop rather than six so
 * the composer, which cares about none of it, forwards a single opaque object.
 */
export interface HandsFreeWiring {
  /** The room a spoken turn is posted to. */
  roomId: string;
  /**
   * Post the transcript through the room's ordinary send path with
   * `origin:'voice'`; resolves with the new message id (or `null` on failure).
   */
  onSend: (text: string) => Promise<string | null>;
  /** Replies from other members that arrived while the mode was open. */
  incoming?: HandsFreeIncoming[];
  /** The counterpart's live working note, shown while awaiting a reply. */
  awaitingNote?: string | null;
  /** Who we are talking to. */
  counterpartName?: string | null;
  /**
   * Open/close of the mode. The room only collects arrivals for the overlay
   * while it is up — outside it, a reply is just a bubble.
   */
  onOpenChange?: (open: boolean) => void;
}

/**
 * The composer's mic (v-voice). Rendered only when the instance registers an STT
 * provider (`capabilities.voice.stt`).
 *
 * Under voice v1 this button WAS the recorder: hold-to-dictate, transcript into
 * the composer, send by hand. Voice v2 makes it a door instead — it opens
 * {@link HandsFreeOverlay}, which owns capture, the transcript, the send and the
 * spoken reply, and stays up for as many turns as the speaker wants. Nothing
 * dictated ever lands in the composer any more, so the composer's draft and
 * staged attachments are untouched by a voice turn.
 */
export function MicButton({
  handsFree,
  disabled = false,
}: {
  handsFree: HandsFreeWiring;
  disabled?: boolean;
}) {
  const { voice } = useCapabilities();
  const [open, setOpen] = useState(false);

  if (!voice.stt) return null;

  function setMode(next: boolean) {
    setOpen(next);
    handsFree.onOpenChange?.(next);
  }

  const label = 'Start hands-free voice mode';

  return (
    <>
      <button
        type="button"
        onClick={() => setMode(true)}
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        title={label}
        className="inline-flex h-10 min-h-[40px] w-10 items-center justify-center rounded border border-[var(--sparrow-border-strong)] text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)] disabled:opacity-50"
      >
        <Mic size={16} aria-hidden="true" />
      </button>
      {open && (
        <HandsFreeOverlay
          roomId={handsFree.roomId}
          onSend={handsFree.onSend}
          onClose={() => setMode(false)}
          incoming={handsFree.incoming}
          awaitingNote={handsFree.awaitingNote}
          counterpartName={handsFree.counterpartName}
        />
      )}
    </>
  );
}
