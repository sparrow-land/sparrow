/**
 * The docs route table — the single source for every consumer of it.
 *
 * There used to be three copies: the `<Route>` tree in `App.tsx`, the sidebar's
 * link list in `DocsLayout.tsx`, and (once the docs started being pre-rendered
 * for the marketing site) the prerender script's own list. They drifted the
 * moment anyone added a page. Everything now derives from `DOCS_PAGES`:
 *
 * - `App.tsx` builds `<Route>`s from it (`index` becomes the index route),
 * - `DocsLayout.tsx` builds the sidebar and the document title from it,
 * - `scripts/prerender-entry.tsx` iterates it to render one file per page.
 *
 * Order is meaningful — it is the sidebar order and the reading order.
 */

import type { ComponentType } from 'react';
import { DOCS_ROOT } from './paths.js';
import { GettingStarted } from './GettingStarted.js';
import { Concepts } from './Concepts.js';
import { Cli } from './Cli.js';
import { Mcp } from './Mcp.js';
import { Api } from './Api.js';
import { SelfHosting } from './SelfHosting.js';

export interface DocsPage {
  /** Absolute route path, e.g. `/docs/cli`. The docs root is `/docs`. */
  path: string;
  /**
   * Stable short name for the page: the child segment of `path`, or `index`
   * for the docs root. Used for pre-rendered filenames (`cli.html`) and as the
   * manifest key the marketing site joins on, so it must not change casually.
   */
  slug: string;
  /** Sidebar text and document title for the page. Unique across the table. */
  label: string;
  /** The page body. Rendered inside `DocsLayout`'s `.doc` container. */
  Component: ComponentType;
}

export const DOCS_PAGES: DocsPage[] = [
  { path: '/docs', slug: 'index', label: 'Getting started', Component: GettingStarted },
  { path: '/docs/concepts', slug: 'concepts', label: 'Concepts', Component: Concepts },
  { path: '/docs/cli', slug: 'cli', label: 'CLI reference', Component: Cli },
  { path: '/docs/mcp', slug: 'mcp', label: 'MCP server', Component: Mcp },
  { path: '/docs/api', slug: 'api', label: 'REST API', Component: Api },
  {
    path: '/docs/self-hosting',
    slug: 'self-hosting',
    label: 'Self-hosting',
    Component: SelfHosting,
  },
];

/**
 * The docs root — the one page rendered as the tree's `index` route. Defined in
 * the data-only `paths.ts` (which the app's redirect uses without pulling these
 * pages in) and re-exported here so both halves name one value.
 */
export { DOCS_ROOT };

/** Find the page a pathname is on, tolerating a trailing slash. */
export function docsPageForPath(pathname: string): DocsPage | undefined {
  const trimmed =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return DOCS_PAGES.find((p) => p.path === trimmed);
}
