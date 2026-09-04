/**
 * `@sparrow/mail-parse` — raw MIME → the normalized `POST /email/inbound` body.
 *
 * The single source of truth for that translation. `apps/mail-gateway` imports
 * it, and so should any other edge relay an operator prefers, so that the same
 * message always reaches the core as a byte-identical payload. Wire types come
 * from `@sparrow/common-types` and are never redefined here.
 *
 * Verification (SPF/DKIM/DMARC and any spam/virus scan) is an INPUT: the edge
 * authenticates, this package merges the verdicts in.
 */
export {
  parseInboundEmail,
  UNKNOWN_RECIPIENT,
  UNKNOWN_SENDER,
  type ParseInboundOptions,
  type ParseStats,
  type ParsedInboundEmail,
} from './parse.js';
export { normalizeAddress, partiesFromHeader } from './address.js';
export { normalizeMessageId, parseMessageIdList } from './message-id.js';
