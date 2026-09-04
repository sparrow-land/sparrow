import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar } from './Avatar.js';

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
});

describe('Avatar — agents', () => {
  it('renders the procedural bird tile and never an <img>, even with an avatarUrl', () => {
    render(
      <Avatar kind="agent" id="agt_atlas" displayName="atlas" avatarUrl="https://x/should-ignore.png" />,
    );
    const svg = screen.getByRole('img', { name: 'atlas' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    // Square tile (rounded-square rect), a gradient bird, no circle-32.
    expect(svg.querySelector('rect[rx="15"]')).not.toBeNull();
    expect(svg.querySelector('circle[r="32"]')).toBeNull();
    expect(screen.queryByRole('img', { name: 'atlas' })!.tagName.toLowerCase()).not.toBe('img');
  });

  it('gives two different agents visibly different plumage (distinct gradient stops)', () => {
    const { container: a } = render(<Avatar kind="agent" id="agt_1" displayName="one" />);
    const { container: b } = render(<Avatar kind="agent" id="agt_2" displayName="two" />);
    const stopsOf = (c: HTMLElement) =>
      Array.from(c.querySelectorAll('stop')).map((s) => s.getAttribute('stop-color'));
    expect(stopsOf(a)).not.toEqual(stopsOf(b));
  });
});
