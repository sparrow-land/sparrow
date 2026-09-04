import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { hintEntry } from '../../test/fixtures.js';
import { HintEntryCard } from './ActivityRows.js';

/**
 * The HINT INFO BOX — sparrow speaking to the owner about what it taught their
 * agent. The collapsed row is the OWNER'S framing (the trigger's server-side
 * `ownerLabel`, carried as the entry summary): a human-readable third-person
 * sentence, never the agent-directed imperative. Expanding — the same in-place
 * affordance as the email card — reveals the VERBATIM text conveyed to the
 * agent, from the entry's `hint` payload.
 */

const NOW = Date.parse('2026-08-31T12:30:00Z');

const OWNER_LABEL = 'Sparrow hinted the agent to advertise a working status while it is on a job.';
const VERBATIM =
  "You're working with no status advertised — your human can't tell you're on it.";

function payloadEntry() {
  return hintEntry({
    summary: OWNER_LABEL,
    hint: { id: 'set-a-status', text: VERBATIM },
  });
}

describe('HintEntryCard (the Hint info box)', () => {
  it('collapsed: type mark + the owner-framed sentence, not the agent text', () => {
    render(<HintEntryCard entry={payloadEntry()} nowMs={NOW} />);
    // The type identity: bold "Hint" label in the hint tone, from the registry.
    const glyph = screen.getByTestId('medium-glyph');
    expect(glyph).toHaveAttribute('data-medium', 'system');
    expect(glyph).toHaveTextContent('Hint');
    expect(glyph.style.color).toBe('var(--sparrow-type-hint)');
    // The human reads the third-person frame…
    expect(screen.getByText(OWNER_LABEL)).toBeInTheDocument();
    // …and is NOT dumped the agent-directed imperative.
    expect(screen.queryByText(VERBATIM)).not.toBeInTheDocument();
  });

  it('expands in place to reveal the verbatim text conveyed to the agent', async () => {
    const user = userEvent.setup();
    render(<HintEntryCard entry={payloadEntry()} nowMs={NOW} />);
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('aria-expanded', 'false');

    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    // The expanded meta repeats the register in words (same rule as email).
    expect(screen.getByTestId('medium-mark')).toHaveAttribute('data-medium', 'system');
    // The verbatim payload, attributed as what the agent was told…
    expect(screen.getByText(VERBATIM)).toBeInTheDocument();
    expect(screen.getByText(/told the agent/i)).toBeInTheDocument();
    // …with the trigger id for the owner who wants to look it up.
    expect(screen.getByText('set-a-status')).toBeInTheDocument();

    // A second click collapses (per-entry, not persisted — same as email).
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(VERBATIM)).not.toBeInTheDocument();
  });

  it('is a borderless Tinted Etch box in the hint tone', () => {
    // The container: no hairline, no panel fill — the box's ground is its own
    // type tone (wash + tone hatch, drawn by `.info-box` off `--info-tone`).
    const { container } = render(<HintEntryCard entry={payloadEntry()} nowMs={NOW} />);
    const box = container.querySelector<HTMLElement>('.info-box');
    expect(box).not.toBeNull();
    expect(box!.style.getPropertyValue('--info-tone')).toBe('var(--sparrow-type-hint)');
    expect(box!.className).not.toContain('border-[var(--sparrow-border)]');
    expect(box!.className).not.toContain('bg-[var(--sparrow-panel)]');
  });

  it('renders at the full compact density — tight row, type a notch down, mark unshrunk', () => {
    // Hints take the compact density whole (~28px rows): the whisper register.
    render(<HintEntryCard entry={payloadEntry()} nowMs={NOW} />);
    const row = screen.getByRole('button');
    expect(row.className).toContain('py-[5px]');
    expect(screen.getByText(OWNER_LABEL).className).toContain('text-xs');
    // The type label holds its 10px — identity never shrinks with density.
    const label = screen.getByTestId('medium-glyph').querySelector('span')!;
    expect(label.className).toContain('text-[10px]');
  });

  it('an entry without a hint payload (pre-payload rows) is not expandable', () => {
    const legacy = hintEntry({
      summary: 'set-a-status — Set a working status so your humans see progress.',
      hint: undefined,
    });
    render(<HintEntryCard entry={legacy} nowMs={NOW} />);
    // Nothing hidden → no affordance pretending otherwise.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.getByText(/set-a-status — Set a working status/),
    ).toBeInTheDocument();
  });

  it('a non-expandable legacy row wears the same etched container and density', () => {
    const legacy = hintEntry({ summary: 'legacy hint', hint: undefined });
    const { container } = render(<HintEntryCard entry={legacy} nowMs={NOW} />);
    const box = container.querySelector<HTMLElement>('.info-box');
    expect(box).not.toBeNull();
    expect(box!.style.getPropertyValue('--info-tone')).toBe('var(--sparrow-type-hint)');
    expect(box!.className).toContain('py-[5px]');
  });
});
