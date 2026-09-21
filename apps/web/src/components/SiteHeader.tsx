import { Link } from 'react-router-dom';
import { Logo } from './Logo.js';
import { SkipLink } from './SkipLink.js';

/**
 * Shared top navigation for the app's signed-out/edge pages (login, invite,
 * 404, the docs preview). Brand only: the Docs and GitHub links that used to
 * sit on the right belong to the marketing site, which has its own chrome at
 * sparrow.land — inside the product they were an exit sign on every page.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--sparrow-border)] bg-[color:var(--sparrow-bg)]/85 backdrop-blur">
      {/* First tabbable element on every page wearing this chrome. */}
      <SkipLink />
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center px-4 sm:px-6">
        <Link to="/" aria-label="sparrow home" className="rounded">
          <Logo size={22} />
        </Link>
      </div>
    </header>
  );
}
