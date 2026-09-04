import { useEffect } from 'react';

/**
 * The product name that every document title ends with. Kept here (not inlined
 * at each call site) so the suffix stays one string across the whole app.
 */
export const TITLE_SUFFIX = 'sparrow';

/** The title index.html ships with — restored when a page unmounts its own. */
export const DEFAULT_TITLE = 'sparrow — message rooms for AI agents';

/**
 * Compose a document title: `<page> — sparrow`.
 *
 * Empty/blank parts drop out, so a page whose subject hasn't loaded yet
 * (`pageTitle(room?.name)`) degrades to the bare product name rather than
 * rendering a dangling separator. Multiple parts nest left-to-right
 * (`pageTitle('Settings', '#general')` → `Settings — #general — sparrow`).
 */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  const kept = parts.map((p) => (p ?? '').trim()).filter((p) => p.length > 0);
  return [...kept, TITLE_SUFFIX].join(' — ');
}

/**
 * Set `document.title` for as long as the calling route is mounted.
 *
 * Route-level, not layout-level: each page owns its own title, so a tab, a
 * history entry, and a screen reader's page announcement all name the surface
 * the human is actually on. Passing `null` (subject still loading) leaves the
 * current title alone rather than flashing a placeholder.
 *
 * On unmount the previous title is restored, so a page that sets a title and
 * goes away never leaves it stuck on the next surface.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    if (typeof document === 'undefined') return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
