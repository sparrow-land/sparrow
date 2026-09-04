import { InboundEmailPayloadSchema, type EmailVerification } from '@sparrow/common-types';
import { describe, expect, it } from 'vitest';
import { readFixture } from './fixtures/load.js';
import { parseInboundEmail } from './parse.js';

const PASS: EmailVerification = {
  spf: 'pass',
  dkim: 'pass',
  dmarc: 'pass',
  domain: 'partner.example.com',
};

/** Every fixture must produce a payload the core's own schema accepts. */
async function parseFixture(name: string, verification: EmailVerification = PASS) {
  const parsed = await parseInboundEmail(readFixture(name), { verification });
  expect(() => InboundEmailPayloadSchema.parse(parsed.payload)).not.toThrow();
  return parsed;
}

describe('parseInboundEmail — plain text', () => {
  it('normalizes headers, parties and body', async () => {
    const { payload, stats } = await parseFixture('plain.eml');
    expect(payload.rfcMessageId).toBe('<CAF7dana.q3.rollout@mail.partner.example.com>');
    expect(payload.from).toEqual({ email: 'dana@partner.example.com', name: 'Dana Lee' });
    expect(payload.to).toEqual([
      { email: 'fable@acme.example.com', name: 'fable' },
      { email: 'ops@acme.example.com', name: 'Ops Team' },
    ]);
    expect(payload.cc).toEqual([{ email: 'sam@partner.example.com', name: 'Sam Ortiz' }]);
    expect(payload.subject).toBe('Q3 rollout');
    expect(payload.text).toContain('Can you confirm the Q3 rollout dates?');
    expect(payload.html).toBeNull();
    expect(payload.attachments).toEqual([]);
    expect(payload.inReplyTo).toBeNull();
    expect(payload.references).toEqual([]);
    expect(payload.date).toBe('2026-08-31T12:03:58.000Z');
    expect(payload.verification).toEqual(PASS);
    expect(payload.envelope).toBeNull();
    expect(stats.malformed).toBe(false);
    expect(stats.rawBytes).toBe(readFixture('plain.eml').byteLength);
    expect(stats.textBytes).toBe(Buffer.byteLength(payload.text));
    expect(stats.htmlBytes).toBe(0);
    expect(stats.attachmentBytes).toBe(0);
  });

  it('never emits a bcc key', async () => {
    const { payload } = await parseFixture('plain.eml');
    expect(Object.keys(payload)).not.toContain('bcc');
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('bcc');
  });

  it(`merges the caller's verification verdicts verbatim, including scans`, async () => {
    const verification: EmailVerification = {
      spf: 'fail',
      dkim: 'none',
      dmarc: 'fail',
      spam: 'fail',
      virus: 'pass',
      domain: 'spam.example.org',
    };
    const { payload } = await parseFixture('plain.eml', verification);
    expect(payload.verification).toEqual(verification);
  });

  it('omits absent scan verdicts rather than sending undefined', async () => {
    const { payload } = await parseFixture('plain.eml');
    const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(Object.keys(wire.verification as object).sort()).toEqual([
      'dkim',
      'dmarc',
      'domain',
      'spf',
    ]);
  });

  it('carries the envelope through when the edge supplies one', async () => {
    const { payload } = await parseInboundEmail(readFixture('plain.eml'), {
      verification: PASS,
      envelope: { mailFrom: 'bounces@partner.example.com', rcptTo: ['fable@acme.example.com'] },
    });
    expect(payload.envelope).toEqual({
      mailFrom: 'bounces@partner.example.com',
      rcptTo: ['fable@acme.example.com'],
    });
  });
});

describe('parseInboundEmail — multipart/alternative', () => {
  it('prefers the text/plain part and passes html through raw', async () => {
    const { payload, stats } = await parseFixture('multipart-alternative.eml');
    expect(payload.text.trim()).toBe('The dates work for us — locking them in.');
    expect(payload.html).toContain('<b>locking them in</b>');
    // Sanitization is the server's job: the edge must not strip anything.
    expect(payload.html).toContain('<script>alert(1)</script>');
    expect(stats.htmlBytes).toBe(Buffer.byteLength(payload.html ?? ''));
    expect(stats.partCount).toBe(2);
  });

  it('extracts threading identity, unfolding the References header', async () => {
    const { payload } = await parseFixture('multipart-alternative.eml');
    expect(payload.inReplyTo).toBe('<eml_a1b2c3d4e5f6@acme.example.com>');
    expect(payload.references).toEqual([
      '<eml_root0000@acme.example.com>',
      '<eml_a1b2c3d4e5f6@acme.example.com>',
    ]);
  });

  it('lower-cases the domain of an address and keeps the display name', async () => {
    const { payload } = await parseFixture('multipart-alternative.eml');
    expect(payload.from).toEqual({ email: 'dana@partner.example.com', name: 'Lee, Dana' });
  });
});

