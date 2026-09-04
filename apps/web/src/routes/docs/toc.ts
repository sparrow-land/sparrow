/**
 * Anchors + table of contents for the docs tree (#50).
 *
 * Every docs page is hand-written JSX rather than markdown, so there is no
 * markdown renderer to hang heading ids off. What the pages DO share is the
 * one `<DocsLayout>` that renders them, so the ids are derived there from the
 * rendered DOM: one pass over the `h2`/`h3` elements of the current page slugs
 * each heading's text into an id and records it. That keeps the ids and the
 * TOC generated from a single source — they cannot drift — and it covers
 * headings a static scan could not see, like the CLI page's per-command `h3`s
 * that come from a `map()`.
 *
 * Slugs are derived purely from the heading TEXT, so they are stable across
 * edits elsewhere on the page: `#events-sse` keeps pointing at "Events (SSE)"
 * no matter how many sections move above it.
 */

/** One heading in the current page, in document order. */
export interface DocHeading {
  /** The `id` written onto the heading element; unique within the page. */
  id: string;
  /** The heading's visible text, used as the TOC label. */
  text: string;
  /** `2` = section, `3` = sub-section (rendered indented). */
  level: 2 | 3;
}

/**
 * Slugify a heading's text into a URL fragment: lowercase, accents folded,
 * runs of anything that is not a letter or digit collapsed to one `-`, and no
 * leading/trailing `-`.
 *
 * `"Events (SSE)"` → `events-sse`, `"Docs by convention & hints"` →
 * `docs-by-convention-hints`, `"1 · Sign up"` → `1-sign-up`.
 *
 * Apostrophes are dropped rather than turned into separators, so
 * `"The invitee's surface"` reads `the-invitees-surface`, not `…-invitee-s-…`.
 * A heading with no alphanumerics at all falls back to `section` (the caller's
 * de-duplication then keeps it unique).
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .normalize('NFKD')
    // Strip combining marks left behind by NFKD ("Café" → "Cafe").
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Apostrophes join, they do not separate.
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/**
 * Assign a stable `id` to every `h2`/`h3` inside `root` and return them in
 * document order. Two headings that slug the same get `-2`, `-3`, … suffixes,
 * so the ids in a page are always unique and the first occurrence keeps the
 * bare slug.
 *
 * This MUTATES the headings (writing `id`), which is the point: React does not
 * own that attribute on these elements, and doing it here means a page author
 * never has to remember to hand-write an anchor.
 */
export function collectDocHeadings(root: ParentNode): DocHeading[] {
  const used = new Map<string, number>();
  const headings: DocHeading[] = [];
  for (const el of root.querySelectorAll('h2, h3')) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const base = slugifyHeading(text);
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    const id = seen === 1 ? base : `${base}-${seen}`;
    el.id = id;
    headings.push({ id, text, level: el.tagName === 'H3' ? 3 : 2 });
  }
  return headings;
}
