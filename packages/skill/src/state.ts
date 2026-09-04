/**
 * Loop-state + heartbeat primitives — the single source of truth shared by the
 * `sparrow-skill` bin, the `sparrow` CLI (via a thin re-export), and (in shell
 * form) the Stop/presence hooks.
 *
 * Two tiny files live under the state dir — `<project>/.sparrow` for a
 * project-scope install, `~/.sparrow` for a user-scope one, and whatever
 * `$SPARROW_STATE_DIR` names when it is set (see {@link resolveStateDir}):
 *   - `loop-state`  — the word `engaged` or `paused`. Its presence + value is
 *                     the sanctioned on/off switch the Stop hook reads.
 *   - `heartbeat`   — a file whose *mtime* the running listener touches; the
 *                     Stop hook treats a fresh mtime as "a listener is alive".
 *                     Its CONTENT is the listener kind (`await` | `watch` |
 *                     `loop`), so the hook can tell a WAKE-CAPABLE listener
 *                     (`await` exits when work arrives, re-invoking a turn-based
 *                     agent) from a HOLD-ONLY one (`watch`/`loop` keep a
 *                     turn-based agent online but deaf). Empty content = an
 *                     older CLI or a third-party script: kind unknown.
 *
 * Everything here is best-effort: a missing/corrupt file reads as absent and
 * never throws.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The sanctioned loop switch. `engaged` = keep a loop running; `paused` = off. */
export type LoopState = 'engaged' | 'paused';

/**
 * Which listener wrote the heartbeat. `await` is the only WAKE PATH for a
 * turn-based agent — it exits when work arrives, and that exit is what gets the
 * agent re-invoked. `watch`/`loop` hold the stream open forever: right for an
 * always-running agent, and exactly the online-but-deaf state for a turn-based
 * one.
 */
export type ListenerKind = 'await' | 'watch' | 'loop';

const LISTENER_KINDS: readonly string[] = ['await', 'watch', 'loop'];

/**
 * How a listener DIED, stamped into the heartbeat on its way out.
 *
 * `killed` = SIGTERM/SIGHUP — nobody asked this process to stop, the harness
 * tore the tree down (a Claude Code session interrupt kills the tracked
 * background `sparrow await` exactly this way). `stopped` = SIGINT, a
 * deliberate Ctrl-C. Both mean the same thing to a reader — THERE IS NO
 * LISTENER — but the cause is what makes the resulting nudge accurate, so it is
 * recorded rather than guessed.
 */
export type DeadReason = 'killed' | 'stopped';

const DEAD_REASONS: readonly string[] = ['killed', 'stopped'];

/**
 * What the heartbeat file currently claims: either a live listener kind, or a
 * terminal stamp with the signal that caused it (`{ state: 'killed', signal:
 * 'SIGTERM' }`). `signal` is absent when the stamp names none.
 */
export interface HeartbeatState {
  state: ListenerKind | DeadReason;
  signal?: string;
}

type Env = Record<string, string | undefined>;

/** The USER-scope state dir: `$HOME/.sparrow` (OS home dir as a last resort). */
export function homeStateDir(env: Env = process.env): string {
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.sparrow');
}

/**
 * Does `dir` look like the root of a Sparrow-enabled project? Two markers, both
 * written by a project-scope `sparrow skill install`:
 *   - `.sparrow/loop-state` — the state dir itself, already seeded. A BARE
 *     `.sparrow/` does not count: it may be anything.
 *   - `.claude/skills/sparrow/` — the skill install, which is the marker that
 *     works BEFORE the first `loop-state` write (and after a `rm -rf .sparrow`).
 */
function isProjectRoot(dir: string): boolean {
  try {
    if (fs.statSync(path.join(dir, '.sparrow', 'loop-state')).isFile()) return true;
  } catch {
    // not this marker
  }
  try {
    if (fs.statSync(path.join(dir, '.claude', 'skills', 'sparrow')).isDirectory()) return true;
  } catch {
    // not this marker either
  }
  return false;
}

/**
 * The nearest ancestor of `cwd` (inclusive) that carries a project marker, or
 * `undefined` when there is none all the way up to the filesystem root.
 */
