import type { OutboundEmailWebhookPayload } from '@sparrow/common-types';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type GatewayConfig } from './config.js';
import {
  buildMailOptions,
  createRelay,
  type MailOptions,
  type SentMessage,
  type Transport,
  type TransportOptions,
} from './relay.js';

const BASE_ENV = {
  MAIL_INBOUND_URL: 'http://api:8722/email/inbound',
  EMAIL_INBOUND_TOKEN: 'inbound-token',
  EMAIL_ORG_SUFFIX: '.example.com',
};

const PAYLOAD: OutboundEmailWebhookPayload = {
  from: 'fable@acme.example.com',
  to: ['dana@partner.example.com'],
  cc: [],
  bcc: [],
  subject: 'Re: Q3 rollout',
  text: 'Confirmed.',
  html: null,
  headers: {
    messageId: '<eml_7bN3xC6vT9pL@acme.example.com>',
    inReplyTo: '<CAF7dana@mail.partner.example.com>',
    references: '<eml_root@acme.example.com> <CAF7dana@mail.partner.example.com>',
  },
};

function config(env: Record<string, string> = {}): GatewayConfig {
  return loadConfig({ ...BASE_ENV, ...env });
}

function fakeTransport(result?: Partial<SentMessage>) {
  const sendMail = vi.fn(async (_options: MailOptions) => ({
    messageId: PAYLOAD.headers.messageId,
    accepted: [...PAYLOAD.to],
    rejected: [],
    ...result,
  }));
  return { sendMail } satisfies Transport;
}

describe('buildMailOptions', () => {
  it('passes the threading identity through verbatim — the gateway never mints one', () => {
    const options = buildMailOptions(PAYLOAD);
    expect(options.messageId).toBe('<eml_7bN3xC6vT9pL@acme.example.com>');
    expect(options.inReplyTo).toBe('<CAF7dana@mail.partner.example.com>');
    expect(options.references).toBe(
      '<eml_root@acme.example.com> <CAF7dana@mail.partner.example.com>',
    );
  });

  it('marks the mail auto-generated', () => {
    expect(buildMailOptions(PAYLOAD).headers).toEqual({
      'Auto-Submitted': 'auto-generated',
    });
  });

  it('carries envelope, subject and bodies', () => {
    const options = buildMailOptions({ ...PAYLOAD, cc: ['sam@partner.example.com'], html: '<p>Confirmed.</p>' });
    expect(options.from).toBe('fable@acme.example.com');
    expect(options.to).toEqual(['dana@partner.example.com']);
    expect(options.cc).toEqual(['sam@partner.example.com']);
    expect(options.subject).toBe('Re: Q3 rollout');
    expect(options.text).toBe('Confirmed.');
    expect(options.html).toBe('<p>Confirmed.</p>');
  });

  it('omits optional fields the core did not send', () => {
    const options = buildMailOptions({
      from: 'a@acme.example.com',
      to: ['b@x.example'],
      subject: 's',
      text: 't',
      headers: { messageId: '<m@acme.example.com>' },
    });
    expect(options).not.toHaveProperty('html');
    expect(options).not.toHaveProperty('cc');
    expect(options).not.toHaveProperty('bcc');
    expect(options).not.toHaveProperty('inReplyTo');
    expect(options).not.toHaveProperty('references');
    expect(options).not.toHaveProperty('attachments');
  });

  it('decodes attachments back to bytes', () => {
    const options = buildMailOptions({
      ...PAYLOAD,
      attachments: [
        {
          filename: 'plan.pdf',
          contentType: 'application/pdf',
          dataBase64: Buffer.from('%PDF-1.4').toString('base64'),
        },
      ],
    });
    expect(options.attachments).toHaveLength(1);
    const [attachment] = options.attachments ?? [];
    expect(attachment).toMatchObject({ filename: 'plan.pdf', contentType: 'application/pdf' });
    expect((attachment?.content as Buffer).toString()).toBe('%PDF-1.4');
  });
});

