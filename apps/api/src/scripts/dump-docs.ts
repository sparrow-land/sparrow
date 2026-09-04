#!/usr/bin/env node
/**
 * `pnpm --filter @sparrow/api dump-docs -- --out <dir> [--base <url>]
 *  [--docs-url <url>] [--install-url <url>] [--email]`
 *
 * Dump the API documentation (SPEC "Docs by convention") to a directory of
 * markdown files, so the website build can publish it at the canonical docs home:
 *
 *   <out>/index.md              the index (`DOCS_URL/api/index.md`)
 *   <out>/<segment>.md          one page per documented endpoint area
 *
 * The bytes are exactly what {@link renderDocsIndex} / {@link renderDocPage}
 * produce, which is what the server's own `docs` URLs point at — one source, so
 * the pages at the home and the server that names them cannot drift.
 *
 * `--base` is the EXAMPLE SERVER every curl line names (default
 * `https://sparrow.example.com`, the value the SPEC pins); `--docs-url` /
 * `--install-url` are the canonical homes cross-links and the install one-liner
 * are built from. `--email` includes the email-medium pages, which an instance
 * only documents when the medium is configured.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOCS_URL, DEFAULT_INSTALL_URL } from '../public-homes.js';
import {
  docPages,
  renderDocPage,
  renderDocsIndex,
  type DocRenderOptions,
} from '../routes/docs-content.js';
import { optionalString, parseArgs, requireString } from './args.js';

/** The example server URL the SPEC pins for published docs. */
export const DEFAULT_EXAMPLE_BASE = 'https://sparrow.example.com';

export interface DumpOptions extends DocRenderOptions {
  /** The example server origin rendered into every request example. */
  base?: string;
}

/** One dumped file: a path RELATIVE to the output directory, plus its bytes. */
export interface DumpedFile {
  /** e.g. `index.md`, `me/inbox.md`. */
  file: string;
  content: string;
}

/**
 * The complete dump, in index-then-pages order. Pure: no filesystem, so the
 * exact bytes are unit-testable against the render functions.
 */
export function dumpDocs(opts: DumpOptions = {}): DumpedFile[] {
  const base = opts.base?.trim() || DEFAULT_EXAMPLE_BASE;
  const render: DocRenderOptions = {
    email: opts.email,
    docsUrl: opts.docsUrl,
    installUrl: opts.installUrl,
  };
  const files: DumpedFile[] = [
    { file: 'index.md', content: renderDocsIndex(base, render) },
  ];
  for (const page of docPages(render)) {
    const content = renderDocPage(base, page.segment, render);
    // Unreachable: `docPages` is exactly the set `renderDocPage` accepts.
    if (content === undefined) continue;
    files.push({ file: `${page.segment}.md`, content });
  }
  return files;
}

const USAGE = `usage: dump-docs --out <dir> [--base ${DEFAULT_EXAMPLE_BASE}] ` +
  `[--docs-url ${DEFAULT_DOCS_URL}] [--install-url ${DEFAULT_INSTALL_URL}] [--email]`;

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const out = path.resolve(requireString(args, 'out', USAGE));
  const files = dumpDocs({
    base: optionalString(args, 'base'),
    docsUrl: optionalString(args, 'docs-url'),
    installUrl: optionalString(args, 'install-url'),
    email: args.email === true || args.email === 'true',
  });
  for (const { file, content } of files) {
    const full = path.join(out, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  // eslint-disable-next-line no-console
  console.log(`dump-docs: wrote ${files.length} markdown files → ${out}`);
}

// Run only as a script, never on import (the unit tests import `dumpDocs`).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
