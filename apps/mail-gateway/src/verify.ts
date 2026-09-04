import type { EmailAuthResult, EmailVerification } from '@sparrow/common-types';
import { authenticate } from 'mailauth';

/** What the edge needs to authenticate one message. */
export interface VerifyInput {
  /** The raw message as it came off the wire. */
  raw: Buffer;
  /** Connecting client's IP, when the transport knows it. */
  ip?: string | undefined;
  /** The client's EHLO/HELO name. */
  helo?: string | undefined;
  /** Envelope sender (`MAIL FROM`). */
  mailFrom: string;
  /** This MTA's own name, for the Authentication-Results header. */
  mta: string;
}

/** Verdicts for one message. `arc` is logged, not sent: the payload has no field for it. */
export interface VerifyOutcome {
  verification: EmailVerification;
  arc: EmailAuthResult;
}

/** Injectable so the pipeline can be tested without DNS. */
export type Verifier = (input: VerifyInput) => Promise<VerifyOutcome>;

/* ---- the shape of a mailauth result, narrowed to what we read ---- */

interface StatusLike {
  result?: string;
  aligned?: string | false;
}

/** Structural subset of mailauth's `authenticate()` result. */
export interface AuthenticateLike {
  spf?: { status?: StatusLike; domain?: string } | false | undefined;
  dkim?: { results?: Array<{ status?: StatusLike; signingDomain?: string }> } | false | undefined;
  dmarc?: { status?: StatusLike; domain?: string } | false | undefined;
  arc?: { status?: StatusLike } | false | undefined;
}

/**
 * Collapse mailauth's rich statuses onto the three verdicts the core accepts.
 *
 * `pass` stays `pass`; anything that actively failed (`fail`, `softfail`,
 * `permerror`, `policy`) is `fail`; everything else — no record, neutral, a
 * temporary DNS error — is `none`. `domain` is the domain the PASSING
 * mechanism authenticated, DMARC first, then DKIM, then SPF, falling back to
 * the envelope sender's domain when nothing authenticated.
 */
export function toVerification(
  results: AuthenticateLike,
  fallbackDomain: string,
): VerifyOutcome {
  const spf = mapStatus(statusOf(results.spf));
  const dmarc = mapStatus(statusOf(results.dmarc));
  const dkimResults = (results.dkim === false ? undefined : results.dkim?.results) ?? [];
  const dkimVerdicts = dkimResults.map((entry) => mapStatus(entry.status?.result));
  const dkim: EmailAuthResult = dkimVerdicts.includes('pass')
    ? 'pass'
    : dkimVerdicts.includes('fail')
      ? 'fail'
      : 'none';

  const passingDkim = dkimResults.find((entry) => mapStatus(entry.status?.result) === 'pass');
  const dmarcDomain = results.dmarc === false ? undefined : results.dmarc?.domain;
  const spfDomain = results.spf === false ? undefined : results.spf?.domain;
  const domain =
    (dmarc === 'pass' ? dmarcDomain : undefined) ??
    (dkim === 'pass'
      ? typeof passingDkim?.status?.aligned === 'string'
        ? passingDkim.status.aligned
        : passingDkim?.signingDomain
      : undefined) ??
    (spf === 'pass' ? spfDomain : undefined) ??
    fallbackDomain;

  return {
    verification: { spf, dkim, dmarc, domain: domain.toLowerCase() },
    arc: mapStatus(statusOf(results.arc)),
  };
}

function statusOf(result: { status?: StatusLike } | false | undefined): string | undefined {
  return result === false || result === undefined ? undefined : result.status?.result;
}

function mapStatus(result: string | undefined): EmailAuthResult {
  switch (result) {
    case 'pass':
      return 'pass';
    case 'fail':
    case 'softfail':
    case 'permerror':
    case 'policy':
      return 'fail';
    default:
      return 'none';
  }
}

/** The domain of an address, lower-cased — `''` when there is none. */
export function senderDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return '';
  return address.slice(at + 1).trim().toLowerCase();
}

/**
 * The real verifier: SPF, DKIM, DMARC and ARC computed at the edge with
 * `mailauth` (DNS lookups happen here, which is why it is injectable).
 * A verification that throws is not fatal — it degrades to all-`none`, which
 * the core treats as an unauthenticated stranger.
 */
export function createMailauthVerifier(): Verifier {
  return async (input) => {
    const fallback = senderDomain(input.mailFrom);
    try {
      const results = (await authenticate(input.raw, {
        ip: input.ip,
        helo: input.helo,
        sender: input.mailFrom,
        mta: input.mta,
      })) as AuthenticateLike;
      return toVerification(results, fallback);
    } catch {
      return toVerification({}, fallback);
    }
  };
}
