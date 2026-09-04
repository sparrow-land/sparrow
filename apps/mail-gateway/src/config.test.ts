import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const REQUIRED = {
  MAIL_INBOUND_URL: 'http://api:8722/email/inbound',
  EMAIL_INBOUND_TOKEN: 'inbound-token',
  EMAIL_ORG_SUFFIX: '.example.com',
};

describe('loadConfig', () => {
  it('applies every documented default', () => {
    const config = loadConfig(REQUIRED);
    expect(config).toEqual({
      smtpPort: 2525,
      smtpMaxBytes: 26214400,
      inboundUrl: 'http://api:8722/email/inbound',
      inboundToken: 'inbound-token',
      orgSuffix: '.example.com',
      outboundPort: 2526,
      webhookToken: null,
      dkim: null,
      smarthost: null,
      heloName: hostname(),
    });
  });

  it('reads every knob in the env table', () => {
    const config = loadConfig({
      ...REQUIRED,
      MAIL_SMTP_PORT: '25',
      MAIL_SMTP_MAX_BYTES: '1048576',
      MAIL_OUTBOUND_PORT: '9000',
      EMAIL_WEBHOOK_TOKEN: 'webhook-token',
      MAIL_DKIM_DOMAIN: 'acme.example.com',
      MAIL_DKIM_SELECTOR: 'sparrow',
      MAIL_DKIM_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      MAIL_SMARTHOST_HOST: 'smtp.relay.example',
      MAIL_SMARTHOST_PORT: '587',
      MAIL_SMARTHOST_USER: 'relay-user',
      MAIL_SMARTHOST_PASS: 'relay-pass',
      MAIL_HELO_NAME: 'mail.acme.example.com',
    });
    expect(config.smtpPort).toBe(25);
    expect(config.smtpMaxBytes).toBe(1048576);
    expect(config.outboundPort).toBe(9000);
    expect(config.webhookToken).toBe('webhook-token');
    expect(config.dkim).toEqual({
      domain: 'acme.example.com',
      selector: 'sparrow',
      privateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
    });
    expect(config.smarthost).toEqual({
      host: 'smtp.relay.example',
      port: 587,
      user: 'relay-user',
      pass: 'relay-pass',
    });
    expect(config.heloName).toBe('mail.acme.example.com');
  });

  it('names every missing required var at once', () => {
    expect(() => loadConfig({})).toThrowError(
      /MAIL_INBOUND_URL.*EMAIL_INBOUND_TOKEN.*EMAIL_ORG_SUFFIX/s,
    );
  });

  it('rejects a half-configured DKIM key rather than silently sending unsigned mail', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, MAIL_DKIM_DOMAIN: 'acme.example.com' }),
    ).toThrowError(/MAIL_DKIM_SELECTOR/);
  });

  it('defaults the smarthost port to 25 and its credentials to none', () => {
    const config = loadConfig({ ...REQUIRED, MAIL_SMARTHOST_HOST: 'smtp.relay.example' });
    expect(config.smarthost).toEqual({
      host: 'smtp.relay.example',
      port: 25,
      user: null,
      pass: null,
    });
  });

  it('lower-cases the org suffix and demands it start with a dot or @', () => {
    expect(loadConfig({ ...REQUIRED, EMAIL_ORG_SUFFIX: '.Example.COM' }).orgSuffix).toBe(
      '.example.com',
    );
    expect(() => loadConfig({ ...REQUIRED, EMAIL_ORG_SUFFIX: 'example.com' })).toThrowError(
      /EMAIL_ORG_SUFFIX/,
    );
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => loadConfig({ ...REQUIRED, MAIL_SMTP_PORT: 'abc' })).toThrowError(
      /MAIL_SMTP_PORT/,
    );
    expect(() => loadConfig({ ...REQUIRED, MAIL_OUTBOUND_PORT: '70000' })).toThrowError(
      /MAIL_OUTBOUND_PORT/,
    );
  });
});
