import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, X } from 'lucide-react';
import type { AttachmentMeta } from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { imageMimeFor, isViewableAttachment, formatBytes } from '../../lib/attachments.js';
import { AttachmentViewerModal } from './AttachmentViewerModal.js';

/**
 * A single message attachment. Image attachments (detected by mime, falling back
 * to the filename extension only when the mime is absent) render as an inline
 * thumbnail that opens an in-app lightbox; small text/markdown files render as a
 * chip whose name opens an in-app viewer modal (download demoted to a secondary
 * icon); everything else keeps the plain download row. The download route is
 * bearer-authed, so a bare `<img src>` can't load it — we fetch the bytes
 * through the authed client and use an object URL (revoked on unmount). SVGs are
 * ONLY ever set as an `<img src>` (never inlined into the DOM), and their blob
 * keeps the `image/svg+xml` type, so any embedded script cannot execute.
 */
export function Attachment({ roomId, meta }: { roomId: string; meta: AttachmentMeta }) {
  const mime = imageMimeFor(meta.contentType, meta.filename);
  if (mime) return <ImageAttachment roomId={roomId} meta={meta} mime={mime} />;
  if (isViewableAttachment(meta.contentType, meta.filename, meta.sizeBytes)) {
    return <ViewableRow roomId={roomId} meta={meta} />;
  }
  return <DownloadRow roomId={roomId} meta={meta} />;
}

/** Force-download an already-fetched object URL under the attachment's filename. */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

type ImgState = 'loading' | 'ready' | 'error';

function ImageAttachment({
  roomId,
  meta,
  mime,
}: {
  roomId: string;
  meta: AttachmentMeta;
  mime: string;
}) {
  const [state, setState] = useState<ImgState>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dl = await api.getAttachment(roomId, meta.id);
        if (cancelled) return;
        // Keep the image mime (esp. image/svg+xml) so the browser treats the blob
        // as an image. This URL is only ever used as an <img src>.
        const blob = new Blob([dl.bytes as BlobPart], { type: mime });
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [roomId, meta.id, mime]);

  // Broken/unauthorized image → plain download row.
  if (state === 'error') return <DownloadRow roomId={roomId} meta={meta} />;

  if (state === 'loading' || !url) {
    return (
      <div
        className="flex h-24 w-40 items-center justify-center self-start rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] text-xs text-[var(--sparrow-muted)]"
        aria-label={`Loading ${meta.filename}`}
      >
        Loading…
      </div>
    );
  }

  return (
    <div className="flex max-w-full flex-col gap-1 self-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${meta.filename}`}
        className="block overflow-hidden rounded-md border border-[var(--sparrow-border)] transition-colors hover:border-[var(--sparrow-accent)]"
      >
        <img
          src={url}
          alt={meta.filename}
          onError={() => setState('error')}
          className="max-h-[240px] max-w-full object-contain"
        />
      </button>
      <div className="flex items-center gap-2 text-xs text-[var(--sparrow-muted)]">
        <span className="mono min-w-0 truncate">{meta.filename}</span>
        <span className="shrink-0">{formatBytes(meta.sizeBytes)}</span>
        <button
          type="button"
          onClick={() => triggerDownload(url, meta.filename)}
          aria-label={`Download ${meta.filename}`}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-[var(--sparrow-border)] px-1.5 py-0.5 transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
        >
          <Download size={12} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <Lightbox
          url={url}
          filename={meta.filename}
          onDownload={() => triggerDownload(url, meta.filename)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Full-viewport image viewer: portalled to the body, backdrop + Escape close, and
 * the image contained within the viewport. Purpose-built rather than the shared
 * Modal so the image can use most of the viewport (Modal caps at max-w-lg).
 */
function Lightbox({
  url,
  filename,
  onDownload,
  onClose,
}: {
  url: string;
  filename: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
      <div
        data-testid="lightbox-backdrop"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-black/80 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={filename}
        className="relative flex max-h-full max-w-full flex-col gap-3"
      >
        <div className="flex items-center gap-3 text-sm text-[var(--sparrow-text)]">
          <span className="mono min-w-0 truncate">{filename}</span>
          <button
            type="button"
            onClick={onDownload}
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
          >
            <Download size={14} aria-hidden="true" /> Download
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel)] p-1.5 text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <img
          src={url}
          alt={filename}
          className="min-h-0 rounded-md object-contain"
          style={{ maxHeight: '85vh', maxWidth: '90vw' }}
        />
      </div>
    </div>,
    document.body,
  );
}

/**
 * A viewable text/markdown attachment: clicking the name opens the in-app viewer
 * modal; download is demoted to a secondary icon button on the chip.
 */
function ViewableRow({ roomId, meta }: { roomId: string; meta: AttachmentMeta }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const { bytes, contentType } = await api.getAttachment(roomId, meta.id);
      const blob = new Blob([bytes as BlobPart], { type: contentType });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, meta.filename);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2 self-start rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-2 py-1 text-xs">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${meta.filename}`}
        className="inline-flex min-w-0 items-center gap-2 transition-colors hover:text-[var(--sparrow-accent)]"
      >
        <FileText size={14} aria-hidden="true" />
        <span className="mono min-w-0 truncate">{meta.filename}</span>
        <span className="text-[var(--sparrow-muted)]">{formatBytes(meta.sizeBytes)}</span>
      </button>
      <button
        type="button"
        onClick={() => void download()}
        aria-label={`Download ${meta.filename}`}
        className="shrink-0 rounded border border-transparent p-0.5 text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-accent)]"
      >
        <Download size={12} aria-hidden="true" />
      </button>
      {busy && <span className="text-[var(--sparrow-muted)]">…</span>}
      {open && (
        <AttachmentViewerModal roomId={roomId} meta={meta} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/** The classic non-image (and fallback) attachment: click to download the bytes. */
function DownloadRow({ roomId, meta }: { roomId: string; meta: AttachmentMeta }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const { bytes, contentType } = await api.getAttachment(roomId, meta.id);
      const blob = new Blob([bytes as BlobPart], { type: contentType });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, meta.filename);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={() => void download()}
      className="inline-flex items-center gap-2 self-start rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-2 py-1 text-xs hover:border-[var(--sparrow-accent)]"
    >
      <Download size={14} aria-hidden="true" />
      <span className="mono">{meta.filename}</span>
      <span className="text-[var(--sparrow-muted)]">{formatBytes(meta.sizeBytes)}</span>
      {busy && <span className="text-[var(--sparrow-muted)]">…</span>}
    </button>
  );
}
