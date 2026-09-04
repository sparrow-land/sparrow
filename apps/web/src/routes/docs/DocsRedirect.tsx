import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { docsUrl } from '../../lib/docsUrl.js';
import { DOCS_PATHS, DOCS_ROOT, docsPathForSlug } from './paths.js';

/**
 * The instance serves no docs (SPEC: *Canonical public homes*) — it forwards to
 * the one home instead. The server answers `302` for `/docs*`; this is the same
 * door for anyone already inside the SPA (an in-app link, a bookmark restored
 * from history, a client-side navigation the server never sees).
 *
 * The docs page SOURCES still live in this package: the marketing site
 * pre-renders them (`pnpm --filter @sparrow/web prerender-docs`). They are just
 * no longer mounted as live routes here.
 */

/**
 * Every path the docs tree ever published, so an old link keeps its page. From
 * `paths.ts`, NOT `pages.ts`: the app must not carry the pages it redirects away
 * from (`pages.test.tsx` holds the two lists together).
 */
const DOC_PATHS = new Set(DOCS_PATHS);
/** The one REST reference — every per-endpoint API path lands on it. */
const API_PATH = docsPathForSlug('api');

/**
 * Where a `/docs…` path goes. A known page keeps its page. A per-endpoint API
 * path (`/docs/api/<segment>`) collapses onto the ONE REST reference — those
 * segments are Markdown on sparrow.land, with no HTML page of their own — and
 * anything else lands on the docs root rather than a 404 on another host. A
 * fragment rides along: the published anchors come from these same sources, so
 * a deep link still lands on its section.
 */
export function docsRedirectTarget(pathname: string, hash = ''): string {
  const path = pathname.replace(/\/+$/, '');
  const base = DOC_PATHS.has(path)
    ? docsUrl(path.slice(DOCS_ROOT.length + 1))
    : path.startsWith(`${API_PATH}/`)
      ? docsUrl('api')
      : docsUrl();
  return hash && hash !== '#' ? `${base}${hash.startsWith('#') ? '' : '#'}${hash}` : base;
}

export function DocsRedirect() {
  const { pathname, hash } = useLocation();
  const target = docsRedirectTarget(pathname, hash);

  useEffect(() => {
    window.location.replace(target);
  }, [target]);

  // Visible only in the beat before the browser leaves — and the way out for
  // anyone the replace does not carry (a blocked navigation, no JS at all).
  return (
    <p className="p-6 text-sm text-[var(--sparrow-muted)]">
      The docs live at{' '}
      <a href={target} className="text-[var(--sparrow-accent)] underline">
        {target.replace(/^https:\/\//, '')}
      </a>
      …
    </p>
  );
}
