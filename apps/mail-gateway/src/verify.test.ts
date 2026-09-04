import { describe, expect, it } from 'vitest';
import { toVerification, type AuthenticateLike } from './verify.js';

const FALLBACK = 'partner.example.com';

function results(overrides: AuthenticateLike): AuthenticateLike {
  return overrides;
}

describe('toVerification', () => {
  it('maps a fully authenticated message', () => {
    const { verification, arc } = toVerification(
      results({
        spf: { status: { result: 'pass' }, domain: 'partner.example.com' },
        dkim: { results: [{ status: { result: 'pass', aligned: 'partner.example.com' }, signingDomain: 'partner.example.com' }] },
        dmarc: { status: { result: 'pass' }, domain: 'partner.example.com' },
        arc: { status: { result: 'pass' } },
      }),
      FALLBACK,
    );
    expect(verification).toEqual({
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      domain: 'partner.example.com',
    });
    expect(arc).toBe('pass');
  });

  it('collapses softfail and permerror to fail, and neutral/temperror to none', () => {
    const soft = toVerification(results({ spf: { status: { result: 'softfail' } } }), FALLBACK);
    expect(soft.verification.spf).toBe('fail');
    const perm = toVerification(results({ spf: { status: { result: 'permerror' } } }), FALLBACK);
    expect(perm.verification.spf).toBe('fail');
    const neutral = toVerification(results({ spf: { status: { result: 'neutral' } } }), FALLBACK);
    expect(neutral.verification.spf).toBe('none');
    const temp = toVerification(results({ spf: { status: { result: 'temperror' } } }), FALLBACK);
    expect(temp.verification.spf).toBe('none');
  });

  it('is "none" for every check a message carried nothing for', () => {
    const { verification, arc } = toVerification(results({}), FALLBACK);
    expect(verification).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none', domain: FALLBACK });
    expect(arc).toBe('none');
  });

  it('passes DKIM when any signature verifies, fails only when one failed and none passed', () => {
    const anyPass = toVerification(
      results({
        dkim: {
          results: [
            { status: { result: 'fail' }, signingDomain: 'a.example' },
            { status: { result: 'pass' }, signingDomain: 'b.example' },
          ],
        },
      }),
      FALLBACK,
    );
    expect(anyPass.verification.dkim).toBe('pass');

    const allFail = toVerification(
      results({ dkim: { results: [{ status: { result: 'fail' }, signingDomain: 'a.example' }] } }),
      FALLBACK,
    );
    expect(allFail.verification.dkim).toBe('fail');

    const unsigned = toVerification(results({ dkim: { results: [] } }), FALLBACK);
    expect(unsigned.verification.dkim).toBe('none');
  });

  it('reports the domain the passing mechanism authenticated, DMARC first', () => {
    expect(
      toVerification(
        results({
          spf: { status: { result: 'pass' }, domain: 'bounce.example' },
          dkim: { results: [{ status: { result: 'pass' }, signingDomain: 'dkim.example' }] },
          dmarc: { status: { result: 'pass' }, domain: 'dmarc.example' },
        }),
        FALLBACK,
      ).verification.domain,
    ).toBe('dmarc.example');

    expect(
      toVerification(
        results({
          spf: { status: { result: 'pass' }, domain: 'bounce.example' },
          dkim: { results: [{ status: { result: 'pass' }, signingDomain: 'dkim.example' }] },
          dmarc: { status: { result: 'fail' }, domain: 'dmarc.example' },
        }),
        FALLBACK,
      ).verification.domain,
    ).toBe('dkim.example');

    expect(
      toVerification(
        results({ spf: { status: { result: 'pass' }, domain: 'bounce.example' } }),
        FALLBACK,
      ).verification.domain,
    ).toBe('bounce.example');
  });

  it('lower-cases the domain and falls back when nothing authenticated', () => {
    expect(
      toVerification(
        results({ dmarc: { status: { result: 'pass' }, domain: 'DMARC.Example' } }),
        FALLBACK,
      ).verification.domain,
    ).toBe('dmarc.example');
    expect(
      toVerification(results({ spf: { status: { result: 'fail' } } }), 'Fallback.Example')
        .verification.domain,
    ).toBe('fallback.example');
  });

  it('never emits spam or virus verdicts — the gateway computes none', () => {
    const { verification } = toVerification(results({}), FALLBACK);
    expect(verification).not.toHaveProperty('spam');
    expect(verification).not.toHaveProperty('virus');
  });
});

describe('senderDomain fallback', () => {
  it('is derived from the envelope sender, else the empty string', async () => {
    const { senderDomain } = await import('./verify.js');
    expect(senderDomain('dana@Partner.Example.com')).toBe('partner.example.com');
    expect(senderDomain('')).toBe('');
    expect(senderDomain('postmaster')).toBe('');
  });
});
