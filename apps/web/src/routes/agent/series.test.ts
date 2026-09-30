import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAnalyticsPoint } from '@sparrow-land/sdk/types';
import { MAX_BARS, bucketLabel, bucketSeries } from './series.js';

/** `n` consecutive UTC days ending 2026-09-29, one message each (tokens 10). */
function days(n: number): AgentAnalyticsPoint[] {
  const end = Date.UTC(2026, 8, 29);
  return Array.from({ length: n }, (_, i) => ({
    start: new Date(end - (n - 1 - i) * 86_400_000).toISOString(),
    messages: 1,
    tokens: 10,
  }));
}

const sum = (ps: { messages: number }[]) => ps.reduce((n, p) => n + p.messages, 0);

describe('bucketSeries', () => {
  it('keeps short series as they are (hourly 24h, daily 7d/30d)', () => {
    expect(bucketSeries(days(7), false)).toMatchObject({ unit: 'day' });
    expect(bucketSeries(days(7), false).points).toHaveLength(7);
    expect(bucketSeries(days(30), false).points).toHaveLength(30);
    expect(bucketSeries(days(24), true).unit).toBe('hour');
  });

  it('a long daily series becomes weekly buckets, the last ending today; totals preserved', () => {
    const r = bucketSeries(days(90), false);
    expect(r.unit).toBe('week');
    expect(r.points.length).toBeLessThanOrEqual(MAX_BARS);
    expect(r.points).toHaveLength(13);
    expect(r.points.at(-1)!.messages).toBe(7);
    expect(sum(r.points)).toBe(90);
    expect(r.points.reduce((n, p) => n + p.tokens, 0)).toBe(900);
  });

  it('a year of days becomes monthly buckets (UTC calendar months)', () => {
    const r = bucketSeries(days(366), false);
    expect(r.unit).toBe('month');
    expect(r.points.length).toBeLessThanOrEqual(MAX_BARS);
    expect(r.points.at(-1)).toMatchObject({ start: '2026-09-01T00:00:00.000Z', messages: 29 });
    expect(sum(r.points)).toBe(366);
  });

  it('several years never exceed the bar cap', () => {
    const r = bucketSeries(days(365 * 4), false);
    expect(r.points.length).toBeLessThanOrEqual(MAX_BARS);
    expect(sum(r.points)).toBe(365 * 4);
  });
});

describe('bucketLabel is UTC for day-or-longer buckets', () => {
  const tz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterEach(() => {
    process.env.TZ = tz;
  });

  it('a UTC-midnight day reads as that day, not the evening before', () => {
    // 2026-09-28 is a Monday; in Los Angeles its UTC midnight is Sunday 17:00.
    expect(bucketLabel('2026-09-28T00:00:00Z', 'day', false)).toBe('Mon');
    expect(bucketLabel('2026-09-28T00:00:00Z', 'day', true)).toBe('Sep 28');
    expect(bucketLabel('2026-09-28T00:00:00Z', 'week', true)).toBe('Sep 28');
    expect(bucketLabel('2026-09-01T00:00:00Z', 'month', true)).toBe('Sep');
  });
});
