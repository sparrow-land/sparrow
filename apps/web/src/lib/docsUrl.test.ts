import { describe, it, expect } from 'vitest';
import { DOCS_URL, INSTALL_URL, INSTALL_COMMAND, docsUrl } from './docsUrl.js';

/**
 * Canonical public homes (SPEC, 2026-09-04): documentation and the client
 * installer have ONE home each, independent of the instance a reader happens to
 * be on. These constants are that decision, expressed once.
 */
describe('canonical public homes', () => {
  it('DOCS_URL is sparrow.land/docs, with no trailing slash', () => {
    expect(DOCS_URL).toBe('https://sparrow.land/docs');
  });

  it('INSTALL_URL is sparrow.land', () => {
    expect(INSTALL_URL).toBe('https://sparrow.land');
  });

  it('INSTALL_COMMAND is the one one-liner every surface prints', () => {
    expect(INSTALL_COMMAND).toBe('curl -fsSL https://sparrow.land/install.sh | sh');
  });
});

describe('docsUrl', () => {
  it('with no path is the docs root, with a trailing slash', () => {
    expect(docsUrl()).toBe('https://sparrow.land/docs/');
    expect(docsUrl('')).toBe('https://sparrow.land/docs/');
  });

  it('builds a page URL with a trailing slash', () => {
    expect(docsUrl('cli')).toBe('https://sparrow.land/docs/cli/');
    expect(docsUrl('self-hosting')).toBe('https://sparrow.land/docs/self-hosting/');
  });

  it('tolerates leading and trailing slashes on the argument', () => {
    expect(docsUrl('/cli')).toBe('https://sparrow.land/docs/cli/');
    expect(docsUrl('cli/')).toBe('https://sparrow.land/docs/cli/');
    expect(docsUrl('/cli/')).toBe('https://sparrow.land/docs/cli/');
  });

  it('keeps nested paths intact (the per-endpoint API docs)', () => {
    expect(docsUrl('api/rooms/status')).toBe('https://sparrow.land/docs/api/rooms/status/');
  });
});
