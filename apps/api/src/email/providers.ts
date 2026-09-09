/**
 * The email medium's outbound providers (SPEC v4 "The email medium →
 * Providers"). The medium is ON iff `EMAIL_ORG_SUFFIX` is set AND one of these
 * registers: `fake` (an in-process loopback with no network at all — the TDD
 * workhorse) or `webhook` (the v4 envelope POSTed to `email.webhookUrl`; naming
 * `webhook` without a URL registers nothing, so the medium stays off).
 */
import type {
  CapturedEmail,
  InboundEmailResponse,
  OutboundEmailWebhookPayload,
} from '@sparrow/common-types';
import { sendEmail, type EmailWebhookConfig } from '../email.js';
import type { EmailFakeHandle, EmailProvider, RelayResult } from './types.js';

/** How many captured sends the fake provider's ring buffer keeps. */
export const FAKE_OUTBOX_MAX = 100;

/**
 * `EMAIL_PROVIDER=fake` — outbound is CAPTURED, never relayed (disposition
 * `sent`), landing in a bounded ring buffer (last {@link FAKE_OUTBOX_MAX}). The
 * same object is `app.emailFake`, whose `deliver()` runs the exact
 * `/email/inbound` pipeline in-process (no HTTP, no token) — unit tests use it.
 */
export class FakeEmailProvider implements EmailProvider, EmailFakeHandle {
  readonly id = 'fake';
  private readonly buffer: CapturedEmail[] = [];
  private deliverFn: ((payload: unknown) => Promise<InboundEmailResponse>) | null = null;

  get sent(): CapturedEmail[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /** Late-bind the inbound pipeline (it needs the app context, built after this). */
  bindDeliver(fn: (payload: unknown) => Promise<InboundEmailResponse>): void {
    this.deliverFn = fn;
  }

  deliver(payload: unknown): Promise<InboundEmailResponse> {
    if (!this.deliverFn) return Promise.reject(new Error('inbound pipeline not bound'));
    return this.deliverFn(payload);
  }

  relay(payload: OutboundEmailWebhookPayload, captured?: CapturedEmail): Promise<RelayResult> {
    if (captured) {
      this.buffer.push(captured);
      if (this.buffer.length > FAKE_OUTBOX_MAX) this.buffer.shift();
    }
    void payload;
    return Promise.resolve({ ok: true });
  }
}

/**
 * `EMAIL_PROVIDER=webhook` — outbound rides the `sendEmail` seam with the v4
 * envelope. Any 2xx = accepted for delivery → `sent`; anything else →
 * `send-failed` with `reason: "relay-error"`.
 */
export class WebhookEmailProvider implements EmailProvider {
  readonly id = 'webhook';

  constructor(private readonly resolve: () => EmailWebhookConfig) {}

  async relay(payload: OutboundEmailWebhookPayload): Promise<RelayResult> {
    const result = await sendEmail(this.resolve(), payload);
    return result.sent ? { ok: true } : { ok: false, reason: result.reason };
  }
}
