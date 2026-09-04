/**
 * The email medium's presentation rules (v4), as pure functions — no React, no
 * network. Everything the email surfaces render (cards in a conversation stream,
 * the agent page's Activity/Email tabs, both approval queues) derives from these,
 * so one rule is written once and tested once.
 *
 * Three contracts from SPEC v4 live here:
 *  - a **disposition badge** renders ONLY off the happy path (`delivered`/`sent`
 *    carry no badge);
 *  - the **verification indicator** puts a short state in the label and the
 *    per-mechanism detail in the tooltip AS TEXT (the v3 rule: tooltips always
 *    carry state in text);
 *  - a **judge note** names the verdict and its reason, never the provider.
 *
 * Reason slugs are carried verbatim from the wire — there is exactly one reason
 * vocabulary in the system and no mapping layer.
 */
import type {
  ActivityEntry,
  ActivityEntryType,
  Email,
  EmailDirection,
  EmailDisposition,
  EmailJudge,
  EmailPreview,
  EmailReason,
  EmailVerification,
  Party,
} from '@sparrow/common-types';

/* -------------------------------------------------------------------------- */
/* Dispositions                                                               */
/* -------------------------------------------------------------------------- */

const BADGES: Partial<Record<EmailDisposition, string>> = {
  quarantined: 'Quarantined',
  held: 'Held',
  rejected: 'Rejected',
  'send-failed': 'Send failed',
};

/**
 * The badge for a disposition, or `null` on the happy path. `delivered`/`sent`
 * are the norm and carry no badge — a badge means "this needs your attention or
 * did not happen".
 */
export function dispositionBadge(d: EmailDisposition | null): string | null {
  return d ? (BADGES[d] ?? null) : null;
}

/** The approvals queue IS these two dispositions — there is no approvals table. */
export function isPending(d: EmailDisposition | null): boolean {
  return d === 'quarantined' || d === 'held';
}

