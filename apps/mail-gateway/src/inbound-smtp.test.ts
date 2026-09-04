import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InboundEmailPayload, InboundEmailResponse } from '@sparrow/common-types';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createInboundSmtpServer, type InboundSmtpServer } from './inbound-smtp.js';
import { silentLogger } from './log.js';
import type { Verifier } from './verify.js';

/** A stub of the core's `POST /email/inbound`. */
interface StubCore {
  url: string;
  requests: Array<{ authorization: string | undefined; payload: InboundEmailPayload }>;
  reply: { status: number; body: unknown };
  close(): Promise<void>;
}

async function startStubCore(): Promise<StubCore> {
  const stub: Partial<StubCore> & { requests: StubCore['requests']; reply: StubCore['reply'] } = {
    requests: [],
    reply: {
      status: 202,
      body: {
        status: 'delivered',
        reason: null,
        email: { id: 'eml_1', threadId: 'eth_1' },
        deliveries: [],
      } satisfies InboundEmailResponse,
    },
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      stub.requests.push({
        authorization: req.headers.authorization,
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as InboundEmailPayload,
      });
      res.writeHead(stub.reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stub.reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/email/inbound`,
    requests: stub.requests,
    get reply() {
      return stub.reply;
    },
    set reply(value: { status: number; body: unknown }) {
      stub.reply = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** SPF/DKIM/DMARC are the caller's job; the pipeline is what we are testing. */
const verifyPass: Verifier = async () => ({
  verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'partner.example.com' },
  arc: 'none',
});

let core: StubCore;
let gateway: InboundSmtpServer;
let smtpPort: number;

async function startGateway(env: Record<string, string> = {}, verify: Verifier = verifyPass) {
  gateway = createInboundSmtpServer({
    config: loadConfig({
      MAIL_INBOUND_URL: core.url,
      EMAIL_INBOUND_TOKEN: 'inbound-token',
      EMAIL_ORG_SUFFIX: '.example.com',
      ...env,
    }),
    verify,

    logger: silentLogger,
  });
  smtpPort = await gateway.listen(0);
}

interface SmtpError extends Error {
  responseCode?: number;
}

async function send(message: nodemailer.SendMailOptions): Promise<void> {
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: smtpPort,
    secure: false,
    ignoreTLS: true,
  });
  try {
    await transport.sendMail(message);
  } finally {
    transport.close();
  }
}

beforeEach(async () => {
  core = await startStubCore();
});

afterEach(async () => {
  await gateway?.close();
  await core.close();
});

describe('SMTP in → POST /email/inbound', () => {
  it('normalizes the message and posts it with the bearer token', async () => {
    await startGateway();
    await send({
      envelope: { from: 'bounces@partner.example.com', to: ['fable@acme.example.com'] },
      from: 'Dana Lee <dana@partner.example.com>',
      to: 'fable@acme.example.com',
      subject: 'Q3 rollout',
      text: 'Can you confirm the dates?',
      messageId: '<CAF7dana@mail.partner.example.com>',
    });

    expect(core.requests).toHaveLength(1);
    const { authorization, payload } = core.requests[0]!;
    expect(authorization).toBe('Bearer inbound-token');
    expect(payload.rfcMessageId).toBe('<CAF7dana@mail.partner.example.com>');
    expect(payload.from).toEqual({ email: 'dana@partner.example.com', name: 'Dana Lee' });
    expect(payload.to).toEqual([{ email: 'fable@acme.example.com', name: null }]);
    expect(payload.subject).toBe('Q3 rollout');
    expect(payload.text).toContain('Can you confirm the dates?');
    expect(payload.verification).toEqual({
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      domain: 'partner.example.com',
    });
    expect(payload.envelope).toEqual({
      mailFrom: 'bounces@partner.example.com',
      rcptTo: ['fable@acme.example.com'],
    });
    expect(payload).not.toHaveProperty('bcc');
  });

  it('carries attachments through as base64', async () => {
    await startGateway();
    await send({
      from: 'dana@partner.example.com',
      to: 'fable@acme.example.com',
      subject: 'Plan attached',
      text: 'see attached',
      attachments: [{ filename: 'plan.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') }],
    });
    const [attachment] = core.requests[0]!.payload.attachments;
    expect(attachment).toMatchObject({ filename: 'plan.pdf', contentType: 'application/pdf' });
    expect(Buffer.from(attachment!.dataBase64, 'base64').toString()).toBe('%PDF-1.4');
  });

  it('lists every envelope recipient in one post', async () => {
    await startGateway();
    await send({
      envelope: {
        from: 'dana@partner.example.com',
        to: ['fable@acme.example.com', 'scribe@acme.example.com'],
      },
      from: 'dana@partner.example.com',
      to: 'fable@acme.example.com, scribe@acme.example.com',
      subject: 'both',
      text: 'hello',
    });
    expect(core.requests).toHaveLength(1);
    expect(core.requests[0]!.payload.envelope?.rcptTo).toEqual([
      'fable@acme.example.com',
      'scribe@acme.example.com',
    ]);
  });

  it('rejects RCPT outside EMAIL_ORG_SUFFIX at SMTP time — never an open relay', async () => {
    await startGateway();
    const error = await send({
      from: 'dana@partner.example.com',
      to: 'someone@elsewhere.example',
      subject: 'relay me',
      text: 'nope',
    }).catch((err: SmtpError) => err);
    expect((error as SmtpError).responseCode).toBe(550);
    expect(core.requests).toHaveLength(0);
  });
});

describe('the response mapping, end to end', () => {
  const message: nodemailer.SendMailOptions = {
    from: 'dana@partner.example.com',
    to: 'fable@acme.example.com',
    subject: 'mapping',
    text: 'body',
  };

  async function sendExpectingFailure(): Promise<SmtpError> {
    await startGateway();
    const error = await send(message).catch((err: SmtpError) => err);
    expect(error).toBeInstanceOf(Error);
    return error as SmtpError;
  }

  it('202 unknown-recipient → 550', async () => {
    core.reply = {
      status: 202,
      body: { status: 'unknown-recipient', reason: null, email: null, deliveries: [] },
    };
    const error = await sendExpectingFailure();
    expect(error.responseCode).toBe(550);
  });

  it('400 → 550', async () => {
    core.reply = { status: 400, body: { error: 'bad_request' } };
    const error = await sendExpectingFailure();
    expect(error.responseCode).toBe(550);
  });

  it('401 → 451', async () => {
    core.reply = { status: 401, body: { error: 'unauthorized' } };
    const error = await sendExpectingFailure();
    expect(error.responseCode).toBe(451);
  });

  it('413 → 552', async () => {
    core.reply = { status: 413, body: { error: 'payload_too_large' } };
    const error = await sendExpectingFailure();
    expect(error.responseCode).toBe(552);
  });

  it('429 → 451', async () => {
    core.reply = { status: 429, body: { error: 'rate_limited' } };
    const error = await sendExpectingFailure();
    expect(error.responseCode).toBe(451);
  });

  it('5xx → 451', async () => {
    core.reply = { status: 500, body: { error: 'internal' } };
    const error = await sendExpectingFailure();
    expect(error.responseCode).toBe(451);
  });

  it('a core that is down → 451, so the sending MTA retries', async () => {
    const url = core.url;
    await core.close();
    gateway = createInboundSmtpServer({
      config: loadConfig({
        MAIL_INBOUND_URL: url,
        EMAIL_INBOUND_TOKEN: 'inbound-token',
        EMAIL_ORG_SUFFIX: '.example.com',
      }),
      verify: verifyPass,
      logger: silentLogger,
    });
    smtpPort = await gateway.listen(0);
    const error = (await send(message).catch((err: SmtpError) => err)) as SmtpError;
    expect(error.responseCode).toBe(451);
    core = await startStubCore(); // afterEach closes it
  });

  it('a message over MAIL_SMTP_MAX_BYTES is refused as too large', async () => {
    await startGateway({ MAIL_SMTP_MAX_BYTES: '2048' });
    const error = (await send({ ...message, text: 'x'.repeat(20000) }).catch(
      (err: SmtpError) => err,
    )) as SmtpError;
    expect(error).toBeInstanceOf(Error);
    expect(error.responseCode === 552 || /size/i.test(error.message)).toBe(true);
    expect(core.requests).toHaveLength(0);
  });
});
