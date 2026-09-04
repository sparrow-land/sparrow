/**
 * Pure helpers for the docs prerender (scripts/prerender-docs.mjs).
 *
 * Everything here is string-in/string-out so it can be unit-tested without a
 * build, a browser, or the filesystem — see prerender-lib.test.mjs.
 */

/** @typedef {'fragments' | 'pages'} PrerenderMode */

/**
 * @typedef {object} PrerenderOptions
 * @property {string} origin   Absolute origin baked into install/join snippets.
 * @property {string} out      Directory the artifacts are written to.
 * @property {PrerenderMode} mode
 * @property {string} base     URL prefix for root-relative links; `/` = none.
 * @property {string | null} css  Explicit built stylesheet, else auto-discovered.
 */

const MODES = ['fragments', 'pages'];

/**
 * Parse the CLI flags. Accepts both `--flag value` and `--flag=value`.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {PrerenderOptions}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run <script> -- --flag` forwards the separator verbatim.
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    let name, value;
    if (eq !== -1) {
      name = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      name = arg.slice(2);
      value = argv[++i];
    }
    if (!['origin', 'out', 'mode', 'base', 'css'].includes(name)) {
      throw new Error(`unknown flag: --${name}`);
    }
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }

  if (!flags.origin) throw new Error('--origin <url> is required');
  if (!flags.out) throw new Error('--out <dir> is required');
  if (!/^https?:\/\/[^/]+/.test(flags.origin)) {
    throw new Error(`--origin must be an absolute http(s) URL, got: ${flags.origin}`);
  }

  const mode = flags.mode ?? 'fragments';
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${MODES.join('|')}, got: ${mode}`);
  }

  return {
    origin: flags.origin.replace(/\/+$/, ''),
    out: flags.out,
    mode: /** @type {PrerenderMode} */ (mode),
    base: normalizeBase(flags.base ?? '/'),
    css: flags.css ?? null,
  };
}

/** `docs-site` / `/docs-site` / `/docs-site/` all become `/docs-site/`. */
export function normalizeBase(base) {
  const trimmed = base.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/**
 * Prefix root-relative `href`/`src` attributes with `base`, so a site that
 * mounts these files somewhere other than the web root still links correctly.
 * Absolute URLs, protocol-relative `//host`, fragments and relative paths are
 * left alone. At the default base (`/`) this is the identity.
 */
export function rewriteBase(html, base) {
  const prefix = normalizeBase(base);
  if (prefix === '/') return html;
  return html.replace(
    /\b(href|src)="\/(?!\/)/g,
    (_m, attr) => `${attr}="${prefix}`,
  );
}

/**
 * Build `manifest.json` from the rendered pages, in DOCS_PAGES order.
 *
 * Deliberately narrow: only the fields the marketing site consumes survive, so
 * internal bookkeeping (byte counts, timings) can never leak into the contract.
 *
 * @param {{ origin: string, generatedAt: string, pages: any[] }} input
 */
export function buildManifest({ origin, generatedAt, pages }) {
  return {
    origin,
    generatedAt,
    pages: pages.map((p) => {
      if (!p.title) {
        throw new Error(`page ${p.slug} rendered without an <h1> title`);
      }
      return {
        slug: p.slug,
        path: p.path,
        label: p.label,
        title: p.title,
        headings: p.headings.map((h) => ({ id: h.id, text: h.text, level: h.level })),
      };
    }),
  };
}
