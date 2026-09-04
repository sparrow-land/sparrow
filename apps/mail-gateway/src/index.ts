#!/usr/bin/env node
/**
 * `sparrow-mail-gateway` — the OSS mail edge.
 *
 * SMTP in → verify (SPF/DKIM/DMARC/ARC) → normalize (`@sparrow/mail-parse`) →
 * `POST $MAIL_INBOUND_URL`. Outbound webhook in → DKIM-signed MIME → smarthost
 * or direct to MX. Configuration is entirely environmental; see `config.ts`.
 */
import { ConfigError, loadConfig } from './config.js';
import { createGateway } from './gateway.js';
import { createLogger } from './log.js';

const logger = createLogger();

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  throw error;
}

const gateway = createGateway({ config, logger });
await gateway.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void gateway.stop().then(() => process.exit(0));
  });
}
