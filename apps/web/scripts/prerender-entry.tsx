/**
 * The React half of the docs prerender: renders every page in `DOCS_PAGES` to
 * static HTML. Bundled for Node by scripts/vite.prerender.config.ts and driven
 * by scripts/prerender-docs.mjs, which owns argument parsing and the
 * filesystem — this module is pure render-in, strings-out.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { JSDOM } from 'jsdom';

import { DocsTree } from '../src/routes/docs/tree.js';
import { DOCS_PAGES } from '../src/routes/docs/pages.js';
import { collectDocHeadings, type DocHeading } from '../src/routes/docs/toc.js';
import { pageTitle } from '../src/lib/title.js';

export interface RenderedPage {
  slug: string;
  path: string;
  label: string;
  /** The page's `<h1>` text — the real title, not the sidebar label. */
  title: string;
  headings: DocHeading[];
  html: string;
}

export interface RenderOptions {
  /** `fragments` = the `.doc` body only; `pages` = standalone app-shell pages. */
  mode: 'fragments' | 'pages';
  /** Stylesheet href written into `pages`-mode documents. */
  cssHref: string;
}

/** Parse a markup string and hand back its `<body>` for querying/mutation. */
function parse(markup: string): HTMLElement {
  return new JSDOM(`<!doctype html><body>${markup}</body>`).window.document.body;
}

function h1Text(root: ParentNode): string {
  return (root.querySelector('h1')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function shell(title: string, cssHref: string, body: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${cssHref}" />
<script>(function(){try{var p=localStorage.getItem('sparrow:theme');if(p==='dark'||p==='light')document.documentElement.dataset.theme=p;else delete document.documentElement.dataset.theme;}catch(e){}})()</script>
</head>
<body><div id="root">${body}</div></body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render one docs page.
 *
 * `pages` mode renders twice on purpose. The first pass produces the content so
 * `collectDocHeadings` can slug it; the second pass hands those headings back
 * to `DocsLayout` so the "On this page" rail is really there in the HTML (the
 * app builds it in an effect, and `renderToStaticMarkup` runs no effects). A
 * final `collectDocHeadings` over the second pass writes the `id`s the rail
 * links to — the same function the app uses, so the anchors cannot disagree.
 */
function renderPage(page: (typeof DOCS_PAGES)[number], opts: RenderOptions): RenderedPage {
  if (opts.mode === 'fragments') {
    const markup = renderToStaticMarkup(
      <StaticRouter location={page.path}>
        <article className="doc">
          <page.Component />
        </article>
      </StaticRouter>,
    );
    const body = parse(markup);
    const doc = body.querySelector('.doc');
    if (!doc) throw new Error(`${page.path}: rendered no .doc container`);
    const headings = collectDocHeadings(doc);
    return {
      slug: page.slug,
      path: page.path,
      label: page.label,
      title: h1Text(doc),
      headings,
      html: doc.outerHTML + '\n',
    };
  }

  const first = parse(renderToStaticMarkup(<StaticRouter location={page.path}><DocsTree /></StaticRouter>));
  const firstDoc = first.querySelector('.doc');
  if (!firstDoc) throw new Error(`${page.path}: rendered no .doc container`);
  const headings = collectDocHeadings(firstDoc);
  const title = h1Text(firstDoc);

  const second = parse(
    renderToStaticMarkup(<StaticRouter location={page.path}><DocsTree headings={headings} /></StaticRouter>),
  );
  const secondDoc = second.querySelector('.doc');
  if (!secondDoc) throw new Error(`${page.path}: second pass rendered no .doc container`);
  const again = collectDocHeadings(secondDoc);
  if (again.map((h) => h.id).join() !== headings.map((h) => h.id).join()) {
    throw new Error(`${page.path}: headings changed between passes — the render is not stable`);
  }

  return {
    slug: page.slug,
    path: page.path,
    label: page.label,
    title,
    headings,
    html: shell(pageTitle(page.label, 'Docs'), opts.cssHref, second.innerHTML),
  };
}

/** Render every docs page. Throws on the first page that fails. */
export function renderDocs(opts: RenderOptions): RenderedPage[] {
  return DOCS_PAGES.map((page) => renderPage(page, opts));
}
