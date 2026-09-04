import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoopModeArt } from './LoopModeArt.js';

describe('LoopModeArt', () => {
  it('renders the inline mode with the ring on the agent and the arrow pointing at sparrow', () => {
    const { container } = render(<LoopModeArt mode="inline" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toMatch(/agent/i);

    const ring = container.querySelector('[data-part="ring"]')!;
    expect(ring.getAttribute('data-holder')).toBe('agent');
    const arrow = container.querySelector('[data-part="call-arrow"]')!;
    expect(arrow.getAttribute('data-from')).toBe('agent');
    expect(arrow.getAttribute('data-to')).toBe('sparrow');
  });

  it('renders the harness mode with the ring on sparrow and the arrow pointing at the agent', () => {
    const { container } = render(<LoopModeArt mode="harness" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toMatch(/sparrow/i);

    const ring = container.querySelector('[data-part="ring"]')!;
    expect(ring.getAttribute('data-holder')).toBe('sparrow');
    const arrow = container.querySelector('[data-part="call-arrow"]')!;
    expect(arrow.getAttribute('data-from')).toBe('sparrow');
    expect(arrow.getAttribute('data-to')).toBe('agent');
  });

  it('labels both actors in the card size', () => {
    render(<LoopModeArt mode="harness" size="card" />);
    expect(screen.getByText('sparrow')).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('calls')).toBeInTheDocument();
  });

  it('uses the ~200x90 viewBox for the card size', () => {
    const { container } = render(<LoopModeArt mode="inline" size="card" />);
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 200 90');
  });

  it('draws both halves, frames, command labels and captions in the figure size', () => {
    const { container } = render(<LoopModeArt mode="harness" size="figure" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 252');

    // both halves present
    expect(container.querySelector('[data-half="inline"]')).toBeTruthy();
    expect(container.querySelector('[data-half="harness"]')).toBeTruthy();

    // each half wrapped in a dashed "your machine" frame
    expect(container.querySelectorAll('[data-part="machine-frame"]')).toHaveLength(2);
    expect(screen.getAllByText('your machine')).toHaveLength(2);

    // command labels under each arrow
    expect(screen.getByText('read()')).toBeInTheDocument();
    expect(screen.getByText('claude -p')).toBeInTheDocument();

    // one sentence of caption per half (line-broken by hand — SVG text never wraps)
    const caption = (half: string) =>
      Array.from(
        container.querySelectorAll(`[data-half="${half}"] [data-part="caption"] text`),
      )
        .map((t) => t.textContent)
        .join(' ');
    expect(caption('inline')).toBe(
      'The agent holds the loop and calls Sparrow when it remembers to.',
    );
    expect(caption('harness')).toBe(
      "Sparrow's CLI holds the loop and calls the agent for every message.",
    );
  });

  it('puts the ring on the right actor in each half of the figure', () => {
    const { container } = render(<LoopModeArt mode="inline" size="figure" />);
    const inlineRing = container.querySelector('[data-half="inline"] [data-part="ring"]')!;
    const harnessRing = container.querySelector('[data-half="harness"] [data-part="ring"]')!;
    expect(inlineRing.getAttribute('data-holder')).toBe('agent');
    expect(harnessRing.getAttribute('data-holder')).toBe('sparrow');
  });

  it('accepts a className', () => {
    const { container } = render(<LoopModeArt mode="inline" className="w-full" />);
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('w-full');
  });
});
