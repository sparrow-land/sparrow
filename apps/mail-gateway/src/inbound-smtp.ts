import { parseInboundEmail } from '@sparrow/mail-parse';
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from 'smtp-server';
import type { GatewayConfig } from './config.js';
import { createInboundDeliverer, type Deliverer } from './deliver.js';
import { createLogger, type Logger } from './log.js';
import { smtpReplyFor } from './smtp-response.js';
import { createMailauthVerifier, type Verifier } from './verify.js';

export interface InboundSmtpServer {
  /** Start listening. Pass `0` for an ephemeral port; resolves with the real one. */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export interface InboundSmtpOptions {
  config: GatewayConfig;
  /** Defaults to real SPF/DKIM/DMARC/ARC verification via mailauth. */
  verify?: Verifier;
  /** Defaults to POSTing the core's `/email/inbound`. */
  deliver?: Deliverer;
  logger?: Logger;
}

/** An error smtp-server turns into a specific SMTP reply. */
function smtpError(code: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode: code });
}

/**
 * The inbound half of the gateway: an SMTP listener that accepts mail only for
 * `EMAIL_ORG_SUFFIX` (everything else `550`, so the box is never an open
 * relay), authenticates it at the edge, normalizes it with
 * `@sparrow/mail-parse`, and POSTs it to the core — answering the sending MTA
 * with whatever the core's answer maps to.
 */
export function createInboundSmtpServer(options: InboundSmtpOptions): InboundSmtpServer {
  const { config } = options;
  const verify = options.verify ?? createMailauthVerifier();
  const deliver = options.deliver ?? createInboundDeliverer(config);
  const logger = options.logger ?? createLogger();

  const server = new SMTPServer({
    // A public MX: no AUTH, and TLS termination (if any) is the operator's.
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: config.smtpMaxBytes,
    banner: 'sparrow mail-gateway',
    logger: false,
    onRcptTo(address, _session, callback) {
      const rcpt = address.address.trim().toLowerCase();
      const local = rcpt.slice(0, rcpt.lastIndexOf('@'));
      if (!local || !rcpt.endsWith(config.orgSuffix)) {
        callback(smtpError(550, `5.1.1 <${address.address}>: relay access denied`));
        return;
      }
      callback();
    },
    onData(stream, session, callback) {
      handleMessage(stream, session)
        .then((reply) => {
          if (reply.code === 250) callback(null, reply.message);
          else callback(smtpError(reply.code, reply.message));
        })
        .catch((error: unknown) => {
          logger.error('inbound failed', { error: String(error) });
          callback(smtpError(451, '4.3.0 temporary failure, try again later'));
        });
    },
  });

  async function handleMessage(stream: SMTPServerDataStream, session: SMTPServerSession) {
    const raw = await collect(stream, config.smtpMaxBytes);
    if (raw === null || stream.sizeExceeded) {
      return { code: 552, message: '5.3.4 message too large', permanent: true };
    }

    const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
    const rcptTo = session.envelope.rcptTo.map((address) => address.address);

    const { verification, arc } = await verify({
      raw,
      ip: session.remoteAddress,
      helo: session.clientHostname,
      mailFrom,
      mta: config.heloName,
    });

    const { payload, stats } = await parseInboundEmail(raw, {
      verification,
      envelope: { mailFrom, rcptTo },
    });

    const result = await deliver(payload);
    const reply = smtpReplyFor(result);
    logger.info('inbound', {
      messageId: payload.rfcMessageId,
      from: payload.from.email,
      rcptTo,
      bytes: stats.rawBytes,
      attachments: stats.attachmentCount,
      malformed: stats.malformed,
      warnings: stats.warnings,
      spf: verification.spf,
      dkim: verification.dkim,
      dmarc: verification.dmarc,
      arc,
      core: result.kind === 'ok' ? (result.body?.status ?? 'accepted') : result.kind,
      smtp: reply.code,
    });
    return reply;
  }

  return {
    listen(port = config.smtpPort, host = '0.0.0.0') {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.server.address() as AddressInfo | null;
          resolve(address?.port ?? port);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** Read the DATA stream, giving up (with `null`) once it passes the cap. */
function collect(stream: SMTPServerDataStream, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(overflowed ? null : Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
