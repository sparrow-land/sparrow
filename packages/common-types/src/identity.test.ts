import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import {
  deriveDefaultAgentName,
  shortHostname,
  formatFolder,
  slugifyAgentName,
  sha256Hex,
} from './identity.js';

describe('shortHostname', () => {
  it('takes the part before the first dot, lowercased', () => {
    expect(shortHostname('M3.example.com')).toBe('m3');
    expect(shortHostname('m3.local')).toBe('m3');
  });
  it('lowercases a bare hostname', () => {
    expect(shortHostname('BuildBox')).toBe('buildbox');
  });
  it('handles an empty-ish hostname gracefully', () => {
    expect(shortHostname('')).toBe('');
  });
});

describe('formatFolder', () => {
  const home = '/home/jake';
  it('strips the $HOME/ prefix for paths under home', () => {
    expect(formatFolder('/home/jake/projects/foo', home)).toBe('projects/foo');
  });
  it('maps $HOME itself to ~', () => {
    expect(formatFolder('/home/jake', home)).toBe('~');
  });
  it('keeps the absolute path for cwd outside home', () => {
    expect(formatFolder('/opt/foo', home)).toBe('/opt/foo');
  });
  it('does not strip a sibling dir that shares a prefix', () => {
    expect(formatFolder('/home/jakeson/x', home)).toBe('/home/jakeson/x');
  });
});

describe('deriveDefaultAgentName', () => {
  // v4: a slugified `{host}-{folder}`, dash-joined so the default is
  // email-friendly, and valid against the agent-name rule by construction.
  // Full coverage (incl. the rule itself) lives in agent-name.test.ts.
  const host = slugifyAgentName(shortHostname(os.hostname()));

  it('joins short host and home-relative folder with a dash (email-friendly)', () => {
    const id = deriveDefaultAgentName('/home/jake/projects/foo', '/home/jake');
    expect(id).toBe(`${host}-projects-foo`);
    expect(id).not.toContain(':');
    expect(id).not.toContain('/');
    expect(id).toBe(id.toLowerCase());
  });
  it('keeps the host segment lowercased and dot-free', () => {
    expect(host).toBe(host.toLowerCase());
    expect(host).not.toContain('.');
  });
  it('uses `home` when cwd is $HOME (never a bare `~`)', () => {
    const id = deriveDefaultAgentName('/home/jake', '/home/jake');
    expect(id).toBe(`${host}-home`);
    expect(id).not.toContain('~');
  });
  it('slugifies an absolute path outside home', () => {
    expect(deriveDefaultAgentName('/opt/foo', '/home/jake')).toBe(`${host}-opt-foo`);
  });
});

describe('sha256Hex', () => {
  it('matches node crypto sha256 hex', () => {
    const s = 'agk_hello';
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });
  it('produces 64 hex chars', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
