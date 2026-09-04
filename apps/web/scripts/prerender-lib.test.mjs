import { describe, it, expect } from 'vitest';
import { parseArgs, rewriteBase, buildManifest } from './prerender-lib.mjs';

describe('parseArgs', () => {
  const required = ['--origin', 'https://sparrow.example.com', '--out', '/tmp/docs'];

  it('reads the required flags and applies the defaults', () => {
    expect(parseArgs(required)).toEqual({
      origin: 'https://sparrow.example.com',
      out: '/tmp/docs',
      mode: 'fragments',
      base: '/',
      css: null,
    });
  });

  it('ignores the bare `--` that `pnpm run <script> --` forwards', () => {
    expect(parseArgs(['--', ...required]).out).toBe('/tmp/docs');
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(parseArgs(['--origin=https://a.test', '--out=/tmp/x', '--mode=pages']).mode).toBe(
      'pages',
    );
  });

  it('strips a trailing slash from the origin so `${origin}/api` never doubles up', () => {
    expect(parseArgs([...required.slice(0, 1), 'https://a.test/', ...required.slice(2)]).origin).toBe(
      'https://a.test',
    );
  });

  it('normalizes --base to a leading and trailing slash', () => {
    expect(parseArgs([...required, '--base', 'docs-site']).base).toBe('/docs-site/');
    expect(parseArgs([...required, '--base', '/docs-site']).base).toBe('/docs-site/');
    expect(parseArgs([...required, '--base', '/']).base).toBe('/');
  });

  it('rejects a missing --origin or --out', () => {
    expect(() => parseArgs(['--out', '/tmp/x'])).toThrow(/--origin/);
    expect(() => parseArgs(['--origin', 'https://a.test'])).toThrow(/--out/);
  });

  it('rejects a non-http origin and an unknown mode or flag', () => {
    expect(() => parseArgs(['--origin', 'sparrow.example.com', '--out', '/tmp/x'])).toThrow(
      /origin/i,
    );
    expect(() => parseArgs([...required, '--mode', 'partials'])).toThrow(/mode/i);
    expect(() => parseArgs([...required, '--wat'])).toThrow(/--wat/);
  });
});

describe('rewriteBase', () => {
  const html = '<a href="/docs/cli">CLI</a><a href="/docs">Docs</a><img src="/icon.png">';

  it('leaves root-relative links alone at the default base', () => {
    expect(rewriteBase(html, '/')).toBe(html);
  });

  it('prefixes root-relative href/src with the base', () => {
    expect(rewriteBase(html, '/site/')).toBe(
      '<a href="/site/docs/cli">CLI</a><a href="/site/docs">Docs</a><img src="/site/icon.png">',
    );
  });

  it('never touches absolute, protocol-relative, hash or relative links', () => {
    const other =
      '<a href="https://x.test/docs">x</a><a href="//cdn.test/a.js">c</a>' +
      '<a href="#events-sse">e</a><a href="cli">rel</a>';
    expect(rewriteBase(other, '/site/')).toBe(other);
  });
});

describe('buildManifest', () => {
  const pages = [
    {
      slug: 'index',
      path: '/docs',
      label: 'Getting started',
      title: 'Getting started with sparrow',
      headings: [{ id: 'sign-up', text: 'Sign up', level: 2 }],
      bytes: 10,
    },
    {
      slug: 'cli',
      path: '/docs/cli',
      label: 'CLI reference',
      title: 'CLI reference',
      headings: [],
      bytes: 20,
    },
  ];

  it('keeps page order and drops anything not part of the contract', () => {
    const m = buildManifest({ origin: 'https://a.test', generatedAt: '2026-09-04T00:00:00.000Z', pages });
    expect(m).toEqual({
      origin: 'https://a.test',
      generatedAt: '2026-09-04T00:00:00.000Z',
      pages: [
        {
          slug: 'index',
          path: '/docs',
          label: 'Getting started',
          title: 'Getting started with sparrow',
          headings: [{ id: 'sign-up', text: 'Sign up', level: 2 }],
        },
        {
          slug: 'cli',
          path: '/docs/cli',
          label: 'CLI reference',
          title: 'CLI reference',
          headings: [],
        },
      ],
    });
  });

  it('refuses a page with no <h1> title — a silent empty title is a broken build', () => {
    expect(() =>
      buildManifest({
        origin: 'https://a.test',
        generatedAt: 'now',
        pages: [{ ...pages[0], title: '' }],
      }),
    ).toThrow(/title/i);
  });
});
