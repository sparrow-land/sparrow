import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Cli } from './Cli.js';
import { serverOrigin } from '../../lib/origin.js';

/**
 * The presence rule, stated the same way here, on the Getting started page, and
 * in the onboarding document served to agents at `GET /invite/:token`.
 */
const PRESENCE_RULE =
  'Always-running agents hold the events stream (sparrow watch / sparrow loop); ' +
  'turn-based agents arm sparrow await and re-arm it every turn — never ' +
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
    expect(text).toContain('a successful empty check keeps waiting');
    expect(text).toContain('inbox check fails');
    expect(text).toContain('item:null');
    const flags = [...section.querySelectorAll('td code')].map((c) => c.textContent ?? '');
    expect(flags).toContain('--timeout S');
    // Exit 5: under Claude Code, a listener that cannot wake the session.
    expect(text).toMatch(/\b5 means\b/);
    expect(text).toMatch(/cannot wake your session/i);
    expect(flags).toContain('--allow-unowned');
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
    // `sparrow await` is a substring of the retired bounded form, so the
    // negative is the real fence: the page must never prescribe a timeout.
    expect(flatText(container)).not.toContain('--timeout 900');
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

  /**
   * Every example URL on this page is THIS instance's origin, so the reference
   * continues the walk the Getting started page begins (its `docker run` line
   * is the origin the published docs render). No marketing host, no invented
   * example host.
   */
  it('uses this instance’s own origin in its examples, never an invented host', () => {
    const { container } = render(<Cli />);
    const text = flatText(container);
    expect(text).not.toContain('sparrow-hq.com');
    expect(text).not.toContain('sparrow.example.com');
    const origin = serverOrigin();
    const terminals = [...container.querySelectorAll('.terminal code')].map(
      (c) => c.textContent ?? '',
    );
    expect(terminals.some((t) => t.includes(`${origin}/invite/ivk_`))).toBe(true);
    expect(terminals.some((t) => t.includes(origin))).toBe(true);
  });

  it('never calls one way of connecting "recommended"', () => {
    const { container } = render(<Cli />);
    expect(flatText(container)).not.toMatch(/recommended/i);
  });
});

describe('CLI reference — environment variables', () => {
  /**
   * A token alone is not a target: without SPARROW_SERVER the CLI stops with
   * "No server configured". The table says the two go together so a reader
   * who copies only SPARROW_TOKEN is not surprised (sparrow-land/sparrow#7).
   */
  it('says SPARROW_TOKEN needs SPARROW_SERVER alongside it', () => {
    const { container } = render(<Cli />);
    const row = [...container.querySelectorAll('tr')].find((tr) =>
      tr.querySelector('td code')?.textContent === 'SPARROW_TOKEN',
    );
    expect(row).toBeTruthy();
    expect(flatText(row!)).toMatch(/SPARROW_SERVER/);
    expect(flatText(row!)).toMatch(/No server configured/);
  });
});

describe('CLI reference — sparrow rooms', () => {
  /** `--all` lists PROJECT rooms only; DMs are never enumerated (sparrow-land/sparrow#7). */
  it('describes --all as the project-room list and never claims every room', () => {
    const { container } = render(<Cli />);
    const text = flatText(container);
    expect(text).toMatch(/every project room in the org/);
    expect(text).not.toMatch(/every room in the org/i);
    expect(text).toMatch(/DM rooms are never listed/);
  });
});

describe('CLI reference — agent visibility (tags, messaging, grants, stats)', () => {
  const section = (name: string) => screen.getByRole('heading', { name }).closest('section')!;
  const synopsisOf = (s: Element) => s.querySelector('.terminal code')?.textContent ?? '';

  it('documents sparrow tags with its set/add/rm forms, defaulting to yourself', () => {
    render(<Cli />);
    const s = section('sparrow tags');
    const syn = synopsisOf(s);
    expect(syn).toContain('sparrow tags [<agent>]');
    for (const verb of ['set', 'add', 'rm']) expect(syn).toContain(`sparrow tags ${verb} <agent> <tag…>`);
    expect(flatText(s)).toMatch(/yourself/i);
    expect(flatText(s)).toMatch(/at most 10/);
  });

  it('documents sparrow messaging with its three values', () => {
    render(<Cli />);
    const s = section('sparrow messaging');
    expect(synopsisOf(s)).toContain('sparrow messaging <agent> [any|tags|none]');
    const text = flatText(s);
    for (const v of ['any', 'tags', 'none']) expect(text).toContain(v);
    expect(text).toMatch(/both/i);
  });

  it('documents sparrow grants ls/add/rm and the two scopes', () => {
    render(<Cli />);
    const s = section('sparrow grants');
    const syn = synopsisOf(s);
    expect(syn).toContain('sparrow grants [ls]');
    expect(syn).toContain('sparrow grants add <principal> tags:*|tag:<slug>');
    expect(syn).toContain('sparrow grants rm <grantId>');
    expect(flatText(s)).toContain('grt_');
  });

  it('documents sparrow stats with --window and says tokens are estimated', () => {
    render(<Cli />);
    const s = section('sparrow stats');
    expect(synopsisOf(s)).toContain('sparrow stats [<agent>] [--window 24h|7d|30d|all]');
    const flags = [...s.querySelectorAll('td code')].map((c) => c.textContent ?? '');
    expect(flags).toContain('--window W');
    expect(flatText(s)).toMatch(/estimated from message text/i);
  });

  it('shows a stats example whose numbers add up the way the server counts them', () => {
    render(<Cli />);
    const blocks = [...section('sparrow stats').querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
    const example = blocks.find((b) => b.includes('in DMs'))!;
    const row = (label: string) => {
      const m = example.match(new RegExp(`^${label}\\s+(\\d+)`, 'm'));
      expect(m, label).toBeTruthy();
      return Number(m![1]);
    };
    expect(row('in DMs')).toBe(row('with agents') + row('with humans'));
    expect(row('sent') + row('received')).toBe(row('in DMs') + row('in rooms'));
  });

  it('explains the 403 hints once, and places the section after sparrow unshare', () => {
    render(<Cli />);
    const text = flatText(section('sparrow tags').parentElement!);
    expect(text).toContain("you can't change your own settings");
    const unshare = screen.getByRole('heading', { name: 'sparrow unshare' });
    const tags = screen.getByRole('heading', { name: 'sparrow tags' });
    expect(unshare.compareDocumentPosition(tags) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
