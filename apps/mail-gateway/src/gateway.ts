import type { GatewayConfig } from './config.js';
import { createInboundSmtpServer, type InboundSmtpServer } from './inbound-smtp.js';
import { createLogger, type Logger } from './log.js';
import { createOutboundServer, type OutboundServer } from './outbound-http.js';
import { createRelay, type Relay } from './relay.js';
import type { Verifier } from './verify.js';

export interface Gateway {
  /** Bind both listeners; resolves with the ports actually bound. */
  start(): Promise<{ smtpPort: number; outboundPort: number }>;
  stop(): Promise<void>;
}

export interface GatewayOptions {
  config: GatewayConfig;
  verify?: Verifier;
  relay?: Relay;
  logger?: Logger;
}

/**
 * The whole sidecar: SMTP in on `MAIL_SMTP_PORT`, the outbound webhook and
 * health endpoint on `MAIL_OUTBOUND_PORT`. Stateless — no database, no queue,
 * no credentials beyond the environment.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const { config } = options;
  const logger = options.logger ?? createLogger();
  const relay = options.relay ?? createRelay(config);

  const inbound: InboundSmtpServer = createInboundSmtpServer({
    config,
    logger,
    ...(options.verify ? { verify: options.verify } : {}),
  });
  const outbound: OutboundServer = createOutboundServer({ config, relay, logger });

  return {
    async start() {
      const smtpPort = await inbound.listen();
      const outboundPort = await outbound.listen();
      logger.info('mail-gateway listening', {
        smtpPort,
        outboundPort,
        orgSuffix: config.orgSuffix,
        inboundUrl: config.inboundUrl,
        dkim: config.dkim ? `${config.dkim.selector}._domainkey.${config.dkim.domain}` : null,
        delivery: config.smarthost ? `smarthost ${config.smarthost.host}:${config.smarthost.port}` : 'direct-to-mx',
        helo: config.heloName,
      });
      return { smtpPort, outboundPort };
    },
    async stop() {
      await Promise.all([inbound.close(), outbound.close()]);
      logger.info('mail-gateway stopped');
    },
  };
}

export { loadConfig, ConfigError, type GatewayConfig } from './config.js';
export { parseInboundEmail } from '@sparrow/mail-parse';
