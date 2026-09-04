import { Link } from 'react-router-dom';
import { useDocumentTitle, pageTitle } from '../lib/title.js';
import { Mark } from '../components/Logo.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { SiteFooter } from '../components/SiteFooter.js';
import { MAIN_CONTENT_ID } from '../components/SkipLink.js';

export function NotFound() {
  useDocumentTitle(pageTitle('Page not found'));
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-24 outline-none"
      >
        <Mark
          size={360}
          strokeWidth={1.5}
          className="pointer-events-none absolute text-[var(--sparrow-accent)] opacity-[0.05]"
        />
        <div className="relative text-center">
          <p className="mono text-6xl font-semibold tracking-tight text-[var(--sparrow-accent)]">404</p>
          <h1 className="mt-4 text-xl font-semibold text-[var(--sparrow-text)]">This page isn’t here</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--sparrow-muted)]">
            The page you’re looking for doesn’t exist. Check the URL, or head back to a known place.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-sm">
            <Link
              to="/"
              className="rounded-md bg-[var(--sparrow-accent)] px-4 py-2 font-semibold text-black transition-opacity hover:opacity-90"
            >
              Back home
            </Link>
            <Link
              to="/docs"
              className="rounded-md border border-[var(--sparrow-border-strong)] px-4 py-2 text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-accent-2)]"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
