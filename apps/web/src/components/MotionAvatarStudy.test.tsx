import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MotionAvatarStudy } from './MotionAvatarStudy.js';

describe('motion avatar study', () => {
  it('waits for the sprite atlas and keeps idle on the original artwork', () => {
    const view = render(<MotionAvatarStudy busy mode="hovering" />);
    expect(screen.getByRole('img')).toHaveAttribute('data-moving', 'false');
    fireEvent.load(view.container.querySelector('img[data-layer="sprite"]')!);
    expect(screen.getByRole('img')).toHaveAttribute('data-moving', 'true');
    expect(view.container.querySelector('.motion-wing')).toBeNull();
    view.rerender(<MotionAvatarStudy busy={false} mode="hovering" />);
    expect(screen.getByRole('img')).toHaveAttribute('data-moving', 'false');
    expect(view.container.querySelector('.motion-still')).toHaveAttribute('src', '/avatars/sparrow-v2/base-3.webp');
  });
  it('keeps the approved still visible until both layers are ready', () => {
    const { container } = render(<MotionAvatarStudy busy mode="energetic" />);
    const avatar = screen.getByRole('img', { name: 'Sparrow, busy' });
    expect(avatar).toHaveAttribute('data-moving', 'false');
    const layers = container.querySelectorAll('img[data-layer]');
    fireEvent.load(layers[0]!);
    expect(avatar).toHaveAttribute('data-moving', 'false');
    fireEvent.load(layers[1]!);
    expect(avatar).toHaveAttribute('data-moving', 'true');
    expect(container.querySelector('.motion-still')).toHaveAttribute('src', '/avatars/sparrow-v2/base-3.webp');
  });

  it('returns to still on idle and suppresses motion for reduced motion', () => {
    const view = render(<MotionAvatarStudy busy mode="calm" />);
    view.container.querySelectorAll('img[data-layer]').forEach((layer) => fireEvent.load(layer));
    expect(screen.getByRole('img')).toHaveAttribute('data-moving', 'true');
    view.rerender(<MotionAvatarStudy busy mode="calm" reducedMotion />);
    expect(screen.getByRole('img')).toHaveAttribute('data-moving', 'false');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Sparrow, busy');
    view.rerender(<MotionAvatarStudy busy={false} mode="calm" />);
    expect(screen.getByRole('img')).toHaveAttribute('data-moving', 'false');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Sparrow, idle');
  });

  it('falls back to still after an asset error and preserves fixed size', () => {
    const { container } = render(<MotionAvatarStudy busy mode="energetic" size={28} />);
    container.querySelectorAll('img[data-layer]').forEach((layer) => fireEvent.load(layer));
    fireEvent.error(container.querySelector('img[data-layer]')!);
    expect(screen.getByRole('img')).toHaveAttribute('data-moving', 'false');
    expect(screen.getByRole('img')).toHaveStyle({ width: '28px', height: '28px' });
  });
});
