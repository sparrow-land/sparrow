/**
 * CAN THIS PROCESS WAKE THE SESSION THAT ARMED IT?
 *
 * Under Claude Code a `sparrow await` wakes the agent by EXITING — but only if
 * it is a descendant of the Claude Code process: a tracked background task is
 * one (measured: a direct child), while a `( sparrow await & )` disowned inside
 * a foreground Bash call is reparented away within a second. The disowned one
 * passes every other health check — fresh heartbeat, live pid, no stamp — and
 * can never wake anybody. Ancestry is the only test that tells them apart.
 *
 * Three rules this module keeps:
 *
 *   - ANCESTRY, NOT "ppid == 1". The parent chain is walked; a subreaper
 *     (systemd --user, tini, a container init) adopts orphans without being
 *     pid 1, so "reparented to init" is not a usable signal.
 *   - GATED ON THE HARNESS SAYING SO. Only `CLAUDECODE` + `CLAUDE_PID` switch
 *     any of this on, so `sparrow harness`, `enroll --exec`, Codex and Gemini
 *     are untouched.
 *   - UNKNOWN IS NOT NO. A walk that cannot be completed (no `/proc`, `ps`
 *     failing, a cycle, the hop cap) answers `unknown`, and callers never act
 *     on it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

type Env = Record<string, string | undefined>;

/** The harness that owns this shell, as it announced itself in the environment. */
export interface HarnessOwner {
  kind: 'claude';
  pid: number;
}

export type Ancestry = 'yes' | 'no' | 'unknown';

/** The parent of `pid`, or undefined when it cannot be read. */
export type ReadParent = (pid: number) => number | undefined;

/** How far up the tree we are willing to walk. Real chains are a handful deep. */
export const MAX_ANCESTRY_HOPS = 64;

const truthy = (v: string | undefined): boolean => {
  const s = v?.trim().toLowerCase();
  return s !== undefined && s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
};

/**
 * The Claude Code harness this process runs under, or null. `CLAUDECODE` must
 * be truthy AND `CLAUDE_PID` a positive integer — anything less is "no harness",
 * never a guess.
 */
export function detectHarness(env: Env): HarnessOwner | null {
  if (!truthy(env.CLAUDECODE)) return null;
  const raw = env.CLAUDE_PID?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { kind: 'claude', pid };
}

/**
 * `/proc/<pid>/stat` on Linux; `ps -o ppid= -p <pid>` elsewhere (or when /proc
 * is absent). The comm field can hold spaces and parentheses, so the ppid is
 * read after the LAST `)`: `pid (comm) state ppid …`.
 */
export function readParentPid(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(tail[1]);
    if (Number.isInteger(ppid) && ppid >= 0) return ppid;
  } catch {
    /* no /proc, or no such pid there — fall through to ps */
  }
  if (fs.existsSync('/proc/self/stat')) return undefined; // /proc works; the pid is gone
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    if (r.status !== 0) return undefined;
    const ppid = Number(r.stdout.trim());
    return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is `targetPid` a (strict) ancestor of `fromPid`? The walk stops at pid 0/1 —
 * every chain ends at init, so init is never an answer — or after
 * {@link MAX_ANCESTRY_HOPS}.
 */
export function isAncestor(
  targetPid: number,
  fromPid: number,
  readParent: ReadParent = readParentPid,
): Ancestry {
  if (!Number.isInteger(targetPid) || targetPid <= 0) return 'unknown';
  if (!Number.isInteger(fromPid) || fromPid <= 0) return 'unknown';
  const seen = new Set<number>([fromPid]);
  let cur = fromPid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    const parent = readParent(cur);
    if (parent === undefined) return 'unknown';
    if (parent <= 1) return 'no';
    if (parent === targetPid) return 'yes';
    if (seen.has(parent)) return 'unknown'; // a cycle: the tree changed under us
    seen.add(parent);
    cur = parent;
  }
  return 'unknown';
}

/** `process.kill(pid, 0)`: success or EPERM is alive; anything else is not. */
export function isAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (p, s) => {
    process.kill(p, s);
  },
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** The one line an unowned arm prints (exit 5). */
export const unownedRefusal = (pid: number): string =>
  `sparrow await: armed from a shell this Claude Code session does not own (harness pid ${pid} ` +
  'is not an ancestor): this listener could never wake your session. Run it as a tracked ' +
  'background task, or pass --allow-unowned.';

/** The one line an orphaned listener prints on its way out (exit 5). */
export const orphanedNotice = (pid: number): string =>
  `sparrow await: orphaned — the Claude Code session that armed this listener (pid ${pid}) is ` +
  'gone; standing down.';

/** `sparrow await`'s exit code for both: this listener cannot wake its session. */
export const UNOWNED_EXIT_CODE = 5;
