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
import { detectPidNamespace, pidAlive } from '@sparrow/skill';
import { envSwitchedOn } from './util.js';

type Env = Record<string, string | undefined>;

/** The harness that owns this shell, as it announced itself in the environment. */
export interface HarnessOwner {
  kind: 'claude';
  pid: number;
}

/**
 * `unknown`: this walk could not be completed (retry may help).
 * `unjudgeable`: no walk can EVER answer for this target (pid 1: every process
 * descends from init). Callers treat both alike — never refuse, never record —
 * except that retrying `unjudgeable` is pointless.
 */
export type Ancestry = 'yes' | 'no' | 'unknown' | 'unjudgeable';

/** Consecutive `unknown` answers a PENDING harness gets before its walks stop (8 × 15 s). */
export const PENDING_UNKNOWN_CAP = 8;

/** The parent of `pid`, or undefined when it cannot be read. */
export type ReadParent = (pid: number) => number | undefined;

/** How far up the tree we are willing to walk. Real chains are a handful deep. */
export const MAX_ANCESTRY_HOPS = 64;

/**
 * The Claude Code harness this process runs under, or null. `CLAUDECODE` must
 * be truthy AND `CLAUDE_PID` a positive integer — anything less is "no harness",
 * never a guess.
 */
export function detectHarness(env: Env): HarnessOwner | null {
  if (!envSwitchedOn(env.CLAUDECODE)) return null;
  const raw = env.CLAUDE_PID?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { kind: 'claude', pid };
}

/**
 * Linux: `/proc/<pid>/stat`. The comm field can hold spaces and parentheses, so
 * the ppid is read after the LAST `)`: `pid (comm) state ppid …`.
 */
function readProcParent(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(tail[1]);
    return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
  } catch {
    return undefined; // no such pid (it exited mid-walk)
  }
}

/** `ps -axo pid=,ppid=` output → pid → ppid. Lines that are not two integers are skipped. */
export function parseParentSnapshot(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && pid > 0 && ppid >= 0) map.set(pid, ppid);
  }
  return map;
}

/** The `spawnSync` shape the snapshot needs — injectable for tests. */
export type RunPs = (cmd: string, args: string[]) => { status: number | null; stdout: string };

const runPs: RunPs = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 2000 });
  return { status: r.status, stdout: r.stdout ?? '' };
};

/**
 * OFF LINUX: a {@link ReadParent} for ONE walk, backed by ONE `ps` snapshot of
 * the whole table, taken lazily on the first lookup and resolved in memory
 * after that. (Per-hop `ps` meant 4-6 synchronous spawns per walk, every tick,
 * per listener.) A failed snapshot answers undefined — the walk is `unknown`.
 * Build a new reader per walk: the table is only as fresh as its snapshot.
 */
export function snapshotParentReader(run: RunPs = runPs): ReadParent {
  let table: Map<number, number> | null | undefined;
  return (pid) => {
    if (table === undefined) {
      try {
        const r = run('ps', ['-axo', 'pid=,ppid=']);
        table = r.status === 0 ? parseParentSnapshot(r.stdout) : null;
      } catch {
        table = null;
      }
    }
    return table?.get(pid);
  };
}

/** The reader for one walk on THIS host: /proc when it exists, else one ps snapshot. */
export function defaultParentReader(): ReadParent {
  return fs.existsSync('/proc/self/stat') ? readProcParent : snapshotParentReader();
}

/**
 * Is `targetPid` a (strict) ancestor of `fromPid`? Reaching pid 0/1 ends the
 * walk with `no`; a cycle or {@link MAX_ANCESTRY_HOPS} gives up (`unknown`).
 * A target of pid 1 (or below) is `unjudgeable` (see below).
 */
export function isAncestor(
  targetPid: number,
  fromPid: number,
  /** Evaluated per call, so every walk gets its own (off-Linux: one-snapshot) reader. */
  readParent: ReadParent = defaultParentReader(),
): Ancestry {
  // pid 1 (and below) is UNJUDGEABLE: every process descends from init, a
  // disowned listener reparented to it included, so "yes" would prove nothing.
  if (!Number.isInteger(targetPid) || targetPid <= 1) return 'unjudgeable';
  if (!Number.isInteger(fromPid) || fromPid <= 0) return 'unknown';
  const seen = new Set<number>([fromPid]);
  let cur = fromPid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    const parent = readParent(cur);
    if (parent === undefined) return 'unknown';
    if (parent === targetPid) return 'yes';
    if (parent <= 1) return 'no';
    if (seen.has(parent)) return 'unknown'; // a cycle: the tree changed under us
    seen.add(parent);
    cur = parent;
  }
  return 'unknown';
}

