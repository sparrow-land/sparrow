import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SiteHeader, GITHUB_URL } from './SiteHeader.js';
import { SiteFooter } from './SiteFooter.js';

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
