import { describe, expect, it } from 'vitest';
import { normalizeAddress, partiesFromHeader } from './address.js';

describe('normalizeAddress', () => {
  it('lower-cases the domain and leaves the local part alone', () => {
    expect(normalizeAddress('Dana.Lee@PARTNER.Example.COM')).toBe('Dana.Lee@partner.example.com');
  });

  it('trims whitespace and strips stray angle brackets', () => {
    expect(normalizeAddress('  <dana@partner.example.com> ')).toBe('dana@partner.example.com');
  });

  it('leaves an address with no @ untouched apart from trimming', () => {
    expect(normalizeAddress(' postmaster ')).toBe('postmaster');
  });

  it('returns null for nothing at all', () => {
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress('<>')).toBeNull();
  });
});

describe('partiesFromHeader', () => {
  it('is empty for an absent header', () => {
    expect(partiesFromHeader(undefined)).toEqual([]);
  });

  it('maps a flat address list, keeping display names', () => {
    expect(
      partiesFromHeader({
        value: [
          { address: 'dana@Partner.example.com', name: 'Dana Lee' },
          { address: 'ops@acme.example.com', name: '' },
        ],
        html: '',
        text: '',
      }),
    ).toEqual([
      { email: 'dana@partner.example.com', name: 'Dana Lee' },
      { email: 'ops@acme.example.com', name: null },
    ]);
  });

  it('flattens group syntax into its members', () => {
    expect(
      partiesFromHeader({
        value: [
          {
            name: 'Team',
            group: [
              { address: 'a@x.example', name: 'A' },
              { address: 'b@x.example', name: '' },
            ],
          },
        ],
        html: '',
        text: '',
      }),
    ).toEqual([
      { email: 'a@x.example', name: 'A' },
      { email: 'b@x.example', name: null },
    ]);
  });

  it('drops an empty group (undisclosed-recipients:;)', () => {
    expect(
      partiesFromHeader({ value: [{ name: 'undisclosed-recipients', group: [] }], html: '', text: '' }),
    ).toEqual([]);
  });

  it('de-duplicates repeated addresses, keeping the first display name', () => {
    expect(
      partiesFromHeader({
        value: [
          { address: 'dana@partner.example.com', name: 'Dana Lee' },
          { address: 'DANA@partner.example.com', name: 'D. Lee' },
        ],
        html: '',
        text: '',
      }),
    ).toEqual([{ email: 'dana@partner.example.com', name: 'Dana Lee' }]);
  });

  it('accepts an array of address objects (repeated To: headers)', () => {
    expect(
      partiesFromHeader([
        { value: [{ address: 'a@x.example', name: 'A' }], html: '', text: '' },
        { value: [{ address: 'b@x.example', name: 'B' }], html: '', text: '' },
      ]),
    ).toEqual([
      { email: 'a@x.example', name: 'A' },
      { email: 'b@x.example', name: 'B' },
    ]);
  });
});
