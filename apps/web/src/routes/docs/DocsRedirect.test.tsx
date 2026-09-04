import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DocsRedirect, docsRedirectTarget } from './DocsRedirect.js';
import { DOCS_PAGES } from './pages.js';
import { App } from '../../App.js';
import { useFetch, restoreFetch, errorJson } from '../../test/apiStub.js';

/**
 * Canonical public homes: the instance serves NO docs. Every `/docs*` path in
 * the SPA is a one-way door to sparrow.land, mirroring the server's own `302`
 * so a bookmark, an old link, and an in-app link all land in the same place.
 */
describe('docsRedirectTarget', () => {
  it('sends the docs root to the canonical root', () => {
    expect(docsRedirectTarget('/docs')).toBe('https://sparrow.land/docs/');
    expect(docsRedirectTarget('/docs/')).toBe('https://sparrow.land/docs/');
  });

  it('sends every known page to its canonical page', () => {
    for (const page of DOCS_PAGES) {
      const slug = page.path === '/docs' ? '' : `${page.slug}/`;
      expect(docsRedirectTarget(page.path)).toBe(`https://sparrow.land/docs/${slug}`);
      expect(docsRedirectTarget(`${page.path}/`)).toBe(`https://sparrow.land/docs/${slug}`);
    }
  });

  /**
   * The per-endpoint Markdown docs have no HTML page of their own on
   * sparrow.land — there is ONE REST reference — so a browser following
   * `/docs/api/<anything>` lands on that page rather than a 404.
   */
  it('collapses every per-endpoint API path onto the one REST reference', () => {
    expect(docsRedirectTarget('/docs/api/rooms/status')).toBe('https://sparrow.land/docs/api/');
    expect(docsRedirectTarget('/docs/api/me/inbox/pop')).toBe('https://sparrow.land/docs/api/');
    expect(docsRedirectTarget('/docs/api/rooms/status/')).toBe('https://sparrow.land/docs/api/');
    // …and the fragment still rides along, so a deep link keeps its section.
    expect(docsRedirectTarget('/docs/api/rooms/status', '#events-sse')).toBe(
      'https://sparrow.land/docs/api/#events-sse',
    );
  });

  it('sends anything it does not recognize to the docs root', () => {
    expect(docsRedirectTarget('/docs/nope')).toBe('https://sparrow.land/docs/');
    expect(docsRedirectTarget('/docs/cli/deeper')).toBe('https://sparrow.land/docs/');
    expect(docsRedirectTarget('/docs/index')).toBe('https://sparrow.land/docs/');
  });

  it('carries a deep-link fragment across (the anchors are the same document)', () => {
    expect(docsRedirectTarget('/docs/api', '#events-sse')).toBe(
      'https://sparrow.land/docs/api/#events-sse',
    );
    expect(docsRedirectTarget('/docs', '')).toBe('https://sparrow.land/docs/');
  });
});

describe('DocsRedirect', () => {
  const replaceMock = vi.fn();
  beforeAll(() => {
    // jsdom's `location.replace` is a throwing no-op, so swap the whole object
    // for a stand-in that reads through (same approach as the Login tests).
    const real = window.location;
    const fake: Record<string, unknown> = {
      replace: replaceMock,
      assign: vi.fn(),
      reload: vi.fn(),
    };
    for (const k of ['origin', 'href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
      Object.defineProperty(fake, k, {
        get: () => (real as unknown as Record<string, unknown>)[k],
        enumerable: true,
      });
    }
    Object.defineProperty(window, 'location', { configurable: true, value: fake });
  });
  beforeEach(() => replaceMock.mockClear());
  afterEach(() => restoreFetch());

  it('replaces the location as soon as it mounts', async () => {
    render(
      <MemoryRouter initialEntries={['/docs/cli']}>
        <DocsRedirect />
      </MemoryRouter>,
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('https://sparrow.land/docs/cli/'));
  });

  it('offers the canonical link too, for anyone the replace does not carry', () => {
    render(
      <MemoryRouter initialEntries={['/docs/mcp']}>
        <DocsRedirect />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /sparrow\.land\/docs\/mcp/ })).toHaveAttribute(
      'href',
      'https://sparrow.land/docs/mcp/',
    );
  });

  describe('mounted in the app', () => {
    it.each(['/docs', '/docs/cli', '/docs/api', '/docs/api/rooms/status', '/docs/bogus'])(
      '%s redirects instead of rendering a docs page',
      async (path) => {
        useFetch(async () => errorJson('unauthorized', 401));
        const { container } = render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );
        await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(docsRedirectTarget(path)));
        // No docs chrome, no docs body — the pages are not mounted any more.
        expect(container.querySelector('#docs-sidebar')).toBeNull();
        expect(container.querySelector('.doc')).toBeNull();
      },
    );
  });
});
