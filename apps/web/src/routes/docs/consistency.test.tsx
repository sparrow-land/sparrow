import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GettingStarted } from './GettingStarted.js';
import { Concepts } from './Concepts.js';
import { Cli } from './Cli.js';
import { Mcp } from './Mcp.js';
import { Sdk } from './Sdk.js';
import { Api } from './Api.js';
import { SelfHosting } from './SelfHosting.js';
import { serverOrigin } from '../../lib/origin.js';
import { INSTALL_COMMAND } from '../../lib/docsUrl.js';
import { slugifyHeading } from './toc.js';

/**
 * The docs pages are read as ONE walk-through: run the server, then every
 * example that follows talks to that server. The prerender feeds the pages a
 * placeholder origin, so a hard-coded host in any example silently contradicts
 * the `docker run` line two pages earlier. These are the rules that keep the
 * walk consistent; per-page meaning lives in the per-page tests.
 */

/** The one host that stands for "your own public URL" — Self-hosting only. */
const PUBLIC_HOST = 'https://sparrow.yourcompany.com';

/** The cast: one agent, one room, one human (plus a named second of each). */
const AGENT = 'my-agent';
const ROOM = 'build-crew';
const SECOND_AGENT = 'triage-bot';

/** Example hosts that must never appear again. */
const RETIRED_HOSTS = ['sparrow.example.com', 'sparrow-hq.com'];

/** Example names that must never appear again (the cast above replaced them). */
const RETIRED_NAMES = ['deploy-bot', 'scout', 'project-x', 'alpha ↔ beta'];

type Page = { name: string; el: ReactElement };

const PAGES: Page[] = [
  { name: 'Getting started', el: <GettingStarted /> },
  { name: 'Concepts', el: <Concepts /> },
  { name: 'CLI reference', el: <Cli /> },
  { name: 'MCP server', el: <Mcp /> },
  { name: 'SDK', el: <Sdk /> },
  { name: 'REST API', el: <Api /> },
  { name: 'Self-hosting', el: <SelfHosting /> },
];

function renderPage(page: Page): HTMLElement {
  return render(<MemoryRouter>{page.el}</MemoryRouter>).container;
}

/** A page by name — the list is ordered, but no rule here should depend on its indexes. */
function byName(name: string): Page {
  const found = PAGES.find((p) => p.name === name);
  if (!found) throw new Error(`no such docs page: ${name}`);
  return found;
}

function flatText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

/** The raw text of every Terminal block on a page. */
function terminals(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
}

