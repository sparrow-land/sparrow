import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SiteHeader, GITHUB_URL } from './SiteHeader.js';
import { SiteFooter } from './SiteFooter.js';
import { docsUrl } from '../lib/docsUrl.js';

/**
 * The public repo moved to github.com/sparrow-land/sparrow. `GITHUB_URL` is the
 * one constant behind the header link and every footer link that hangs off it,
 * so a rename is a one-line change — these tests hold that shape.
 */
describe('site chrome — the public repo URL', () => {
  it('points at the sparrow-land/sparrow repo', () => {
    expect(GITHUB_URL).toBe('https://github.com/sparrow-land/sparrow');
  });

  it('the header GitHub link uses it', () => {
    const { container } = render(
      <MemoryRouter>
        <SiteHeader />
      </MemoryRouter>,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(GITHUB_URL);
    expect(hrefs.every((h) => !h?.includes('jakequist'))).toBe(true);
  });

  it('the footer license and issues links hang off it', () => {
    render(
      <MemoryRouter>
        <SiteFooter />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', GITHUB_URL);
    expect(screen.getByRole('link', { name: 'MIT License' })).toHaveAttribute(
      'href',
      'https://github.com/sparrow-land/sparrow/blob/main/LICENSE',
    );
    expect(screen.getByRole('link', { name: 'Issues' })).toHaveAttribute(
      'href',
      'https://github.com/sparrow-land/sparrow/issues',
    );
  });
});

/**
 * Canonical public homes (SPEC): the docs have ONE address, so the chrome links
 * to it directly rather than through this instance's `/docs`, which is now just
 * a redirect. Router `<Link>`s would keep the reader inside the SPA for a beat
 * and then bounce them out — these are plain external anchors.
 */
describe('site chrome — docs point at the one canonical home', () => {
  function hrefs(container: HTMLElement): string[] {
    return [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
  }

  it('the header Docs link is the absolute docs URL', () => {
    const { container } = render(
      <MemoryRouter>
        <SiteHeader />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', docsUrl());
    expect(hrefs(container).some((h) => h === '/docs' || h.startsWith('/docs/'))).toBe(false);
  });

  it('every footer docs link is an absolute sparrow.land page', () => {
    const { container } = render(
      <MemoryRouter>
        <SiteFooter />
      </MemoryRouter>,
    );
    const expected: Array<[string, string]> = [
      ['Getting started', docsUrl()],
      ['CLI', docsUrl('cli')],
      ['MCP', docsUrl('mcp')],
      ['REST API', docsUrl('api')],
      ['Self-hosting', docsUrl('self-hosting')],
      ['Concepts', docsUrl('concepts')],
    ];
    for (const [name, href] of expected) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }
    // Nothing in the chrome still points at this instance's /docs.
    expect(hrefs(container).some((h) => h === '/docs' || h.startsWith('/docs/'))).toBe(false);
  });
});
