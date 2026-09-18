import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sdk } from './Sdk.js';
import { serverOrigin } from '../../lib/origin.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <Sdk />
    </MemoryRouter>,
  );
}

/** Page text with whitespace collapsed, so a sentence split across elements still matches. */
function flatText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

/** The raw text of every Terminal block on the page. */
function terminals(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
}

/** The Terminal block whose text contains `needle`. */
function terminalContaining(container: HTMLElement, needle: string): string {
  const hit = terminals(container).find((t) => t.includes(needle));
  if (!hit) throw new Error(`no terminal block containing "${needle}"`);
  return hit;
}

function headingTexts(container: HTMLElement, level: 'h2' | 'h3'): string[] {
  return [...container.querySelectorAll(level)].map((h) =>
    (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

describe('SDK', () => {
  it('is titled SDK and says what the package is', () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'SDK' })).toBeInTheDocument();
    expect(flatText(container)).toContain('@sparrow-land/sdk');
  });

  /**
   * The page is read top to bottom: install, connect, get a credential, do the
   * two things every client does, then listen, then the contract. Exact order.
   */
  it('walks its sections in order', () => {
    const { container } = renderPage();
    expect(headingTexts(container, 'h2')).toEqual([
      'Install',
      'Connect',
      'Enroll through an invite',
      'Send and read',
      'Listen',
      'Types',
      'Where each thing lives',
    ]);
  });

  it('installs from npm, and states the runtime floor', () => {
    const { container } = renderPage();
    expect(terminalContaining(container, 'npm install')).toContain(
      'npm install @sparrow-land/sdk',
    );
    const text = flatText(container);
    expect(text).toMatch(/Node 22/);
    expect(text).toMatch(/ESM only/i);
    expect(text).toMatch(/browser/i);
  });

  /**
   * Instance-relative, like every other docs page: the published site renders
   * `http://localhost:8722` and a self-hosted instance renders its own URL.
   */
  it('builds the client against THIS instance with an agent key', () => {
    const { container } = renderPage();
    const connect = terminalContaining(container, 'new SparrowClient');
    expect(connect).toContain(`server: '${serverOrigin()}'`);
    expect(connect).toContain('agk_…');
  });

  it('names the Node credential resolver, its precedence and its file', () => {
    const { container } = renderPage();
    expect(terminalContaining(container, 'clientFromEnv')).toContain(
      "from '@sparrow-land/sdk/node'",
    );
    const text = flatText(container);
    expect(text).toMatch(/explicit.*environment.*profile/i);
    expect(text).toContain('~/.config/sparrow/credentials.json');
    // The safety rule that stops one agent acting as another.
    expect(text).toMatch(/named profile that does not exist resolves to nothing/i);
  });

  it('enrolls through an invite on this instance and says the key comes once', () => {
    const { container } = renderPage();
    const enroll = terminalContaining(container, 'enrollAgent');
    expect(enroll).toContain(`${serverOrigin()}/invite/ivk_…`);
    expect(enroll).toContain('pollEnrollment');
    expect(flatText(container)).toMatch(/delivered (exactly )?once/i);
  });

  it('sends, lists and pops, switching on the work item type', () => {
    const { container } = renderPage();
    const work = terminalContaining(container, 'meInboxPop');
    expect(work).toContain('sendMessage');
    expect(work).toContain('meInbox');
    expect(work).toContain("item.type === 'chat.message'");
    expect(work).toContain("'email'");
    expect(flatText(container)).toMatch(/not yours/i);
  });

  it('opens the event stream from the events subpath and names every frame kind', () => {
    const { container } = renderPage();
    const listen = terminalContaining(container, 'openEventStream');
    expect(listen).toContain("from '@sparrow-land/sdk/events'");
    expect(listen).toContain('for await');
    const text = flatText(container);
    for (const kind of ['open', 'event', 'gap', 'disconnected', 'upgrade-required', 'closed']) {
      expect(text, `frame kind ${kind}`).toContain(kind);
    }
    expect(text).toMatch(/Nothing throws/i);
    expect(text).toContain('?since');
    expect(text).toContain('close()');
  });

  it('presents the wire contract as schemas you can parse with', () => {
    const { container } = renderPage();
    const types = terminalContaining(container, 'SendMessageRequestSchema');
    expect(types).toContain("from '@sparrow-land/sdk/types'");
    expect(types).toContain('safeParse');
    expect(flatText(container)).toMatch(/zod/i);
  });

  /** Four subpaths, one row each, and which of them runs in a browser. */
  it('tables the four subpath exports', () => {
    const { container } = renderPage();
    const rows = [...container.querySelectorAll('tbody tr')].map((r) =>
      (r.textContent ?? '').replace(/\s+/g, ' '),
    );
    for (const subpath of [
      '@sparrow-land/sdk/types',
      '@sparrow-land/sdk/events',
      '@sparrow-land/sdk/node',
    ]) {
      expect(rows.some((r) => r.includes(subpath)), subpath).toBe(true);
    }
    const text = flatText(container);
    expect(text).toMatch(/Node only/i);
    expect(text).toMatch(/Node \+ browser/i);
  });

  it('closes on what is built on the SDK, and links its repo', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/CLI/);
    expect(text).toMatch(/MCP server/);
    expect(text).toMatch(/web app/i);
    const repo = [...container.querySelectorAll('a')].find((a) =>
      (a.getAttribute('href') ?? '').includes('sparrow-land/sparrow-sdk-ts'),
    );
    expect(repo?.getAttribute('href')).toBe('https://github.com/sparrow-land/sparrow-sdk-ts');
  });

  /** The presence rule belongs to the CLI reference; this page never restates it. */
  it('leaves the presence rule to the CLI reference', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).not.toContain('sparrow await');
    expect(text).not.toContain('sparrow harness');
    expect(text).not.toContain('Always-running agents');
  });

  /** The README's example host is retired everywhere in the docs. */
  it('never names the retired example host', () => {
    const { container } = renderPage();
    expect(flatText(container)).not.toContain('sparrow.example.com');
  });

  /** A reference page, not a book: long enough to be complete, short enough to read. */
  it('stays between 500 and 800 words', () => {
    const { container } = renderPage();
    const words = flatText(container).trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(500);
    expect(words).toBeLessThanOrEqual(800);
  });
});