/** Every absolute http(s) URL written out in a Terminal block. */
function urlsIn(code: string): string[] {
  return [...code.matchAll(/https?:\/\/[^\s"'`\\)]+/g)].map((m) => m[0]);
}

describe('docs — one origin across the whole walk-through', () => {
  it.each(PAGES)('$name never names a retired example host', (page) => {
    const container = renderPage(page);
    const text = flatText(container);
    for (const host of RETIRED_HOSTS) {
      expect(text, `${page.name} prose`).not.toContain(host);
      for (const code of terminals(container)) {
        expect(code, `${page.name} terminal`).not.toContain(host);
      }
    }
  });

  /**
   * Anything instance-relative — an invite URL, an API call, an explicit
   * `--server` — has to come from `serverOrigin()`, so the published docs read
   * `http://localhost:8722` and a self-hosted instance reads its own URL. The
   * one exception is Self-hosting, whose deployment examples are about a host
   * OTHER than the one you are reading the docs on.
   */
  it.each(PAGES)('$name derives every instance-relative URL from serverOrigin()', (page) => {
    const container = renderPage(page);
    const origin = serverOrigin();
    const selfHosting = page.name === 'Self-hosting';
    for (const code of terminals(container)) {
      for (const url of urlsIn(code)) {
        if (!/\/invite\/|\/api\/v1\//.test(url)) continue;
        const ok = url.startsWith(origin) || (selfHosting && url.startsWith(PUBLIC_HOST));
        expect(ok, `${page.name}: instance-relative URL off this instance: ${url}`).toBe(true);
      }
    }
  });

  /** …and the rule is not vacuous: these three pages do show such URLs. */
  it.each([byName('Getting started'), byName('CLI reference'), byName('REST API')])(
    '$name shows at least one invite or API URL on this instance',
    (page) => {
      const origin = serverOrigin();
      const urls = terminals(renderPage(page)).flatMap(urlsIn);
      expect(
        urls.some((u) => u.startsWith(origin) && /\/invite\/|\/api\/v1\//.test(u)),
        `${page.name}: no instance-relative example URL at all`,
      ).toBe(true);
    },
  );

  it.each(PAGES)('$name only ever writes an allowed host in a Terminal block', (page) => {
    const container = renderPage(page);
    const origin = serverOrigin();
    const selfHosting = page.name === 'Self-hosting';
    for (const code of terminals(container)) {
      for (const url of urlsIn(code)) {
        const ok =
          url.startsWith(origin) ||
          url.startsWith('https://sparrow.land') ||
          (selfHosting && (url.startsWith(PUBLIC_HOST) || url.startsWith('http://localhost:')));
        expect(ok, `${page.name}: unexpected host in a terminal block: ${url}`).toBe(true);
      }
    }
  });

  it.each(PAGES)('$name gives --server either the origin or the URL placeholder', (page) => {
    const container = renderPage(page);
    const origin = serverOrigin();
    for (const code of terminals(container)) {
      for (const match of code.matchAll(/--server[ =]+([^\s\]]+)/g)) {
        const value = match[1] ?? '';
        const ok = value === 'URL' || value.startsWith(origin);
        expect(ok, `${page.name}: --server ${value}`).toBe(true);
      }
    }
  });

  it('keeps the public-host placeholder on the Self-hosting page alone', () => {
    for (const page of PAGES) {
      const text = flatText(renderPage(page));
      if (page.name === 'Self-hosting') {
        expect(text, 'Self-hosting must show the public-host placeholder').toContain(PUBLIC_HOST);
      } else {
        expect(text, `${page.name} must not invent a public host`).not.toContain(
          'sparrow.yourcompany.com',
        );
      }
    }
  });

  it('starts the server with the same docker run line on both pages that show it', () => {
    const line = (container: HTMLElement) =>
      terminals(container).find((t) => t.startsWith('docker run -p'));
    const started = line(renderPage(byName('Getting started')));
    const hosted = line(renderPage(byName('Self-hosting')));
    expect(started).toBeTruthy();
    expect(hosted).toBeTruthy();
    expect(started).toBe(hosted);
  });
});

describe('docs — one cast of names', () => {
  it.each(PAGES)('$name never uses a retired example name', (page) => {
    const text = flatText(renderPage(page));
    for (const name of RETIRED_NAMES) {
      expect(text, `${page.name}`).not.toContain(name);
    }
  });

  it('walks the same agent and room on Getting started and the CLI reference', () => {
    for (const p of [byName('Getting started'), byName('CLI reference')]) {
      const blocks = terminals(renderPage(p)).join('\n');
      expect(blocks, `${p.name}: agent name`).toContain(AGENT);
      expect(blocks, `${p.name}: room name`).toContain(ROOM);
    }
  });

  /** Two agents are needed where an example shows sharing or a pair; name the second one once. */
  it('names the second agent consistently where the CLI reference needs two', () => {
    const blocks = terminals(renderPage(byName('CLI reference'))).join('\n');
    expect(blocks).toContain(SECOND_AGENT);
  });
});

describe('docs — the pages link to each other as one walk', () => {
  it('sends the Getting started reader on to every page that owns the depth', () => {
    const container = renderPage(byName('Getting started'));
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    for (const href of ['/docs/concepts', '/docs/cli', '/docs/api', '/docs/self-hosting']) {
      expect(hrefs.some((h) => h.startsWith(href)), `Getting started → ${href}`).toBe(true);
    }
    // "Lock it down" is a SECTION of Self-hosting, so it is linked as one.
    expect(hrefs).toContain('/docs/self-hosting#lock-it-down');
  });

  it('points that anchor at a heading Self-hosting actually has', () => {
    const container = renderPage(byName('Self-hosting'));
    const headings = [...container.querySelectorAll('h2')].map((h) =>
      slugifyHeading((h.textContent ?? '').trim()),
    );
    expect(headings).toContain('lock-it-down');
  });

  it('closes Self-hosting on the way back to Getting started', () => {
    const container = renderPage(byName('Self-hosting'));
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/docs');
  });
});

describe('docs — one form for tokens, ids and commands', () => {
  it.each(PAGES)('$name elides tokens with a single ellipsis character', (page) => {
    const text = flatText(renderPage(page));
    for (const prefix of ['ivk_', 'agk_', 'enr_', 'ses_', 'agt_', 'usr_', 'mem_', 'msg_']) {
      expect(text, `${page.name}: ${prefix}...`).not.toContain(`${prefix}...`);
    }
  });

  it('writes invite URLs as /invite/ivk_… wherever one is shown', () => {
    for (const page of PAGES) {
      const container = renderPage(page);
      for (const code of terminals(container)) {
        if (!code.includes('/invite/')) continue;
        expect(code, `${page.name}`).toMatch(/\/invite\/(ivk_…|\$TOKEN|\{token\})/);
      }
    }
  });

  /**
   * Ids carry their real prefixes (packages/common-types/src/ids.ts). The ones
   * that used to be wrong in a doc are worth pinning: an enrollment is `enl_`
   * (its one-time TOKEN is `enr_`), a room invitation is `rin_`.
   */
  it('uses the real id prefixes in CLI example output', () => {
    const blocks = terminals(renderPage(byName('CLI reference'))).join('\n');
    for (const prefix of ['agt_', 'org_', 'room_', 'mem_', 'msg_', 'inv_', 'enl_', 'rin_']) {
      expect(blocks, `CLI example output: ${prefix}`).toContain(prefix);
    }
    // An enrollment ROW is never `enr_` (that prefix is the one-time token).
    expect(blocks).not.toMatch(/enr_[0-9A-Za-z]/);
  });

  it.each(PAGES)('$name installs with the one canonical command', (page) => {
    const container = renderPage(page);
    for (const code of terminals(container)) {
      if (!code.includes('install.sh')) continue;
      expect(code, `${page.name}`).toContain(INSTALL_COMMAND);
      expect(INSTALL_COMMAND).toBe('curl -fsSL https://sparrow.land/install.sh | sh');
    }
  });
});
