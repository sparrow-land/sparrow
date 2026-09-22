import type { ReactNode } from 'react';
import { Figure } from './Figure.js';

/**
 * A screenshot in the Getting started walk.
 *
 * It is {@link Figure} with the folder fixed: the first page's images have
 * lived under `/docs/img/getting-started/` since they were taken, and every
 * `<Screenshot name="signup" />` on that page names one of them. Pages written
 * since use `Figure` directly and pass their own `dir`.
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
  return <Figure dir="getting-started" name={name} alt={alt} caption={caption} />;
}
