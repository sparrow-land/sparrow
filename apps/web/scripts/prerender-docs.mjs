#!/usr/bin/env node
/**
 * Pre-render the docs tree to static HTML.
 *
 *   pnpm --filter @sparrow/web prerender-docs -- \
 *     --origin https://sparrow.example.com \
 *     --out   ../../../sparrow-website/public/docs \
 *     [--mode fragments|pages] [--base /] [--css path/to/index.css]
 *
 * Flags
 *   --origin  (required) absolute origin baked into the docs' install/join
 *             snippets. Off-browser `src/lib/origin.ts` answers
 *             `http://localhost:8722`, so this is not optional.
 *   --out     (required) directory to write into; created if missing.
 *   --mode    `fragments` (default) writes `<slug>.html` holding ONLY the
 *             `<article class="doc">` body plus a `manifest.json` — that is
 *             what the marketing site consumes, wrapping the bodies in its own
 *             chrome. `pages` writes standalone documents with the app shell
 *             (header, sidebar, "On this page" rail, footer) for previewing.
 *   --base    URL prefix for root-relative links (default `/`, i.e. leave
 *             `/docs/cli` alone). `--base /site` rewrites them to `/site/docs/cli`.
 *   --css     the built stylesheet to copy in. Defaults to `dist/assets/index-*.css`,
 *             running `vite build` first if `dist/` is missing.
 *
 * Both modes also write `<out>/sparrow-docs.css`.
 *
 * How it works: `vite build --ssr` bundles scripts/prerender-entry.tsx for
 * Node (aliasing `src/lib/origin.ts` to origin-stub.ts, the only shim the docs
 * import graph needs), then this script imports the bundle and renders every
 * page in `src/routes/docs/pages.ts` inside a `StaticRouter`. Headings come
 * from the app's own `collectDocHeadings` run over a jsdom parse, so the
 * anchors and the table of contents match the running app exactly.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, existsSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, rewriteBase, buildManifest } from './prerender-lib.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(SCRIPTS, '..');
const VITE = join(WEB, 'node_modules/.bin/vite');
const SSR_OUT = join(WEB, 'node_modules/.cache/prerender-docs');
/** The stylesheet name both modes emit; stable so consumers can hardcode it. */
const CSS_NAME = 'sparrow-docs.css';

function run(label, args, env = {}) {
  try {
    execFileSync(VITE, args, { cwd: WEB, env: { ...process.env, ...env }, stdio: 'pipe' });
  } catch (err) {
    process.stderr.write(err.stdout?.toString() ?? '');
    process.stderr.write(err.stderr?.toString() ?? '');
    throw new Error(`${label} failed`);
  }
}

/** The app's built stylesheet: explicit `--css`, else `dist/assets/index-*.css`. */
function findAppCss(explicit) {
  if (explicit) {
    const p = resolve(WEB, explicit);
    if (!existsSync(p)) throw new Error(`--css ${explicit}: no such file`);
    return p;
  }
  const assets = join(WEB, 'dist/assets');
  const pick = () =>
    existsSync(assets)
      ? readdirSync(assets)
          .filter((f) => f.startsWith('index-') && f.endsWith('.css'))
          .sort()
      : [];
  let found = pick();
  if (found.length === 0) {
    console.log('dist/ has no built stylesheet — running `vite build` first…');
    run('vite build', ['build']);
    found = pick();
  }
  if (found.length === 0) throw new Error('no dist/assets/index-*.css after building');
  if (found.length > 1) {
    // Stale hashed builds pile up; the newest one is the current stylesheet.
    found.sort((a, b) => statSync(join(assets, b)).mtimeMs - statSync(join(assets, a)).mtimeMs);
  }
  return join(assets, found[0]);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });

  const css = findAppCss(opts.css);

  console.log(`prerendering docs · mode=${opts.mode} origin=${opts.origin} base=${opts.base}`);
  run('vite build --ssr (prerender bundle)', ['build', '--config', join(SCRIPTS, 'vite.prerender.config.ts')], {
    PRERENDER_SSR_OUT: SSR_OUT,
  });

  // Read by scripts/origin-stub.ts at render time, so one bundle serves any origin.
  process.env.PRERENDER_ORIGIN = opts.origin;
  const { renderDocs } = await import(pathToFileURL(join(SSR_OUT, 'prerender-entry.js')).href);

  const rendered = renderDocs({ mode: opts.mode, cssHref: CSS_NAME });

  for (const page of rendered) {
    const html = rewriteBase(page.html, opts.base);
    const file = join(outDir, `${page.slug}.html`);
    writeFileSync(file, html);
    console.log(
      `  ${`${page.slug}.html`.padEnd(20)} ${String(Buffer.byteLength(html)).padStart(7)} bytes  ` +
        `${String(page.headings.length).padStart(3)} headings  ${page.title}`,
    );
  }

  copyFileSync(css, join(outDir, CSS_NAME));
  console.log(`  ${CSS_NAME.padEnd(20)} ${String(statSync(css).size).padStart(7)} bytes  (from ${css.replace(WEB + '/', '')})`);

  if (opts.mode === 'fragments') {
    const manifest = buildManifest({
      origin: opts.origin,
      generatedAt: new Date().toISOString(),
      pages: rendered,
    });
    const json = JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(join(outDir, 'manifest.json'), json);
    console.log(`  ${'manifest.json'.padEnd(20)} ${String(Buffer.byteLength(json)).padStart(7)} bytes`);
  }

  console.log(`wrote ${rendered.length} pages to ${outDir}`);
}

main().catch((err) => {
  console.error(`prerender-docs: ${err.message}`);
  process.exitCode = 1;
});