export function findProjectRoot(cwd: string): string | undefined {
  let dir: string;
  try {
    dir = path.resolve(cwd);
  } catch {
    return undefined;
  }
  for (;;) {
    if (isProjectRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the state directory — PER PROJECT, because one machine now routinely
 * runs several agents under ONE unix user (and one HOME) in different checkouts:
 *
 *   1. `$SPARROW_STATE_DIR` when set (what a project-scope install stamps into
 *      every hook command, and the isolation hook for tests);
 *   2. else `<project>/.sparrow`, where `<project>` is the nearest ancestor of
 *      `cwd` holding `.sparrow/loop-state` or `.claude/skills/sparrow/`;
 *   3. else `$HOME/.sparrow` — the user-scope install, and the historical path.
 *
 * A single shared `~/.sparrow` would give those agents ONE loop switch, ONE
 * heartbeat and ONE pair of auto-status markers: agent A's `skill pause`
 * silences B, and B's idle listener makes A's Stop hook complain. The shell
 * hooks resolve `${SPARROW_STATE_DIR:-$HOME/.sparrow}` — identical, because a
 * project-scope install always stamps the variable.
 */
export function resolveStateDir(env: Env = process.env, cwd: string = safeCwd()): string {
  const override = env.SPARROW_STATE_DIR?.trim();
  if (override) return override;
  const root = findProjectRoot(cwd);
  if (root) return path.join(root, '.sparrow');
  return homeStateDir(env);
}

/** `process.cwd()` that never throws (a deleted cwd is not worth a crash). */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

export function loopStatePath(stateDir: string): string {
  return path.join(stateDir, 'loop-state');
}

export function heartbeatPath(stateDir: string): string {
  return path.join(stateDir, 'heartbeat');
}

/** Read the loop switch; `undefined` when absent or unrecognized. */
export function readLoopState(stateDir: string): LoopState | undefined {
  try {
    const raw = fs.readFileSync(loopStatePath(stateDir), 'utf8').trim();
    if (raw === 'engaged' || raw === 'paused') return raw;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Write the loop switch (creating the state dir as needed). */
export function writeLoopState(stateDir: string, state: LoopState): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(loopStatePath(stateDir), `${state}\n`);
}

/** Age (whole seconds) of the heartbeat file's mtime, or `undefined` if absent. */
export function heartbeatAgeSeconds(stateDir: string, now: number = Date.now()): number | undefined {
  try {
    const st = fs.statSync(heartbeatPath(stateDir));
    return Math.max(0, Math.floor((now - st.mtimeMs) / 1000));
  } catch {
    return undefined;
  }
}

/** How often (ms) {@link touchHeartbeat} actually writes; further calls are cheap no-ops. */
export const HEARTBEAT_THROTTLE_MS = 15_000;

let lastTouch = 0;

/**
 * Mark the loop alive by touching `heartbeat`'s mtime, recording WHICH listener
 * is alive as the file's content. Throttled to ~15s so a hot event handler can
 * call it per message without hammering the filesystem.
 *
 * Omitting `kind` writes EMPTY content — the shape an older CLI or a
 * third-party heartbeat script produces, which readers must treat as "kind
 * unknown, cannot judge" rather than inheriting whatever the last listener
 * claimed. Best-effort: never throws. `now`/`force` exist for tests.
 */
export function touchHeartbeat(
  stateDir: string,
  {
    kind,
    now = Date.now(),
    force = false,
  }: { kind?: ListenerKind; now?: number; force?: boolean } = {},
): void {
  if (!force && now - lastTouch < HEARTBEAT_THROTTLE_MS) return;
  lastTouch = now;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = heartbeatPath(stateDir);
    const when = new Date(now);
    // Always (re)write the content: the claim must match the listener doing the
    // touching, never a stale one from a previous process.
    fs.writeFileSync(file, kind ? `${kind}\n` : '');
    try {
      fs.utimesSync(file, when, when);
    } catch {
      // leave the OS-assigned mtime (still "fresh")
    }
  } catch {
    // best-effort — a loop must never crash over a heartbeat
  }
}

/**
 * Stamp the heartbeat as DEAD — the last thing a terminating listener does.
 *
 * Writes `killed:<signal>` / `stopped:<signal>` (the bare word when no signal is
 * named) and a fresh mtime, BYPASSING the touch throttle: a dying process gets
 * exactly one chance to speak, and it may die a millisecond after its last
 * touch. Freshness is deliberately preserved — what disqualifies this heartbeat
 * is its CONTENT, so readers report "killed 3s ago" instead of waiting out a
 * 120s staleness window while the agent sits deaf.
 *
 * Best-effort and synchronous (a signal handler has no time for promises):
 * never throws, whatever the filesystem does.
 */
export function markHeartbeatDead(
  stateDir: string,
  reason: DeadReason,
  signal?: string,
  now: number = Date.now(),
): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = heartbeatPath(stateDir);
    fs.writeFileSync(file, signal ? `${reason}:${signal}\n` : `${reason}\n`);
    try {
      const when = new Date(now);
      fs.utimesSync(file, when, when);
    } catch {
      // leave the OS-assigned mtime
    }
  } catch {
    // best-effort — dying is not the moment to throw
  }
}

/**
 * The full heartbeat claim: a live listener kind, or a terminal `killed`/
 * `stopped` stamp plus the signal that caused it. `undefined` when the file is
 * absent, empty (legacy/third-party heartbeat) or unrecognized — "cannot judge",
 * never "no listener".
 *
 * Separate from {@link readHeartbeatKind} on purpose: that reader answers
 * "which LISTENER is alive?" and must keep answering `undefined` for a corpse.
 */
export function readHeartbeatState(stateDir: string): HeartbeatState | undefined {
  try {
    const raw = fs.readFileSync(heartbeatPath(stateDir), 'utf8').trim();
    if (LISTENER_KINDS.includes(raw)) return { state: raw as ListenerKind };
    const [word, ...rest] = raw.split(':');
    if (word !== undefined && DEAD_REASONS.includes(word)) {
      const signal = rest.join(':').trim();
      return signal ? { state: word as DeadReason, signal } : { state: word as DeadReason };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which listener last heartbeated, or `undefined` when the file is absent,
 * empty (legacy/third-party heartbeat) or unrecognized. `undefined` means
 * "cannot judge" — never "no listener".
 */
export function readHeartbeatKind(stateDir: string): ListenerKind | undefined {
  try {
    const raw = fs.readFileSync(heartbeatPath(stateDir), 'utf8').trim();
    return LISTENER_KINDS.includes(raw) ? (raw as ListenerKind) : undefined;
  } catch {
    return undefined;
  }
}

/** Test-only: reset the in-process throttle clock. */
export function __resetHeartbeatThrottle(): void {
  lastTouch = 0;
}
