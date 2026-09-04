/**
 * Attachment helpers shared by the room view. Image detection drives whether an
 * attachment renders as an inline preview (with a lightbox) or as a plain
 * download row. This module also owns the composer-side staging logic: turning
 * picked/pasted/dropped `File`s into pending attachments (mirroring the server's
 * size/count limits) and encoding them to the wire's base64 upload shape.
 */
import type { AttachmentInput } from '@sparrow/common-types';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '@sparrow/common-types';

/** Image mime types we render inline. SVG is rendered ONLY via `<img>`. */
const IMAGE_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/** Filename-extension fallback, used ONLY when a mime type is absent. */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/**
 * The canonical image mime for an attachment, or `null` if it is not an image.
 * Detection prefers the declared content-type; the filename extension is only
 * consulted when the mime is absent (empty/null), so an explicit non-image mime
 * (e.g. `application/octet-stream`) is never overridden by a misleading name.
 */
export function imageMimeFor(contentType: string | null | undefined, filename: string): string | null {
  const ct = (contentType ?? '').trim().toLowerCase().split(';')[0]!.trim();
  if (ct) return IMAGE_MIME.has(ct) ? ct : null;
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return EXT_TO_MIME[ext] ?? null;
}

export function isImageAttachment(contentType: string | null | undefined, filename: string): boolean {
  return imageMimeFor(contentType, filename) !== null;
}

/** In-app text viewer size cap: bigger files stay download-only. */
export const MAX_VIEWABLE_BYTES = 1024 * 1024;

/** Extensions we treat as viewable text even when the mime is absent/opaque. */
const TEXT_EXTS = new Set(['md', 'markdown', 'txt']);
const MARKDOWN_EXTS = new Set(['md', 'markdown']);

function normalizedMime(contentType: string | null | undefined): string {
  return (contentType ?? '').trim().toLowerCase().split(';')[0]!.trim();
}

function extOf(filename: string): string {
  return filename.toLowerCase().split('.').pop() ?? '';
}

/**
 * Whether an attachment can open in the in-app text viewer: any `text/*` mime,
 * or a .md/.markdown/.txt filename (even when the mime is opaque, e.g.
 * `application/octet-stream`), capped at {@link MAX_VIEWABLE_BYTES}. Images are
 * routed to the inline preview BEFORE this check, so `image/svg+xml` never
 * reaches the text viewer.
 */
export function isViewableAttachment(
  contentType: string | null | undefined,
  filename: string,
  sizeBytes: number,
): boolean {
  if (sizeBytes > MAX_VIEWABLE_BYTES) return false;
  if (normalizedMime(contentType).startsWith('text/')) return true;
  return TEXT_EXTS.has(extOf(filename));
}

/**
 * Whether a viewable attachment should render as markdown (vs a literal `<pre>`
 * block): a `text/markdown` mime, or a .md/.markdown filename — the extension
 * wins even over `text/plain`, since servers commonly mislabel markdown.
 */
export function isMarkdownAttachment(
  contentType: string | null | undefined,
  filename: string,
): boolean {
  if (normalizedMime(contentType) === 'text/markdown') return true;
  return MARKDOWN_EXTS.has(extOf(filename));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Composer-side staging                                                      */
/* -------------------------------------------------------------------------- */

/** A file staged on the composer, awaiting send. `id` is client-local (chip key). */
export interface PendingAttachment {
  id: string;
  file: File;
  filename: string;
  contentType: string;
  size: number;
}

const MB = 1024 * 1024;
const MAX_EACH_MB = Math.round(MAX_ATTACHMENT_BYTES / MB);
const MAX_TOTAL_MB = Math.round(MAX_TOTAL_ATTACHMENT_BYTES / MB);

let stageSeq = 0;
function nextStageId(): string {
  stageSeq += 1;
  return `pa_${Date.now().toString(36)}_${stageSeq}`;
}

/** The wire content type for a File, defaulting when the browser gives none. */
function contentTypeOf(file: File): string {
  return file.type || 'application/octet-stream';
}

/**
 * Merge freshly picked/pasted/dropped files into the existing staged list,
 * enforcing the same limits the server does (≤5 MB each, ≤8 total, ≤20 MB
 * combined). Rejected files are dropped from the result but named in a single
 * human-readable `error` so nothing disappears silently. Pure — no side effects.
 */
export function stageFiles(
  existing: PendingAttachment[],
  incoming: File[],
): { next: PendingAttachment[]; error: string | null } {
  const next = [...existing];
  let total = existing.reduce((sum, p) => sum + p.size, 0);
  let error: string | null = null;

  for (const file of incoming) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      error = `${file.name} is larger than ${MAX_EACH_MB} MB`;
      continue;
    }
    if (next.length >= MAX_ATTACHMENTS) {
      error = `You can attach up to ${MAX_ATTACHMENTS} files`;
      continue;
    }
    if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      error = `Attachments can total at most ${MAX_TOTAL_MB} MB`;
      continue;
    }
    next.push({
      id: nextStageId(),
      file,
      filename: file.name,
      contentType: contentTypeOf(file),
      size: file.size,
    });
    total += file.size;
  }

  return { next, error };
}

/** Read a File's bytes and produce the base64 upload shape the send route accepts. */
export async function fileToAttachmentInput(file: File): Promise<AttachmentInput> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // A data URL is `data:<mime>;base64,<payload>` — keep only the payload.
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
  return {
    filename: file.name,
    contentType: contentTypeOf(file),
    dataBase64,
  };
}
