import { InboundEmailResponseSchema, type InboundEmailPayload } from '@sparrow/common-types';
import type { GatewayConfig } from './config.js';
import type { DeliveryResult } from './smtp-response.js';

/** POSTs one normalized payload to the core. Injectable for tests. */
export type Deliverer = (payload: InboundEmailPayload) => Promise<DeliveryResult>;

/** How long the core gets to answer before the sender is told to retry. */
export const INBOUND_TIMEOUT_MS = 30_000;

/**
 * `POST $MAIL_INBOUND_URL` with `Authorization: Bearer $EMAIL_INBOUND_TOKEN`.
 *
 * Never throws: every failure mode becomes a {@link DeliveryResult} that
 * {@link import('./smtp-response.js').smtpReplyFor} turns into an SMTP reply.
 */
export function createInboundDeliverer(
  config: GatewayConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Deliverer {
  const timeoutMs = options.timeoutMs ?? INBOUND_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  return async (payload) => {
    let response: Response;
    try {
      response = await doFetch(config.inboundUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.inboundToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return { kind: 'timeout' };
      }
      return { kind: 'network', error: error instanceof Error ? error.message : String(error) };
    }

    const bodyText = await response.text().catch(() => '');
    if (response.status !== 202) return { kind: 'http', status: response.status, bodyText };

    // A 202 is custody transferred even if the body surprises us.
    try {
      const parsed = InboundEmailResponseSchema.safeParse(JSON.parse(bodyText));
      return { kind: 'ok', status: 202, body: parsed.success ? parsed.data : null };
    } catch {
      return { kind: 'ok', status: 202, body: null };
    }
  };
}
