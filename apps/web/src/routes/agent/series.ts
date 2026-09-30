import type { AgentAnalyticsPoint } from '@sparrow-land/sdk/types';

/**
 * Chart buckets for the Analytics tab. The wire series is hourly for 24h and
 * DAILY otherwise — for `all` that is one point per day since the agent was
 * created, far more bars than a phone-width chart can hold. Long daily series
 * are summed client-side into weeks, then UTC calendar months, then runs of
 * months, so the chart never draws more than {@link MAX_BARS} bars.
 */

/** At most this many bars (31 fits a 30-day window unchanged). */
export const MAX_BARS = 31;

export type BucketUnit = 'hour' | 'day' | 'week' | 'month';

export interface Bucket {
  /** ISO start of the bucket (its first wire point). */
  start: string;
  messages: number;
  tokens: number;
}

function sumRun(points: readonly AgentAnalyticsPoint[]): Bucket {
  return {
    start: points[0]!.start,
    messages: points.reduce((n, p) => n + p.messages, 0),
    tokens: points.reduce((n, p) => n + p.tokens, 0),
  };
}

/** Consecutive runs of `size`, aligned to the END so the last bucket ends with the newest point. */
function chunkFromEnd<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let end = items.length; end > 0; end -= size) out.unshift(items.slice(Math.max(0, end - size), end));
  return out;
}

export function bucketSeries(
  series: readonly AgentAnalyticsPoint[],
  hourly: boolean,
): { unit: BucketUnit; points: Bucket[] } {
  if (hourly) return { unit: 'hour', points: series.map((p) => ({ ...p })) };
  if (series.length <= MAX_BARS) return { unit: 'day', points: series.map((p) => ({ ...p })) };
  if (Math.ceil(series.length / 7) <= MAX_BARS) {
    return { unit: 'week', points: chunkFromEnd(series, 7).map(sumRun) };
  }
  // UTC calendar months (the wire's day buckets start at UTC midnight).
  const months: AgentAnalyticsPoint[][] = [];
  let key = '';
  for (const p of series) {
    const k = p.start.slice(0, 7);
    if (k !== key) {
      months.push([]);
      key = k;
    }
    months[months.length - 1]!.push(p);
  }
  const perBar = Math.ceil(months.length / MAX_BARS);
  const runs = perBar === 1 ? months : chunkFromEnd(months, perBar).map((run) => run.flat());
  return { unit: 'month', points: runs.map(sumRun) };
}

/**
 * Axis label for one bucket. Hours read in the viewer's time zone; day-or-longer
 * buckets start at UTC midnight, so they are formatted in UTC — otherwise a
 * viewer west of Greenwich sees every day labelled as the one before.
 */
export function bucketLabel(start: string, unit: BucketUnit, dense: boolean, withYear = false): string {
  const d = new Date(start);
  if (unit === 'hour') return d.toLocaleTimeString(undefined, { hour: 'numeric' });
  if (unit === 'month') {
    return d.toLocaleDateString(undefined, { month: 'short', ...(withYear ? { year: '2-digit' } : {}), timeZone: 'UTC' });
  }
  if (unit === 'day' && !dense) return d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The newest bucket, still filling. */
export const CURRENT_LABEL: Record<BucketUnit, string> = {
  hour: 'Now',
  day: 'Today',
  week: 'This week',
  month: 'This month',
};
