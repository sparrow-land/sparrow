# @sparrow/web

The React SPA for sparrow, served by the API at `/`. `pnpm dev` runs Vite with
`/api` proxied to a local API on `:8722`; `pnpm build` emits `dist/`, which the
API container serves. `pnpm test` (vitest + jsdom) and `pnpm typecheck` are the
gates.

## Pre-rendering the docs

The `/docs` tree is hand-written JSX, and the marketing site wants the same
prose without shipping the whole SPA. `pnpm --filter @sparrow/web prerender-docs
-- --origin <url> --out <dir> [--mode fragments|pages] [--base /] [--css <file>]`
renders every page in `src/routes/docs/pages.ts` to static HTML: it bundles
`scripts/prerender-entry.tsx` for Node with `vite build --ssr`, renders each
route inside a `StaticRouter`, and derives the anchors and the "On this page"
list with the app's own `collectDocHeadings`, so the pre-rendered anchors can
never disagree with the running app. `--origin` is required because the docs
embed the server URL in their `sparrow join …` snippets and off-browser
`src/lib/origin.ts` would answer `http://localhost:8722`. The default
`fragments` mode writes `<slug>.html` holding only the `<article class="doc">`
body plus a `manifest.json` (`origin`, `generatedAt`, and per page `slug`,
`path`, `label`, `title`, `headings`) for a host site to wrap in its own chrome;
`--mode pages` writes standalone documents with the app shell for previewing.
Both copy the built stylesheet to `<out>/sparrow-docs.css`. Internal links stay
as `/docs/...`; pass `--base` to prefix them.
