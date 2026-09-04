import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { AttachmentMeta } from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { isMarkdownAttachment, formatBytes } from '../../lib/attachments.js';
import { MessageBody } from '../../components/MessageBody.js';
import { Modal } from '../../components/Modal.js';

/** Force-download an object URL under the attachment's filename. */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

type ViewState = 'loading' | 'ready' | 'error';

/**
 * In-app viewer for text/markdown attachments (reuses the shared Modal, so
 * Esc / backdrop / X close and focus trapping come for free). Fetches the bytes
 * through the authed client on open (the download route is cookie/bearer-authed,
 * so a bare href can't reach it), decodes as UTF-8, and renders markdown files
 * through MessageBody and everything else in a literal <pre>. Download stays
 * available as a secondary action — from the already-fetched bytes when we have
 * them, or a fresh fetch from the error state's fallback.
 */
export function AttachmentViewerModal({
  roomId,
  meta,
  onClose,
}: {
  roomId: string;
  meta: AttachmentMeta;
  onClose: () => void;
}) {
  const [state, setState] = useState<ViewState>('loading');
  const [text, setText] = useState('');
  const bytesRef = useRef<Uint8Array | null>(null);
  const typeRef = useRef<string>('text/plain');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dl = await api.getAttachment(roomId, meta.id);
        if (cancelled) return;
        bytesRef.current = dl.bytes;
        typeRef.current = dl.contentType;
        setText(new TextDecoder().decode(dl.bytes));
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, meta.id]);

  async function download() {
    try {
      let bytes = bytesRef.current;
      let type = typeRef.current;
      if (!bytes) {
        const dl = await api.getAttachment(roomId, meta.id);
        bytes = dl.bytes;
        type = dl.contentType;
      }
      const blob = new Blob([bytes as BlobPart], { type });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, meta.filename);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <Modal
      title={<span className="mono">{meta.filename}</span>}
      onClose={onClose}
      labelledById="attachment-viewer-title"
    >
      <div className="max-h-[60vh] overflow-y-auto">
        {state === 'loading' && (
          <p className="text-sm text-[var(--sparrow-muted)]">Loading…</p>
        )}
        {state === 'error' && (
          <p className="text-sm text-[var(--sparrow-muted)]">
            Couldn’t load this file for viewing. You can still download it below.
          </p>
        )}
        {state === 'ready' &&
          (isMarkdownAttachment(meta.contentType, meta.filename) ? (
            <div className="text-sm leading-relaxed">
              <MessageBody text={text} />
            </div>
          ) : (
            <pre className="mono whitespace-pre-wrap break-words rounded bg-[var(--sparrow-panel-2)] px-3 py-2 text-[0.85rem] leading-relaxed">
              {text}
            </pre>
          ))}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-[var(--sparrow-border)] pt-3 text-xs text-[var(--sparrow-muted)]">
        <span>{formatBytes(meta.sizeBytes)}</span>
        <button
          type="button"
          onClick={() => void download()}
          className="ml-auto inline-flex items-center gap-1.5 rounded border border-[var(--sparrow-border-strong)] px-2.5 py-1 font-medium transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
        >
          <Download size={12} aria-hidden="true" /> Download
        </button>
      </div>
    </Modal>
  );
}