/* ================================ THE WATCH ================================
 * Every decision `sparrow await` makes about its harness, as one small state
 * machine with injectable probes (so each rule is testable without processes):
 *
 *   arm()      — inside a detected pid namespace only a proven `yes` counts
 *                (Claude Code in a container); `no`/`unknown` there may be a
 *                sandbox-local pid colliding with the host's `CLAUDE_PID`, so
 *                they leave the watch OFF. Otherwise:
 *                refuse a harness pid that is NOT RUNNING (nothing but a gone
 *                session explains it outside a namespace), and a live harness
 *                that is demonstrably NOT an ancestor. A PROVEN ancestor is
 *                the ARM OWNER — the only harness ever written to
 *                await-owner.json (`harnessPid`) — and is watched. A live
 *                harness whose ancestry is `unknown` is PENDING: neither
 *                refused nor watched yet. `--allow-unowned` turns all of it off: no probe,
 *                no watch, no `harnessPid`, ever. An `unjudgeable` harness
 *                (see isAncestor — pid 1) can never be answered for, so it is
 *                left OFF rather than pending: no retry timer.
 *   tick()     — the timer path, never throttled (the timer IS the cadence).
 *                A pending harness is re-tried: `yes` starts the watch IN
 *                MEMORY (the owner record is never amended); a definite `no`
 *                is UNOWNED — exactly what the arm would have refused, so the
 *                listener stands down as an orphan does rather than stay
 *                online-but-deaf. A watched harness is ORPHANED when it is dead
 *                or the full walk says `no` — liveness every tick, the walk
 *                every tick with procfs and every OFF_PROCFS_WALK_EVERY-th
 *                without (a `ps` spawn). `unknown` is never acted on — EXCEPT
 *                that a pending harness (always seen alive at arm) which then
 *                dies is orphaned: it is gone, and no ancestry answer can
 *                matter any more.
 *                PENDING IS CAPPED: after PENDING_UNKNOWN_CAP consecutive
 *                unknown answers the walks stop (off Linux each is a blocking
 *                `ps` spawn) and the watch keeps LIVENESS only — its exit still
 *                orphans the listener. The cap is reported once (`capped`).
 *                Both endings are terminal.
 *   activity() — the stream-activity path, throttled to `checkMs` and CHEAP:
 *                a liveness probe only. Off Linux the ancestry walk spawns
 *                `ps`, which has no place on the SSE read path.
 * ======================================================================== */

export interface HarnessWatchProbes {
  alive(pid: number): boolean;
  ancestry(pid: number): Ancestry;
  now(): number;
  /**
   * Is this process inside a pid namespace (a sandboxed Bash, or a container)?
   * Then `CLAUDE_PID` may be a HOST pid colliding with a local one, and only a
   * proven ancestry `yes` is believed.
   */
  foreignPidNamespace(): boolean;
  /** Is `/proc` here? Then a walk is free; without it, a walk is a `ps` spawn. */
  procfs: boolean;
}

/** Without procfs, a WATCHED harness's ancestry is walked on every Nth tick (once a minute). */
export const OFF_PROCFS_WALK_EVERY = 4;

/**
 * What the timer path tells `await` to do: nothing, or stand down (exit 5)
 * because the watched session is gone (`orphaned`) or because it turned out
 * this listener never descended from it (`unowned`).
 */
export type HarnessTick = 'none' | 'orphaned' | 'unowned' | 'capped';

export interface HarnessWatch {
  /** `not-running`: CLAUDE_PID names no live process; `not-ancestor`: a live stranger. */
  arm(): 'ok' | 'not-ancestor' | 'not-running';
  /** The harness PROVEN an ancestor AT ARM TIME — what `harnessPid` records. */
  armOwner(): HarnessOwner | undefined;
  /** Does anything need the periodic timer (a watch, or a pending retry)? */
  needsTimer(): boolean;
  tick(): HarnessTick;
  /** The cheap path; a terminal state reads the same here as on the timer. */
  activity(): HarnessTick;
  /**
   * How the watch ENDED — `orphaned` (the session is gone) or `unowned` (a
   * later check showed this listener does not descend from it) — or undefined
   * while it has not. The one record of it: what `await` prints reads this.
   */
  ending(): 'orphaned' | 'unowned' | undefined;
}

/** No harness, or `--allow-unowned`: nothing is probed, refused or watched. */
const OFF: HarnessWatch = {
  arm: () => 'ok',
  armOwner: () => undefined,
  needsTimer: () => false,
  tick: () => 'none',
  activity: () => 'none',
  ending: () => undefined,
};

