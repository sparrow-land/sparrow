import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from './Logo.js';
import { SkipLink, MAIN_CONTENT_ID } from './SkipLink.js';
import { useAuth } from '../lib/auth.js';

/**
 * A minimal signed-in frame for pages that live OUTSIDE any org — the `/welcome`
 * create-org page and the no-org `/me/*` fallback. It wears a slim app-style top
 * bar matching the {@link AppShell} header (logo left; signed-in identity + Sign
 * out right) over the app background, so it reads unmistakably as "you ARE logged
 * in" — just without an org to hang the full shell on. No marketing
 * SiteHeader/SiteFooter.
 */
export function BareShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const identity = auth.user?.displayName || auth.user?.email || '';

  return (
    <div className="relative flex app-height flex-col">
      <SkipLink />
      <header className="app-header flex shrink-0 items-center gap-3 border-b border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-4">
        <Link to="/" aria-label="sparrow home" className="shrink-0 rounded">
          <Logo size={20} />
        </Link>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-2 text-sm">
          {identity && (
            <span
              className="max-w-[12rem] truncate text-xs text-[var(--sparrow-muted)]"
              title={identity}
            >
              {identity}
            </span>
          )}
          <button
            type="button"
            onClick={() => void auth.signOut()}
            className="rounded-md px-2.5 py-1.5 text-xs text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            Sign out
          </button>
        </div>
      </header>
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--sparrow-bg)] outline-none"
      >
        {children}
      </main>
    </div>
  );
}
