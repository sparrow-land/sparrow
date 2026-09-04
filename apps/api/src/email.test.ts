import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sendEmail } from './email.js';

/**
 * A throwaway HTTP server standing in for the outbound-email webhook. Records
 * the last request it saw and answers with a configurable status so the tests
 * can exercise the 2xx / non-2xx / network branches against a real fetch.
 */
interface StubServer {
  url: string;
  close(): Promise<void>;
  received: {
    method?: string;
    authorization?: string;
    contentType?: string;
    body?: any;
  };
}

async function startStub(status = 200): Promise<StubServer> {
  const received: StubServer['received'] = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.method = req.method;
      received.authorization = req.headers['authorization'];
      received.contentType = req.headers['content-type'];
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        received.body = raw ? JSON.parse(raw) : undefined;
      } catch {
        received.body = raw;
      }
      res.statusCode = status;
      res.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('sendEmail — the v4 outbound webhook envelope', () => {
  let stub: StubServer | undefined;
  beforeEach(() => {
    stub = undefined;
  });
  afterEach(async () => {
    if (stub) await stub.close();
  });

  it('posts the v4 envelope (array `to` + `headers`) with a bearer token, sent on 2xx', async () => {
    stub = await startStub(202);
    const result = await sendEmail(
      { webhookUrl: stub.url, webhookToken: 'secret-token' },
      {
        from: 'fable@acme.example.com',
        to: ['dana@partner.example.com'],
        cc: [],
        subject: 'Re: Q3 rollout',
        text: 'plain body',
        html: '<p>html body</p>',
        headers: {
          messageId: '<eml_7bN3xC6vT9pL@acme.example.com>',
          inReplyTo: '<CAF7@mail.example.net>',
          references: '<CAF7@mail.example.net>',
        },
      },
    );
    expect(result).toEqual({ sent: true });
    expect(stub.received.method).toBe('POST');
    expect(stub.received.authorization).toBe('Bearer secret-token');
    expect(stub.received.contentType).toContain('application/json');
    expect(stub.received.body).toEqual({
      from: 'fable@acme.example.com',
      to: ['dana@partner.example.com'],
      cc: [],
      subject: 'Re: Q3 rollout',
      text: 'plain body',
      html: '<p>html body</p>',
      headers: {
        messageId: '<eml_7bN3xC6vT9pL@acme.example.com>',
        inReplyTo: '<CAF7@mail.example.net>',
        references: '<CAF7@mail.example.net>',
      },
    });
  });

  it('omits the optional keys from the payload when not provided', async () => {
    stub = await startStub(200);
    const result = await sendEmail(
      { webhookUrl: stub.url, webhookToken: 't' },
      {
        from: 'fable@acme.example.com',
        to: ['a@b.com'],
        subject: 'S',
        text: 'T',
        headers: { messageId: '<eml_1@acme.example.com>' },
      },
    );
    expect(result).toEqual({ sent: true });
    expect(stub.received.body).toEqual({
      from: 'fable@acme.example.com',
      to: ['a@b.com'],
      subject: 'S',
      text: 'T',
      headers: { messageId: '<eml_1@acme.example.com>' },
    });
    expect('html' in (stub.received.body as object)).toBe(false);
    expect('cc' in (stub.received.body as object)).toBe(false);
    expect('attachments' in (stub.received.body as object)).toBe(false);
  });

  it('reports not-sent on a non-2xx response (never throws)', async () => {
    stub = await startStub(500);
    const result = await sendEmail({ webhookUrl: stub.url, webhookToken: 't' }, minimal());
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBeTruthy();
  });

  it('reports not-sent on a network error (never throws)', async () => {
    // Nothing is listening on this port → fetch rejects; must be swallowed.
    const result = await sendEmail(
      { webhookUrl: 'http://127.0.0.1:1/hook', webhookToken: 't' },
      minimal(),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBeTruthy();
  });

  it('reports not-sent (unconfigured) when no webhook URL is set — no request attempted', async () => {
    const result = await sendEmail({ webhookUrl: '', webhookToken: '' }, minimal());
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBeTruthy();
  });
});

/** The smallest valid v4 envelope. */
function minimal() {
  return {
    from: 'fable@acme.example.com',
    to: ['a@b.com'],
    subject: 'S',
    text: 'T',
    headers: { messageId: '<eml_1@acme.example.com>' },
  };
}
