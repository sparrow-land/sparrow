import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusIndicator, WorkingBubble, PresenceGlyph, RoomBusyGlyph } from './StatusIndicator.js';

describe('StatusIndicator', () => {
  it('renders "working" plus the note (no gear — the ring carries busy now)', () => {
    render(<StatusIndicator note="thinking" />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('working');
    expect(el).toHaveTextContent('thinking');
    expect(el).toHaveAttribute('aria-label', 'working — thinking');
    // The old ⚙ marker is gone — busy is shown by the glyph ring.
    expect(el.textContent).not.toContain('⚙');
  });

  it('renders without a note', () => {
    render(<StatusIndicator note={null} />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('working');
    expect(el).toHaveAttribute('aria-label', 'working');
  });

  it('folds a member label into the text and the accessible name', () => {
    render(<StatusIndicator note="reviewing" label="deploy-bot" />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('deploy-bot');
    expect(el).toHaveTextContent('working');
    expect(el).toHaveAttribute('aria-label', 'deploy-bot — working — reviewing');
  });

  it('appends a muted staleness suffix once the status text is old (~2m+)', () => {
    const nowMs = Date.now();
    render(<StatusIndicator note="digging" sinceMs={nowMs - 25 * 60_000} nowMs={nowMs} />);
    const el = screen.getByRole('status');
    // "working — digging — 25m", with the age in the accessible name too.
    expect(el).toHaveTextContent('25m');
    expect(el).toHaveAttribute('aria-label', 'working — digging — 25m');
    // The age is rendered in the muted token, not the accent.
    const age = screen.getByText('25m');
    expect(age.className).toContain('sparrow-muted');
  });

  it('shows no staleness suffix while the status is still fresh (<2m)', () => {
    const nowMs = Date.now();
    render(<StatusIndicator note="digging" sinceMs={nowMs - 30_000} nowMs={nowMs} />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-label', 'working — digging');
    expect(el.textContent).not.toMatch(/\d+[mhd]$/);
  });
});

describe('WorkingBubble', () => {
  it('renders an iMessage-style typing bubble with the working label + note', () => {
    render(<WorkingBubble note="thinking" />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('working');
    expect(el).toHaveTextContent('thinking');
    expect(el).toHaveAttribute('aria-label', 'working — thinking');
  });

  it('renders three animated typing dots (motion-safe)', () => {
    const { container } = render(<WorkingBubble note={null} />);
    const dots = container.querySelectorAll('[class*="animate-bounce"]');
    expect(dots).toHaveLength(3);
    // Every dot also opts out under reduced motion.
    dots.forEach((d) => expect(d.className).toContain('motion-reduce:animate-none'));
  });

  it('renders without a note', () => {
    render(<WorkingBubble note={null} />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('working');
    expect(el).toHaveAttribute('aria-label', 'working');
  });

  it('names the working member when given a label (project-room usage)', () => {
    render(<WorkingBubble note="building" label="Ann" />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('Ann');
    expect(el).toHaveAttribute('aria-label', 'Ann — working — building');
  });
});

describe('PresenceGlyph', () => {
  it('labels an online, non-busy member "online"', () => {
    render(<PresenceGlyph presence="online" busy={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'online');
  });

  it('folds the busy axis into the label (still discoverable as "working")', () => {
    render(<PresenceGlyph presence="online" busy />);
    const el = screen.getByRole('img');
    expect(el).toHaveAttribute('aria-label', 'online + working');
    expect(screen.getByLabelText(/working/i)).toBe(el);
  });

  it('carries the "active" state and its relative time in the label', () => {
    render(<PresenceGlyph presence="active" busy={false} activeAgo="3m ago" />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'active 3m ago');
  });

  it('labels an offline member "offline"', () => {
    render(<PresenceGlyph presence="offline" busy={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'offline');
  });

  // Issue #46: the dot must never be colour-only. Both axes of the name are
  // asserted for BOTH states: the exposed role + aria-label for assistive tech,
  // and the `title` so a sighted mouse user can read the state too.
  it.each(['online', 'offline'] as const)('names the %s dot for eye and screen reader', (state) => {
    render(<PresenceGlyph presence={state} busy={false} />);
    const dot = screen.getByRole('img');
    expect(dot).toHaveAttribute('aria-label', state);
    expect(dot).toHaveAttribute('title', state);
    // The coloured pip itself stays decorative — the name lives on the wrapper.
    expect(dot.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('RoomBusyGlyph', () => {
  it('renders a labelled busy marker for a room node', () => {
    render(<RoomBusyGlyph />);
    expect(screen.getByLabelText(/working/i)).toBeInTheDocument();
  });
});
