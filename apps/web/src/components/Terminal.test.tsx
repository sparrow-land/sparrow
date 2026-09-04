import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Terminal } from './Terminal.js';

describe('Terminal', () => {
  it('shows the code, the label and a copy button', () => {
    render(<Terminal code="sparrow watch" label="cli" />);
    expect(screen.getByText('sparrow watch')).toBeInTheDocument();
    expect(screen.getByText('cli')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('keeps commands on one line by default — a wrapped command is a broken command', () => {
    const { container } = render(<Terminal code="sparrow harness --url https://example.test/x" />);
    expect(container.querySelector('pre')!.className).not.toMatch(/wrap/);
  });

  it('wraps when asked, for prose blocks like the invitation blob', () => {
    const { container } = render(<Terminal code="a long paragraph of prose" wrap />);
    expect(container.querySelector('pre')!.className).toMatch(/terminal-wrap/);
  });
});
