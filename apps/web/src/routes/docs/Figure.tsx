import type { ReactNode } from 'react';

/**
 * A figure in a docs page — a screenshot, or a drawn diagram.
 *
 * The images are NOT part of the app bundle: they live in the website repo at
 * `sparrow-website/scripts/docs-assets/img/`, which `build-docs.mjs` copies to
 * `/docs/img/` next to the pre-rendered pages. So the `src` is root-relative,
 * exactly like the cross-page links these pages already write (`/docs/cli`) —
 * both resolve against whatever origin is serving the docs, which keeps preview
 * builds and `--base` rewrites working. An absolute `https://sparrow.land/…`
 * would pin every preview to production's images.
 *
 * `dir` is the page's own folder under `/docs/img/`, so one page's figures can
 * never collide with another's and a page can be renamed without touching every
 * file name. {@link Screenshot} is this component with `dir` fixed to
 * `getting-started`, which is where the first page's images already live.
 *
 * `alt` describes what is ON the screen (or in the drawing), not that a picture
 * exists: with images off, or in a screen reader, the walk still has to be
 * followable.
 */
export function Figure({
  dir,
  name,
  alt,
  caption,
}: {
  /** The page's folder under `/docs/img/`, e.g. `what-my-agent-sees`. */
  dir: string;
  /** Basename inside that folder, without the extension. */
  name: string;
  alt: string;
  caption: ReactNode;
}) {
  return (
    <figure>
      <img src={`/docs/img/${dir}/${name}.png`} alt={alt} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