export function createHarnessWatch(
  harness: HarnessOwner | null,
  opts: { allowUnowned: boolean; checkMs: number; probes?: HarnessWatchProbes },
): HarnessWatch {
  if (!harness || opts.allowUnowned) return OFF;
  const h = harness;
  const p: HarnessWatchProbes = opts.probes ?? {
    alive: pidAlive,
    ancestry: (pid) => isAncestor(pid, process.pid),
    now: () => Date.now(),
    foreignPidNamespace: () => detectPidNamespace().inNamespace,
    procfs: fs.existsSync('/proc/self/stat'),
  };
  const walkEvery = p.procfs ? 1 : OFF_PROCFS_WALK_EVERY;
  let ticksSinceWalk = 0;
  /** `liveness`: a capped pending harness seen alive — kill 0 only, no walks. */
  let state: 'off' | 'pending' | 'watching' | 'liveness' | 'orphaned' | 'unowned' = 'off';
  let unknownAnswers = 0;
  let armOwner: HarnessOwner | undefined;
  let lastActivityCheck = Number.NEGATIVE_INFINITY;

  return {
    arm() {
      const alive = p.alive(h.pid);
      const a: Ancestry = alive ? p.ancestry(h.pid) : 'unknown';
      // INSIDE A PID NAMESPACE only a proven `yes` counts (Claude Code in a
      // container: CLAUDE_PID is this namespace's, and really our ancestor).
      // `no`/`unknown` may be a sandbox-local pid that merely shares the HOST
      // pid's number: unjudgeable — no refusal, no record, no retries, and
      // that colliding pid is not "seen alive".
      if (a !== 'yes' && p.foreignPidNamespace()) return 'ok';
      // Outside one, a CLAUDE_PID that names nothing running is a gone session.
      if (!alive) return 'not-running';
      if (a === 'unjudgeable') return 'ok'; // never answerable: OFF, no retry timer
      if (a === 'no') return 'not-ancestor';
      if (a === 'yes') {
        armOwner = h;
        state = 'watching';
      } else {
        state = 'pending';
      }
      return 'ok';
    },
    armOwner: () => armOwner,
    needsTimer: () => state === 'pending' || state === 'watching' || state === 'liveness',
    tick() {
      if (state === 'orphaned' || state === 'unowned') return state;
      if (state === 'liveness') {
        if (p.alive(h.pid)) return 'none';
        state = 'orphaned';
        return 'orphaned';
      }
      if (state === 'pending') {
        // Seen alive at arm (a dead one was refused), so dying now is GONE.
        if (!p.alive(h.pid)) {
          state = 'orphaned';
          return 'orphaned';
        }
        const a = p.ancestry(h.pid);
        if (a === 'yes') state = 'watching';
        else if (a === 'no') state = 'unowned';
        else if (++unknownAnswers >= PENDING_UNKNOWN_CAP) {
          state = 'liveness';
          return 'capped';
        }
        return state === 'unowned' ? 'unowned' : 'none';
      }
      if (state !== 'watching') return 'none';
      // Liveness every tick; the walk every tick with procfs, every Nth without.
      if (p.alive(h.pid)) {
        if (++ticksSinceWalk < walkEvery) return 'none';
        ticksSinceWalk = 0;
        if (p.ancestry(h.pid) !== 'no') return 'none';
      }
      state = 'orphaned';
      return 'orphaned';
    },
    ending: () => (state === 'orphaned' || state === 'unowned' ? state : undefined),
    activity() {
      if (state === 'orphaned' || state === 'unowned') return state;
      if (state !== 'watching' && state !== 'liveness') return 'none';
      const now = p.now();
      if (now - lastActivityCheck < opts.checkMs) return 'none';
      lastActivityCheck = now;
      if (p.alive(h.pid)) return 'none';
      state = 'orphaned';
      return 'orphaned';
    },
  };
}

/** The one line an arm over a CLAUDE_PID that is not running prints (exit 5). */
export const notRunningRefusal = (pid: number): string =>
  `sparrow await: the Claude Code session named by CLAUDE_PID (pid ${pid}) is not running: this ` +
  'listener could never wake it. Start it from a live session as a tracked background task, ' +
  'or pass --allow-unowned.';

/** The one line printed when a pending harness's ancestry could not be proven in time. */
export const cappedNotice = (pid: number): string =>
  'sparrow await: could not prove this listener descends from the Claude Code session ' +
  `(pid ${pid}) after ${PENDING_UNKNOWN_CAP} tries; watching only whether that session is still running`;

/** The one line an unowned arm prints (exit 5). */
export const unownedRefusal = (pid: number): string =>
  `sparrow await: armed from a shell this Claude Code session does not own (harness pid ${pid} ` +
  'is not an ancestor): this listener could never wake your session. Run it as a tracked ' +
  'background task, or pass --allow-unowned.';

/** The one line a listener prints when its pending harness proves NOT an ancestor (exit 5). */
export const neverOwnedNotice = (pid: number): string =>
  'sparrow await: orphaned — arming could not prove this listener descends from the Claude Code ' +
  `session (pid ${pid}), and a later check shows it does not, so it cannot wake that session; ` +
  'standing down. Re-arm it as a tracked background task.';

/** The stand-down line for how the watch ended (exit 5). */
export const standDownNotice = (ending: 'orphaned' | 'unowned' | undefined, pid: number): string =>
  ending === 'unowned' ? neverOwnedNotice(pid) : orphanedNotice(pid);

/** The one line an orphaned listener prints on its way out (exit 5). */
export const orphanedNotice = (pid: number): string =>
  `sparrow await: orphaned — the Claude Code session that armed this listener (pid ${pid}) is ` +
  'gone; standing down.';

/** `sparrow await`'s exit code for both: this listener cannot wake its session. */
export const UNOWNED_EXIT_CODE = 5;
