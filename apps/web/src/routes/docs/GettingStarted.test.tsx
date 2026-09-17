import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GettingStarted } from './GettingStarted.js';
import { serverOrigin } from '../../lib/origin.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <GettingStarted />
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

/**
 * The presence rule, stated the same way here, in the CLI reference, and in the
 * onboarding document served to agents at `GET /invite/:token`. If it drifts in
 * one place it is two stories again.
 */
const PRESENCE_RULE =
  'Always-running agents hold the events stream (sparrow watch / sparrow loop); ' +
  'turn-based agents arm sparrow await and re-arm it every turn — never ' +
  'sparrow loop --exec as a wake mechanism; or the human runs sparrow harness and the ' +
  'agent never has to remember.';

describe('Getting started', () => {
  it('opens with the five-minute promise', () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Getting started' })).toBeInTheDocument();
    expect(flatText(container)).toContain('Five minutes from nothing to an agent you can message.');
  });

  /**
   * The page is a numbered walk, and the numbers are part of the headings so
   * the TOC rail reads as the walk too. Exact list, exact order.
   */
  it('walks six numbered steps, in order', () => {
    const { container } = renderPage();
    expect(headingTexts(container, 'h2')).toEqual([
      '1. Run the server',
      '2. Sign up',
      '3. Make an invite',
      '4. Connect an agent',
      '5. Say hello',
      '6. Make a room',
    ]);
  });

  it('starts the server with the one docker run line', () => {
    const { container } = renderPage();
    expect(terminalContaining(container, 'docker run')).toContain(
      'docker run -p 8722:8722 -v sparrow-data:/data ghcr.io/sparrow-land/sparrow',
    );
  });

  it('sends the reader to THIS instance to sign up', () => {
    const { container } = renderPage();
    const origin = serverOrigin();
    const link = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === origin);
    expect(link, `no link to ${origin}`).toBeTruthy();
    expect(flatText(container)).toMatch(/first account on a fresh instance owns the workspace/i);
  });

  it('shows an invite URL on this instance, and says fetching enrolls nobody', () => {
    const { container } = renderPage();
    expect(terminals(container).some((t) => t.includes(`${serverOrigin()}/invite/`))).toBe(true);
    const text = flatText(container);
    expect(text).toMatch(/plain-text onboarding doc/i);
    expect(text).toMatch(/Fetching never enrolls anyone by itself/i);
  });

  /**
   * Three modes, in the README's order: less machinery first, most robust last.
   * The headings match the README's bold leads word for word.
   */
  it('names the three connect modes in the README’s order', () => {
    const { container } = renderPage();
    expect(headingTexts(container, 'h3')).toEqual([
      'No-dependency mode',
      'CLI and hooks mode',
      'Harness mode',
    ]);
  });

  /**
   * Each mode is tied to the numbered path the agent will read in its own
   * onboarding doc — once each, so the two documents can be matched up without
   * this page re-telling the doc.
   */
  it('ties each mode to the onboarding doc’s path number exactly once', () => {
    const { container } = renderPage();
    const text = flatText(container);
    for (const path of ['Path 1', 'Path 2', 'Path 3']) {
      expect(text.match(new RegExp(path, 'g')) ?? [], `${path} count`).toHaveLength(1);
    }
  });

  it('calls the CLI path recommended, as the README does', () => {
    const { container } = renderPage();
    expect(flatText(container)).toMatch(/recommended/i);
  });

  /**
   * Canonical public homes (SPEC): the installer has ONE address. A per-instance
   * `curl <this server>/install.sh` taught every reader a different command —
   * and an instance does not serve the file at all any more, it redirects.
   */
  it('installs from the one canonical URL, never this instance', () => {
    const { container } = renderPage();
    const installs = terminals(container).filter((t) => t.includes('install.sh'));
    expect(installs.length).toBeGreaterThan(0);
    for (const code of installs) {
      expect(code).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
      expect(code).not.toContain(`${serverOrigin()}/install.sh`);
    }
  });

  it('shows the CLI enroll-and-listen block and the two-line harness block', () => {
    const { container } = renderPage();
    const cli = terminalContaining(container, 'sparrow enroll');
    expect(cli).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
    expect(cli).toMatch(/sparrow enroll http.*\/invite\/ivk_/);
    expect(cli).toContain('sparrow await');

    const harness = terminalContaining(container, 'sparrow harness --url');
    expect(harness).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
    expect(harness).toMatch(/sparrow harness --url http.*\/invite\/ivk_/);
  });

  it('states the presence rule in the one canonical sentence', () => {
    const { container } = renderPage();
    expect(flatText(container)).toContain(PRESENCE_RULE);
    // `sparrow await` is a substring of the retired bounded form, so the
    // negative is the real fence: the page must never prescribe a timeout.
    expect(flatText(container)).not.toContain('--timeout 900');
  });

  it('tells the reader to approve the enrollment', () => {
    const { container } = renderPage();
    expect(flatText(container)).toMatch(/approve the enrollment/i);
    expect(flatText(container)).toContain('sparrow requests approve');
  });

  /** The Codex trust dance belongs to the CLI reference; this page only links it. */
  it('leaves the Codex trust steps to the CLI reference', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).not.toContain('.codex/hooks.json');
    expect(text).not.toContain('trust_level');
    expect(text).not.toContain('--dangerously-bypass-hook-trust');
    expect(container.querySelector('a[href="/docs/cli"]')).toBeTruthy();
  });

  it('says hello over a DM and then builds a room', () => {
    const { container } = renderPage();
    expect(terminalContaining(container, 'sparrow dm')).toContain(
      'sparrow dm my-agent "hello, are you receiving?"',
    );
    const room = terminalContaining(container, 'sparrow room create');
    expect(room).toContain('sparrow room add my-agent --room build-crew');
    expect(room).toContain('sparrow send all "welcome to the crew" --room build-crew');
    expect(flatText(container)).toMatch(/Rooms have no door/);
    expect(container.querySelector('a[href="/docs/concepts"]')).toBeTruthy();
  });

  it('closes by pointing at the CLI, API and self-hosting pages', () => {
    const { container } = renderPage();
    for (const href of ['/docs/cli', '/docs/api', '/docs/self-hosting']) {
      expect(container.querySelector(`a[href="${href}"]`), href).toBeTruthy();
    }
  });

  /**
   * The old page had grown to ~1,900 words: an HTTP signup curl, a four-column
   * action table, and the Codex trust steps duplicated from the CLI page. A
   * first page nobody finishes teaches nothing, so its length is a contract.
   */
  it('stays a five-minute read', () => {
    const { container } = renderPage();
    const words = flatText(container).trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(600);
    expect(words).toBeLessThanOrEqual(750);
  });

  it('drops the old page’s structure', () => {
    const { container } = renderPage();
    const text = flatText(container);
    for (const gone of [
      '1 · Sign up',
      'Action reference',
      'Harness — sparrow holds the loop',
      'Inline — your agent holds the loop',
      'How an inline agent talks to the API',
    ]) {
      expect(text, gone).not.toContain(gone);
    }
    // No HTTP signup curl, no ACTIONS table.
    expect(text).not.toContain('/api/v1/auth/signup');
    expect(container.querySelector('table')).toBeNull();
  });
});
