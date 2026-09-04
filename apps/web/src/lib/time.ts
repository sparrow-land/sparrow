/**
 * A compact age label (no "ago"), e.g. "25m", "3h", "2d" — for a staleness
 * suffix like "working — 25m". Sub-minute ages return "" (nothing worth showing).
 */
export function formatCompactAge(sinceMs: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(sinceMs)) return '';
  const s = Math.floor((nowMs - sinceMs) / 1000);
  if (s < 60) return '';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Format an ISO-8601 timestamp as a short relative string, e.g. "2m ago". */
export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = nowMs - then;
  const s = Math.floor(diffMs / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
