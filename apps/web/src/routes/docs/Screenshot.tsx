import type { ReactNode } from 'react';

/**
 * A screenshot in a docs page.
 *
 * The images are NOT part of the app bundle: they live in the website repo at
 * `sparrow-website/scripts/docs-assets/img/`, which `build-docs.mjs` copies to
 * `/docs/img/` next to the pre-rendered pages. So the `src` is root-relative,
 * exactly like the cross-page links these pages already write (`/docs/cli`) —
 * both resolve against whatever origin is serving the docs, which keeps preview
 * builds and `--base` rewrites working. An absolute `https://sparrow.land/…`
 * would pin every preview to production's images.
 *
 * `alt` describes what is ON the screen, not that a screenshot exists: with
 * images off, or in a screen reader, the walk still has to be followable.
 */
export function Screenshot({
  name,
  alt,
  caption,
}: {
  /** Basename under `/docs/img/getting-started/`, without the extension. */
  name: string;
  alt: string;
  caption: ReactNode;
}) {
  return (
    <figure>
      <img src={`/docs/img/getting-started/${name}.png`} alt={alt} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
