import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DocsTree } from './tree.js';
import { DOCS_PAGES, DOCS_ROOT } from './pages.js';
import { DOCS_ROOT as PATHS_ROOT, DOCS_SLUGS, DOCS_PATHS } from './paths.js';

/**
 * The docs route table used to exist three times: the `<Route>` tree in
 * App.tsx, the sidebar's `DOC_LINKS` in DocsLayout.tsx, and (once the docs got
 * pre-rendered for the marketing site) a third copy in the prerender script.
 * `DOCS_PAGES` is now the one source; these tests hold the other consumers to
 * it so a page can never be added to one and forgotten in the others. The app
 * itself is no longer one of them — it redirects `/docs*` to sparrow.land (see
 * DocsRedirect.test.tsx); the tree lives on for the pre-render.
 */

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DocsTree />
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

describe('the docs tree routes each DOCS_PAGES path to its component', () => {
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

      // …then check the docs route tree puts exactly that page at that path.
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

/**
 * `paths.ts` is the same table with the components cut out, so the SPA can
 * answer "is this a real docs page?" for a redirect without pulling six pages
 * of prose into its bundle (they are ~107 kB of it). Two lists is exactly the
 * drift this file exists to prevent — so they are bound here, and the moment a
 * page is added to one and not the other this fails.
 */
describe('paths.ts mirrors DOCS_PAGES, without importing a single component', () => {
  it('lists the same slugs, in the same order', () => {
    expect([...DOCS_SLUGS]).toEqual(DOCS_PAGES.map((p) => p.slug));
  });

  it('lists the same paths, in the same order', () => {
    expect(DOCS_PATHS).toEqual(DOCS_PAGES.map((p) => p.path));
  });

  it('agrees on the docs root', () => {
    expect(PATHS_ROOT).toBe(DOCS_ROOT);
  });

  it('imports nothing that drags a page in (data only)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    // vitest runs with the package root as cwd (vite.config.ts lives there).
    const src = await readFile(resolve(process.cwd(), 'src/routes/docs/paths.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