describe('parseInboundEmail — html only', () => {
  it('derives the required text body from the html', async () => {
    const { payload } = await parseFixture('html-only.eml');
    expect(payload.html).toContain('<h1>Weekly digest</h1>');
    expect(payload.text).toContain('WEEKLY DIGEST');
    expect(payload.text).toContain('Three things happened this week & one of them mattered.');
    // List items become bullets; a &nbsp; stays a non-breaking space.
    expect(payload.text).toContain(`* Ship\u00a0date moved`);
    expect(payload.text).toContain('See you\nMonday — the team');
    // Markup, script and style never survive into the text body.
    expect(payload.text).not.toContain('<');
    expect(payload.text).not.toContain('tracker()');
    expect(payload.text).not.toContain('color:#333');
  });
});

describe('parseInboundEmail — attachments', () => {
  it('base64-encodes every attachment with its metadata', async () => {
    const { payload, stats } = await parseFixture('attachment.eml');
    expect(payload.attachments).toHaveLength(3);
    const [pdf, png, unnamed] = payload.attachments;
    expect(pdf).toMatchObject({ filename: 'plan.pdf', contentType: 'application/pdf' });
    expect(Buffer.from(pdf!.dataBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect(png).toMatchObject({ filename: 'logo.png', contentType: 'image/png' });
    expect(Buffer.from(png!.dataBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    // An attachment with no filename gets a deterministic, positional one.
    expect(unnamed!.filename).toBe('attachment-3.txt');
    expect(stats.attachmentCount).toBe(3);
    expect(stats.attachmentBytes).toBeGreaterThan(0);
  });

  it('keeps the body parts alongside the attachments', async () => {
    const { payload } = await parseFixture('attachment.eml');
    expect(payload.text.trim()).toBe('Plan attached. Logo inline.');
    expect(payload.html).toContain('cid:logo-1');
  });

  it(`truncates to the core's attachment cap and says so`, async () => {
    const raw = buildMessage({
      headers: ['Message-ID: <many@x.example>', 'From: a@x.example', 'To: fable@acme.example.com'],
      attachments: 11,
    });
    const { payload, stats } = await parseInboundEmail(raw, { verification: PASS });
    expect(payload.attachments).toHaveLength(8);
    expect(stats.attachmentsDropped).toBe(3);
    expect(() => InboundEmailPayloadSchema.parse(payload)).not.toThrow();
  });
});

describe('parseInboundEmail — malformed input', () => {
  it('yields an empty text body and a part count instead of throwing', async () => {
    const { payload, stats } = await parseFixture('malformed.eml');
    expect(payload.text).toBe('');
    expect(payload.html).toBeNull();
    expect(payload.subject).toBe('broken tree');
    expect(payload.from.email).toBe('chaos@spam.example.org');
    expect(payload.date).toBeNull();
    expect(stats.malformed).toBe(true);
    expect(stats.partCount).toBe(0);
    expect(stats.warnings).toContain('no-body-part');
  });

  it('survives bytes that are not a message at all', async () => {
    const { payload, stats } = await parseInboundEmail(readFixture('garbage.eml'), {
      verification: PASS,
      envelope: { mailFrom: 'chaos@spam.example.org', rcptTo: ['fable@acme.example.com'] },
    });
    expect(() => InboundEmailPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.from.email).toBe('chaos@spam.example.org');
    expect(payload.to).toEqual([{ email: 'fable@acme.example.com', name: null }]);
    expect(payload.subject).toBe('');
    expect(stats.malformed).toBe(true);
  });

  it('falls back to sentinels when even the envelope is missing', async () => {
    const { payload } = await parseInboundEmail(readFixture('garbage.eml'), {
      verification: PASS,
    });
    expect(payload.from.email).toBe('unknown@sender.invalid');
    expect(payload.to).toEqual([{ email: 'undisclosed-recipients@unknown.invalid', name: null }]);
    expect(() => InboundEmailPayloadSchema.parse(payload)).not.toThrow();
  });
});

describe('parseInboundEmail — weird encodings', () => {
  it('decodes RFC 2047 words and non-utf8 charsets', async () => {
    const { payload } = await parseFixture('encodings.eml');
    expect(payload.subject).toBe('Grüße — 予定 confirmed');
    expect(payload.from).toEqual({ email: 'bjorn@post.example.se', name: 'Björn Ekström' });
    expect(payload.to[0]!.name).toBe('fable (エージェント)');
    expect(payload.text).toContain('Björn skickar hälsningar.');
    expect(payload.text).toContain('Pris: 45 kr.');
    expect(payload.date).toBe('2026-08-31T06:15:00.000Z');
  });
});

describe('parseInboundEmail — missing headers', () => {
  it('synthesizes a stable Message-ID and drops the Bcc header', async () => {
    const { payload, stats } = await parseInboundEmail(readFixture('no-message-id.eml'), {
      verification: PASS,
      envelope: { mailFrom: 'alerts@monitor.example.io', rcptTo: ['fable@acme.example.com'] },
    });
    expect(payload.rfcMessageId).toMatch(/^<mp\.[0-9a-f]{40}@mail-parse\.invalid>$/);
    expect(stats.warnings).toContain('synthesized-message-id');
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('bcc');
    expect(payload.to).toEqual([{ email: 'fable@acme.example.com', name: null }]);
    expect(stats.warnings).toContain('recipients-from-envelope');
  });

  it('synthesizes the same id for the same bytes and a different one otherwise', async () => {
    const a = await parseInboundEmail(readFixture('no-message-id.eml'), { verification: PASS });
    const b = await parseInboundEmail(readFixture('no-message-id.eml'), { verification: PASS });
    const c = await parseInboundEmail(readFixture('garbage.eml'), { verification: PASS });
    expect(a.payload.rfcMessageId).toBe(b.payload.rfcMessageId);
    expect(a.payload.rfcMessageId).not.toBe(c.payload.rfcMessageId);
  });
});

describe('parseInboundEmail — caps and determinism', () => {
  it('trims and truncates an over-long subject to the RFC line limit', async () => {
    const raw = buildMessage({
      headers: [
        'Message-ID: <long@x.example>',
        'From: a@x.example',
        'To: fable@acme.example.com',
        `Subject: ${'x'.repeat(1200)}`,
      ],
      body: 'body',
    });
    const { payload, stats } = await parseInboundEmail(raw, { verification: PASS });
    expect(payload.subject).toHaveLength(998);
    expect(stats.subjectTruncated).toBe(true);
    expect(() => InboundEmailPayloadSchema.parse(payload)).not.toThrow();
  });

  it('is byte-identical across repeated parses of every fixture', async () => {
    for (const name of [
      'plain.eml',
      'multipart-alternative.eml',
      'html-only.eml',
      'attachment.eml',
      'malformed.eml',
      'encodings.eml',
      'no-message-id.eml',
      'garbage.eml',
    ]) {
      const first = await parseInboundEmail(readFixture(name), { verification: PASS });
      const second = await parseInboundEmail(readFixture(name), { verification: PASS });
      expect(JSON.stringify(second.payload)).toBe(JSON.stringify(first.payload));
    }
  });

  it('accepts a string as well as a Buffer', async () => {
    const buf = readFixture('plain.eml');
    const fromString = await parseInboundEmail(buf.toString('utf8'), { verification: PASS });
    const fromBuffer = await parseInboundEmail(buf, { verification: PASS });
    expect(JSON.stringify(fromString.payload)).toBe(JSON.stringify(fromBuffer.payload));
  });
});

/** Build a small raw message without hand-writing another fixture file. */
function buildMessage(opts: {
  headers: string[];
  body?: string;
  attachments?: number;
}): Buffer {
  const { headers, body = 'hello', attachments = 0 } = opts;
  if (attachments === 0) {
    return Buffer.from(
      [...headers, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'),
      'utf8',
    );
  }
  const parts: string[] = [
    ...headers,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="=_b"',
    '',
    '--=_b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ];
  for (let i = 0; i < attachments; i += 1) {
    parts.push(
      '--=_b',
      `Content-Type: application/octet-stream; name="f${i}.bin"`,
      `Content-Disposition: attachment; filename="f${i}.bin"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(`payload ${i}`).toString('base64'),
      '',
    );
  }
  parts.push('--=_b--', '');
  return Buffer.from(parts.join('\r\n'), 'utf8');
}
