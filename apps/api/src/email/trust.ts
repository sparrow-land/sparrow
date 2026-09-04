/**
 * The trust engine (SPEC v4 "The email medium → The trust engine").
 *
 * Every email crosses the boundary exactly once, and this module IS the
 * crossing. It is pure and deterministic — same inputs, same disposition — so
 * the ladder can be reasoned about (and tested) without a database, a network,
 * or a judge. The impure halves live around it: the caller resolves the trust
 * set from the db, and runs the judge when a decision comes back `judge`.
 */
import type {
  ContactTrust,
  EmailReason,
  EmailUnrecognizedPolicy,
  EmailVerification,
} from '@sparrow/common-types';

/** The resolved trust inputs for ONE org (+ the thread, when there is one). */
export interface TrustSet {
  /** Rung 0: a durable, human-granted approval on THIS conversation. */
  threadTrusted: boolean;
  /** Rung 1: the org humans' account emails, lowercased. */
  humanEmails: Set<string>;
  /** Rung 2: the org agents' own derived addresses, lowercased. */
  agentAddresses: Set<string>;
  /** Rung 3 (+ the block list): lowercased address → its durable trust. */
  contacts: Map<string, ContactTrust>;
  /** Rung 4: the org's `email.trustedPatterns` globs. */
  trustedPatterns: string[];
}

/** Lowercase an address for every comparison in this module. */
function lower(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Glob match over a WHOLE address, case-insensitively: `*` matches any run of
 * characters, `?` matches one. No regex, no anchoring characters.
 */
export function matchesTrustedPattern(pattern: string, address: string): boolean {
  const escaped = lower(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return rx.test(lower(address));
}

/** Whether a contact row blocks this address (never recognized; short-circuits). */
export function blocked(address: string, trust: TrustSet): boolean {
  return trust.contacts.get(lower(address)) === 'blocked';
}

/**
 * Whether an address is RECOGNIZED for an org: any of the five rungs matches
 * and no `blocked` contact short-circuits them (a block outranks even a trusted
 * thread).
 */
export function recognized(address: string, trust: TrustSet): boolean {
  const addr = lower(address);
  if (blocked(addr, trust)) return false;
  if (trust.threadTrusted) return true;
  if (trust.humanEmails.has(addr)) return true;
  if (trust.agentAddresses.has(addr)) return true;
  if (trust.contacts.get(addr) === 'approved') return true;
  return trust.trustedPatterns.some((p) => matchesTrustedPattern(p, addr));
}

/**
 * Inbound step 4: the sender is *authenticated* iff `dmarc === 'pass'`, or
 * `dmarc === 'none'` and at least one of spf/dkim passed AND
 * `verification.domain` equals the From address's domain. `dmarc === 'fail'` is
 * never authenticated.
 */
export function isAuthenticated(from: string, v: EmailVerification): boolean {
  if (v.dmarc === 'pass') return true;
  if (v.dmarc !== 'none') return false;
  if (v.spf !== 'pass' && v.dkim !== 'pass') return false;
  const at = lower(from).lastIndexOf('@');
  const fromDomain = at >= 0 ? lower(from).slice(at + 1) : '';
  return fromDomain !== '' && fromDomain === lower(v.domain);
}

/**
 * A pipeline decision. `terminal` is the disposition to persist; `judge` means
 * the caller must run the LLM judge and map its outcome (allow → delivered/sent,
 * deny → rejected `judge-deny`, anything else → quarantined/held
 * `judge-unavailable`).
 */
export type InboundDecision =
  | { kind: 'terminal'; disposition: 'delivered' | 'quarantined' | 'rejected'; reason: EmailReason | null }
  | { kind: 'judge'; reason: EmailReason };

export interface InboundInput {
  from: string;
  verification: EmailVerification;
  trust: TrustSet;
  policy: EmailUnrecognizedPolicy;
}

/**
 * Inbound steps 5–11, per anchor agent, against that agent's org policy. Within
 * one anchor the FIRST terminal step wins.
 */
export function classifyInbound(input: InboundInput): InboundDecision {
  const { from, verification, trust, policy } = input;

  // 5. Virus — whatever the sender's standing. An edge relay normally drops
  // infected mail; core refuses it too rather than trusting the edge.
  if (verification.virus === 'fail') {
    return { kind: 'terminal', disposition: 'rejected', reason: 'virus' };
  }
  // 6. Blocked.
  if (blocked(from, trust)) {
    return { kind: 'terminal', disposition: 'rejected', reason: 'blocked' };
  }

  const authenticated = isAuthenticated(from, verification);
  const inTrustSet = recognized(from, trust);

  // 7. Spoof — hard reject. This outranks every policy: an org can choose to
  // review strangers, never to review forgeries.
  if (!authenticated && inTrustSet) {
    return { kind: 'terminal', disposition: 'rejected', reason: 'spoof' };
  }

  // 7½. DMARC fail — hard reject, whatever the policy. The sender's own domain
  // published DMARC and this message failed it: the domain is asking to be
  // refused, and no org setting may turn a failed authentication into a review
  // item. (A sender with NO DMARC still authenticates via spf/dkim + domain
  // match above, and a merely-unverified stranger stays policy-governed below.)
  if (verification.dmarc === 'fail') {
    return { kind: 'terminal', disposition: 'rejected', reason: 'auth-failed' };
  }

  const spam = verification.spam === 'fail';
  // 8. Recognized — authenticated, not spam-flagged, in the trust set.
  if (authenticated && !spam && inTrustSet) {
    return { kind: 'terminal', disposition: 'delivered', reason: null };
  }

  // 9/10/11. Spam-flagged mail and unrecognized senders (authenticated or not)
  // all fall through to the org's `inboundUnrecognized` policy. `spam` names the
  // reason when a spam verdict is what diverted the message.
  const reason: EmailReason = spam ? 'spam' : 'unrecognized-sender';
  switch (policy) {
    case 'approve':
      return { kind: 'terminal', disposition: 'quarantined', reason };
    case 'judge':
      return { kind: 'judge', reason };
    case 'reject':
    default:
      return { kind: 'terminal', disposition: 'rejected', reason };
  }
}

/** An outbound decision; `blocked` refuses the call with `403`, persisting nothing. */
export type OutboundDecision =
  | { kind: 'blocked'; blocked: string[] }
  | { kind: 'send' }
  | {
      kind: 'terminal';
      disposition: 'rejected' | 'held';
      reason: EmailReason;
      unrecognized: string[];
    }
  | { kind: 'judge'; reason: EmailReason; unrecognized: string[] };

export interface OutboundInput {
  recipients: string[];
  trust: TrustSet;
  policy: EmailUnrecognizedPolicy;
}

/** Outbound steps 2–4 (step 1, the recipient set, is the caller's). */
export function classifyOutbound(input: OutboundInput): OutboundDecision {
  const { recipients, trust, policy } = input;
  const blockedList = recipients.filter((r) => blocked(r, trust));
  if (blockedList.length > 0) return { kind: 'blocked', blocked: blockedList };

  const unrecognized = recipients.filter((r) => !recognized(r, trust));
  if (unrecognized.length === 0) return { kind: 'send' };

  const reason: EmailReason = 'unrecognized-recipient';
  switch (policy) {
    case 'approve':
      return { kind: 'terminal', disposition: 'held', reason, unrecognized };
    case 'judge':
      return { kind: 'judge', reason, unrecognized };
    case 'reject':
    default:
      return { kind: 'terminal', disposition: 'rejected', reason, unrecognized };
  }
}
