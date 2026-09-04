/**
 * The email medium's provider seams (SPEC v4 "The email medium → Providers" and
 * "Unified attention → LLM judge"). Both are internal server seams, never wire
 * shapes: one outbound relay and (optionally) one judge are registered at boot.
 */
import type {
  CapturedEmail,
  InboundEmailPayload,
  InboundEmailResponse,
  JudgeVerdict,
  OutboundEmailWebhookPayload,
} from '@sparrow/common-types';

/** Outbound relay result: any 2xx = accepted → `sent`; else `send-failed`. */
export type RelayResult = { ok: true } | { ok: false; reason: string };

/**
 * One registered outbound provider. `fake` captures in-process and never
 * touches the network; `webhook` POSTs the v4 envelope to `email.webhookUrl`.
 */
export interface EmailProvider {
  id: 'fake' | 'webhook';
  /** Relay one outbound email. Never throws — a failure is `{ ok: false }`. */
  relay(payload: OutboundEmailWebhookPayload, captured?: CapturedEmail): Promise<RelayResult>;
}

/**
 * The in-process handle `buildServer()` exposes as `app.emailFake` under
 * `EMAIL_PROVIDER=fake`: the captured outbox plus a `deliver()` that runs the
 * exact `/email/inbound` pipeline in-process (no HTTP, no token).
 */
export interface EmailFakeHandle {
  /** The bounded ring buffer of captured sends (last 100), ascending. */
  readonly sent: CapturedEmail[];
  clear(): void;
  deliver(payload: unknown): Promise<InboundEmailResponse>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The in-process fake-provider handle; present only under `EMAIL_PROVIDER=fake`. */
    emailFake?: EmailFakeHandle;
  }
}

/** The narrowed message under review — never raw MIME, never attachment bytes. */
export interface JudgeEmail {
  direction: 'in' | 'out';
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** The first 8 KB of the plain-text body. HTML is NEVER sent to the judge. */
  text: string;
  attachments: { filename: string; contentType: string }[];
  verification: InboundEmailPayload['verification'] | null;
  orgName: string;
  agentName: string;
  agentAddress: string;
}

/**
 * The `LlmJudge` seam. One provider registered at boot, internal to the server.
 * A non-2xx or unreachable vendor raises — the caller degrades to `approve`.
 */
export interface LlmJudge {
  id: string;
  judge(input: { prompt: string; email: JudgeEmail }): Promise<{
    verdict: JudgeVerdict;
    reason: string;
  }>;
}

/** An LLM vendor failure (mirrors `VoiceVendorError`); never leaks a vendor body. */
export class LlmVendorError extends Error {
  constructor(message = 'llm vendor request failed') {
    super(message);
    this.name = 'LlmVendorError';
  }
}

/** Everything the email medium needs from the app context. */
export interface EmailRegistry {
  /** The registered outbound provider, or null (medium off). */
  provider: EmailProvider | null;
  /** The in-process fake handle (only under `EMAIL_PROVIDER=fake`). */
  fake: EmailFakeHandle | null;
  /** The registered `LlmJudge`, or null (a `judge` policy then degrades to approve). */
  judge: LlmJudge | null;
  /** Bearer the mail edge presents to `POST /email/inbound`; unset = seam disabled. */
  inboundToken?: string;
  /** Per-org inbound cap before `429`. */
  inboundRatePerMin: number;
  /** Per-judge-call deadline in ms; expiry counts as an error (degrade to approve). */
  judgeTimeoutMs: number;
}
