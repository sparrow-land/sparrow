import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './time.js';

const NOW = Date.parse('2026-08-12T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('formatRelativeTime', () => {
  it('renders sub-minute as "just now"', () => {
    expect(formatRelativeTime(ago(5_000), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(59_000), NOW)).toBe('just now');
  });

  it('renders minutes', () => {
    expect(formatRelativeTime(ago(2 * 60_000), NOW)).toBe('2m ago');
    expect(formatRelativeTime(ago(59 * 60_000), NOW)).toBe('59m ago');
  });

  it('renders hours', () => {
    expect(formatRelativeTime(ago(3 * 3_600_000), NOW)).toBe('3h ago');
  });

  it('renders days', () => {
    expect(formatRelativeTime(ago(5 * 86_400_000), NOW)).toBe('5d ago');
  });

  it('falls back to a date for old timestamps', () => {
    const out = formatRelativeTime(ago(30 * 86_400_000), NOW);
    expect(out).not.toMatch(/ago/);
    expect(out.length).toBeGreaterThan(0);
  });

  it('treats future timestamps as "just now"', () => {
    expect(formatRelativeTime(ago(-10_000), NOW)).toBe('just now');
  });

  it('returns empty string for invalid input', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
