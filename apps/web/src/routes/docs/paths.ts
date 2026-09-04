/**
 * The docs page table with the pages cut out — DATA ONLY, and deliberately so:
 * this module must never import a component. The SPA no longer renders the docs
 * (SPEC: *Canonical public homes*), it only needs to know which `/docs/…` paths
 * ever existed so `DocsRedirect` can send a known page to its own page and
 * everything else to the docs root. Importing `pages.ts` for that would drag all
 * six documents — ~107 kB of prose — into a bundle that never renders them.
 *
 * `pages.ts` is still the source of the docs THEMSELVES; `pages.test.tsx` binds
 * the two lists together so a new page cannot land in one and not the other.
 */

/** The docs root. Re-exported by `pages.ts`, so there is one value in the app. */
export const DOCS_ROOT = '/docs';

/** Every published page slug, in reading order. `index` is the docs root. */
export const DOCS_SLUGS = ['index', 'concepts', 'cli', 'mcp', 'api', 'self-hosting'] as const;

export type DocsSlug = (typeof DOCS_SLUGS)[number];

/** The route path a slug is published at (`index` → the root itself). */
export function docsPathForSlug(slug: string): string {
  return slug === 'index' ? DOCS_ROOT : `${DOCS_ROOT}/${slug}`;
}

/** Every published page path, in the same order as {@link DOCS_SLUGS}. */
export const DOCS_PATHS: string[] = DOCS_SLUGS.map(docsPathForSlug);
