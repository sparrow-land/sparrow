import { describe, expect, it } from 'vitest';
import { effectiveOrigin } from './effective-origin.js';

/** Minimal request stub carrying only the Host header the helper reads. */
const req = (host?: string) => ({ headers: host === undefined ? {} : { host } });

describe('effectiveOrigin', () => {
  describe('with no orgHostSuffix configured', () => {
    const config = { baseUrl: 'https://example.com', orgHostSuffix: undefined };

    it('always returns BASE_URL, whatever the Host is', () => {
      expect(effectiveOrigin(req('acme.example.com'), config)).toBe('https://example.com');
      expect(effectiveOrigin(req('example.com'), config)).toBe('https://example.com');
      expect(effectiveOrigin(req(undefined), config)).toBe('https://example.com');
    });

    it('strips a trailing slash from BASE_URL', () => {
      expect(effectiveOrigin(req('acme.example.com'), { baseUrl: 'https://example.com/', orgHostSuffix: undefined })).toBe(
        'https://example.com',
      );
    });
  });

  describe('with orgHostSuffix configured', () => {
    const config = { baseUrl: 'https://example.com', orgHostSuffix: '.example.com' };

    it('returns <baseUrl scheme>://<Host> for a valid, non-reserved org slug host', () => {
      expect(effectiveOrigin(req('acme.example.com'), config)).toBe('https://acme.example.com');
      expect(effectiveOrigin(req('foo-bar.example.com'), config)).toBe('https://foo-bar.example.com');
    });

    it('carries the BASE_URL scheme, not the request scheme', () => {
      expect(effectiveOrigin(req('acme.example.com'), { baseUrl: 'http://example.com', orgHostSuffix: '.example.com' })).toBe(
        'http://acme.example.com',
      );
    });

    it('falls back to BASE_URL for the bare apex host (no slug)', () => {
      expect(effectiveOrigin(req('example.com'), config)).toBe('https://example.com');
    });

    it('falls back to BASE_URL for a reserved slug label', () => {
      expect(effectiveOrigin(req('www.example.com'), config)).toBe('https://example.com');
      expect(effectiveOrigin(req('api.example.com'), config)).toBe('https://example.com');
      expect(effectiveOrigin(req('app.example.com'), config)).toBe('https://example.com');
    });

    it('falls back to BASE_URL for an invalid slug label (uppercase, dots, empty)', () => {
      expect(effectiveOrigin(req('ACME.example.com'), config)).toBe('https://example.com');
      expect(effectiveOrigin(req('a.b.example.com'), config)).toBe('https://example.com');
      expect(effectiveOrigin(req('.example.com'), config)).toBe('https://example.com');
    });

    it('falls back to BASE_URL when the Host does not match the suffix', () => {
      expect(effectiveOrigin(req('acme.other.com'), config)).toBe('https://example.com');
      expect(effectiveOrigin(req(undefined), config)).toBe('https://example.com');
    });
  });

  describe('with a suffix that includes a port (dev)', () => {
    const config = { baseUrl: 'http://localhost:8722', orgHostSuffix: '.localhost:8722' };

    it('matches the full host including port', () => {
      expect(effectiveOrigin(req('acme.localhost:8722'), config)).toBe('http://acme.localhost:8722');
    });

    it('falls back when the port differs', () => {
      expect(effectiveOrigin(req('acme.localhost:9999'), config)).toBe('http://localhost:8722');
    });
  });
});
