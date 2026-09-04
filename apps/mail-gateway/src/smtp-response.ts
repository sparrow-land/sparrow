import type { InboundEmailResponse } from '@sparrow/common-types';

/** What came back from `POST /email/inbound`, including the ways it did not. */
export type DeliveryResult =
  /** A `202` whose body parsed as the inbound response (or `null` if it did not). */
  | { kind: 'ok'; status: number; body: InboundEmailResponse | null }
  /** Any other HTTP status. */
  | { kind: 'http'; status: number; bodyText: string }
  /** The request did not finish in time. */
  | { kind: 'timeout' }
  /** DNS/connect/socket failure — the core is unreachable. */
  | { kind: 'network'; error: string };

/** An SMTP reply to end the DATA transaction with. */
export interface SmtpReply {
  code: number;
  message: string;
  /** True for 5xx: the sender must not retry. */
  permanent: boolean;
}

/**
 * The spec's response-mapping table, verbatim (SPEC.md, `apps/mail-gateway`):
 *
 * | `202` (any disposition)          | `250 OK` — custody transferred |
 * | `202` `status: unknown-recipient`| `550` permanent                |
 * | `400` (malformed)                | `550` permanent                |
 * | `401`                            | `451` temporary                |
 * | `413`                            | `552` message too large        |
 * | `429`, `5xx`, timeout, conn error| `451` temporary                |
 *
 * Anything unlisted is treated as temporary: a message is never dropped on a
 * guess. A `rejected` disposition is NOT a bounce — the core took custody.
 */
export function smtpReplyFor(result: DeliveryResult): SmtpReply {
  if (result.kind === 'timeout') {
    return temporary('4.4.1 core did not respond in time, try again later');
  }
  if (result.kind === 'network') {
    return temporary(`4.4.1 core unreachable (${result.error}), try again later`);
  }
  if (result.kind === 'ok') {
    if (result.body?.status === 'unknown-recipient') {
      return { code: 550, message: '5.1.1 no such mailbox here', permanent: true };
    }
    return { code: 250, message: '2.0.0 OK, message accepted', permanent: false };
  }
  switch (result.status) {
    case 400:
      return { code: 550, message: '5.6.0 message rejected as malformed', permanent: true };
    case 413:
      return { code: 552, message: '5.3.4 message too large', permanent: true };
    case 401:
      return temporary('4.7.0 relay not authorized by the core, try again later');
    default:
      return temporary(`4.3.0 core returned ${result.status}, try again later`);
  }
}

function temporary(message: string): SmtpReply {
  return { code: 451, message, permanent: false };
}
