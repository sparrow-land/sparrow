import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * SKIP TO CONTENT (issue #53). Every chrome must offer a first-tabbable escape
 * from its navigation into the main content — otherwise a keyboard or
 * screen-reader user re-tabs the whole sidebar (every human, every agent, every
 * room) on every navigation before reaching the conversation.
 *
 * ONE landmark id serves all of them, so the affordance behaves identically
 * wherever the reader is: {@link MAIN_CONTENT_ID} on the chrome's outermost
 * `<main>`, and the link ahead of everything else in the tab order.
 */

vi.mock('../lib/auth.js', () => ({
  useAuth: () => ({ user: { displayName: 'Jake', email: 'jake@acme.com' }, signOut: vi.fn() }),
}));

import { SkipLink, MAIN_CONTENT_ID } from './SkipLink.js';
import { BareShell } from './BareShell.js';
import { SiteHeader } from './SiteHeader.js';

/** Everything the browser would stop on, in document order. */
function tabbables(root: ParentNode): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
  ].filter((el) => el.getAttribute('tabindex') !== '-1' && !el.hasAttribute('disabled'));
}

describe('SkipLink', () => {
  it('is hidden until focused, and targets the shared landmark', () => {
    render(
      <MemoryRouter>
        <SkipLink />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /skip to content/i });
    expect(link).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`);
    expect(link.className).toContain('sr-only');
    expect(link.className).toContain('focus:not-sr-only');
  });
});

describe('every chrome offers the same skip link', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** The shared contract: first tab stop, and a real `<main>` to land on. */
  function expectSkipContract(container: HTMLElement): void {
    const link = screen.getByRole('link', { name: /skip to content/i });
    expect(tabbables(container)[0]).toBe(link);
    const target = container.querySelector(`#${MAIN_CONTENT_ID}`);
    expect(target).not.toBeNull();
    expect(target!.tagName).toBe('MAIN');
    // Focusable by script only, so the jump moves focus rather than just scroll.
    expect(target!.getAttribute('tabindex')).toBe('-1');
  }

  it('BareShell (the org-less signed-in frame)', () => {
    const { container } = render(
      <MemoryRouter>
        <BareShell>
          <p>child content</p>
        </BareShell>
      </MemoryRouter>,
    );
    expectSkipContract(container);
  });

  it('SiteHeader (the marketing/auth chrome) leads with it', () => {
    const { container } = render(
      <MemoryRouter>
        <SiteHeader />
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          page
        </main>
      </MemoryRouter>,
    );
    expectSkipContract(container);
  });
});
