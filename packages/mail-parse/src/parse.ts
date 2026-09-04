import { createHash } from 'node:crypto';
import {
  EMAIL_SUBJECT_MAX,
  MAX_ATTACHMENTS,
  type AttachmentInput,
  type EmailVerification,
  type InboundEmailPayload,
  type InboundEnvelope,
  type InboundParty,
} from '@sparrow/common-types';
import { simpleParser, type ParsedMail } from 'mailparser';
import { partiesFromHeader, normalizeAddress } from './address.js';
import { normalizeMessageId, parseMessageIdList } from './message-id.js';

/** Used as `from.email` when neither the headers nor the envelope name a sender. */
export const UNKNOWN_SENDER = 'unknown@sender.invalid';
/** Used as the single recipient when neither the headers nor the envelope name one. */
export const UNKNOWN_RECIPIENT = 'undisclosed-recipients@unknown.invalid';

/** Everything the caller knows that the bytes cannot tell us. */
export interface ParseInboundOptions {
  /**
   * The edge's SPF/DKIM/DMARC (and optional spam/virus) verdicts. Verification
   * is an INPUT here: the caller authenticated the message, this package only
   * merges the result into the payload.
   */
  verification: EmailVerification;
  /** The SMTP envelope, when the edge has one. Also the fallback for a headerless message. */
  envelope?: InboundEnvelope | null;
}

/**
 * What the parse noticed but the payload has no room for — logging, metrics,
 * and the "was this even a message?" question. Never sent to the core.
 */
export interface ParseStats {
  /** Size of the raw message as handed to us. */
  rawBytes: number;
  /**
   * Recognized content parts: the text body, the html body, and each
   * attachment. `0` means nothing decodable came out of the tree.
   */
  partCount: number;
  /** Attachments in the payload (after the cap). */
  attachmentCount: number;
  /** Decoded bytes of the attachments in the payload. */
  attachmentBytes: number;
  textBytes: number;
  htmlBytes: number;
  /** True when the subject was longer than the RFC line limit and was cut. */
  subjectTruncated: boolean;
  /** Attachments past `MAX_ATTACHMENTS` that were dropped. */
  attachmentsDropped: number;
  /** True when the MIME tree yielded no content part (or failed to parse at all). */
  malformed: boolean;
  /** Stable machine-readable notes, in the order they were noticed. */
  warnings: string[];
}

export interface ParsedInboundEmail {
  payload: InboundEmailPayload;
  stats: ParseStats;
}

/** Extension used when an attachment arrives with no usable filename. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/calendar': 'ics',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/plain': 'txt',
};

/**
 * Raw RFC 5322/MIME bytes → the normalized `POST /email/inbound` payload.
 *
 * This is the single source of truth for that translation: the gateway and any
 * other edge relay import it, so the same bytes always produce a byte-identical
 * body (every field is built in a fixed key order and nothing depends on the
 * clock, the host, or the parse order).
 *
 * It NEVER throws on hostile input. A message whose MIME tree cannot be
 * decoded comes back with `text: ''`, `html: null`, `stats.partCount: 0` and
 * `stats.malformed: true` — the core decides what to do with it, the edge
 * stays up.
 *
 * The html body is passed through **raw**: sanitizing it is the server's job.
 */
