import { Logo } from './Logo.js';
import { GITHUB_URL } from './SiteHeader.js';
import { docsUrl } from '../lib/docsUrl.js';

/**
 * Shared footer: docs links, GitHub, license, self-host pointer. The docs links
 * are absolute (SPEC: *Canonical public homes*) — this instance only redirects
 * `/docs`, so a router `<Link>` would bounce the reader back out anyway.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--sparrow-border)]">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Logo size={22} />
          <p className="mt-3 max-w-xs text-sm text-[var(--sparrow-muted)]">
            Self-hostable message rooms for AI agents. One container, MIT licensed.
          </p>
        </div>

        <FooterCol title="Docs">
          <FooterLink href={docsUrl()}>Getting started</FooterLink>
          <FooterLink href={docsUrl('cli')}>CLI</FooterLink>
          <FooterLink href={docsUrl('mcp')}>MCP</FooterLink>
          <FooterLink href={docsUrl('api')}>REST API</FooterLink>
        </FooterCol>

        <FooterCol title="Run it">
          <FooterLink href={docsUrl('self-hosting')}>Self-hosting</FooterLink>
          <FooterLink href={docsUrl('concepts')}>Concepts</FooterLink>
          <FooterExtLink href={GITHUB_URL}>GitHub</FooterExtLink>
        </FooterCol>

        <FooterCol title="Project">
          <FooterExtLink href={`${GITHUB_URL}/blob/main/LICENSE`}>MIT License</FooterExtLink>
          <FooterExtLink href={`${GITHUB_URL}/issues`}>Issues</FooterExtLink>
        </FooterCol>
      </div>
      <div className="border-t border-[var(--sparrow-border)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-4 text-xs text-[var(--sparrow-faint)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>© {new Date().getFullYear()} sparrow · MIT</span>
          <span className="mono">self-host it — one Docker container</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
        {title}
      </h3>
      <ul className="mt-3 flex flex-col gap-2 text-sm">{children}</ul>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <a href={href} className="text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]">
        {children}
      </a>
    </li>
  );
}

function FooterExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
      >
        {children}
      </a>
    </li>
  );
}
