/**
 * The outbound-mail webhook seam (`EMAIL_PROVIDER=webhook`).
 *
 * Email in sparrow is ALWAYS best-effort at this layer: nothing here ever
 * throws. When an operator configures a webhook (`email.webhookUrl` +
 * `email.webhookToken`, env `EMAIL_WEBHOOK_URL` / `EMAIL_WEBHOOK_TOKEN`),
 * `sendEmail` POSTs the message as JSON with `Authorization: Bearer <token>`.
 * The endpoint may be anything honoring the contract — `apps/mail-gateway`, an
 * upstream relay, a serverless function wrapping SES/SendGrid/Postmark, a queue
 * shim. The core stays provider-agnostic: it speaks this one small HTTP shape.
 *
 * **v4 changes the body** (SPEC "The email medium → Providers →
 * `EMAIL_PROVIDER=webhook`"): v3's `{ to: string, subject, text }` could not
 * carry threading identity, so `to` is now ALWAYS an array and a `headers`
 * object (`messageId` / `inReplyTo` / `references`) rides along — the core owns
 * threading identity and a relay passes those through verbatim. This is the ONLY
 * outbound mail shape in the system; the shape is
 * {@link OutboundEmailWebhookPayload} in `@sparrow/common-types`.
 *
 * Any 2xx = accepted for delivery → `{ sent: true }`. A non-2xx, a network
 * error, or an unconfigured webhook all yield `{ sent: false, reason }` — the
 * caller decides how to surface it (the email medium lands `send-failed` with
 * `reason: "relay-error"`).
 */
import type { OutboundEmailWebhookPayload } from '@sparrow/common-types';

/** Resolved webhook target for {@link sendEmail}. */
export interface EmailWebhookConfig {
  /** HTTPS endpoint honoring the email-webhook contract; empty = unconfigured. */
  webhookUrl: string;
  /** Bearer token presented to the endpoint; empty = no Authorization header. */
  webhookToken: string;
}

/** One outbound message on the wire — the v4 envelope. */
export type EmailMessage = OutboundEmailWebhookPayload;

/** Best-effort send outcome — never an exception. */
export type SendEmailResult = { sent: true } | { sent: false; reason: string };

/** Drop `undefined` optional keys so the wire payload stays minimal. */
function compact(message: EmailMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    headers: message.headers,
  };
  if (message.cc !== undefined) payload.cc = message.cc;
  if (message.bcc !== undefined) payload.bcc = message.bcc;
  if (message.html !== undefined) payload.html = message.html;
  if (message.attachments !== undefined) payload.attachments = message.attachments;
  return payload;
}

/**
 * Best-effort POST of `message` to the configured email webhook. Returns
 * `{ sent: true }` on any 2xx, `{ sent: false, reason }` otherwise (unconfigured,
 * non-2xx, or network/other error). NEVER throws.
 */
export async function sendEmail(
  config: EmailWebhookConfig,
  message: EmailMessage,
): Promise<SendEmailResult> {
  const url = config.webhookUrl.trim();
  if (!url) return { sent: false, reason: 'email webhook not configured' };

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = config.webhookToken.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(compact(message)),
    });
    if (res.status >= 200 && res.status < 300) return { sent: true };
    return { sent: false, reason: `email webhook responded ${res.status}` };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : 'email webhook request failed',
    };
  }
}
