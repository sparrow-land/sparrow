/**
 * The trust engine (SPEC v4 "The email medium → The trust engine"). Pure and
 * deterministic: same inputs, same disposition. Every email crosses the boundary
 * exactly once, and this module is the crossing.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyInbound,
  classifyOutbound,
  isAuthenticated,
  matchesTrustedPattern,
  recognized,
  type TrustSet,
} from './trust.js';
import type { EmailVerification } from '@sparrow/common-types';

const pass: EmailVerification = { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'partner.example.com' };

function set(overrides: Partial<TrustSet> = {}): TrustSet {
  return {
    threadTrusted: false,
    humanEmails: new Set(['jake@acme.test']),
    agentAddresses: new Set(['fable@acme.example.com']),
    contacts: new Map(),
    trustedPatterns: [],
    ...overrides,
  };
}

describe('globs', () => {
  it('`*` matches any run, `?` matches one, case-insensitively over the whole address', () => {
    expect(matchesTrustedPattern('*@partner.example.com', 'Dana@Partner.Example.Com')).toBe(true);
    expect(matchesTrustedPattern('*@partner.example.com', 'dana@other.example.com')).toBe(false);
    expect(matchesTrustedPattern('dana?@partner.example.com', 'dana1@partner.example.com')).toBe(true);
    expect(matchesTrustedPattern('dana?@partner.example.com', 'dana@partner.example.com')).toBe(false);
    // No regex, no anchoring characters: the pattern is matched WHOLE.
    expect(matchesTrustedPattern('dana@partner.example.com', 'xdana@partner.example.comx')).toBe(false);
    expect(matchesTrustedPattern('d.a+n@partner.example.com', 'd.a+n@partner.example.com')).toBe(true);
  });
});

describe('the trust set', () => {
  it('rung 1 — an org human’s account email is recognized (membership is the grant)', () => {
    expect(recognized('JAKE@acme.test', set())).toBe(true);
  });

  it('rung 2 — an org agent’s own address is recognized (siblings)', () => {
    expect(recognized('fable@acme.example.com', set())).toBe(true);
  });

  it('rung 3 — an approved contact is recognized; an unknown one is not', () => {
    const contacts = new Map([['dana@partner.example.com', 'approved' as const]]);
    expect(recognized('dana@partner.example.com', set({ contacts }))).toBe(true);
    expect(recognized('stranger@partner.example.com', set({ contacts }))).toBe(false);
  });

  it('rung 4 — a trustedPatterns glob is recognized', () => {
    expect(recognized('anyone@partner.example.com', set({ trustedPatterns: ['*@partner.example.com'] }))).toBe(true);
  });

  it('rung 0 — a trusted thread recognizes anyone on it', () => {
    expect(recognized('stranger@nowhere.test', set({ threadTrusted: true }))).toBe(true);
  });

  it('a blocked contact is NEVER recognized — it short-circuits every rung, thread trust included', () => {
    const contacts = new Map([['jake@acme.test', 'blocked' as const]]);
    expect(
      recognized('jake@acme.test', set({ contacts, threadTrusted: true, trustedPatterns: ['*@acme.test'] })),
    ).toBe(false);
  });
});

describe('authentication (inbound step 4)', () => {
  it('dmarc pass authenticates', () => {
    expect(isAuthenticated('dana@partner.example.com', pass)).toBe(true);
  });

  it('dmarc none + a passing spf/dkim authenticates ONLY when the domain matches From', () => {
    const v: EmailVerification = { spf: 'pass', dkim: 'none', dmarc: 'none', domain: 'partner.example.com' };
    expect(isAuthenticated('dana@partner.example.com', v)).toBe(true);
    expect(isAuthenticated('dana@other.example.com', v)).toBe(false);
    expect(
      isAuthenticated('dana@partner.example.com', { ...v, spf: 'none', dkim: 'none' }),
    ).toBe(false);
  });

  it('dmarc fail is NEVER authenticated, whatever else passed', () => {
    expect(
      isAuthenticated('dana@partner.example.com', { ...pass, dmarc: 'fail' }),
    ).toBe(false);
  });
});

describe('the inbound pipeline (steps 5–11)', () => {
  const from = 'dana@partner.example.com';

  it('step 5 — a virus is rejected whatever the sender’s standing', () => {
    const out = classifyInbound({
      from: 'jake@acme.test',
      verification: { ...pass, virus: 'fail', domain: 'acme.test' },
      trust: set({ threadTrusted: true }),
      policy: 'approve',
    });
    expect(out).toEqual({ kind: 'terminal', disposition: 'rejected', reason: 'virus' });
  });

  it('step 6 — a blocked contact is rejected', () => {
    const contacts = new Map([[from, 'blocked' as const]]);
    expect(classifyInbound({ from, verification: pass, trust: set({ contacts }), policy: 'approve' })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'blocked',
    });
  });

  it('step 7 — an UNAUTHENTICATED sender who would match the trust set is a hard spoof reject', () => {
    const out = classifyInbound({
      from: 'jake@acme.test',
      verification: { spf: 'fail', dkim: 'fail', dmarc: 'fail', domain: 'acme.test' },
      trust: set(),
      policy: 'approve',
    });
    expect(out).toEqual({ kind: 'terminal', disposition: 'rejected', reason: 'spoof' });
  });

  it('step 7½ — a DMARC FAIL from a stranger is rejected outright under EVERY policy (auth-failed)', () => {
    // The sender's own domain published a DMARC policy and this message failed
    // it — the domain is asking to be refused. No org setting may turn that
    // into a review item (Jake, 2026-09-02: failing auth must never quarantine).
    for (const policy of ['reject', 'approve', 'judge'] as const) {
      const out = classifyInbound({
        from,
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'fail', domain: 'partner.example.com' },
        trust: set(),
        policy,
      });
      expect(out).toEqual({ kind: 'terminal', disposition: 'rejected', reason: 'auth-failed' });
    }
  });

  it('step 7 outranks policy — no org setting can turn a forgery into a review', () => {
    for (const policy of ['reject', 'approve', 'judge'] as const) {
      const out = classifyInbound({
        from: 'jake@acme.test',
        verification: { spf: 'none', dkim: 'none', dmarc: 'none', domain: 'elsewhere.test' },
        trust: set({ threadTrusted: true }),
        policy,
      });
      expect(out).toEqual({ kind: 'terminal', disposition: 'rejected', reason: 'spoof' });
    }
  });

  it('step 8 — an authenticated, recognized, non-spam sender is delivered', () => {
    const contacts = new Map([[from, 'approved' as const]]);
    expect(classifyInbound({ from, verification: pass, trust: set({ contacts }), policy: 'reject' })).toEqual({
      kind: 'terminal',
      disposition: 'delivered',
      reason: null,
    });
  });

  it('step 9 — a spam verdict denies the fast path even to a recognized sender', () => {
    const contacts = new Map([[from, 'approved' as const]]);
    const spam: EmailVerification = { ...pass, spam: 'fail' };
    expect(classifyInbound({ from, verification: spam, trust: set({ contacts }), policy: 'reject' })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'spam',
    });
    expect(classifyInbound({ from, verification: spam, trust: set({ contacts }), policy: 'approve' })).toEqual({
      kind: 'terminal',
      disposition: 'quarantined',
      reason: 'spam',
    });
  });

  it('step 10 — an unrecognized sender follows the org policy', () => {
    expect(classifyInbound({ from, verification: pass, trust: set(), policy: 'reject' })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'unrecognized-sender',
    });
    expect(classifyInbound({ from, verification: pass, trust: set(), policy: 'approve' })).toEqual({
      kind: 'terminal',
      disposition: 'quarantined',
      reason: 'unrecognized-sender',
    });
    expect(classifyInbound({ from, verification: pass, trust: set(), policy: 'judge' })).toEqual({
      kind: 'judge',
      reason: 'unrecognized-sender',
    });
  });

  it('step 11 — an unauthenticated STRANGER gets the same policy (failing auth is evidence, not a verdict)', () => {
    const unauth: EmailVerification = { spf: 'fail', dkim: 'none', dmarc: 'none', domain: 'partner.example.com' };
    expect(classifyInbound({ from, verification: unauth, trust: set(), policy: 'approve' })).toEqual({
      kind: 'terminal',
      disposition: 'quarantined',
      reason: 'unrecognized-sender',
    });
  });
});

describe('the outbound pipeline', () => {
  it('a blocked recipient refuses the whole send (nothing is persisted)', () => {
    const contacts = new Map([['dana@partner.example.com', 'blocked' as const]]);
    expect(
      classifyOutbound({
        recipients: ['jake@acme.test', 'dana@partner.example.com'],
        trust: set({ contacts }),
        policy: 'approve',
      }),
    ).toEqual({ kind: 'blocked', blocked: ['dana@partner.example.com'] });
  });

  it('every recipient recognized → send', () => {
    expect(
      classifyOutbound({ recipients: ['jake@acme.test'], trust: set(), policy: 'reject' }),
    ).toEqual({ kind: 'send' });
  });

  it('≥1 unrecognized recipient follows the org policy and names them', () => {
    const recipients = ['jake@acme.test', 'dana@partner.example.com'];
    expect(classifyOutbound({ recipients, trust: set(), policy: 'reject' })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'unrecognized-recipient',
      unrecognized: ['dana@partner.example.com'],
    });
    expect(classifyOutbound({ recipients, trust: set(), policy: 'approve' })).toEqual({
      kind: 'terminal',
      disposition: 'held',
      reason: 'unrecognized-recipient',
      unrecognized: ['dana@partner.example.com'],
    });
    expect(classifyOutbound({ recipients, trust: set(), policy: 'judge' })).toEqual({
      kind: 'judge',
      reason: 'unrecognized-recipient',
      unrecognized: ['dana@partner.example.com'],
    });
  });
});
