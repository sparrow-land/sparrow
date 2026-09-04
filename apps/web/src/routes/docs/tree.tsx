import { Routes, Route } from 'react-router-dom';
import { DocsLayout } from './DocsLayout.js';
import { DOCS_PAGES, DOCS_ROOT } from './pages.js';
import type { DocHeading } from './toc.js';

/**
 * The docs route tree. The app itself no longer mounts it — an instance serves
 * no docs (SPEC: *Canonical public homes*), it forwards to sparrow.land — so
 * the two consumers left are the marketing site's pre-render
 * (scripts/prerender-entry.tsx) and the tests that hold the pages to their
 * shape. One definition, so what the tests exercise is what gets published.
 *
 * `headings` is passed straight to {@link DocsLayout}: the pre-render runs no
 * effects, so it collects the headings itself and hands them in.
 */
export function DocsTree({ headings }: { headings?: DocHeading[] } = {}) {
  return (
    <Routes>
      <Route path={DOCS_ROOT} element={<DocsLayout headings={headings} />}>
        {DOCS_PAGES.map(({ path, slug, Component }) =>
          path === DOCS_ROOT ? (
            <Route key={slug} index element={<Component />} />
          ) : (
            <Route key={slug} path={path.slice(DOCS_ROOT.length + 1)} element={<Component />} />
          ),
        )}
      </Route>
    </Routes>
  );
}
