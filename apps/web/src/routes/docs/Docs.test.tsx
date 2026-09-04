import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../../App.js';
import { DocsTree } from './tree.js';

/**
 * The app no longer mounts the docs (SPEC: *Canonical public homes*) — it
 * redirects to sparrow.land, and the sources here are what the marketing site
 * pre-renders. So these tests render the DOCS TREE, the same component the
 * pre-render drives, rather than `<App/>`.
 */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DocsTree />
    </MemoryRouter>,
  );
}

/** The 404 tests below are about the app itself, so they still render it. */
function renderAppAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('docs shell', () => {
  it('renders the sidebar nav on every docs page', () => {
    renderAt('/docs');
    // Sidebar links (there are two navs on mobile+desktop; use getAllByRole).
    for (const label of [
      'Getting started',
      'Concepts',
      'CLI reference',
      'MCP server',
      'REST API',
      'Self-hosting',
    ]) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['/docs', /Getting started/i],
    ['/docs/concepts', /Concepts/i],
    ['/docs/cli', /CLI reference/i],
    ['/docs/mcp', /MCP server/i],
    ['/docs/api', /REST API/i],
    ['/docs/self-hosting', /Self-hosting/i],
  ])('renders %s with its heading', (path, heading) => {
    renderAt(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  // #48: every docs page shared one title, so tabs and history were unreadable.
  it.each([
    ['/docs', 'Getting started — Docs — sparrow'],
    ['/docs/concepts', 'Concepts — Docs — sparrow'],
    ['/docs/cli', 'CLI reference — Docs — sparrow'],
    ['/docs/mcp', 'MCP server — Docs — sparrow'],
    ['/docs/api', 'REST API — Docs — sparrow'],
    ['/docs/self-hosting', 'Self-hosting — Docs — sparrow'],
  ])('titles %s as "%s"', (path, title) => {
    renderAt(path);
    expect(document.title).toBe(title);
  });

  it('lets the sidebar navigate between pages', async () => {
    renderAt('/docs');
    expect(screen.getByRole('heading', { level: 1, name: /Getting started/i })).toBeInTheDocument();
    // Click the CLI reference link (first match = the sidebar nav item).
    const [cliLink] = screen.getAllByRole('link', { name: 'CLI reference' });
    await userEvent.click(cliLink!);
    expect(screen.getByRole('heading', { level: 1, name: /CLI reference/i })).toBeInTheDocument();
  });
});

// #50: /docs/api is ~20k characters of prose with 16 top-level sections and had
// neither anchors nor a way to jump. Anchors + TOC are produced by the SHARED
// docs layout, so every docs page gets them — these tests hold that line.
describe('docs anchors & table of contents', () => {
  const DOC_PATHS = ['/docs', '/docs/concepts', '/docs/cli', '/docs/mcp', '/docs/api', '/docs/self-hosting'];

  /** Content headings only — the TOC is a sibling `<aside>`, never inside <main>. */
  function contentHeadings(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('main h2, main h3'));
  }

  function tocLinks(container: HTMLElement): HTMLAnchorElement[] {
    return Array.from(
      container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="On this page"] a'),
    );
  }

  it.each(DOC_PATHS)('%s: every section heading carries a unique anchor id', async (path) => {
    const { container } = renderAt(path);
    await waitFor(() => expect(contentHeadings(container)[0]?.id).toBeTruthy());
    const ids = contentHeadings(container).map((h) => h.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !id)).toEqual([]);
    // Unique — two sections named the same still get distinct links.
    expect(new Set(ids).size).toBe(ids.length);
    // Slugs, not indexes: they must survive an edit elsewhere on the page.
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it.each(DOC_PATHS)('%s: the TOC lists exactly the page sections, in order', async (path) => {
    const { container } = renderAt(path);
    await waitFor(() => expect(tocLinks(container).length).toBeGreaterThan(0));
    const headings = contentHeadings(container);
    const links = tocLinks(container);
    expect(links.length).toBe(headings.length);
    links.forEach((a, i) => {
      const heading = headings[i]!;
      expect(a.getAttribute('href')).toBe(`#${heading.id}`);
      expect(a.textContent).toBe(heading.textContent!.replace(/\s+/g, ' ').trim());
    });
  });

  it('/docs/api: 17 top-level sections, including the #events-sse deep link', async () => {
    const { container } = renderAt('/docs/api');
    await waitFor(() => expect(tocLinks(container).length).toBeGreaterThan(0));
    const h2Ids = Array.from(container.querySelectorAll<HTMLElement>('main h2')).map((h) => h.id);
    expect(h2Ids.length).toBe(17);
    expect(h2Ids).toContain('events-sse');
    expect(h2Ids).toContain('rooms-members');
    // Voice (hands-free) joined the page with the v2 voice work.
    expect(h2Ids).toContain('voice-speech-in-speech-out');
    // The TOC link for it resolves to that exact heading.
    const link = tocLinks(container).find((a) => a.getAttribute('href') === '#events-sse');
    expect(link?.textContent).toBe('Events (SSE)');
  });

  it('switching pages rebuilds the TOC for the new page', async () => {
    const { container } = renderAt('/docs/api');
    await waitFor(() => expect(tocLinks(container).length).toBeGreaterThan(0));
    expect(tocLinks(container).some((a) => a.getAttribute('href') === '#events-sse')).toBe(true);

    const [mcpLink] = screen.getAllByRole('link', { name: 'MCP server' });
    await userEvent.click(mcpLink!);
    await waitFor(() =>
      expect(tocLinks(container).some((a) => a.getAttribute('href') === '#tools')).toBe(true),
    );
    expect(tocLinks(container).some((a) => a.getAttribute('href') === '#events-sse')).toBe(false);
  });

  describe('deep links', () => {
    let scrollIntoView: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scrollIntoView = vi.fn();
      // jsdom has no layout, so it ships no scrollIntoView at all.
      (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    });
    afterEach(() => {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    });

    it('/docs/api#events-sse scrolls to that section on load', async () => {
      const { container } = renderAt('/docs/api#events-sse');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      // The ids are written by the layout AFTER first paint, which is exactly
      // why the browser's own hash scroll misses and the layout redoes it.
      const target = container.querySelector('main h2#events-sse');
      expect(target).not.toBeNull();
      expect(scrollIntoView.mock.contexts[0]).toBe(target);
    });

    it('an unknown fragment is simply ignored (no throw, no scroll)', async () => {
      const { container } = renderAt('/docs/api#no-such-section');
      await waitFor(() => expect(tocLinks(container).length).toBeGreaterThan(0));
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });
});

describe('404', () => {
  it('renders the designed not-found page for unknown routes', async () => {
    renderAppAt('/nope/does-not-exist');
    // Non-docs routes render after the auth-mode boot fetch resolves.
    expect(await screen.findByText('404')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back home/i })).toBeInTheDocument();
  });

  it('renders not-found for /settings (instance-settings UI was removed)', async () => {
    renderAppAt('/settings');
    expect(await screen.findByText('404')).toBeInTheDocument();
  });
});
