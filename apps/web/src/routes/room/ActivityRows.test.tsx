import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActivityEntry } from '@sparrow/common-types';
import { activityEntry, hintEntry } from '../../test/fixtures.js';
import { ActivityRow, HintEntryCard } from './ActivityRows.js';

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

/**
 * Did the agent ACT on what it was told? The server judges a delivery and the
 * row wears the verdict as a quiet annotation — never an alert, and never the
 * word "unknown": a hint the server could not judge (or one delivered before
 * deliveries were tracked) renders exactly as it does today, badgeless. Absence
 * is the honest rendering of "we don't know".
 *
 * The wire fields (`hint.deliveryId`, `hint.resolution`) are owned by the API;
 * this file mocks them onto the entry until common-types carries them.
 */
const DELIVERED_AT = '2026-08-31T12:04:00Z'; // the fixture entry's createdAt

function judged(
  resolution: unknown,
  extra: { deliveryId?: string } = { deliveryId: 'hdl_1' },
): ActivityEntry {
  const base = hintEntry({
    summary: OWNER_LABEL,
    hint: { id: 'upgrade-your-cli', text: VERBATIM },
    createdAt: DELIVERED_AT,
  });
  return {
    ...base,
    hint: { ...base.hint!, ...extra, resolution },
  } as ActivityEntry;
}

describe('HintEntryCard — hint resolution badge', () => {
  it('resolved: a subdued check with how long the agent took', () => {
    const entry = judged({ state: 'resolved', resolvedAt: '2026-08-31T12:04:10Z' });
    render(<HintEntryCard entry={entry} nowMs={NOW} />);
    const badge = screen.getByTestId('hint-resolution');
    expect(badge).toHaveAttribute('data-state', 'resolved');
    expect(badge).toHaveTextContent('done · 10s later');
    // Quiet: the row's faintest metadata tone and size — the timestamp's own.
    expect(badge.className).toContain('text-[10.5px]');
    expect(badge.className).toContain('text-[var(--sparrow-faint)]');
    // …and no alarm colours borrowed from the danger/accent pills.
    expect(badge.className).not.toContain('--sparrow-danger');
    expect(badge.className).not.toContain('--sparrow-accent');
  });

  it('resolved: the gap scales with the delta (minutes, hours, days)', () => {
    for (const [resolvedAt, expected] of [
      ['2026-08-31T12:06:00Z', 'done · 2m later'],
      ['2026-08-31T15:04:00Z', 'done · 3h later'],
      ['2026-09-02T12:04:00Z', 'done · 2d later'],
    ] as const) {
      const { unmount } = render(
        <HintEntryCard entry={judged({ state: 'resolved', resolvedAt })} nowMs={NOW} />,
      );
      expect(screen.getByTestId('hint-resolution')).toHaveTextContent(expected);
      unmount();
    }
  });

  it('resolved with a nonsensical or missing time: plain "done", no fake gap', () => {
    for (const resolution of [
      { state: 'resolved', resolvedAt: '2026-08-31T11:00:00Z' }, // before delivery
      { state: 'resolved', resolvedAt: 'not-a-date' },
      { state: 'resolved' }, // no timestamp at all
    ]) {
      const { unmount } = render(<HintEntryCard entry={judged(resolution)} nowMs={NOW} />);
      const badge = screen.getByTestId('hint-resolution');
      expect(badge).toHaveTextContent(/^done$/);
      expect(badge.textContent).not.toContain('later');
      unmount();
    }
  });

  it('unresolved: a quiet "not yet" — information, not an error', () => {
    render(<HintEntryCard entry={judged({ state: 'unresolved' })} nowMs={NOW} />);
    const badge = screen.getByTestId('hint-resolution');
    expect(badge).toHaveAttribute('data-state', 'unresolved');
    expect(badge).toHaveTextContent('not yet');
    expect(badge.className).toContain('text-[var(--sparrow-faint)]');
    expect(badge.className).not.toContain('--sparrow-danger');
  });

  it('never renders the word "unknown", and shows nothing when the server could not judge', () => {
    render(<HintEntryCard entry={judged({ state: 'unknown' })} nowMs={NOW} />);
    expect(screen.queryByTestId('hint-resolution')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
  });

  it('legacy entries — no deliveryId, no resolution, no hint payload — wear no badge', () => {
    // Judged, but from before deliveries were tracked: nothing to point at.
    const { unmount } = render(
      <HintEntryCard entry={judged({ state: 'resolved' }, {})} nowMs={NOW} />,
    );
    expect(screen.queryByTestId('hint-resolution')).not.toBeInTheDocument();
    unmount();

    // Delivered and tracked, but never judged.
    const { unmount: unmount2 } = render(
      <HintEntryCard entry={judged(undefined)} nowMs={NOW} />,
    );
    expect(screen.queryByTestId('hint-resolution')).not.toBeInTheDocument();
    unmount2();

    // The oldest rows of all: no `hint` payload whatsoever, unchanged.
    render(<HintEntryCard entry={hintEntry({ hint: undefined })} nowMs={NOW} />);
    expect(screen.queryByTestId('hint-resolution')).not.toBeInTheDocument();
  });

  it('the badge rides the collapsed row, alongside the summary and the age', () => {
    render(
      <HintEntryCard
        entry={judged({ state: 'resolved', resolvedAt: '2026-08-31T12:04:10Z' })}
        nowMs={NOW}
      />,
    );
    const row = screen.getByRole('button');
    expect(row).toContainElement(screen.getByTestId('hint-resolution'));
    // The owner-framed sentence and the entry's own age are untouched.
    expect(screen.getByText(OWNER_LABEL)).toBeInTheDocument();
    expect(screen.getByText('26m ago')).toBeInTheDocument();
  });

  it('non-hint rows are untouched by any of this', () => {
    render(
      <ActivityRow
        row={{ kind: 'email', key: 'k', entry: activityEntry() }}
        orgId="org_1"
        agentId="agt_1"
        nowMs={NOW}
      />,
    );
    expect(screen.queryByTestId('hint-resolution')).not.toBeInTheDocument();
    expect(screen.getByText('Re: Q3 rollout')).toBeInTheDocument();
  });
});
