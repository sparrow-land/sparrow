import { Trash2 } from 'lucide-react';
import type { Draft } from '@sparrow/common-types';
import { Modal } from '../../components/Modal.js';

/**
 * The drafts list for one chat window (reuses the shared Modal). Drafts are shown
 * oldest first. Clicking a row's text drops it into the composer AND removes the
 * draft (the text lives on in the composer, so nothing is lost); the row Send
 * button fires it down the existing send path (disabled while a send is in
 * flight); the trash button removes it. With 2+ drafts a footer "Combine" button
 * folds every draft into one composer message. Esc / backdrop close via Modal.
 */
export function DraftsModal({
  drafts,
  sending,
  onInsert,
  onSend,
  onDelete,
  onCombine,
  onClose,
}: {
  drafts: Draft[];
  sending: boolean;
  onInsert: (d: Draft) => void;
  onSend: (d: Draft) => void;
  onDelete: (d: Draft) => void;
  /** Fold every draft into a single composer message (visible with 2+ drafts). */
  onCombine: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Drafts${drafts.length ? ` (${drafts.length})` : ''}`}
      onClose={onClose}
      labelledById="drafts-title"
    >
      {drafts.length === 0 ? (
        <p className="text-sm text-[var(--sparrow-faint)]">
          No drafts yet. Press the modifier + Enter in the composer to queue one.
        </p>
      ) : (
        <ul role="list" className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {drafts.map((d) => (
            <li
              key={d.id}
              className="flex items-start gap-2 rounded border border-transparent px-1 py-1 hover:border-[var(--sparrow-border)]"
            >
              <button
                type="button"
                onClick={() => {
                  onInsert(d);
                  onDelete(d);
                }}
                title="Insert into composer"
                className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--sparrow-panel-2)]"
              >
                {d.text}
              </button>
              <button
                type="button"
                onClick={() => onSend(d)}
                disabled={sending}
                className="shrink-0 rounded border border-[var(--sparrow-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)] disabled:opacity-50"
              >
                Send
              </button>
              <button
                type="button"
                onClick={() => onDelete(d)}
                aria-label="Delete draft"
                title="Delete draft"
                className="shrink-0 rounded px-1.5 py-1 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-danger)]"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {drafts.length >= 2 && (
        <div className="mt-3 flex justify-end border-t border-[var(--sparrow-border)] pt-3">
          <button
            type="button"
            onClick={onCombine}
            title="Fold every draft into a single composer message"
            className="rounded border border-[var(--sparrow-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
          >
            Combine
          </button>
        </div>
      )}
    </Modal>
  );
}
