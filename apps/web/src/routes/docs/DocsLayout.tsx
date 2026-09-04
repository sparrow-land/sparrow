import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useDocumentTitle, pageTitle } from '../../lib/title.js';
import { SiteHeader } from '../../components/SiteHeader.js';
import { MAIN_CONTENT_ID } from '../../components/SkipLink.js';
import { SiteFooter } from '../../components/SiteFooter.js';
import { collectDocHeadings, type DocHeading } from './toc.js';
import { DOCS_PAGES, DOCS_ROOT, docsPageForPath } from './pages.js';

export interface DocsLayoutProps {
  /**
   * Headings for the "On this page" rail, when the caller already knows them.
   * The app leaves this undefined and the layout derives them from the DOM (see
   * below); the docs prerender (scripts/prerender-docs.mjs) has no DOM and no
   * effects, so it collects them itself and passes them in. An empty array is
   * an answer ("this page has no sections"), not a request to go look.
   */
  headings?: DocHeading[];
}

export function DocsLayout({ headings: given }: DocsLayoutProps = {}) {
  const [open, setOpen] = useState(false);

  // One title source for the whole docs tree: the route table already names
  // every page, so match the current path against it rather than repeating a
  // title effect in each of the six doc components.
  const { pathname, hash } = useLocation();
  const current = docsPageForPath(pathname);
  useDocumentTitle(pageTitle(current?.label, 'Docs'));

  // Anchors + TOC for whatever page the outlet just rendered (#50). Docs pages
  // are JSX, not markdown, so there is no renderer to hang ids off — the layout
  // derives them from the rendered DOM instead, which means every docs page
  // gets them for free and the TOC can never disagree with the ids.
  const contentRef = useRef<HTMLDivElement>(null);
  const [domHeadings, setDomHeadings] = useState<DocHeading[]>([]);
  // Depend on WHETHER headings were supplied, not on the array's identity — an
  // inline `headings={[...]}` would otherwise re-run this on every render.
  const derive = given === undefined;
  useEffect(() => {
    if (!derive) return;
    const root = contentRef.current;
    if (!root) return;
    setDomHeadings(collectDocHeadings(root));
  }, [pathname, derive]);
  const headings = given ?? domHeadings;

  // Deep link (`/docs/api#events-sse`). The browser does its own hash scroll
  // before React has painted — at which point the ids do not exist yet — so the
  // jump has to be redone once the effect above has written them.
  useEffect(() => {
    const id = hash.replace(/^#/, '');
    if (!id) return;
    let target: HTMLElement | null = null;
    try {
      target = document.getElementById(decodeURIComponent(id));
    } catch {
      // A malformed escape in the fragment is just a fragment we cannot match.
      return;
    }
    target?.scrollIntoView?.();
  }, [pathname, hash, headings]);

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />

      {/* Mobile sidebar toggle */}
      <div className="sticky top-14 z-20 border-b border-[var(--sparrow-border)] bg-[color:var(--sparrow-bg)]/85 px-4 py-2 backdrop-blur lg:hidden">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="docs-sidebar"
          className="inline-flex items-center gap-2 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3 py-1.5 text-sm text-[var(--sparrow-muted)]"
        >
          <MenuIcon /> Docs menu
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-wrap gap-8 px-4 sm:px-6 xl:max-w-7xl xl:flex-nowrap">
        <Sidebar id="docs-sidebar" open={open} onNavigate={() => setOpen(false)} />
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1 py-10 outline-none">
          <div ref={contentRef} className="doc mx-auto max-w-3xl">
            <Outlet />
          </div>
        </main>
        <OnThisPage headings={headings} />
      </div>

      <SiteFooter />
    </div>
  );
}

/**
 * The in-page table of contents. Below `xl` it sits at the TOP of the page as a
 * collapsed disclosure (a 20-entry list would otherwise bury the title on a
 * phone); from `xl` up it becomes the sticky right rail and is always open.
 * Both are the same single list of links — there is only ever one copy of each
 * anchor in the DOM.
 */
function OnThisPage({ headings }: { headings: DocHeading[] }) {
  const [open, setOpen] = useState(false);
  if (headings.length === 0) return null;
  return (
    <aside className="order-first w-full shrink-0 pt-4 xl:order-none xl:w-56 xl:pt-10">
      <div className="xl:sticky xl:top-24">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="doc-toc"
          className="inline-flex items-center gap-2 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3 py-1.5 text-sm text-[var(--sparrow-muted)] xl:hidden"
        >
          <MenuIcon /> On this page
        </button>
        <p className="mb-2 hidden px-3 text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)] xl:block">
          On this page
        </p>
        <nav
          id="doc-toc"
          aria-label="On this page"
          className={`${open ? 'block' : 'hidden'} mt-2 max-h-[70vh] overflow-y-auto xl:mt-0 xl:block`}
        >
          <ul className="flex flex-col gap-0.5 border-l border-[var(--sparrow-border)]">
            {headings.map((h) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  onClick={() => setOpen(false)}
                  className={`block border-l-2 border-transparent py-1 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-text)] ${
                    h.level === 3 ? 'pl-6 text-[0.8125rem]' : 'pl-3'
                  }`}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </aside>
  );
}

function Sidebar({
  id,
  open,
  onNavigate,
}: {
  id: string;
  open: boolean;
  onNavigate: () => void;
}) {
  return (
    <aside
      id={id}
      className={`${open ? 'block' : 'hidden'} shrink-0 border-b border-[var(--sparrow-border)] py-6 lg:block lg:w-56 lg:border-b-0 lg:border-r lg:py-10 lg:pr-6`}
    >
      <nav className="lg:sticky lg:top-24">
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
          Documentation
        </p>
        <ul className="flex flex-col gap-0.5">
          {DOCS_PAGES.map((l) => (
            <li key={l.path}>
              <NavLink
                to={l.path}
                end={l.path === DOCS_ROOT}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? 'bg-[var(--sparrow-accent-soft)] font-medium text-[var(--sparrow-accent)]'
                      : 'text-[var(--sparrow-muted)] hover:bg-[var(--sparrow-panel)] hover:text-[var(--sparrow-text)]'
                  }`
                }
              >
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
    </svg>
  );
}

/** Shared page-title block for docs pages. */
export function DocHeader({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      {intro && <p className="lead">{intro}</p>}
    </>
  );
}

/** A titled table wrapper that stays horizontally scrollable on small screens. */
export function DocTable({ children }: { children: ReactNode }) {
  return <div className="doc-table-wrap">{children}</div>;
}
