import { useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AttachmentMeta, ContactTrust, EmailDirection } from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { formatBytes } from '../../lib/attachments.js';
import { directionLabel, partyChip, sanitizeEmailHtml, type VerificationNote } from '../../lib/email.js';
import { CopyMessageButton } from '../CopyMessageButton.js';
import type { Party } from '@sparrow/common-types';

/**
 * The small, shared pieces every email surface renders: the direction glyph
 * (with its word in the accessible name), the disposition badge, the trust pill,
 * the verification mark (state in the label, mechanisms in the tooltip text),
 * participant chips, the style-isolated body, and the attachment row.
 */

/** Received / sent, as a glyph PLUS text — never glyph-only. */
export function DirectionGlyph({ direction }: { direction: EmailDirection }) {
  const Icon = direction === 'in' ? ArrowDownLeft : ArrowUpRight;
  return (
    <span className="inline-flex shrink-0 items-center text-[var(--sparrow-faint)]">
      <Icon size={13} aria-hidden="true" />
      <span className="sr-only">{directionLabel(direction)}</span>
    </span>
  );
}

/** Off the happy path only — `delivered`/`sent` never render one. */
export function DispositionBadge({ label }: { label: string }) {
  const danger = label === 'Rejected' || label === 'Send failed';
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        danger
          ? 'bg-[rgba(224,85,91,0.14)] text-[var(--sparrow-danger)]'
          : 'bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]'
      }`}
    >
      {label}
    </span>
  );
}

/** An external contact's durable trust state. Unknown contacts show nothing. */
export function TrustPill({ trust }: { trust: ContactTrust | null | undefined }) {
  if (!trust) return null;
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
        trust === 'approved'
          ? 'border-[rgba(91,185,139,0.4)] text-[var(--sparrow-good)]'
          : 'border-[rgba(224,85,91,0.4)] text-[var(--sparrow-danger)]'
      }`}
    >
      {trust === 'approved' ? 'trusted' : 'blocked'}
    </span>
  );
}

/** The verification indicator. The tooltip always carries the detail as text. */
export function VerificationMark({ note }: { note: VerificationNote }) {
  const Icon = note.tone === 'good' ? ShieldCheck : ShieldAlert;
  const color =
    note.tone === 'good'
      ? 'text-[var(--sparrow-good)]'
      : note.tone === 'warn'
        ? 'text-[var(--sparrow-accent)]'
        : 'text-[var(--sparrow-danger)]';
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${color}`} title={note.tooltip}>
      <Icon size={13} aria-hidden="true" />
      {note.label}
    </span>
  );
}

/**
 * A participant chip: name + address, click to copy the address. `addressOnly`
 * drops the self-chosen display name — used for UNTRUSTED senders
 * (quarantined / inbound-rejected), whose name is attacker-controlled.
 */
export function PartyChip({ party, addressOnly = false }: { party: Party; addressOnly?: boolean }) {
  const chip = partyChip(party);
  const address = chip.address;
  const label = addressOnly ? address : chip.label;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      /* clipboard unavailable — the address is still readable on the chip */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={`${label} <${address}> — click to copy`}
      className="inline-flex max-w-full items-baseline gap-1.5 rounded-full border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-2 py-0.5 text-xs text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-accent-2)]"
    >
      <span className="truncate">{copied ? 'Copied' : label}</span>
      {label !== address && (
        <span className="mono hidden truncate text-[10px] text-[var(--sparrow-muted)] sm:inline">
          {address}
        </span>
      )}
    </button>
  );
}

/** A labelled participant row (From / To / Cc). There is never a Bcc row. */
export function ParticipantRow({
  label,
  parties,
  addressOnly = false,
}: {
  label: string;
  parties: Party[];
  addressOnly?: boolean;
}) {
  if (parties.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="w-8 shrink-0 text-[10px] uppercase tracking-wider text-[var(--sparrow-faint)]">
        {label}
      </span>
      {parties.map((p, i) => (
        <PartyChip key={`${p.email}:${i}`} party={p} addressOnly={addressOnly} />
      ))}
    </div>
  );
}

/**
 * The email body: sanitized HTML in a style-isolated, bordered container that
 * scrolls HORIZONTALLY INSIDE ITSELF, so wide mail never scrolls the page. No
 * remote content is loaded; plain text renders pre-wrapped when there is no HTML.
 *
 * The copy affordance yields the PLAIN-TEXT part, which is email's equivalent
 * of a chat message's markdown source: the authored body, not the render. The
 * sanitized HTML rides along as the rich flavor when there is any.
 */
export function EmailBody({ html, text }: { html: string | null; text: string }) {
  const safe = html ? sanitizeEmailHtml(html) : null;
  return (
    <div className="group relative">
      <div
        data-testid="email-body"
        className="email-html max-w-full overflow-x-auto rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] p-3 text-sm"
      >
        {safe !== null ? (
          <div dangerouslySetInnerHTML={{ __html: safe }} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans">{text}</pre>
        )}
      </div>
      <CopyMessageButton
        className="absolute right-1.5 top-1.5 rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)]"
        text={text}
        getHtml={() => safe}
      />
    </div>
  );
}

/** One email attachment: click to download the bytes (forced download). */
export function EmailAttachment({ orgId, meta }: { orgId: string; meta: AttachmentMeta }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const { bytes, contentType } = await api.getOrgEmailAttachment(orgId, meta.id);
      const blob = new Blob([bytes as BlobPart], { type: contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
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

/** A muted, one-line note (the judge verdict, a missing-row notice). */
export function MutedNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-[var(--sparrow-muted)]">{children}</p>;
}
