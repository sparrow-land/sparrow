import { describe, expect, it } from 'vitest';
import {
  CLIENT_VERSION,
  parseClientVersion,
  compareClientVersions,
  clientVersionBelow,
  parseClientIdent,
  minorVersionsAhead,
} from './versions.js';

describe('parseClientVersion', () => {
  const table: [string, { major: number; minor: number; patch: number } | null][] = [
    ['0.1.0', { major: 0, minor: 1, patch: 0 }],
    ['1.2.3', { major: 1, minor: 2, patch: 3 }],
    ['0.1.0+dev', { major: 0, minor: 1, patch: 0 }],
    ['0.1.0+20260831.abc1234', { major: 0, minor: 1, patch: 0 }],
    ['2', { major: 2, minor: 0, patch: 0 }],
    ['2.3', { major: 2, minor: 3, patch: 0 }],
    ['10.20.30+build', { major: 10, minor: 20, patch: 30 }],
    ['1.0.0-rc.1', { major: 1, minor: 0, patch: 0 }],
    ['', null],
    ['garbage', null],
    ['v1.2.3', null], // no leading-numeric major (strict)
  ];
  for (const [input, want] of table) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(parseClientVersion(input)).toEqual(want);
    });
  }
  it('undefined → null', () => expect(parseClientVersion(undefined)).toBeNull());
});

describe('compareClientVersions', () => {
  const table: [string, string, -1 | 0 | 1 | undefined][] = [
    ['0.1.0', '0.1.0', 0],
    ['0.1.0', '0.2.0', -1],
    ['0.2.0', '0.1.0', 1],
    ['1.0.0', '0.9.9', 1],
    ['0.1.0+dev', '0.1.0+20260831.abc', 0], // build metadata ignored
    ['0.1.5', '0.1.10', -1], // numeric, not lexical
    ['2.0.0', '10.0.0', -1],
    ['garbage', '0.1.0', undefined],
    ['0.1.0', 'nope', undefined],
  ];
  for (const [a, b, want] of table) {
    it(`${a} vs ${b} → ${String(want)}`, () => {
      expect(compareClientVersions(a, b)).toBe(want);
    });
  }
});

describe('clientVersionBelow', () => {
  it('true only when strictly below the floor', () => {
    expect(clientVersionBelow('0.1.0', '0.2.0')).toBe(true);
    expect(clientVersionBelow('0.2.0', '0.2.0')).toBe(false);
    expect(clientVersionBelow('0.3.0', '0.2.0')).toBe(false);
  });
  it('unknown current or floor → false (unknown clients pass)', () => {
    expect(clientVersionBelow('garbage', '0.2.0')).toBe(false);
    expect(clientVersionBelow('0.1.0', 'garbage')).toBe(false);
  });
});

describe('parseClientIdent', () => {
  it('parses product/version', () => {
    expect(parseClientIdent('sparrow-cli/0.1.0+20260831.abc')).toEqual({
      product: 'sparrow-cli',
      version: '0.1.0+20260831.abc',
    });
    expect(parseClientIdent('sparrow-mcp/1.2.3')).toEqual({
      product: 'sparrow-mcp',
      version: '1.2.3',
    });
  });
  it('returns undefined for malformed/absent values', () => {
    expect(parseClientIdent(undefined)).toBeUndefined();
    expect(parseClientIdent('')).toBeUndefined();
    expect(parseClientIdent('noslash')).toBeUndefined();
    expect(parseClientIdent('/0.1.0')).toBeUndefined();
    expect(parseClientIdent('sparrow-cli/')).toBeUndefined();
  });
});

describe('minorVersionsAhead (whoami skew)', () => {
  it('is 0 when not ahead by a minor', () => {
    expect(minorVersionsAhead('0.1.0', '0.1.0')).toBe(0);
    expect(minorVersionsAhead('0.1.5', '0.1.0')).toBe(0); // patch-only ahead
    expect(minorVersionsAhead('0.1.0', '0.2.0')).toBe(0); // behind
  });
  it('counts minor gaps within a major', () => {
    expect(minorVersionsAhead('0.3.0', '0.1.0')).toBe(2);
    expect(minorVersionsAhead('0.2.0', '0.1.9')).toBe(1);
  });
  it('a major bump always reads as a gap', () => {
    expect(minorVersionsAhead('1.0.0', '0.9.0')).toBeGreaterThanOrEqual(1);
  });
  it('unparseable → 0', () => {
    expect(minorVersionsAhead('garbage', '0.1.0')).toBe(0);
  });
});

describe('CLIENT_VERSION', () => {
  it('is a parseable x.y.z string', () => {
    expect(parseClientVersion(CLIENT_VERSION)).not.toBeNull();
  });
});
