import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo, Mark } from './Logo.js';

describe('Mark', () => {
  it('renders the canonical brand asset at the requested size', () => {
    const { container } = render(<Mark size={32} className="sparrow-mark" />);
    const mark = container.querySelector('img');

    expect(mark).toHaveAttribute('src', '/brand/sparrow-icon.svg');
    expect(mark).toHaveAttribute('width', '32');
    expect(mark).toHaveAttribute('height', '32');
    expect(mark).toHaveClass('sparrow-mark');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Logo', () => {
  it('shows the wordmark by default', () => {
    render(<Logo />);
    expect(screen.getByText('sparrow')).toBeInTheDocument();
  });

  it('supports the existing mark-only contract', () => {
    const { container } = render(<Logo markOnly />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/brand/sparrow-icon.svg');
    expect(screen.queryByText('sparrow')).not.toBeInTheDocument();
  });
});
