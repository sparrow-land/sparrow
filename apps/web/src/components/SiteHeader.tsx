import { Link } from 'react-router-dom';
import { Logo } from './Logo.js';
import { SkipLink } from './SkipLink.js';
import { docsUrl } from '../lib/docsUrl.js';

export const GITHUB_URL = 'https://github.com/sparrow-land/sparrow';

/** Shared top navigation used by the home page, docs, and the 404 page. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--sparrow-border)] bg-[color:var(--sparrow-bg)]/85 backdrop-blur">
      {/* First tabbable element on every page wearing this chrome. */}
      <SkipLink />
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="sparrow home" className="rounded">
          <Logo size={22} />
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {/* The docs have one home and it is not this instance (SPEC:
              *Canonical public homes*) — link straight there, never through
              the local `/docs` redirect. */}
          <a
            href={docsUrl()}
            className="rounded-md px-3 py-1.5 text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            Docs
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            <GitHubMark />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </nav>
      </div>
    </header>
  );
}

export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