/** Direction in words — the accessible name never depends on a glyph alone. */
export function directionLabel(direction: EmailDirection): string {
  return direction === 'in' ? 'Received' : 'Sent';
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

export interface VerificationNote {
  /** `good` = authenticated, `warn` = unverified, `bad` = refused outright. */
  tone: 'good' | 'warn' | 'bad';
  label: string;
  /** Per-mechanism detail, as text, for the tooltip. */
  tooltip: string;
}

/**
 * The verification indicator for one email. Nothing renders on the viewer's own
 * outbound mail (there is no inbound authentication to report: the org signs its
 * own mail). Precedence: a virus block, then a spoof rejection, then a spam
 * flag, then authenticated / not.
 *
 * "Authenticated" here is the *display* reading of the server's rule: any `fail`
 * means unverified; otherwise at least one `pass` earns the verified mark. The
 * tooltip always carries the raw per-mechanism verdicts, so the mark never hides
 * the truth.
 */
export function verificationNote(input: {
  direction: EmailDirection;
  verification: EmailVerification | null;
  disposition: EmailDisposition | null;
  reason: EmailReason | null;
}): VerificationNote | null {
  const { direction, verification: v, disposition, reason } = input;
  if (direction === 'out' || !v) return null;

  const parts = [`SPF: ${v.spf}`, `DKIM: ${v.dkim}`, `DMARC: ${v.dmarc}`];
  if (v.spam) parts.push(`Spam: ${v.spam}`);
  if (v.virus) parts.push(`Virus: ${v.virus}`);
  if (v.domain) parts.push(`Domain: ${v.domain}`);
  const tooltip = parts.join(' · ');

  if (v.virus === 'fail' || reason === 'virus') {
    return { tone: 'bad', label: 'Blocked — malware detected', tooltip };
  }
  if (disposition === 'rejected' && reason === 'spoof') {
    return { tone: 'bad', label: 'Rejected — the sender could not be verified.', tooltip };
  }
  if (disposition === 'rejected' && reason === 'auth-failed') {
    return { tone: 'bad', label: "Rejected — failed the sender domain's own DMARC policy.", tooltip };
  }
  if (v.spam === 'fail') return { tone: 'warn', label: 'Flagged as spam', tooltip };

  const mechanisms = [v.spf, v.dkim, v.dmarc];
  const failed = mechanisms.some((m) => m === 'fail');
  const passed = mechanisms.some((m) => m === 'pass');
  if (!failed && passed) {
    return { tone: 'good', label: `Verified — ${v.domain}`, tooltip };
  }
  return { tone: 'warn', label: 'Unverified sender', tooltip };
}

/* -------------------------------------------------------------------------- */
/* The judge                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The muted line shown when an automatic review ran. The provider name is never
 * surfaced; a `null` verdict is the degrade record (a configured judge that could
 * not answer) and says so plainly rather than implying an answer.
 */
export function judgeNote(judge: EmailJudge | null | undefined): string | null {
  if (!judge) return null;
  const verdict = judge.verdict ?? 'could not decide';
  return judge.reason ? `Automatic review: ${verdict} — ${judge.reason}` : `Automatic review: ${verdict}`;
}

/* -------------------------------------------------------------------------- */
/* Parties                                                                    */
/* -------------------------------------------------------------------------- */

/** Display name when known, else the bare address. */
export function partyLabel(p: Party): string {
  return p.name?.trim() ? p.name : p.email;
}

/**
 * Whether this email's SENDER is untrusted — quarantined, or inbound-rejected.
 * Untrusted senders render as their raw ADDRESS everywhere, never their
 * self-chosen display name: an attacker could name themselves after the org's
 * owner (Jake's ruling, 2026-09-02).
 */
export function untrustedSender(direction: EmailDirection, disposition: EmailDisposition | null): boolean {
  return disposition === 'quarantined' || (direction === 'in' && disposition === 'rejected');
}

/** `partyLabel`, downgraded to the bare address for an untrusted sender. */
export function senderLabel(
  p: Party,
  direction: EmailDirection,
  disposition: EmailDisposition | null,
): string {
  return untrustedSender(direction, disposition) ? p.email : partyLabel(p);
}

/** A participant chip: what it reads, and what a click copies. */
export function partyChip(p: Party): { label: string; address: string } {
  return { label: partyLabel(p), address: p.email };
}

/* -------------------------------------------------------------------------- */
/* Card heads                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything a COLLAPSED email card renders, normalized from whichever source
 * the surface has: a timeline entry (a ref — no body), an `EmailPreview` (events,
 * the approvals queue), or a full `Email` (a thread view, or an expanded card).
 *
 * `disposition: null` means "not derivable without a fetch" — an `email.resolved`
 * entry knows something happened but not the outcome, and a card renders no badge
 * rather than guessing one.
 */
export interface EmailCardHead {
  emailId: string | null;
  threadId: string | null;
  direction: EmailDirection;
  /** The other party, when an address is known (previews and full emails). */
  counterpart: Party | null;
  /** Always renderable: the party's label, or a timeline entry's frozen actor. */
  counterpartLabel: string;
  subject: string;
  /** One-line body snippet, or `null` when the surface holds no body yet. */
  snippet: string | null;
  createdAt: string;
  disposition: EmailDisposition | null;
  reason: EmailReason | null;
}

/** `email.*` entry type → (direction, disposition). `resolved` is unknowable. */
const ENTRY_FACTS: Partial<
  Record<ActivityEntryType, { direction: EmailDirection; disposition: EmailDisposition | null }>
> = {
  'email.received': { direction: 'in', disposition: 'delivered' },
  'email.sent': { direction: 'out', disposition: 'sent' },
  'email.quarantined': { direction: 'in', disposition: 'quarantined' },
  'email.held': { direction: 'out', disposition: 'held' },
  'email.rejected': { direction: 'in', disposition: 'rejected' },
  'email.resolved': { direction: 'in', disposition: null },
};

/** True for the entry types this client renders as email cards. */
export function isEmailEntry(entry: ActivityEntry): boolean {
  return entry.medium === 'email' && entry.type in ENTRY_FACTS;
}

export function headFromEntry(entry: ActivityEntry): EmailCardHead {
  const facts = ENTRY_FACTS[entry.type] ?? { direction: 'in' as EmailDirection, disposition: null };
  return {
    emailId: entry.refs.emailId ?? null,
    threadId: entry.refs.emailThreadId ?? null,
    direction: facts.direction,
    counterpart: null,
    counterpartLabel: entry.actor.displayName,
    subject: entry.summary ?? '(no subject)',
    snippet: null,
    createdAt: entry.createdAt,
    disposition: facts.disposition,
    reason: null,
  };
}

export function headFromPreview(p: EmailPreview): EmailCardHead {
  return {
    emailId: p.id,
    threadId: p.threadId,
    direction: p.direction,
    counterpart: p.from,
    counterpartLabel: senderLabel(p.from, p.direction, p.disposition),
    subject: p.subject || '(no subject)',
    snippet: oneLine(p.preview),
    createdAt: p.createdAt,
    disposition: p.disposition,
    reason: p.reason,
  };
}

export function headFromEmail(e: Email): EmailCardHead {
  const counterpart = e.direction === 'in' ? e.from : (e.to[0] ?? e.from);
  return {
    emailId: e.id,
    threadId: e.threadId,
    direction: e.direction,
    counterpart,
    counterpartLabel: senderLabel(counterpart, e.direction, e.disposition),
    subject: e.subject || '(no subject)',
    snippet: oneLine(e.text),
    createdAt: e.createdAt,
    disposition: e.disposition,
    reason: e.reason,
  };
}

/** Collapse a body to one line for the snippet slot (no wrapping, ever). */
export function oneLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 0 ? flat : null;
}

/* -------------------------------------------------------------------------- */
/* HTML bodies                                                                */
/* -------------------------------------------------------------------------- */

/** Elements that would load remote content or execute — dropped whole. */
const FORBIDDEN = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'IFRAME',
  'FRAME',
  'FRAMESET',
  'OBJECT',
  'EMBED',
  'APPLET',
  'BASE',
  'META',
  'FORM',
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'TRACK',
  'IMG',
  'PICTURE',
  'SVG',
  'CANVAS',
]);

const SAFE_HREF = /^(https?:|mailto:|tel:)/i;

/**
 * The client's own pass over an ALREADY-sanitized stored body: the server stores
 * sanitized HTML, and the client refuses anything that survived. No remote
 * content is loaded (images, webfonts, iframes and stylesheets are removed
 * outright), no script or event handler runs, and links open in a new tab with
 * `rel="noopener noreferrer"` — never auto-followed, never prefetched.
 */
export function sanitizeEmailHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return '';

  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (FORBIDDEN.has(el.tagName.toUpperCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if (name === 'srcset' || name === 'background' || name === 'src') el.removeAttribute(attr.name);
    }
    if (el.tagName.toUpperCase() === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!SAFE_HREF.test(href.trim())) el.removeAttribute('href');
      else {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
  return root.innerHTML;
}
