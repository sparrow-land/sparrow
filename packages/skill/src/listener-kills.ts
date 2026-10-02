/**
 * The listener-kill history — evidence for the prompt hook's harness-cap tip.
 *
 * WHY IT EXISTS. Under Claude Code a turn-based agent arms `sparrow await` as a
 * tracked background task, and Claude Code stops a background task at its Bash
 * call's timeout (30 min by default, at most 7200000 ms = 2 h when passed
 * explicitly). Each stop is a SIGTERM: the listener stamps `killed:SIGTERM`, the
 * prompt hook tells the agent to re-arm, and the agent spends a turn doing so.
 * An agent that habitually arms with a short timeout therefore burns a turn on
 * a regular clock while nothing is happening. The default prescription stays
 * plain `sparrow await` (most waits are short); instead, once the kills LOOK
 * like such a cap, the hook says so once, with the exact arming parameters.
 *
 * THE RECORD. `sparrow await` appends one entry per SIGTERM/SIGHUP death (a
 * kill always means nothing woke it — a wake exits 0) to
 * `<state dir>/listener-kills.json`, keeping the last {@link KILL_HISTORY_MAX}.
 * Anything that proves the pattern broken — a wake, a deliberate Ctrl-C, an
 * orphan stand-down, a supersede — deletes the file ({@link resetListenerKills}),
 * so "the last N entries" always means "the last N consecutive kills".
 *
 * THE RULE IS DECIDED HERE, NOT IN THE HOOK. The hook is POSIX `sh` with no JSON
 * parser it can rely on, so the writer evaluates {@link capStreakMinutes} and
 * stores the verdict as two flat top-level fields (`tipStreak`, `tipMinutes`)
 * the hook can read with one `sed` each. `tipStreak` is an identity that holds
 * while consecutive kills keep qualifying; the hook remembers the last identity
 * it showed (`listener-cap-tip-shown`), which is what makes the tip once per
 * streak.
 *
 * Best-effort throughout: these are called from a signal handler on the way
 * out, so nothing here may throw.
 */
import fs from 'node:fs';
import path from 'node:path';

/** File name under the state dir. */
export const LISTENER_KILLS_FILE = 'listener-kills.json';
/** Written by the prompt hook: the `tipStreak` it last showed. */
export const LISTENER_CAP_TIP_SHOWN_FILE = 'listener-cap-tip-shown';
/** Entries kept. */
export const KILL_HISTORY_MAX = 5;
/** Consecutive kills that make a streak. */
export const CAP_STREAK_LENGTH = 3;
/** Shorter lifetimes are interrupts, not a timeout cap. */
export const CAP_MIN_LIFETIME_SECONDS = 5 * 60;
/**
 * At or above this the listener already ran close to Claude Code's 2 h
 * maximum: there is nothing better to suggest.
 */
export const CAP_MAX_LIFETIME_SECONDS = 115 * 60;
/** Lifetimes this close to each other (relative to the longest) are a regular cap. */
export const CAP_SPREAD = 0.15;

export interface ListenerKill {
  /** Epoch ms the listener started. */
  armedAt: number;
  /** Epoch ms it was killed. */
  killedAt: number;
  lifetimeSeconds: number;
  signal?: string;
  /** The `await` generation nonce its `killed:` stamp carried. */
  generation?: string;
}

export interface ListenerKillHistory {
  version: 1;
  /** Present while the last {@link CAP_STREAK_LENGTH} kills form a sub-cap streak. */
  tipStreak?: string;
  /** The streak's typical lifetime, whole minutes. */
  tipMinutes?: number;
  /** The newest kill's generation: the hook offers the tip only for that stamp. */
  lastGeneration?: string;
  kills: ListenerKill[];
}

export function listenerKillsPath(stateDir: string): string {
  return path.join(stateDir, LISTENER_KILLS_FILE);
}

const empty = (): ListenerKillHistory => ({ version: 1, kills: [] });

function isKill(v: unknown): v is ListenerKill {
  if (!v || typeof v !== 'object') return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.armedAt === 'number' &&
    typeof k.killedAt === 'number' &&
    typeof k.lifetimeSeconds === 'number' &&
    Number.isFinite(k.lifetimeSeconds)
  );
}

/** The recorded history; an empty one when absent or unreadable. Never throws. */
export function readListenerKills(stateDir: string): ListenerKillHistory {
  try {
    const raw = JSON.parse(fs.readFileSync(listenerKillsPath(stateDir), 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.kills)) return empty();
    const h: ListenerKillHistory = { version: 1, kills: raw.kills.filter(isKill) };
    if (typeof raw.tipStreak === 'string') h.tipStreak = raw.tipStreak;
    if (typeof raw.tipMinutes === 'number') h.tipMinutes = raw.tipMinutes;
    if (typeof raw.lastGeneration === 'string') h.lastGeneration = raw.lastGeneration;
    return h;
  } catch {
    return empty();
  }
}

/**
 * THE STREAK RULE. The last {@link CAP_STREAK_LENGTH} kills each lived at least
 * ~5 min and under ~115 min (a cap shorter than the maximum), and within
 * {@link CAP_SPREAD} of each other (a regular clock, not random interrupts).
 * Returns their mean lifetime in whole minutes, or `undefined`.
 */
export function capStreakMinutes(kills: readonly ListenerKill[]): number | undefined {
  if (kills.length < CAP_STREAK_LENGTH) return undefined;
  const last = kills.slice(-CAP_STREAK_LENGTH).map((k) => k.lifetimeSeconds);
  if (last.some((s) => s < CAP_MIN_LIFETIME_SECONDS || s >= CAP_MAX_LIFETIME_SECONDS)) return undefined;
  const max = Math.max(...last);
  const min = Math.min(...last);
  if ((max - min) / max > CAP_SPREAD) return undefined;
  const mean = last.reduce((a, b) => a + b, 0) / last.length;
  return Math.max(1, Math.round(mean / 60));
}

/** temp + rename, so a reader never sees half a file. Throws; callers guard. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
}

/**
 * Append one kill (keeping the last {@link KILL_HISTORY_MAX}) and re-evaluate
 * the streak. A streak that continues keeps its identity; a new one gets a new
 * identity. Synchronous and best-effort: safe from a signal handler.
 */
export function recordListenerKill(stateDir: string, kill: ListenerKill): void {
  try {
    const prev = readListenerKills(stateDir);
    const kills = [...prev.kills, kill].slice(-KILL_HISTORY_MAX);
    const minutes = capStreakMinutes(kills);
    const next: ListenerKillHistory = {
      version: 1,
      ...(minutes !== undefined
        ? { tipStreak: prev.tipStreak ?? `k${Math.trunc(kill.killedAt).toString(36)}`, tipMinutes: minutes }
        : {}),
      ...(kill.generation ? { lastGeneration: kill.generation } : {}),
      kills,
    };
    fs.mkdirSync(stateDir, { recursive: true });
    writeAtomic(listenerKillsPath(stateDir), `${JSON.stringify(next)}\n`);
  } catch {
    /* best-effort: a dying listener must never throw */
  }
}

/** The streak is broken (a wake, a Ctrl-C, an orphan, a supersede). Never throws. */
export function resetListenerKills(stateDir: string): void {
  try {
    fs.rmSync(listenerKillsPath(stateDir), { force: true });
  } catch {
    /* best-effort */
  }
}
