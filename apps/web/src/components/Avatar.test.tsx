import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar } from './Avatar.js';
import { agentVisual } from '../lib/avatar.js';

describe('Avatar — humans', () => {
  it('renders an <img> when a human has an avatarUrl', () => {
    render(<Avatar kind="human" id="usr_1" displayName="Jake Quist" avatarUrl="https://x/a.png" />);
    const img = screen.getByRole('img', { name: 'Jake Quist' }) as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('https://x/a.png');
    // Round.
    expect(img.className).toMatch(/rounded-full/);
  });

  it('falls back to the generated initials avatar when the image fails to load', () => {
    render(<Avatar kind="human" id="usr_1" displayName="Jake Quist" avatarUrl="https://x/broken.png" />);
    const img = screen.getByRole('img', { name: 'Jake Quist' });
    expect(img.tagName).toBe('IMG');
    fireEvent.error(img);
    // Now a generated SVG (with the initials) stands in.
    const svg = screen.getByRole('img', { name: 'Jake Quist' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('text')?.textContent).toBe('JQ');
  });

  it('renders generated initials (round) when there is no avatarUrl', () => {
    render(<Avatar kind="human" id="usr_1" displayName="Mara Ellison" />);
    const svg = screen.getByRole('img', { name: 'Mara Ellison' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    // Round: a full-radius circle, not a rounded-square tile.
    expect(svg.querySelector('circle[r="32"]')).not.toBeNull();
    expect(svg.querySelector('text')?.textContent).toBe('ME');
  });

  it('falls back to an initial when raster art fails to load', () => {
    render(<Avatar kind="agent" id="agt_atlas" displayName="atlas" />);
    fireEvent.error(screen.getByRole('img', { name: 'atlas' }).querySelector('image')!);
    expect(screen.getByRole('img', { name: 'atlas' }).querySelector('text')?.textContent).toBe('A');
  });

  it('retries art when a reused avatar receives a different assigned source', () => {
    const first = Array.from({ length: 30 }, (_, i) => `agt_retry_${i}`);
    const [a, b] = first.flatMap((id, i) => first.slice(i + 1).map((other) => [id, other] as const))
      .find(([left, right]) => agentVisual(left).base.src !== agentVisual(right).base.src)!;
    const { rerender } = render(<Avatar kind="agent" id={a} displayName="alpha" />);
    fireEvent.error(screen.getByRole('img', { name: 'alpha' }).querySelector('image')!);
    rerender(<Avatar kind="agent" id={b} displayName="beta" />);
    expect(screen.getByRole('img', { name: 'beta' }).querySelector('image')).not.toBeNull();
  });
});

describe('Avatar — agents', () => {
  it('renders the painterly bird composition and ignores an agent avatarUrl', () => {
    render(
      <Avatar kind="agent" id="agt_atlas" displayName="atlas" avatarUrl="https://x/should-ignore.png" />,
    );
    const svg = screen.getByRole('img', { name: 'atlas' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('data-avatar-version')).toBe('sparrow-v2');
    expect(svg.querySelector('rect[rx="15"]')).not.toBeNull();
    expect(svg.querySelector('image')?.getAttribute('href')).toMatch(/\/avatars\/sparrow-v2\/base-[123]\.webp/);
    expect(screen.queryByRole('img', { name: 'atlas' })!.tagName.toLowerCase()).not.toBe('img');
  });

  it('gives agents stable catalog traits', () => {
    const { container: a } = render(<Avatar kind="agent" id="agt_1" displayName="one" />);
    const { container: b } = render(<Avatar kind="agent" id="agt_2" displayName="two" />);
    const traitsOf = (c: HTMLElement) => {
      const svg = c.querySelector('svg')!;
      return [svg.dataset.avatarBase, svg.dataset.avatarBackground];
    };
    expect(traitsOf(a)).not.toEqual(traitsOf(b));
    expect(traitsOf(a)).toEqual(traitsOf(render(<Avatar kind="agent" id="agt_1" displayName="one again" />).container));
  });
});
