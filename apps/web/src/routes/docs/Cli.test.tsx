import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Cli } from './Cli.js';

/**
 * The presence rule, stated the same way here, on the Getting started page, and
 * in the onboarding document served to agents at `GET /invite/:token`.
 */
const PRESENCE_RULE =
  'Always-running agents hold the events stream (sparrow watch / sparrow loop); ' +
  'turn-based agents arm sparrow await --timeout 900 and re-arm it every turn — never ' +
  'sparrow loop --exec as a wake mechanism; or the human runs sparrow harness and the ' +
  'agent never has to remember.';

function flatText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ');
}

describe('CLI reference — sparrow harness', () => {
  it('documents the command, its semantics and every flag', () => {
    const { container } = render(<Cli />);

    const heading = screen.getByRole('heading', { name: 'sparrow harness' });
    expect(heading).toBeInTheDocument();
    const section = heading.closest('section')!;

    // Synopsis block.
    const synopsis = section.querySelector('.terminal code')?.textContent ?? '';
    expect(synopsis).toContain('sparrow harness [--url URL]');
    expect(synopsis).toContain('--claude|--codex|--gemini|--exec CMD');

    // Semantics: who holds the loop, and the at-least-once ack.
    expect(section.textContent).toMatch(/holds the loop/i);
    expect(section.textContent).toMatch(/at-least-once/i);
    // …and that "did it fail?" is not the exit code alone any more.
    expect(section.textContent).toMatch(/turn\.failed/i);
    expect(section.textContent).toMatch(/claude and codex keep one conversation/i);

    // Flags table.
    const flags = [...section.querySelectorAll('td code')].map((c) => c.textContent ?? '');
    for (const f of [
      '--url URL',
      '--claude | --codex | --gemini | --exec CMD',
      '--model M',
      '--name N',
      '--cwd DIR',
      '--permission-mode MODE',
      '--sandbox MODE',
      '--yolo',
      '--no-resume',
      '--context N',
      '--run-timeout S',
      '--batch-window S',
      '--once',
      '-j',
      '-v',
    ]) {
      expect(flags).toContain(f);
    }

    // It sits with the other long-running listener commands, after `sparrow watch`.
    const watch = screen.getByRole('heading', { name: 'sparrow watch' });
    expect(watch.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).toBeTruthy();
  });
});

describe('CLI reference — the listener trio and the skill', () => {
  it('documents `sparrow await`: the wake primitive, with its exit-code contract', () => {
    render(<Cli />);
    const heading = screen.getByRole('heading', { name: 'sparrow await' });
    const section = heading.closest('section')!;
    const text = flatText(section);
    // It holds the stream (presence rides it) and EXITS when work is waiting…
    expect(text).toMatch(/turn-based/i);
    expect(text).toMatch(/exits/i);
    // …without consuming the item, so the agent still sees it.
    expect(text).toMatch(/does not consume|without consuming/i);
    // The exit codes a harness re-arms on.
    expect(text).toMatch(/\b0\b/);
    expect(text).toMatch(/re-arm/i);
    const flags = [...section.querySelectorAll('td code')].map((c) => c.textContent ?? '');
    expect(flags).toContain('--timeout S');
    // It sits with the other listeners, right after `sparrow watch`.
    const watch = screen.getByRole('heading', { name: 'sparrow watch' });
    expect(watch.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('documents `sparrow skill`, and never claims an `npx sparrow-skill` package', () => {
    const { container } = render(<Cli />);
    const heading = screen.getByRole('heading', { name: 'sparrow skill' });
    const section = heading.closest('section')!;
    const synopsis = section.querySelector('.terminal code')?.textContent ?? '';
    for (const sub of ['install', 'uninstall', 'pause', 'resume', 'status', 'verify']) {
      expect(synopsis).toContain(sub);
    }
    expect(flatText(section)).toMatch(/Claude Code/);
    // No such package is published; `install.sh` drops the wrapper instead.
    expect(flatText(container)).not.toContain('npx sparrow-skill');
  });

  /**
   * The skill is a TWO-provider thing now (Claude Code and Codex), and the
   * entry has to say which files each one gets, how the provider is chosen, and
   * — for Codex — the two manual trust steps plus the verify that proves the
   * hooks really fire. Live-verified against codex-cli 0.153.3.
   */
  it('names both skill providers, their flags, what each installs, and verify', () => {
    render(<Cli />);
    const section = screen.getByRole('heading', { name: 'sparrow skill' }).closest('section')!;
    const synopsis = section.querySelector('.terminal code')?.textContent ?? '';
    expect(synopsis).toContain('--codex');
    expect(synopsis).toContain('--claude');

    const text = flatText(section);
    expect(text).toMatch(/Claude Code/);
    expect(text).toMatch(/Codex/);

    // What each provider installs.
    expect(text).toContain('.claude/skills/sparrow/');
    expect(text).toContain('.claude/settings.local.json');
    expect(text).toContain('.agents/skills/sparrow/SKILL.md');
    expect(text).toContain('$sparrow');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('.codex/hooks.json');
    expect(text).toContain('.codex/config.toml');

    // How the provider is chosen: auto-detected, or named when ambiguous.
    expect(text).toMatch(/auto-detect/i);
    expect(text).toContain('.claude/');
    expect(text).toContain('.codex/');
    expect(text).toMatch(/ambiguous|both/i);

    // The two manual trust steps and their silent failure.
    expect(text).toMatch(/trust this folder/i);
    expect(text).toContain('~/.codex/config.toml');
    expect(text).toContain('trust_level = "trusted"');
    expect(text).toContain('/hooks');
    expect(text).toContain('--dangerously-bypass-hook-trust');
    expect(text).toMatch(/never fire/i);
    expect(text).toMatch(/no error message/i);

    // …which is why verify exists, and what it actually proves.
    expect(text).toContain('sparrow skill verify --codex');
    expect(text).toMatch(/really fire|actually fire|proves/i);
    expect(text).toContain('codex-cli 0.153.3');

    // Named in the flags table like every other flag on this page.
    const flags = [...section.querySelectorAll('td code')].map((c) => c.textContent ?? '');
    expect(flags).toContain('--codex | --claude');
  });

  it('states the presence rule in the one canonical sentence', () => {
    const { container } = render(<Cli />);
    expect(flatText(container)).toContain(PRESENCE_RULE);
  });

  // Canonical public homes (SPEC): one installer URL, on every instance.
  it('installs from the canonical URL, never a `<your-server>` placeholder', () => {
    const { container } = render(<Cli />);
    const install = [...container.querySelectorAll('.terminal code')]
      .map((c) => c.textContent ?? '')
      .find((t) => t.includes('install.sh'));
    expect(install).toBe('curl -fsSL https://sparrow.land/install.sh | sh');
    expect(flatText(container)).not.toContain('<your-server>');
  });

  it('uses a neutral example origin, never the marketing host', () => {
    const { container } = render(<Cli />);
    const text = flatText(container);
    expect(text).not.toContain('sparrow-hq.com');
    expect(text).toContain('https://sparrow.example.com');
  });

  it('never calls one way of connecting "recommended"', () => {
    const { container } = render(<Cli />);
    expect(flatText(container)).not.toMatch(/recommended/i);
  });
});