export async function parseInboundEmail(
  raw: Buffer | string,
  options: ParseInboundOptions,
): Promise<ParsedInboundEmail> {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const warnings: string[] = [];
  const envelope = options.envelope ?? null;

  let parsed: ParsedMail | null = null;
  try {
    // `keepCidLinks` leaves `cid:` references alone — inlining them as data URIs
    // would duplicate every attachment into the html body and blow its 1 MB cap.
    parsed = await simpleParser(source, { keepCidLinks: true, skipTextToHtml: true });
  } catch {
    warnings.push('parse-failed');
  }

  /* ---- bodies ---- */
  const text = typeof parsed?.text === 'string' ? parsed.text : '';
  const html = typeof parsed?.html === 'string' && parsed.html.length > 0 ? parsed.html : null;

  /* ---- attachments ---- */
  const all = parsed?.attachments ?? [];
  const kept = all.slice(0, MAX_ATTACHMENTS);
  const attachmentsDropped = all.length - kept.length;
  if (attachmentsDropped > 0) warnings.push('attachments-truncated');
  let attachmentBytes = 0;
  const attachments: AttachmentInput[] = kept.map((attachment, index) => {
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content ?? '');
    attachmentBytes += content.byteLength;
    const contentType = (attachment.contentType || 'application/octet-stream').toLowerCase();
    return {
      filename: attachmentFilename(attachment.filename, contentType, index),
      contentType,
      dataBase64: content.toString('base64'),
    };
  });

  /* ---- headers ---- */
  const rawSubject = (parsed?.subject ?? '').trim();
  const subjectTruncated = rawSubject.length > EMAIL_SUBJECT_MAX;
  if (subjectTruncated) warnings.push('subject-truncated');
  const subject = subjectTruncated ? rawSubject.slice(0, EMAIL_SUBJECT_MAX) : rawSubject;

  let rfcMessageId = normalizeMessageId(parsed?.messageId);
  if (!rfcMessageId) {
    // Deterministic and content-addressed: the same bytes always synthesize the
    // same id, so a redelivered message still de-duplicates at the core.
    rfcMessageId = `<mp.${createHash('sha256').update(source).digest('hex').slice(0, 40)}@mail-parse.invalid>`;
    warnings.push('synthesized-message-id');
  }

  const from = senderParty(parsed, envelope, warnings);
  const to = recipientParties(parsed, envelope, warnings);

  const partCount = (text.length > 0 ? 1 : 0) + (html ? 1 : 0) + attachments.length;
  if (partCount === 0) warnings.push('no-body-part');

  const payload: InboundEmailPayload = {
    rfcMessageId,
    inReplyTo: normalizeMessageId(parsed?.inReplyTo),
    references: parseMessageIdList(parsed?.references),
    date: headerDate(parsed),
    from,
    to,
    cc: partiesFromHeader(parsed?.cc),
    subject,
    text,
    html,
    attachments,
    verification: normalizeVerification(options.verification),
    envelope: envelope ? { mailFrom: envelope.mailFrom, rcptTo: [...envelope.rcptTo] } : null,
  };

  return {
    payload,
    stats: {
      rawBytes: source.byteLength,
      partCount,
      attachmentCount: attachments.length,
      attachmentBytes,
      textBytes: Buffer.byteLength(text),
      htmlBytes: html ? Buffer.byteLength(html) : 0,
      subjectTruncated,
      attachmentsDropped,
      malformed: parsed === null || partCount === 0,
      warnings,
    },
  };
}

/** `From:`, else the envelope sender, else a sentinel — the field is required. */
function senderParty(
  parsed: ParsedMail | null,
  envelope: InboundEnvelope | null,
  warnings: string[],
): InboundParty {
  const fromHeader = partiesFromHeader(parsed?.from)[0];
  if (fromHeader) return fromHeader;
  const mailFrom = normalizeAddress(envelope?.mailFrom);
  if (mailFrom) {
    warnings.push('sender-from-envelope');
    return { email: mailFrom, name: null };
  }
  warnings.push('no-sender');
  return { email: UNKNOWN_SENDER, name: null };
}

/**
 * `To:`, else the envelope recipients (a Bcc'd message has them nowhere else),
 * else a sentinel. `Bcc:` headers are never read: Bcc must not reach the core.
 */
function recipientParties(
  parsed: ParsedMail | null,
  envelope: InboundEnvelope | null,
  warnings: string[],
): InboundParty[] {
  const header = partiesFromHeader(parsed?.to);
  if (header.length > 0) return header;

  const fromEnvelope: InboundParty[] = [];
  const seen = new Set<string>();
  for (const rcpt of envelope?.rcptTo ?? []) {
    const email = normalizeAddress(rcpt);
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    fromEnvelope.push({ email, name: null });
  }
  if (fromEnvelope.length > 0) {
    warnings.push('recipients-from-envelope');
    return fromEnvelope;
  }
  warnings.push('no-recipients');
  return [{ email: UNKNOWN_RECIPIENT, name: null }];
}

/**
 * The `Date:` header as an ISO 8601 instant, or `null`.
 *
 * Read from the raw header line rather than the parser's `date`, which falls
 * back to "now" for an unparseable header — a clock read would make the output
 * non-deterministic, and `date` is advisory anyway (the core stamps its own).
 */
function headerDate(parsed: ParsedMail | null): string | null {
  const line = parsed?.headerLines?.find((header) => header.key === 'date')?.line;
  if (!line) return null;
  const value = line.slice(line.indexOf(':') + 1).trim();
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Rebuild the verdicts in a fixed key order, omitting absent scan results. */
function normalizeVerification(verification: EmailVerification): EmailVerification {
  const normalized: EmailVerification = {
    spf: verification.spf,
    dkim: verification.dkim,
    dmarc: verification.dmarc,
    domain: verification.domain,
  };
  if (verification.spam !== undefined) normalized.spam = verification.spam;
  if (verification.virus !== undefined) normalized.virus = verification.virus;
  return normalized;
}

/**
 * A safe, deterministic filename: path separators and control characters out,
 * length bounded, and a positional `attachment-N.ext` when the part carried no
 * name of its own.
 */
function attachmentFilename(
  filename: string | undefined,
  contentType: string,
  index: number,
): string {
  const cleaned = (filename ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 200);
  if (cleaned && cleaned !== '.' && cleaned !== '..') return cleaned;
  const extension = EXTENSION_BY_TYPE[contentType] ?? 'bin';
  return `attachment-${index + 1}.${extension}`;
}
