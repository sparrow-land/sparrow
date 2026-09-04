import { resolveMx as dnsResolveMx } from 'node:dns/promises';
import type { OutboundEmailWebhookPayload } from '@sparrow/common-types';
import nodemailer from 'nodemailer';
import type { GatewayConfig } from './config.js';

/** One rendered attachment as nodemailer wants it. */
export interface RelayAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** The message we hand a transport. Structural, so tests need no nodemailer. */
export interface MailOptions {
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Passed through VERBATIM — the core owns threading identity. */
  messageId: string;
  inReplyTo?: string;
  references?: string;
  headers: Record<string, string>;
  attachments?: RelayAttachment[];
  /** Set for direct-to-MX delivery, where one submission serves one domain. */
  envelope?: { from: string; to: string[] };
}

export interface SentMessage {
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
}

export interface Transport {
  sendMail(options: MailOptions): Promise<SentMessage>;
}

export interface TransportOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  /** EHLO name. */
  name?: string;
  auth?: { user: string; pass: string };
  dkim?: { domainName: string; keySelector: string; privateKey: string };
  tls?: { rejectUnauthorized: boolean };
}

/** Injectable so signing, routing and failure handling are testable offline. */
export interface RelayDeps {
  createTransport(options: TransportOptions): Transport;
  /** MX hosts for a domain, best first. */
  resolveMx(domain: string): Promise<string[]>;
}

export interface RelayResult {
  sent: boolean;
  messageId: string;
  accepted: string[];
  rejected: string[];
  error?: string;
}

export type Relay = (payload: OutboundEmailWebhookPayload) => Promise<RelayResult>;

/**
 * Render the outbound webhook envelope to a MIME message.
 *
 * `messageId`, `inReplyTo` and `references` are copied through untouched: the
 * gateway must never mint its own Message-ID. `Auto-Submitted:
 * auto-generated` is added because this mail is written by an agent.
 */
export function buildMailOptions(payload: OutboundEmailWebhookPayload): MailOptions {
  const options: MailOptions = {
    from: payload.from,
    to: [...payload.to],
    subject: payload.subject,
    text: payload.text,
    messageId: payload.headers.messageId,
    headers: { 'Auto-Submitted': 'auto-generated' },
  };
  if (payload.cc && payload.cc.length > 0) options.cc = [...payload.cc];
  if (payload.bcc && payload.bcc.length > 0) options.bcc = [...payload.bcc];
  if (payload.html) options.html = payload.html;
  if (payload.headers.inReplyTo) options.inReplyTo = payload.headers.inReplyTo;
  if (payload.headers.references) options.references = payload.headers.references;
  if (payload.attachments && payload.attachments.length > 0) {
    options.attachments = payload.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.dataBase64, 'base64'),
    }));
  }
  return options;
}

/** Real transports and real DNS. */
export function defaultRelayDeps(): RelayDeps {
  return {
    createTransport: (options) =>
      nodemailer.createTransport(options as Parameters<typeof nodemailer.createTransport>[0]) as unknown as Transport,
    resolveMx: async (domain) => {
      const records = await dnsResolveMx(domain);
      return records
        .sort((a, b) => a.priority - b.priority)
        .map((record) => record.exchange)
        .filter((exchange) => exchange.length > 0);
    },
  };
}

/**
 * The outbound half of the gateway: render, DKIM-sign, and submit — through
 * the configured smarthost, or direct to each recipient domain's MX.
 *
 * Never throws: a failure comes back as `{ sent: false, error }`, which the
 * listener answers with a non-2xx so the core records `send-failed`
 * (`reason: "relay-error"`).
 */
export function createRelay(
  config: GatewayConfig,
  deps: RelayDeps = defaultRelayDeps(),
): Relay {
  const dkim = config.dkim
    ? {
        domainName: config.dkim.domain,
        keySelector: config.dkim.selector,
        privateKey: config.dkim.privateKey,
      }
    : undefined;

  const withSigning = (options: TransportOptions): TransportOptions =>
    dkim ? { ...options, dkim } : options;

  return async (payload) => {
    const message = buildMailOptions(payload);
    const recipients = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])];
    if (recipients.length === 0) {
      return {
        sent: false,
        messageId: payload.headers.messageId,
        accepted: [],
        rejected: [],
        error: 'no recipient addresses',
      };
    }

    if (config.smarthost) {
      const { host, port, user, pass } = config.smarthost;
      const transport = deps.createTransport(
        withSigning({
          host,
          port,
          secure: port === 465,
          name: config.heloName,
          ...(user !== null && pass !== null ? { auth: { user, pass } } : {}),
        }),
      );
      try {
        const info = await transport.sendMail(message);
        return {
          sent: true,
          messageId: payload.headers.messageId,
          accepted: addresses(info.accepted, recipients),
          rejected: addresses(info.rejected, []),
        };
      } catch (error) {
        return {
          sent: false,
          messageId: payload.headers.messageId,
          accepted: [],
          rejected: recipients,
          error: errorMessage(error),
        };
      }
    }

    /* ---- direct to MX: one submission per recipient domain ---- */
    const byDomain = new Map<string, string[]>();
    for (const recipient of recipients) {
      const domain = recipient.slice(recipient.lastIndexOf('@') + 1).toLowerCase();
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), recipient]);
    }

    const accepted: string[] = [];
    const rejected: string[] = [];
    const errors: string[] = [];

    for (const [domain, domainRecipients] of byDomain) {
      try {
        const hosts = await deps.resolveMx(domain);
        if (hosts.length === 0) throw new Error(`no MX records for ${domain}`);
        await sendToFirstWorkingHost(hosts, domainRecipients);
        accepted.push(...domainRecipients);
      } catch (error) {
        rejected.push(...domainRecipients);
        errors.push(`${domain}: ${errorMessage(error)}`);
      }
    }

    return {
      sent: errors.length === 0,
      messageId: payload.headers.messageId,
      accepted,
      rejected,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    };

    async function sendToFirstWorkingHost(hosts: string[], to: string[]): Promise<void> {
      let lastError: unknown;
      for (const host of hosts) {
        const transport = deps.createTransport(
          withSigning({
            host,
            port: 25,
            secure: false,
            name: config.heloName,
            // Public MX certificates are routinely self-signed; opportunistic
            // TLS is still better than none.
            tls: { rejectUnauthorized: false },
          }),
        );
        try {
          await transport.sendMail({ ...message, envelope: { from: payload.from, to } });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
  };
}

/** nodemailer reports addresses as strings or `{ address }` objects. */
function addresses(list: unknown[] | undefined, fallback: string[]): string[] {
  if (!list) return fallback;
  return list.map((entry) =>
    typeof entry === 'string'
      ? entry
      : ((entry as { address?: string }).address ?? String(entry)),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
