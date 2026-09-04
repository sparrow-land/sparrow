import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OutboundEmailWebhookPayloadSchema } from '@sparrow/common-types';
import type { GatewayConfig } from './config.js';
import { createLogger, type Logger } from './log.js';
import { createRelay, type Relay } from './relay.js';

export interface OutboundServer {
  /** Start listening. Pass `0` for an ephemeral port; resolves with the real one. */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export interface OutboundServerOptions {
  config: GatewayConfig;
  /** Defaults to the real DKIM-signing relay. */
  relay?: Relay;
  logger?: Logger;
}

/**
 * The outbound listener: the v4 outbound webhook contract on
 * `MAIL_OUTBOUND_PORT`, plus a health endpoint.
 *
 * The core reads ANY 2xx as "accepted for delivery" and anything else as
 * `send-failed` / `relay-error`, so the status codes here are the contract:
 * `202` relayed, `400` off-contract body, `401` bad bearer, `413` too large,
 * `502` the relay could not deliver.
 */
export function createOutboundServer(options: OutboundServerOptions): OutboundServer {
  const { config } = options;
  const relay = options.relay ?? createRelay(config);
  const logger = options.logger ?? createLogger();

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error('outbound handler failed', { error: String(error) });
      send(res, 500, { error: 'internal' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && (path === '/healthz' || path === '/health')) {
      send(res, 200, { status: 'ok', service: 'sparrow-mail-gateway' });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 404, { error: 'not_found' });
      return;
    }
    if (config.webhookToken && bearer(req) !== config.webhookToken) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    const body = await readBody(req, config.smtpMaxBytes);
    if (body === null) {
      send(res, 413, { error: 'payload_too_large' });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      send(res, 400, { error: 'bad_request', detail: 'body is not JSON' });
      return;
    }

    const parsed = OutboundEmailWebhookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      send(res, 400, { error: 'bad_request', detail: parsed.error.issues[0]?.message });
      return;
    }

    const result = await relay(parsed.data);
    logger.info('outbound', {
      messageId: result.messageId,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      sent: result.sent,
      ...(result.error ? { error: result.error } : {}),
    });
    if (!result.sent) {
      send(res, 502, { error: 'relay-error', detail: result.error ?? null });
      return;
    }
    send(res, 202, { status: 'sent', messageId: result.messageId, accepted: result.accepted });
  }

  return {
    listen(port = config.outboundPort, host = '0.0.0.0') {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address() as AddressInfo | null;
          resolve(address?.port ?? port);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Read the request body, giving up (with `null`) once it passes the cap. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // Drain the rest rather than destroying the socket — the client still
        // needs to read the 413 we are about to write.
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
