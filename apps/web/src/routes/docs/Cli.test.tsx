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

    // Flags table.
    const flags = [...section.querySelectorAll('td code')].map((c) => c.textContent ?? '');
    for (const f of [
      '--url URL',
      '--claude | --codex | --gemini | --exec CMD',
      '--model M',
      '--name N',
      '--cwd DIR',
      '--permission-mode MODE',
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
    for (const sub of ['install', 'uninstall', 'pause', 'resume', 'status']) {
      expect(synopsis).toContain(sub);
    }
    expect(flatText(section)).toMatch(/Claude Code/);
    // No such package is published; `install.sh` drops the wrapper instead.
    expect(flatText(container)).not.toContain('npx sparrow-skill');
  });

  it('states the presence rule in the one canonical sentence', () => {
    const { container } = render(<Cli />);
    expect(flatText(container)).toContain(PRESENCE_RULE);
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
