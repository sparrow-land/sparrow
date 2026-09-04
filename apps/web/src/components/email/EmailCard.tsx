import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  ContactTrust,
  Email,
  EmailDisposition,
  EmailJudge,
  EmailVerification,
} from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { formatRelativeTime } from '../../lib/time.js';
import {
  dispositionBadge,
  directionLabel,
  isPending,
  judgeNote,
  untrustedSender,
  verificationNote,
  type EmailCardHead,
} from '../../lib/email.js';
import {
  DirectionGlyph,
  DispositionBadge,
  EmailAttachment,
  EmailBody,
  MutedNote,
  ParticipantRow,
  TrustPill,
  VerificationMark,
} from './EmailBits.js';
import { MediumGlyph, MediumMark, infoBoxToneStyle } from '../MediumGlyph.js';

export interface EmailCardProps {
  orgId: string;
  /** Everything the collapsed row renders, from an entry, a preview, or an email. */
  head: EmailCardHead;
  /**
   * The full email when the surface already holds it (a thread view). Otherwise
   * the card fetches it the first time it is expanded — entries are typed refs,
   * so a pane holds no bodies until something is expanded.
   */
  full?: Email | null;
  /**
   * A LIVE disposition, winning over both the head's and any fetched email's.
   * This is how an `email.resolved` event mutates a card without a refetch: a
   * `Held` badge flips to no badge when approved, and a denial grays the card
   * to "Denied" in place. Without it a card that had already fetched its body
   * would keep rendering the stale, fetched disposition.
   */
  disposition?: EmailDisposition | null;
  /** Extra facts a surface may carry alongside a preview (the approvals queue). */
  verification?: EmailVerification | null;
  judge?: EmailJudge | null;
  /** The counterpart's durable trust, when the surface knows it. */
  trust?: ContactTrust | null;
  expanded: boolean;
  onToggle: () => void;
  /** Deep link into the agent page's Email section at this thread. */
  threadHref?: string | null;
  /** Where a pending card sends a viewer who may act on it. */
  reviewHref?: string | null;
  /** Rendered inside the expanded card (e.g. approve / deny affordances). */
  children?: ReactNode;
  /** Clock for relative times, shared with the surrounding bubbles. */
  nowMs?: number;
}

/**
 * ONE email, collapsed to a single legible row and expandable in place to the
 * full view (SPEC v4 → *Web UI → the conversation view is an activity stream*).
 * The same card renders in a DM pane, on the agent page's Activity tab, in a
 * thread view, and in both approval queues — so the anatomy is written once.
 *
 * Email carries none of chat's conversation behaviors: no receipt, no presence,
 * no working status. There is no reply affordance either — v4's web UI reads,
 * expands, approves and denies email; only an agent may send it.
 */