describe('createRelay — smarthost', () => {
  it('submits everything through the configured smarthost with its credentials', async () => {
    const transport = fakeTransport();
    const createTransport = vi.fn((_options: TransportOptions) => transport);
    const relay = createRelay(
      config({
        MAIL_SMARTHOST_HOST: 'smtp.relay.example',
        MAIL_SMARTHOST_PORT: '587',
        MAIL_SMARTHOST_USER: 'u',
        MAIL_SMARTHOST_PASS: 'p',
        MAIL_HELO_NAME: 'mail.acme.example.com',
      }),
      { createTransport, resolveMx: async () => ['should-not-be-called'] },
    );

    const result = await relay({ ...PAYLOAD, cc: ['sam@other.example'] });
    expect(result.sent).toBe(true);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0]![0]).toMatchObject({
      host: 'smtp.relay.example',
      port: 587,
      auth: { user: 'u', pass: 'p' },
      name: 'mail.acme.example.com',
    });
    // One submission covers every recipient domain.
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  it('signs with DKIM when signing material is configured', async () => {
    const createTransport = vi.fn((_options: TransportOptions) => fakeTransport());
    const relay = createRelay(
      config({
        MAIL_SMARTHOST_HOST: 'smtp.relay.example',
        MAIL_DKIM_DOMAIN: 'acme.example.com',
        MAIL_DKIM_SELECTOR: 'sparrow',
        MAIL_DKIM_PRIVATE_KEY: 'PRIVATE',
      }),
      { createTransport, resolveMx: async () => [] },
    );
    await relay(PAYLOAD);
    expect(createTransport.mock.calls[0]![0]).toMatchObject({
      dkim: { domainName: 'acme.example.com', keySelector: 'sparrow', privateKey: 'PRIVATE' },
    });
  });

  it('sends unsigned when no DKIM material is configured', async () => {
    const createTransport = vi.fn((_options: TransportOptions) => fakeTransport());
    const relay = createRelay(config({ MAIL_SMARTHOST_HOST: 'smtp.relay.example' }), {
      createTransport,
      resolveMx: async () => [],
    });
    await relay(PAYLOAD);
    expect(createTransport.mock.calls[0]![0]).not.toHaveProperty('dkim');
  });

  it('reports a relay failure instead of throwing', async () => {
    const transport: Transport = {
      sendMail: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    const relay = createRelay(config({ MAIL_SMARTHOST_HOST: 'smtp.relay.example' }), {
      createTransport: () => transport,
      resolveMx: async () => [],
    });
    const result = await relay(PAYLOAD);
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/connection refused/);
  });
});

describe('createRelay — direct to MX', () => {
  it('resolves one MX per recipient domain and submits to each', async () => {
    const transport = fakeTransport();
    const createTransport = vi.fn((_options: TransportOptions) => transport);
    const resolveMx = vi.fn(async (domain: string) => [`mx1.${domain}`, `mx2.${domain}`]);
    const relay = createRelay(config(), { createTransport, resolveMx });

    const result = await relay({
      ...PAYLOAD,
      to: ['dana@partner.example.com', 'other@partner.example.com'],
      cc: ['sam@third.example'],
    });

    expect(result.sent).toBe(true);
    expect(resolveMx.mock.calls.map((call) => call[0]).sort()).toEqual([
      'partner.example.com',
      'third.example',
    ]);
    // One transport and one submission per destination domain, port 25.
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(createTransport.mock.calls[0]![0]).toMatchObject({ port: 25 });
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    const envelopes = transport.sendMail.mock.calls.map((call) => call[0].envelope);
    expect(envelopes).toContainEqual({
      from: 'fable@acme.example.com',
      to: ['dana@partner.example.com', 'other@partner.example.com'],
    });
    expect(envelopes).toContainEqual({
      from: 'fable@acme.example.com',
      to: ['sam@third.example'],
    });
  });

  it('fails the whole send when a domain has no MX', async () => {
    const relay = createRelay(config(), {
      createTransport: () => fakeTransport(),
      resolveMx: async () => [],
    });
    const result = await relay(PAYLOAD);
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/partner\.example\.com/);
  });

  it('fails the whole send when one destination rejects', async () => {
    const relay = createRelay(config(), {
      createTransport: (options: { host?: string }) =>
        options.host === 'mx1.bad.example'
          ? { sendMail: async () => { throw new Error('550 blocked'); } }
          : fakeTransport(),
      resolveMx: async (domain: string) => [`mx1.${domain}`],
    });
    const result = await relay({ ...PAYLOAD, to: ['ok@good.example', 'no@bad.example'] });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/550 blocked/);
  });

  it('rejects a payload with no recipients at all', async () => {
    const relay = createRelay(config(), {
      createTransport: () => fakeTransport(),
      resolveMx: async () => ['mx1.x.example'],
    });
    const result = await relay({ ...PAYLOAD, to: [], cc: [], bcc: [] });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/recipient/i);
  });
});
