/**
 * `<state dir>/blocked/*.json` — "the agent behind this listener cannot take a
 * turn right now".
 *
 * THE INCIDENT (2026-09-17, Jake). A Claude Code session hit its usage limit.
 * `sparrow await` went on holding the events stream perfectly happily, so the
 * agent stayed ONLINE — while every wake it delivered died on the limit before
 * the agent could read anything. Worse, the server's owner watchdog (which
 * notices "unread work and nobody listening") cannot fire while a stream is
 * open, so the one mechanism that would have told a human was disarmed by the
 * listener's own health. Online and deaf is the worst state a presence system
 * can report, and this was a way to reach it that no heartbeat could see.
 *
 * WHO WRITES IT: the skill's Claude Code `StopFailure` hook, when a turn ends on
 * a blocking API error; its `Notification` hook removes the files again when
 * `quota_auto_resume_fired` says the window has reopened. This module only ever
 * READS — the CLI must never decide on its own that an agent is rate-limited,
 * and it NEVER deletes a marker (a clear it did not observe is not its to make).
 *
 * ONE FILE PER BLOCK, not one file overwritten. Markers are unique names in a
 * DIRECTORY so that a clear can never delete a replacement: the hook that
 * removes what it saw cannot race a StopFailure that has just written a fresh
 * marker for a limit that still holds. Standby lasts while ANY live marker
 * remains, and the newest one is the record that describes it.
 *
 * WHAT `await` DOES WITH IT: closes the stream and stands by (see runAwait's
 * standby loop). Dropping presence is the POINT: the truth becomes visible to
 * the watchdog, to `sparrow who`, and to anyone looking at the room.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from '@sparrow/skill';

type Env = Record<string, string | undefined>;

export interface BlockedRecord {
  version: 1;
  /** Why the turn could not run — `rate_limit`, or whatever the hook recorded. */
  reason: string;
  /** When it happened (ISO); the file's mtime when the hook wrote none. */
  at: string;
  session?: string;
  /** What the agent was asked to do, when the hook recorded it. */
  prompt?: string;
  /** When the provider says the window reopens, when it says so at all. */
  resumesAt?: string;
}

/** `<state dir>/blocked/` — the marker directory (this profile's, and no other). */
export function blockedDir(env: Env): string {
  return path.join(resolveStateDir(env), 'blocked');
}

/**
 * A reason word safe to put in a heartbeat stamp: the stamp is
 * `blocked:<reason> <nonce>`, whitespace-separated and line-based, so a reason
 * with a space or a newline in it would forge a second token (or a second line)
 * in a file other processes parse.
 */
function safeReason(raw: unknown): string {
  const word = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return word || 'blocked';
}

/**
 * One marker file, or `undefined` when it is unreadable or malformed.
 *
 * AGE IS NOT EVIDENCE. An old marker was tempting to expire, but nothing about
 * the clock says a quota recovered — only the hook that watches for the resume
 * knows that, and a human can say so with `sparrow skill unblock`. Expiring
 * markers ourselves would put a listener back online, silently, on a guess.
 */
function readMarker(file: string): BlockedRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BlockedRecord>;
    if (raw === null || typeof raw !== 'object') return undefined;
    const stated = Date.parse(String(raw.at ?? ''));
    // An `at` we cannot read is not a reason to ignore a real block: fall back
    // to the mtime, which the hook set by writing the file.
    const at = Number.isFinite(stated) ? stated : fs.statSync(file).mtimeMs;
    return {
      version: 1,
      reason: safeReason(raw.reason),
      at: new Date(at).toISOString(),
      ...(typeof raw.session === 'string' && raw.session ? { session: raw.session } : {}),
      ...(typeof raw.prompt === 'string' && raw.prompt ? { prompt: raw.prompt } : {}),
      ...(typeof raw.resumesAt === 'string' && raw.resumesAt ? { resumesAt: raw.resumesAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Is this listener's agent blocked, and by what?
 *
 * The NEWEST parsable marker in `<state dir>/blocked/`, or `undefined` when the
 * directory is absent, empty, or holds nothing readable. Best-effort and
 * synchronous: it runs on the listener's own cadence and must never throw into
 * the stream loop.
 */
export function readBlocked(env: Env): BlockedRecord | undefined {
  const dir = blockedDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined; // no directory at all is the ordinary case
  }
  let newest: BlockedRecord | undefined;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = readMarker(path.join(dir, name));
    if (record === undefined) continue;
    if (newest === undefined || Date.parse(record.at) > Date.parse(newest.at)) newest = record;
  }
  return newest;
}
