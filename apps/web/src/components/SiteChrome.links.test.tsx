import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SiteHeader } from './SiteHeader.js';

/**
 * The app's chrome is the product's chrome, not the marketing site's. For
 * launch it carries the brand mark and nothing else: the Docs and GitHub links
 * are gone from the header, and the marketing SiteFooter is gone from every app
 * route (login, invite, welcome, 404, the docs preview). The docs and the
 * repo are still linked from sparrow.land, which owns that chrome.
 */
describe('SiteHeader — brand only', () => {
  function renderHeader() {
    return render(
      <MemoryRouter>
        <SiteHeader />
      </MemoryRouter>,
    );
  }

  it('keeps the sparrow logo linking home', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: /sparrow home/i })).toHaveAttribute('href', '/');
  });

  it('carries no Docs link and no GitHub link', () => {
    renderHeader();
    expect(screen.queryByRole('link', { name: /^docs$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /github/i })).toBeNull();
  });

  it('links nowhere but home — no docs URL, no repo URL, no navigation rail', () => {
    const { container } = renderHeader();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    // The skip link (`#main`) and the brand link are the whole inventory.
    expect(hrefs.filter((h) => !h.startsWith('#'))).toEqual(['/']);
    expect(hrefs.some((h) => h.includes('github.com'))).toBe(false);
    expect(hrefs.some((h) => h.includes('/docs'))).toBe(false);
    expect(container.querySelector('nav')).toBeNull();
  });

  it('renders no footer of its own', () => {
    renderHeader();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });
});
