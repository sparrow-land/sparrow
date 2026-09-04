import type { InboundEmailResponse } from '@sparrow/common-types';
import { describe, expect, it } from 'vitest';
import { smtpReplyFor } from './smtp-response.js';

function accepted(status: InboundEmailResponse['status']): InboundEmailResponse {
  return { status, reason: null, email: null, deliveries: [] };
}

/** SPEC.md — apps/mail-gateway, "Response mapping is the whole reliability story". */
describe('smtpReplyFor', () => {
  it('202 with any delivered disposition → 250 OK (custody transferred)', () => {
    for (const status of ['delivered', 'quarantined', 'rejected', 'duplicate'] as const) {
      const reply = smtpReplyFor({ kind: 'ok', status: 202, body: accepted(status) });
      expect(reply.code).toBe(250);
      expect(reply.permanent).toBe(false);
    }
  });

  it('202 unknown-recipient → 550 permanent (no such mailbox here)', () => {
    const reply = smtpReplyFor({ kind: 'ok', status: 202, body: accepted('unknown-recipient') });
    expect(reply.code).toBe(550);
    expect(reply.permanent).toBe(true);
    expect(reply.message).toMatch(/no such/i);
  });

  it('400 malformed → 550 permanent', () => {
    expect(smtpReplyFor({ kind: 'http', status: 400, bodyText: 'bad_request' })).toMatchObject({
      code: 550,
      permanent: true,
    });
  });

  it('401 → 451 temporary (the operator has a misconfiguration to fix)', () => {
    expect(smtpReplyFor({ kind: 'http', status: 401, bodyText: 'unauthorized' })).toMatchObject({
      code: 451,
      permanent: false,
    });
  });

  it('413 → 552 message too large', () => {
    expect(smtpReplyFor({ kind: 'http', status: 413, bodyText: '' })).toMatchObject({
      code: 552,
      permanent: true,
    });
  });

  it('429, 5xx, timeout and connection errors → 451 temporary so the MTA retries', () => {
    expect(smtpReplyFor({ kind: 'http', status: 429, bodyText: '' }).code).toBe(451);
    expect(smtpReplyFor({ kind: 'http', status: 500, bodyText: '' }).code).toBe(451);
    expect(smtpReplyFor({ kind: 'http', status: 503, bodyText: '' }).code).toBe(451);
    expect(smtpReplyFor({ kind: 'timeout' }).code).toBe(451);
    expect(smtpReplyFor({ kind: 'network', error: 'ECONNREFUSED' }).code).toBe(451);
  });

  it('treats an unmapped status as temporary — never lose a message to a guess', () => {
    expect(smtpReplyFor({ kind: 'http', status: 404, bodyText: '' }).code).toBe(451);
    expect(smtpReplyFor({ kind: 'http', status: 418, bodyText: '' }).code).toBe(451);
  });

  it('treats a 202 whose body is not an inbound response as delivered', () => {
    expect(smtpReplyFor({ kind: 'ok', status: 202, body: null }).code).toBe(250);
  });
});