export function EmailCard({
  orgId,
  head,
  full = null,
  disposition: dispositionOverride = null,
  verification: verificationOverride,
  judge: judgeOverride,
  trust,
  expanded,
  onToggle,
  threadHref,
  reviewHref,
  children,
  nowMs,
}: EmailCardProps) {
  const [fetched, setFetched] = useState<Email | null>(null);
  const [missing, setMissing] = useState(false);
  const email = full ?? fetched;

  // Lazy body fetch: only once expanded, only when we do not already hold it.
  // A `404` from the medium is expected (the row a ref points at may be gone) —
  // the card then renders from the entry's own facts alone.
  useEffect(() => {
    if (!expanded || email || !head.emailId) return;
    let cancelled = false;
    void api
      .getOrgEmail(orgId, head.emailId)
      .then((e) => {
        if (!cancelled) setFetched(e);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, email, head.emailId, orgId]);

  // A live resolution wins over everything: the fetched body is a snapshot, the
  // event is now. A pending card that was DENIED grays in place and says so —
  // it does not silently become an ordinary rejection row.
  const disposition = dispositionOverride ?? email?.disposition ?? head.disposition;
  const denied = dispositionOverride === 'rejected' && isPending(head.disposition);
  const badge = denied ? 'Denied' : dispositionBadge(disposition);
  const snippet = head.snippet;
  const note = verificationNote({
    direction: head.direction,
    verification: verificationOverride ?? email?.verification ?? null,
    disposition,
    reason: email?.reason ?? head.reason,
  });
  const judge = judgeNote(judgeOverride ?? email?.judge ?? null);
  const counterpart = head.counterpartLabel;

  return (
    // The Tinted Etch container in the email tone. The ROW keeps the shipped
    // py-1.5 rather than the hint boxes' compact py-[5px]: the email box's
    // floor is set by its controls — the disposition pill and the Review link
    // must sit comfortably and the whole row stays a thumbable target.
    <div
      style={infoBoxToneStyle('email')}
      className={`info-box rounded-lg ${denied ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {/* The leading rail says WHAT this box is before it says which way it
              went: a disposition badge only appears off the happy path, so
              without a medium mark a delivered email reads as a plain message. */}
          <MediumGlyph medium="email" />
          <DirectionGlyph direction={head.direction} />
          <span className="sr-only">
            {`${directionLabel(head.direction)} email ${head.direction === 'in' ? 'from' : 'to'} ${counterpart} — ${head.subject}`}
          </span>
          <span aria-hidden="true" className="min-w-0 shrink-0 max-w-[9rem] truncate text-xs text-[var(--sparrow-muted)]">
            {counterpart}
          </span>
          <TrustPill trust={trust} />
          <span aria-hidden="true" className="min-w-0 truncate text-xs text-[var(--sparrow-text)]">
            {head.subject}
          </span>
          {snippet && (
            <span aria-hidden="true" className="hidden min-w-0 flex-1 truncate text-[11px] text-[var(--sparrow-muted)] sm:inline">
              {snippet}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10.5px] text-[var(--sparrow-faint)]">
            {formatRelativeTime(head.createdAt, nowMs ?? Date.now())}
          </span>
          {badge && <DispositionBadge label={badge} />}
        </button>
        {reviewHref && isPending(disposition) && (
          <Link
            to={reviewHref}
            className="shrink-0 rounded border border-[var(--sparrow-accent-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--sparrow-accent)] hover:border-[var(--sparrow-accent)]"
          >
            Review
          </Link>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-2.5 border-t border-[var(--sparrow-border)] px-3 py-3">
          {/* The register, in words, for a reader who has scrolled past the
              header row: an opened card should never leave "what is this?" to
              inference. */}
          <MediumMark medium="email" />
          {email ? (
            <>
              <div className="flex flex-col gap-1.5">
                {/* An untrusted sender's chip shows the raw address only — the
                    display name is attacker-controlled (Jake, 2026-09-02). */}
                <ParticipantRow
                  label="From"
                  parties={[email.from]}
                  addressOnly={untrustedSender(email.direction, disposition)}
                />
                <ParticipantRow label="To" parties={email.to} />
                <ParticipantRow label="Cc" parties={email.cc} />
              </div>
              {note && <VerificationMark note={note} />}
              {judge && <MutedNote>{judge}</MutedNote>}
              <EmailBody html={email.html} text={email.text} />
              {email.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {email.attachments.map((a) => (
                    <EmailAttachment key={a.id} orgId={orgId} meta={a} />
                  ))}
                </div>
              )}
            </>
          ) : missing ? (
            <MutedNote>This email is no longer available.</MutedNote>
          ) : (
            <MutedNote>Loading…</MutedNote>
          )}

          {(threadHref || children) && (
            <div className="flex flex-wrap items-center gap-3">
              {threadHref && (
                <Link
                  to={threadHref}
                  className="text-xs text-[var(--sparrow-accent)] hover:underline"
                >
                  Open thread
                </Link>
              )}
              {children}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
