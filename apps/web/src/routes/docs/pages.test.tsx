import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../../App.js';
import { DOCS_PAGES } from './pages.js';

/**
 * The docs route table used to exist three times: the `<Route>` tree in
 * App.tsx, the sidebar's `DOC_LINKS` in DocsLayout.tsx, and (once the docs got
 * pre-rendered for the marketing site) a third copy in the prerender script.
 * `DOCS_PAGES` is now the one source; these tests hold the other consumers to
 * it so a page can never be added to one and forgotten in the others.
 */

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('DOCS_PAGES', () => {
  it('lists the six docs pages, `/docs` first with slug `index`', () => {
    expect(DOCS_PAGES.map((p) => p.path)).toEqual([
      '/docs',
      '/docs/concepts',
      '/docs/cli',
      '/docs/mcp',
      '/docs/api',
      '/docs/self-hosting',
    ]);
    expect(DOCS_PAGES.map((p) => p.slug)).toEqual([
      'index',
      'concepts',
      'cli',
      'mcp',
      'api',
      'self-hosting',
    ]);
  });

  it('gives every page a label and a component', () => {
    for (const page of DOCS_PAGES) {
      expect(page.label).toBeTruthy();
      expect(typeof page.Component).toBe('function');
    }
    // Labels are unique — they are the sidebar text and the document title.
    expect(new Set(DOCS_PAGES.map((p) => p.label)).size).toBe(DOCS_PAGES.length);
  });
});

describe('the docs sidebar is generated from DOCS_PAGES', () => {
  it('renders exactly those links, in order, with those hrefs', () => {
    const { container } = renderAt('/docs');
    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('#docs-sidebar a'),
    );
    expect(links.map((a) => a.textContent)).toEqual(DOCS_PAGES.map((p) => p.label));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(DOCS_PAGES.map((p) => p.path));
  });

  it('marks only the current page active (so `/docs` is not active on `/docs/cli`)', () => {
    const { container } = renderAt('/docs/cli');
    const active = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('#docs-sidebar a[aria-current="page"]'),
    );
    expect(active.map((a) => a.getAttribute('href'))).toEqual(['/docs/cli']);
  });
});

describe('App routes each DOCS_PAGES path to its component', () => {
  for (const page of DOCS_PAGES) {
    it(`${page.path} → ${page.label}`, () => {
      // Render the component on its own to learn what its own <h1> says…
      const solo = render(
        <MemoryRouter>
          <page.Component />
        </MemoryRouter>,
      );
      const expected = solo.container.querySelector('h1')?.textContent;
      expect(expected).toBeTruthy();
      solo.unmount();

      // …then check the app's route tree puts exactly that page at that path.
      const { container } = renderAt(page.path);
      expect(container.querySelector('main h1')?.textContent).toBe(expected);
    });
  }

  it('titles the document from the DOCS_PAGES label', () => {
    for (const page of DOCS_PAGES) {
      const view = renderAt(page.path);
      expect(document.title).toBe(`${page.label} — Docs — sparrow`);
      view.unmount();
    }
  });
});
