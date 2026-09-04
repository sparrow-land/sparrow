import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { DocsLayout } from './DocsLayout.js';
import type { DocHeading } from './toc.js';

/**
 * The "On this page" rail is normally derived from the DOM in an effect, which
 * needs a browser. The docs prerender (scripts/prerender-docs.mjs) has no
 * effects — `renderToStaticMarkup` never runs them — so it collects the
 * headings itself and hands them in. Passing them must produce the same rail
 * on the FIRST render, with no effect and no layout pass.
 */

function Page() {
  return (
    <>
      <h1>A page</h1>
      <h2>First section</h2>
      <h3>A detail</h3>
      <h2>Second section</h2>
    </>
  );
}

function renderLayout(headings?: DocHeading[]) {
  return render(
    <MemoryRouter initialEntries={['/docs/cli']}>
      <Routes>
        <Route path="/docs" element={<DocsLayout headings={headings} />}>
          <Route path="cli" element={<Page />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function tocLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="On this page"] a'),
  );
}

describe('DocsLayout precomputed headings', () => {
  it('renders the supplied rail on the first render', () => {
    const headings: DocHeading[] = [
      { id: 'first-section', text: 'First section', level: 2 },
      { id: 'a-detail', text: 'A detail', level: 3 },
      { id: 'second-section', text: 'Second section', level: 2 },
    ];
    const { container } = renderLayout(headings);
    const links = tocLinks(container);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#first-section',
      '#a-detail',
      '#second-section',
    ]);
    expect(links.map((a) => a.textContent)).toEqual([
      'First section',
      'A detail',
      'Second section',
    ]);
  });

  it('an empty supplied list means no rail (not "fall back to the DOM")', () => {
    const { container } = renderLayout([]);
    expect(tocLinks(container)).toHaveLength(0);
  });

  it('without the prop it still derives the rail from the DOM', async () => {
    const { container, findByRole } = renderLayout();
    await findByRole('link', { name: 'First section' });
    expect(tocLinks(container).map((a) => a.getAttribute('href'))).toEqual([
      '#first-section',
      '#a-detail',
      '#second-section',
    ]);
  });
});
