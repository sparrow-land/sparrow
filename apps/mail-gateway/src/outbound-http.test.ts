import type { OutboundEmailWebhookPayload } from '@sparrow/common-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { silentLogger } from './log.js';
import { createOutboundServer, type OutboundServer } from './outbound-http.js';
import type { RelayResult } from './relay.js';

const BASE_ENV = {
  MAIL_INBOUND_URL: 'http://api:8722/email/inbound',
  EMAIL_INBOUND_TOKEN: 'inbound-token',
  EMAIL_ORG_SUFFIX: '.example.com',
};

const PAYLOAD: OutboundEmailWebhookPayload = {
  from: 'fable@acme.example.com',
  to: ['dana@partner.example.com'],
  subject: 'Re: Q3 rollout',
  text: 'Confirmed.',
  headers: { messageId: '<eml_7bN3xC6vT9pL@acme.example.com>' },
};

let running: OutboundServer | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(
  env: Record<string, string>,
  relay: (payload: OutboundEmailWebhookPayload) => Promise<RelayResult>,
): Promise<string> {
  running = createOutboundServer({
    config: loadConfig({ ...BASE_ENV, ...env }),
    relay,
    logger: silentLogger,
  });
  const port = await running.listen(0);
  return `http://127.0.0.1:${port}`;
}

const ok: RelayResult = { sent: true, messageId: PAYLOAD.headers.messageId, accepted: [], rejected: [] };

describe('outbound relay listener', () => {
  it('answers the health endpoint without a token', async () => {
    const base = await start({ EMAIL_WEBHOOK_TOKEN: 'secret' }, async () => ok);
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('relays a valid envelope and answers 2xx (the core reads any 2xx as sent)', async () => {
    const relay = vi.fn(async (_payload: OutboundEmailWebhookPayload) => ok);
    const base = await start({}, relay);
    const response = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PAYLOAD),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'sent', messageId: PAYLOAD.headers.messageId });
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0]![0]).toMatchObject({
      from: 'fable@acme.example.com',
      to: ['dana@partner.example.com'],
      headers: { messageId: '<eml_7bN3xC6vT9pL@acme.example.com>' },
    });
  });

  it('requires the bearer token when one is configured', async () => {
    const relay = vi.fn(async () => ok);
    const base = await start({ EMAIL_WEBHOOK_TOKEN: 'secret' }, relay);
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/`, { method: 'POST', headers, body: JSON.stringify(PAYLOAD) });

    expect((await post({ 'content-type': 'application/json' })).status).toBe(401);
    expect(
      (await post({ 'content-type': 'application/json', authorization: 'Bearer wrong' })).status,
    ).toBe(401);
    expect(relay).not.toHaveBeenCalled();

    const good = await post({ 'content-type': 'application/json', authorization: 'Bearer secret' });
    expect(good.status).toBe(202);
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('accepts unauthenticated posts when no token is configured', async () => {
    const base = await start({}, async () => ok);
    const response = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PAYLOAD),
    });
    expect(response.status).toBe(202);
  });

  it('rejects a malformed or off-contract body with 400', async () => {
    const relay = vi.fn(async () => ok);
    const base = await start({}, relay);
    const bad = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);

    // v3's shape: `to` as a string, no headers object.
    const legacy = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'dana@partner.example.com', subject: 's', text: 't' }),
    });
    expect(legacy.status).toBe(400);
    expect(relay).not.toHaveBeenCalled();
  });

  it('answers 502 when the relay could not deliver — the core records send-failed', async () => {
    const base = await start({}, async () => ({
      sent: false,
      messageId: PAYLOAD.headers.messageId,
      accepted: [],
      rejected: ['dana@partner.example.com'],
      error: 'no MX for partner.example.com',
    }));
    const response = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PAYLOAD),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'relay-error' });
  });

  it('404s anything that is not the webhook or the health endpoint', async () => {
    const base = await start({}, async () => ok);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a body larger than the SMTP size cap', async () => {
    const base = await start({ MAIL_SMTP_MAX_BYTES: '1024' }, async () => ok);
    const response = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...PAYLOAD, text: 'x'.repeat(4096) }),
    });
    expect(response.status).toBe(413);
  });
});
