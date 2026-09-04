import { useState } from 'react';
import type { EmailApprovalItem, EmailResolution, HumanRef } from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { headFromPreview, partyLabel, verificationNote } from '../../lib/email.js';
import { EmailCard } from './EmailCard.js';
import { VerificationMark } from './EmailBits.js';

/** A resolution that arrived from outside this row (a live `email.resolved`). */
export interface ExternalResolution {
  resolution: EmailResolution;
  by: HumanRef | null;
}

export interface EmailApprovalRowProps {
  orgId: string;
  item: EmailApprovalItem;
  /** Set when someone else (or the admin token) resolved this email first. */
  resolution?: ExternalResolution | null;
  /** Called after this row resolves it, so the list can stop tracking it. */
  onResolved?: (emailId: string) => void;
  /** Rendered next to the agent name (e.g. the org tag on a multi-org page). */
  tag?: React.ReactNode;
  nowMs?: number;
}

/**
 * ONE row of an email approvals queue — the same component on `/me/approvals`
 * and in org admin's org-wide Approvals block, because the affordances are the
 * same (SPEC v4 → *Web UI → Approvals*):
 *
 *  - **Approve** is primary, under a checkbox CHECKED by default ("Also trust
 *    {sender} from now on"); unchecking sends `{ trustSender: false }` — a
 *    one-time pass.
 *  - **Deny** is secondary and opens a small confirm carrying an UNCHECKED
 *    "Block {sender}" box (`blockSender`).
 *  - **Resolution is final**: the row collapses in place to its outcome, and the
 *    confirm copy says so plainly before the click. Trust itself stays editable
 *    later, in org admin's contacts list.
 */
export function EmailApprovalRow({
  orgId,
  item,
  resolution = null,
  onResolved,
  tag,
  nowMs,
}: EmailApprovalRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [trustSender, setTrustSender] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [blockSender, setBlockSender] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const inbound = item.email.direction === 'in';
  // An INBOUND approval row is by definition an untrusted sender: render the
  // raw ADDRESS, never the self-chosen display name (Jake, 2026-09-02 — an
  // attacker could name themselves after the org's owner). Outbound holds are
  // the agent's own sends; the recipient label stays friendly.
  const counterpart = inbound ? item.email.from.email : partyLabel(item.email.from);
  const address = item.email.from.email;
  const head = headFromPreview(item.email);

  const externalOutcome = resolution
    ? resolution.resolution === 'approved'
      ? inbound
        ? 'Delivered'
        : 'Sent'
      : resolution.resolution === 'denied'
        ? inbound
          ? 'Rejected'
          : 'Not sent'
        : 'Send failed'
    : null;
  const settled = outcome ?? externalOutcome;

  async function approve() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.approveEmail(orgId, item.email.id, trustSender ? {} : { trustSender: false });
      setOutcome(
        inbound ? (trustSender ? 'Delivered — sender trusted' : 'Delivered') : 'Sent',
      );
      onResolved?.(item.email.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not approve this email.');
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.denyEmail(orgId, item.email.id, blockSender ? { blockSender: true } : {});
      const base = inbound ? 'Rejected' : 'Not sent';
      setOutcome(blockSender ? `${base} — ${inbound ? 'sender' : 'recipient'} blocked` : base);
      onResolved?.(item.email.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not deny this email.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div
      className={`rounded-xl border p-3 ${
        inbound
          ? 'border-[var(--sparrow-border)] bg-[var(--sparrow-panel)]'
          : 'border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)]'
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--sparrow-muted)]">
        <span className="rounded bg-[var(--sparrow-panel-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
          {inbound ? 'Inbound' : 'Outbound'}
        </span>
        <span className="text-[var(--sparrow-text)]">{item.agent.name}</span>
        {tag}
      </div>

      <EmailCard
        orgId={orgId}
        head={head}
        verification={item.verification}
        judge={item.judge}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        nowMs={nowMs}
      />

      {!expanded && item.verification && (
        <div className="mt-1.5">
          <InlineVerification item={item} />
        </div>
      )}

      {settled ? (
        <p className="mt-3 text-sm text-[var(--sparrow-good)]" role="status">
          {settled}
          {resolution?.by && !outcome ? (
            <span className="ml-1 text-xs text-[var(--sparrow-muted)]">
              · resolved by {resolution.by.displayName}
            </span>
          ) : null}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void approve()}
              disabled={busy}
              className="rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming((v) => !v)}
              disabled={busy}
              className="rounded-md border border-[var(--sparrow-border)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
            >
              Deny
            </button>
          </div>

          <label className="flex items-start gap-2 text-xs text-[var(--sparrow-muted)]">
            <input
              type="checkbox"
              checked={trustSender}
              onChange={(e) => setTrustSender(e.target.checked)}
              className="mt-0.5 accent-[var(--sparrow-accent)]"
            />
            {/* Inbound names the sender. An outbound hold's unrecognized
                recipients are not carried on the preview (only the agent's own
                From is), so it uses the spec's plural variant rather than
                naming an address it does not have. */}
            <span>
              {inbound
                ? `Also trust ${address} from now on`
                : 'Also trust these recipients from now on'}
            </span>
          </label>

          {confirming && (
            <div className="rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] p-3">
              <p className="text-sm text-[var(--sparrow-text)]">
                {inbound
                  ? 'Deny this email? It will be rejected and can’t be undone.'
                  : 'Deny this email? It will not be sent, and that can’t be undone.'}
              </p>
              <label className="mt-2 flex items-start gap-2 text-xs text-[var(--sparrow-muted)]">
                <input
                  type="checkbox"
                  checked={blockSender}
                  onChange={(e) => setBlockSender(e.target.checked)}
                  className="mt-0.5 accent-[var(--sparrow-accent)]"
                />
                <span>
                  {inbound
                    ? `Block ${address} — reject anything from them in future`
                    : 'Block these recipients — refuse mail to or from them in future'}
                </span>
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void deny()}
                  disabled={busy}
                  className="rounded-md border border-[var(--sparrow-danger)] px-3 py-2 text-sm text-[var(--sparrow-danger)] transition-colors hover:bg-[var(--sparrow-danger)] hover:text-black disabled:opacity-50"
                >
                  {blockSender ? 'Deny and block' : 'Deny this email'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="rounded-md border border-[var(--sparrow-border)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-[var(--sparrow-danger)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The collapsed row's verification line (the expanded card renders its own). */
function InlineVerification({ item }: { item: EmailApprovalItem }) {
  const note = verificationNote({
    direction: item.email.direction,
    verification: item.verification,
    disposition: item.email.disposition,
    reason: item.email.reason,
  });
  return note ? <VerificationMark note={note} /> : null;
}
