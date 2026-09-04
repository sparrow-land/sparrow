import { describe, it, expect } from 'vitest';
import { parseOrgSettings, slugify } from './org-helpers.js';

describe('slugify', () => {
  it('drops apostrophes so a possessive stays one word', () => {
    // Bootstrap org names are "{displayName}'s org" — the apostrophe must not
    // leave a stray single-letter segment.
    expect(slugify("Olive Owner's org")).toBe('olive-owners-org');
    expect(slugify("Bob's Burgers")).toBe('bobs-burgers');
    // Typographic apostrophe too.
    expect(slugify('Olive Owner’s org')).toBe('olive-owners-org');
  });

  it('lowercases, hyphenates runs, and trims/collapses hyphens', () => {
    expect(slugify('  Acme  Robotics!! ')).toBe('acme-robotics');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('falls back to "org" for empty/all-punctuation input', () => {
    expect(slugify('')).toBe('org');
    expect(slugify("'''")).toBe('org');
    expect(slugify('!!!')).toBe('org');
  });
});

describe('parseOrgSettings', () => {
  it('returns full defaults for empty/absent/corrupt input', () => {
    const defaults = {
      invites: { who: 'members' },
      enroll: { agents: 'approval' },
      rooms: { create: 'members' },
      // v4: the org's email trust policy defaults (the medium may be off; the
      // policy is org data either way).
      email: {
        inboundUnrecognized: 'reject',
        outboundUnrecognized: 'reject',
        trustedPatterns: [],
        judgePrompt: null,
      },
    };
    expect(parseOrgSettings(null)).toEqual(defaults);
    expect(parseOrgSettings(undefined)).toEqual(defaults);
    expect(parseOrgSettings('')).toEqual(defaults);
    expect(parseOrgSettings('not json')).toEqual(defaults);
  });

  it('strips the retired enroll.humans / autoApproveEmailPatterns knobs on read', () => {
    const stored = JSON.stringify({
      invites: { who: 'admins' },
      enroll: { agents: 'open', humans: 'auto-email', autoApproveEmailPatterns: ['*@acme.com'] },
      rooms: { create: 'admins' },
    });
    const parsed = parseOrgSettings(stored);
    // Legacy keys gone…
    expect('humans' in parsed.enroll).toBe(false);
    expect('autoApproveEmailPatterns' in parsed.enroll).toBe(false);
    // …but every surviving policy is preserved (no silent reset to defaults).
    expect(parsed).toEqual({
      invites: { who: 'admins' },
      enroll: { agents: 'open' },
      rooms: { create: 'admins' },
      email: {
        inboundUnrecognized: 'reject',
        outboundUnrecognized: 'reject',
        trustedPatterns: [],
        judgePrompt: null,
      },
    });
  });
});
