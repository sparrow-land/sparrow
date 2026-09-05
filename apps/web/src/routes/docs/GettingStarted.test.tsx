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

/** The raw text inside the Terminal block whose <code> matches `needle`. */
function terminalContaining(container: HTMLElement, needle: string): string {
  const blocks = [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
  const hit = blocks.find((t) => t.includes(needle));
  if (!hit) throw new Error(`no terminal block containing "${needle}"`);
  return hit;
}

/**
 * The presence rule, stated the same way here, in the CLI reference, and in the
 * onboarding document served to agents at `GET /invite/:token`. If it drifts in
 * one place it is two stories again.
 */
const PRESENCE_RULE =
  'Always-running agents hold the events stream (sparrow watch / sparrow loop); ' +
  'turn-based agents arm sparrow await --timeout 900 and re-arm it every turn — never ' +
  'sparrow loop --exec as a wake mechanism; or the human runs sparrow harness and the ' +
  'agent never has to remember.';

/** Page text with whitespace collapsed, so a sentence split across elements still matches. */
function flatText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

describe('Getting started — connecting an agent', () => {
  /**
   * ONE STORY, TWO AXES. First the human picks WHO HOLDS THE LOOP (harness or
   * inline); only an inline agent then picks HOW IT TALKS to the API, and those
   * three choices carry the same names as the onboarding doc's Path 1/2/3
   * headings. No A/B/C letters — they collided with that numbering.
   */
  it('puts the who-holds-the-loop choice first: harness, then inline', () => {
    renderPage();
    const names = [/^harness — sparrow holds the loop$/i, /^inline — your agent holds the loop$/i];
    const found = names.map((n) => screen.getByRole('heading', { name: n }));
    expect(
      found[0]!.compareDocumentPosition(found[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('drops the Option A/B/C letters that collided with the onboarding doc', () => {
    const { container } = renderPage();
    expect(flatText(container)).not.toMatch(/Option [ABC]/);
  });

  it('offers "how it talks" only under inline, using the onboarding doc’s path labels', () => {
    const { container } = renderPage();
    const how = screen.getByRole('heading', { name: /how an inline agent talks to the api/i });
    const inline = screen.getByRole('heading', { name: /^inline — your agent holds the loop$/i });
    expect(inline.compareDocumentPosition(how) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The three labels, verbatim as the onboarding doc's headings.
    for (const label of [
      'Path 1 — raw HTTP (no install)',
      'Path 2 — the CLI',
      'Path 3 — CLI + the sparrow skill',
    ]) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    }
    // All three transports of that axis are named: CLI, MCP, raw HTTP.
    expect(flatText(container)).toMatch(/MCP/);
  });

  /**
   * Path 3 stopped being Claude-Code-only when the sparrow skill grew a Codex
   * adapter — the tier heading is provider-neutral (it matches the onboarding
   * doc's heading verbatim) and each provider gets its own sub-step.
   */
  it('Path 3 names both providers, each with its own sub-step', () => {
    const { container } = renderPage();
    const path3 = screen.getByRole('heading', { name: 'Path 3 — CLI + the sparrow skill' });
    expect(flatText(container)).not.toContain('Path 3 — CLI + the sparrow skill (Claude Code)');

    const claude = screen.getByRole('heading', { name: /^claude code$/i });
    const codex = screen.getByRole('heading', { name: /^codex$/i });
    for (const h of [claude, codex]) {
      expect(path3.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(claude.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const text = flatText(container);
    // Claude Code, unchanged in substance.
    expect(text).toContain('.claude/skills/sparrow/');
    expect(text).toContain('.claude/settings.local.json');
    // Codex: the install, what it writes, the two manual trust steps, verify.
    expect(text).toContain('sparrow skill install --codex');
    expect(text).toContain('.agents/skills/sparrow/SKILL.md');
    expect(text).toContain('$sparrow');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('.codex/hooks.json');
    expect(text).toContain('.codex/config.toml');
    expect(text).toMatch(/trust this folder/i);
    expect(text).toContain('trust_level = "trusted"');
    expect(text).toContain('--dangerously-bypass-hook-trust');
    expect(text).toMatch(/never fire/i);
    expect(text).toMatch(/no error message/i);
    expect(text).toContain('sparrow skill verify --codex');
    expect(text).toContain('codex-cli 0.153.3');
    // The one honest gap on Codex.
    expect(text).toMatch(/no Notification event/i);
  });

  it('draws the who-holds-the-loop figure above the two modes', () => {
    const { container } = renderPage();
    const figure = container.querySelector('svg[viewBox="0 0 640 252"]');
    expect(figure).toBeTruthy();
    const harness = screen.getByRole('heading', { name: /^harness — sparrow holds the loop$/i });
    expect(
      figure!.compareDocumentPosition(harness) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the two-command harness block', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, 'sparrow harness');
    expect(code).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
    expect(code).toMatch(/sparrow harness --url http.*\/invite\/ivk_/);
  });

  /**
   * Canonical public homes (SPEC): the installer has ONE address. A per-instance
   * `curl <this server>/install.sh` taught every reader a different command —
   * and an instance does not serve the file at all any more, it redirects.
   */
  it('installs from the one canonical URL, never this instance', () => {
    const { container } = renderPage();
    const blocks = [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
    const installs = blocks.filter((t) => t.includes('install.sh'));
    expect(installs.length).toBeGreaterThan(0);
    for (const code of installs) {
      expect(code).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
      expect(code).not.toContain(`${serverOrigin()}/install.sh`);
    }
  });

  it('keeps instance-relative examples for what the instance really owns', () => {
    const { container } = renderPage();
    const blocks = [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
    expect(blocks.some((t) => t.includes(`${serverOrigin()}/api/v1/`))).toBe(true);
    expect(blocks.some((t) => t.includes(`${serverOrigin()}/invite/`))).toBe(true);
  });

  it('states the harness robustness facts and the cron flag', () => {
    renderPage();
    expect(screen.getByText(/only after the reply is posted/i)).toBeInTheDocument();
    expect(screen.getByText(/session per room/i)).toBeInTheDocument();
    expect(screen.getByText(/handles what is waiting and exits/i)).toBeInTheDocument();
  });

  it('says harness does not host the agent — the machine still has to stay up', () => {
    const { container } = renderPage();
    expect(flatText(container)).toMatch(/machine you pick still has to stay up/i);
  });

  it('states the presence rule in the one canonical sentence', () => {
    const { container } = renderPage();
    expect(flatText(container)).toContain(PRESENCE_RULE);
  });

  it('never calls one way of connecting "recommended"', () => {
    const { container } = renderPage();
    expect(flatText(container)).not.toMatch(/recommended/i);
  });

  it('keeps the rest of the happy path', () => {
    renderPage();
    for (const h of [/1 · sign up/i, /2 · invite someone/i, /4 · dm your agent/i, /5 · create a room/i, /action reference/i]) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
    }
  });
});
