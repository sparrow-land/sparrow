/**
 * Usage-limit markers — "this session cannot run until something changes".
 *
 * Claude Code fires `StopFailure` when a turn ends on an API error; the
 * auto-status hook records the ones that mean the agent is stuck (rate_limit,
 * billing_error, authentication_failed, …) as ONE FILE PER BLOCK under
 * `<state dir>/blocked/`. This is the reader for the CLI surfaces.
 *
 * TWO RULES CARRIED OVER FROM THE HOOK, because a reader that breaks them turns
 * a careful protocol into a race:
 *
 *   * A marker is cleared BY NAME, from a snapshot. {@link clearBlockedMarkers}
 *     lists first and deletes exactly what it listed, so a block recorded while
 *     it works cannot be erased by a caller that never saw it.
 *   * NOTHING EXPIRES. A marker's age is not evidence that quota came back, so
 *     an old marker still reads as blocked. It clears on evidence of a
 *     successful turn, on Claude Code's quota-resume notification, or by hand
 *     (`sparrow skill unblock`) — which is the only recovery available when the
 *     limited session is already closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonRecord } from './state.js';

export interface BlockedMarker {
  /** Absolute path of the marker file — what a clear deletes, by name. */
  file: string;
  reason: string;
  /** ISO time the block was recorded, when the marker carries one. */
  at?: string;
  session?: string;
  prompt?: string;
  resumesAt?: string;
}

export function blockedDir(stateDir: string): string {
  return path.join(stateDir, 'blocked');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Every standing marker, OLDEST FIRST (filenames start with a compact
 * timestamp, so name order is chronological). Unreadable or malformed files are
 * skipped rather than thrown over: this runs inside `status`.
 */
export function readBlockedMarkers(stateDir: string): BlockedMarker[] {
  const dir = blockedDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: BlockedMarker[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const rec = readJsonRecord(file);
      if (!rec) continue;
      out.push({
        file,
        reason: str(rec.reason) ?? 'unknown',
        ...(str(rec.at) ? { at: str(rec.at) } : {}),
        ...(str(rec.session) ? { session: str(rec.session) } : {}),
        ...(str(rec.prompt) ? { prompt: str(rec.prompt) } : {}),
        ...(str(rec.resumesAt) ? { resumesAt: str(rec.resumesAt) } : {}),
      });
    } catch {
      // A half-written or hand-mangled marker tells us nothing; skip it.
    }
  }
  return out;
}

/** The block a human should be told about: the most recent one. */
export function currentBlock(stateDir: string): BlockedMarker | undefined {
  const all = readBlockedMarkers(stateDir);
  return all.length > 0 ? all[all.length - 1] : undefined;
}

/**
 * Delete exactly the markers listed at call time; returns the file names
 * removed. A marker written after the listing keeps its own name and survives.
 */
export function clearBlockedMarkers(stateDir: string): string[] {
  const removed: string[] = [];
  for (const marker of readBlockedMarkers(stateDir)) {
    try {
      fs.rmSync(marker.file, { force: true });
      removed.push(path.basename(marker.file));
    } catch {
      // Someone else got there first, or it is not ours to delete.
    }
  }
  return removed;
}

/** Local `HH:MM` for an ISO timestamp, or undefined when it cannot be read. */
export function clockOf(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
