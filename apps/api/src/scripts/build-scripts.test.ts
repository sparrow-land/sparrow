/**
 * The two build-time scripts that publish the canonical public homes: the docs
 * dump and the installer render. Both are tested through their PURE functions,
 * so what the website build writes is pinned to what the server's own render
 * functions produce (SPEC "Canonical public homes" / "Docs by convention").
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXAMPLE_BASE, dumpDocs } from './dump-docs.js';
import { installScriptFor } from './render-install-script.js';
import { parseArgs, optionalString, requireString } from './args.js';
import { DOC_PAGES, EMAIL_DOC_PAGES, renderDocPage, renderDocsIndex } from '../routes/docs-content.js';
import { renderInstallScript } from '../routes/onboarding.templates.js';

describe('parseArgs', () => {
  it('reads --key value, --key=value and bare flags, and skips pnpm’s leading --', () => {
    const args = parseArgs(['--', '--out', '/tmp/x', '--base=https://a.example', '--email']);
    expect(args.out).toBe('/tmp/x');
    expect(args.base).toBe('https://a.example');
    expect(args.email).toBe(true);
    expect(optionalString(args, 'base')).toBe('https://a.example');
    expect(optionalString(args, 'email')).toBeUndefined();
    expect(requireString(args, 'out', 'usage')).toBe('/tmp/x');
    expect(() => requireString(args, 'nope', 'usage')).toThrow(/missing --nope/);
  });
});

describe('dump-docs', () => {
  it('writes index.md plus one file per core page, and omits email by default', () => {
    const files = dumpDocs();
    expect(files[0]!.file).toBe('index.md');
    const names = files.map((f) => f.file);
    for (const page of DOC_PAGES) expect(names).toContain(`${page.segment}.md`);
    for (const page of EMAIL_DOC_PAGES) expect(names).not.toContain(`${page.segment}.md`);
    expect(files).toHaveLength(DOC_PAGES.length + 1);
  });

  it('includes the email pages with --email', () => {
    const names = dumpDocs({ email: true }).map((f) => f.file);
    for (const page of EMAIL_DOC_PAGES) expect(names).toContain(`${page.segment}.md`);
    expect(names).toHaveLength(DOC_PAGES.length + EMAIL_DOC_PAGES.length + 1);
  });

  it('is EXACTLY what renderDocsIndex / renderDocPage produce for those inputs', () => {
    const opts = {
      base: 'https://sparrow.example.com',
      docsUrl: 'https://sparrow.land/docs',
      installUrl: 'https://sparrow.land',
    };
    const files = dumpDocs(opts);
    const render = { docsUrl: opts.docsUrl, installUrl: opts.installUrl, email: undefined };
    expect(files[0]!.content).toBe(renderDocsIndex(opts.base, render));
    for (const page of DOC_PAGES) {
      const dumped = files.find((f) => f.file === `${page.segment}.md`)!;
      expect(dumped.content, page.segment).toBe(renderDocPage(opts.base, page.segment, render));
    }
  });

  it('defaults the example server to https://sparrow.example.com and the homes to sparrow.land', () => {
    expect(DEFAULT_EXAMPLE_BASE).toBe('https://sparrow.example.com');
    const index = dumpDocs()[0]!.content;
    expect(index).toContain('https://sparrow.example.com/api/v1/meta');
    expect(index).toContain('https://sparrow.land/docs/api/');
  });

  it('renders examples from --base and cross-links from --docs-url', () => {
    const files = dumpDocs({
      base: 'https://acme.internal',
      docsUrl: 'https://mirror.example.com/handbook',
    });
    const page = files.find((f) => f.file === 'rooms/status.md')!.content;
    expect(page).toContain('https://acme.internal/api/v1/');
    expect(page).toContain('https://mirror.example.com/handbook/api/');
    expect(page).not.toContain('sparrow.land');
  });
});

describe('render-install-script', () => {
  it('is exactly renderInstallScript for the given base', () => {
    expect(installScriptFor('https://sparrow.land')).toBe(
      renderInstallScript('https://sparrow.land'),
    );
  });

  it('defaults to the canonical install home and points the bundles at it', () => {
    const body = installScriptFor();
    expect(body).toContain('BASE_URL="https://sparrow.land"');
    expect(body).toContain('download "${BASE_URL}/install/sparrow.js"');
    expect(body).toContain('download "${BASE_URL}/install/sparrow-mcp.js"');
  });

  it('keeps the installer behaviour: Node >= 22, SPARROW_BIN_DIR, three wrappers, idempotent', () => {
    const body = installScriptFor('https://sparrow.land');
    expect(body).toMatch(/\b22\b/);
    expect(body).toContain('BIN_DIR="${SPARROW_BIN_DIR:-${HOME}/.local/bin}"');
    expect(body).toContain('write_wrapper sparrow sparrow.mjs');
    expect(body).toContain('write_wrapper sparrow-mcp sparrow-mcp.mjs');
    expect(body).toContain('${BIN_DIR}/sparrow-skill');
    // Re-runnable: directories are created with -p and wrappers overwritten.
    expect(body).toContain('mkdir -p "${BIN_DIR}"');
  });

  it('follows --base for a mirror', () => {
    expect(installScriptFor('https://mirror.example.com/sparrow/')).toContain(
      'BASE_URL="https://mirror.example.com/sparrow"',
    );
  });
});
