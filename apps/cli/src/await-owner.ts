/**
 * The listener GENERATION record — `<state dir>/await-owner.json`.
 *
 * WHY THIS EXISTS. `sparrow await` is the wake path for a turn-based agent, and
 * the skill tells that agent to re-arm it as the LAST action of every turn. But
 * a turn can end while the previous `await` is still alive (it exits only on
 * work, a replay gap, a 426, or `--timeout`), so an unconditional re-arm used to
 * leave TWO listeners on one state dir: under the Codex bridge each queues a
 * turn per message, and the duplicates amplify into a backlog; under Claude Code
 * each fires a redundant wake. Found in the field, 2026-09.
 *
 * THE SHAPE: newest wins, with NO trust in pids. Arming publishes a new
 * generation record — `{version, nonce, pid, startedAt, kind, profile?}`,
 * written atomically (temp + rename). Nothing is ever signalled, no liveness is
 * ever probed, and the record is NEVER unlinked (a read-then-unlink could delete
 * a newer generation). An older listener notices on its own: it re-reads the
 * record at every checkpoint and, seeing a nonce that is not its own, exits 4
 * having done nothing. A crashed owner needs no cleanup — the next arm simply
 * overwrites its record.
 *
 * PUBLISH LATE. A candidate publishes only once it has real credentials AND has
 * either opened the events stream or reached the preflight hand-off, so a re-arm
 * that dies on a bad token or an unreachable server never evicts a healthy
 * listener. Until then it owns nothing and touches nothing (no heartbeat, no
 * cursor, no presence, no Codex queue). That delay spans a round trip, though,
 * and an outside reader looking only at the published record cannot tell "no
 * listener" from "a listener is starting right now" — the Stop hook, checking
 * the owner's pid while the agent's last-act re-arm was still authenticating,
 * would see the exited listener's dead pid and block a turn that is about to be
 * covered. The CANDIDATE MARKER below announces the arming attempt immediately
 * so that window reads correctly, and it is never consulted for eviction.
 *
 * FAIL OPEN. Every read/write here is best-effort: an unreadable or missing
 * record reads as "still mine", and a record this process could not WRITE
 * leaves it `unfenced` — running exactly as pre-0.1.20 did, never standing
 * down — rather than silently pretending to own the state dir.
 *
 * NOT TAGGED: THE EVENT CURSOR. The cursor lives in the shared `state.json`
 * read by the CLI itself, not by hooks; a stale cursor written by a superseded
 * listener can only move the cursor backwards by at most the successor's own
 * progress, and the successor's next reconcile poll reports a gap and adopts
 * `latest` (0.1.17 semantics) — worst case one duplicate wake, fail-open by
 * construction. Tagging it would change the state.json shape every command
 * shares, for a failure that already heals.
 *
 * CROSS-PROCESS TOCTOU on the heartbeat (live claims and dead stamps alike) is
 * resolved on the READ side: stamps
 * are generation-tagged (`await:codex <nonce>`, `killed:SIGTERM <nonce>`) and
 * hooks discard a claim whose nonce is not the live generation's. Every check-then-write fence here
 * still has a window — a newer generation can publish between a checkpoint and
 * the write it guards — so BOTH heartbeat writes could persist false state: a
 * corpse reporting the live listener as dead, or a stale live claim overwriting
 * the successor's classification. The tag makes either unjudgeable rather than
 * believed. (`readHeartbeatKind` is the one deliberately RAW reader — it
 * answers "which kind of listener wrote this?" without validating the
 * generation; the validating readers are `readHeartbeatState` and the hooks.)
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from '@sparrow/skill';
import { CliError } from './util.js';

type Env = Record<string, string | undefined>;

/** What the arming listener publishes to claim the state dir. */
export interface AwaitOwnerRecord {
  version: 1;
  /** The generation id. The only thing supersession is ever decided on. */
  nonce: string;
  /**
   * Diagnostic — and, for ONE question only, evidence: whether a
   * different-thread incumbent is demonstrably alive (see {@link assertMayArm}).
   * Supersession itself is still decided on the nonce alone.
   */
  pid: number;
  startedAt: string;
  kind: string;
  profile?: string;
  /**
   * The Codex thread this listener bridges to, when it has one. ABSENT for
   * Claude Code, for a plain listener, and for every record written before
   * 0.1.38 — which all read as "no thread", i.e. freely superseded.
   */
  thread?: string;
  /**
   * How this record's publication was made atomic: `flock` (the kernel held the
   * arming lock across the re-check and the rename) or `advisory` (no `flock`
   * binary on the host — the checks ran, unserialised). Absent in records
   * written before 0.1.39.
   */
  lock?: ArmLockMechanism;
}

/** `process.kill(pid, 0)`, injectable so the three answers are testable. */
export type PidSignal = (pid: number, signal: 0) => void;

/**
 * Is this pid demonstrably ALIVE? The Stop hook's rule, exactly:
 *
 *   - the call succeeds        → alive
 *   - it throws EPERM          → alive (it exists; it is simply not ours)
 *   - it throws ESRCH          → absent
 *   - anything else, or no pid → UNKNOWN, which is not proof of either
 *
 * Only the first two are proof, and only proof may block an arm.
 */
function pidDemonstrablyAlive(pid: number, kill: PidSignal = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** The refusal — it names the pid so a hung incumbent is one command away. */
export const differentThreadRefusal = (thread: string, pid: number): string =>
  `sparrow await refused to arm: a listener for Codex thread ${thread} (pid ${pid}) already owns this ` +
  `state dir, and it is still running. If that session is gone, stop that process (kill ${pid}) or ` +
  'set SPARROW_AWAIT_TAKE_OVER=1 to arm anyway.';

/**
 * MAY this candidate take the state dir? Throws {@link CliError} (exit 1) only
 * when it must not.
 *
 * NEWEST-WINS IS DELIBERATE AND STAYS. It is what makes a blind re-arm safe:
 * check-then-exit on a pid cannot tell a healthy listener from a hung one, and a
 * listener that refuses to replace anything leaves the agent deaf the first time
 * a process wedges. So the bar for blocking is PROOF, and there is exactly one
 * proof: an incumbent that is demonstrably alive AND bound to a DIFFERENT Codex
 * thread. Replacing that one cannot re-point the wake path — Codex will not
 * accept a queue for a thread this shell does not own (the 2026-09-17 sub-agent
 * incident) — so the workspace simply goes deaf.
 *
 * EVERYTHING ELSE SUPERSEDES, exactly as before: no record, an unreadable one,
 * an incumbent with no thread (Claude Code, or any pre-0.1.38 listener), the
 * same thread re-arming, a dead pid, no pid, or a kill that failed for a reason
 * we do not understand. A lock that outlives its owner would make the whole
 * project deaf, which is strictly worse than the duplicate this guard prevents.
 * The escape hatch is printed in the refusal itself.
 *
 * @param thread this candidate's Codex thread, or `undefined` for a non-Codex
 *   listener — which never consults the guard at all.
 *
 * DELIBERATELY ONE-WAY. `thread` undefined (a Claude Code listener, or any
 * non-Codex runtime) consults nothing and keeps newest-wins, even over a live
 * Codex incumbent: there is no identity to compare in that direction, and two
 * Claude Code sessions in one project genuinely ARE the same agent re-arming.
 * A live cross-runtime collision means two agents share a profile and state
 * dir that only one should own — a misconfiguration, not a case to arbitrate.
 */
export function assertMayArm(env: Env, thread: string | undefined, kill?: PidSignal): void {
  if (!thread) return;
  if (takingOver(env)) return;
  const owner = readAwaitOwner(env);
  if (owner?.thread === undefined || owner.thread === thread) return;
  if (!pidDemonstrablyAlive(owner.pid, kill)) return;
  throw new CliError(differentThreadRefusal(owner.thread, owner.pid));
}

/**
 * TEST-ONLY seam: run immediately after a generation's record is written,
 * inside {@link AwaitGeneration.publish}. It exists to exercise the ONE gap no
 * in-process test can otherwise reach — a newer generation publishing between
 * this listener's write and the check that guards its next write (see "Known
 * residual" above). Mirrors `@sparrow/skill`'s `__resetHeartbeatThrottle`;
 * nothing in production ever sets it.
 */
let afterPublishHook: (() => void) | undefined;
export function __setAwaitPublishHookForTests(fn: (() => void) | undefined): void {
  afterPublishHook = fn;
}
function runPublishHook(): void {
  /* THE THROW IS THE POINT when a test sets one. Nothing in production ever
   * installs this hook, so swallowing here protected nobody and cost the one
   * way to exercise an UNEXPECTED failure of `publish()` end to end — the case
   * the caller's catch exists for. */
  afterPublishHook?.();
}

/** `<state dir>/await-owner.json` — the same state dir the heartbeat uses. */
export function awaitOwnerPath(env: Env): string {
  return path.join(resolveStateDir(env), 'await-owner.json');
}

/** `<state dir>/await-candidate.json` — see {@link AwaitCandidateRecord}. */
export function awaitCandidatePath(env: Env): string {
  return path.join(resolveStateDir(env), 'await-candidate.json');
}

/**
 * "A LISTENER IS ARMING." Written the instant a generation is constructed —
 * before credentials, before the network, before anything is published.
 *
 * IT IS NOT OWNERSHIP. Nothing here reads it, no eviction decision consults it,
 * and publish-late is untouched: a candidate that dies on a bad token still
 * evicts nobody. It exists so an OUTSIDE reader (the Stop hook) can tell the
 * arming window apart from an empty state dir.
 *
 * HOW READERS MUST JUDGE IT: the marker means "arming" only while its `pid` is
 * alive AND its `startedAt` is within the last {@link AWAIT_CANDIDATE_TTL_SECONDS}
 * seconds; anything else is stale — age retires a marker no one cleaned up.
 * Cleanup itself is never blind: a process removes the marker on its own publish
 * and on its own exit, and ONLY when the nonce on disk is its own (see
 * {@link clearAwaitCandidate}). A later arm overwrites whatever is there.
 */
export interface AwaitCandidateRecord {
  version: 1;
  /** The nonce this candidate will publish if it gets that far. */
  nonce: string;
  pid: number;
  startedAt: string;
  /** Which arming mechanism this host offers — see {@link ArmLockMechanism}. */
  lock?: ArmLockMechanism;
}

/** How long a candidate marker may be believed. Readers enforce this. */
export const AWAIT_CANDIDATE_TTL_SECONDS = 120;

/**
 * Retire OUR OWN marker (publish, or the listener's exit) — and only ours.
 *
 * Read, compare, unlink: a newer candidate's file must never be deleted by an
 * older process, exactly as the owner record is never unlinked blindly. The
 * opposite would re-open the window the marker exists to close, by erasing the
 * announcement of the listener that overtook us.
 *
 * A MARKER NEVER AUTHORISES ANYTHING. The Stop hook reads it only to decide how
 * PATIENT to be: a live, fresh, unpublished candidate makes the hook poll the
 * owner record for up to two seconds before blocking; the verdict itself always
 * rests on a published owner whose process exists. So the residual — a candidate
 * SIGKILLed before it could clean up, its pid recycled within
 * {@link AWAIT_CANDIDATE_TTL_SECONDS} — costs one pointless wait that still ends
 * in a block, never a turn that ends uncovered. (Reviewed 2026-09-16: a pending
 * candidate is not a wake path; a false ALLOW here is the incident itself.)
 *
 * ONE SLOT, AND THAT IS THE DESIGN. Listener A starts and announces itself; B
 * starts and overwrites the slot; B then fails (a bad token, an unreachable
 * server) and retires its own marker — and now nothing on disk says that A,
 * still opening its stream, is arming. A Stop hook firing in that window is
 * impatient and blocks a turn that was about to be covered. That is exactly the
 * pre-marker behaviour, over a narrower window, and it is where this stops: the
 * marker only ever OPTIMISES PATIENCE, so its failures must cost patience.
 * Keeping a SET of live candidates would turn the slot into a second ownership
 * record — its own staleness, its own races, its own way to talk a hook out of
 * blocking — which is the thing publish-late exists to avoid.
 */
function clearAwaitCandidate(env: Env, nonce: string): void {
  try {
    const file = awaitCandidatePath(env);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AwaitCandidateRecord>;
    if (raw?.nonce !== nonce) return; // someone else's announcement — hands off
    fs.unlinkSync(file);
  } catch {
    /* absent, unreadable, already gone: nothing to retire */
  }
}

/** Best-effort, atomic, never throws: an unwritable state dir just skips it. */
function writeAwaitCandidate(env: Env, nonce: string, lock?: ArmLockMechanism): void {
  const record: AwaitCandidateRecord = {
    version: 1,
    nonce,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(lock ? { lock } : {}),
  };
  let tmp: string | undefined;
  try {
    const file = awaitCandidatePath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${nonce}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    fs.renameSync(tmp, file); // atomic: no reader ever sees half a record
    tmp = undefined; // renamed away; there is nothing left to clean up
  } catch {
    /* best-effort: a marker that cannot be written must not stop the listener.
     * A rename that failed (the target path occupied, a state dir gone
     * read-only) would otherwise leave litter in the state dir on EVERY arm, so
     * take the temp file with us — its name carries our own pid and nonce, so
     * this can only ever remove ours. */
    if (tmp !== undefined) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing further to try; a stray temp file is inert either way */
      }
    }
  }
}

/** The published generation, or undefined when absent, unreadable, or malformed. */
export function readAwaitOwner(env: Env): AwaitOwnerRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(awaitOwnerPath(env), 'utf8')) as Partial<AwaitOwnerRecord>;
    if (typeof raw?.nonce !== 'string' || !raw.nonce) return undefined;
    return {
      version: 1,
      nonce: raw.nonce,
      pid: Number.isInteger(raw.pid) ? (raw.pid as number) : 0,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      kind: typeof raw.kind === 'string' ? raw.kind : 'await',
      ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
      ...(typeof raw.thread === 'string' && raw.thread ? { thread: raw.thread } : {}),
      ...(raw.lock === 'flock' || raw.lock === 'advisory' ? { lock: raw.lock } : {}),
    };
  } catch {
    return undefined;
  }
}

/* ==================================================================
 * PUBLISHING ATOMICALLY — the arming lock
 *
 * WHY. {@link assertMayArm} and the record rename are two operations, and
 * between them another process can publish: two different-thread candidates
 * both passed the guard, both renamed, and the live incumbent the guard exists
 * to protect was lost (reproduced with two real node processes, vm5,
 * 2026-09-17). The re-check and the rename have to be ONE critical section.
 *
 * WHY NOT A LOCK FILE WE MANAGE OURSELVES. Every home-made protocol needs an
 * answer to "the holder died holding it", and every answer is a guess: a pid
 * can be recycled, `kill(pid, 0)` cannot tell the holder from whoever inherited
 * its number, and any age-based reclaim steals from a holder that was merely
 * paused — a 60-second stop resumes exactly like a 5-second one. Each rule we
 * tried traded one wedge for another.
 *
 * SO THE KERNEL HOLDS IT. `flock(2)` is released when the holding process ends,
 * however it ends — exit, SIGKILL, container stop, power loss — so there is
 * nothing to reclaim and no staleness to reason about. We reach it through
 * `flock(1)` (util-linux 2.38.1 here and in the shipping Debian 12 image;
 * busybox's flock has the same `-w` semantics — both are PROBED, never assumed).
 *
 * AND THE LOCK HOLDER RUNS THE SECTION. `flock <file> <command>` holds the lock
 * for exactly as long as `<command>` runs, so the command must BE the critical
 * section: a helper that merely announces "acquired" and waits for its parent
 * would release the moment it died, while the parent went on renaming. The
 * helper is therefore a hidden CLI entry ({@link ARM_HELPER_COMMAND}) that does
 * the re-check, the rename and the candidate cleanup itself and prints one JSON
 * line back. The parent only interprets that line.
 *
 * WHERE THERE IS NO `flock` (macOS, minimal images without util-linux or
 * busybox), the mode is ADVISORY: exactly the 0.1.38 behaviour — the preflight
 * guard plus the publish-time re-check, newest-wins — and one stderr line
 * saying so. Refusing to arm there is not an option: a macOS Codex agent would
 * never be able to listen at all. Advisory is chosen ONLY for a genuinely
 * absent binary, NEVER as a fallback from contention, a permission error, a
 * helper crash or an unexpected exit code — those refuse and publish nothing.
 * ================================================================== */

/** How long to wait for the arming lock before refusing. */
export const ARM_LOCK_WAIT_MS = 3_000;

/** Which mechanism made this generation's publication atomic. */
export type ArmLockMechanism = 'flock' | 'advisory';

/**
 * What the probe concluded. `unavailable` is NOT a mechanism: it is a `flock`
 * that exists and could not be run, which refuses rather than publishing.
 */
export type ArmLockDecision =
  | { mechanism: ArmLockMechanism }
  | { mechanism: 'unavailable'; code: string };

/** The hidden CLI entry that runs the critical section under the kernel lock. */
export const ARM_HELPER_COMMAND = '__arm-publish';

/**
 * `<state dir>/await-arming.lock` — a STABLE INODE, never unlinked and never
 * read: `flock` locks the file, it does not own its contents. Removing it would
 * hand two processes two different inodes to lock, which is the one thing that
 * breaks this.
 */
export function awaitArmLockPath(env: Env): string {
  return path.join(resolveStateDir(env), 'await-arming.lock');
}

/** Everything injectable about arming. Production passes none of it. */
export interface ArmLockOptions {
  /** Force a mechanism instead of probing for `flock`. */
  mechanism?: ArmLockMechanism;
  waitMs?: number;
  /** The `flock` binary (tests point this at a directory without one). */
  flockPath?: string;
  /** The CLI entry the helper is run from; `process.argv[1]` by default. */
  bundle?: string;
  /** Injected `spawnSync` for both the probe and the helper. */
  spawn?: typeof spawnSync;
}

export const armLockContention = (path: string, waitMs: number): string => {
  const secs = Number((waitMs / 1000).toFixed(1)).toString();
  return (
    `sparrow await could not arm: the arming lock ${path} is held by another publisher and did not ` +
    `clear within ${secs} s; run \`sparrow await\` again`
  );
};

export const armLockUnavailable = (path: string, detail: string): string =>
  `sparrow await could not arm: the arming lock ${path} could not be taken (${detail}); nothing was ` +
  'published. Fix that path (or its permissions) and run `sparrow await` again.';

export const flockBrokenRefusal = (code: string): string =>
  `sparrow await could not arm: flock is present but failed to run (${code}); nothing was published. ` +
  'Fix the flock binary or set SPARROW_ARM_LOCK=advisory deliberately.';

export const ADVISORY_LOCK_NOTE =
  'arming lock unavailable (no flock on PATH): ownership checks are advisory on this host';

/* ------------------------------ mechanism ------------------------------ */

let probedMechanism: ArmLockMechanism | undefined;

/** The operator/embedder override, when it names a mechanism we know. */
function envForcedMechanism(env: Env): ArmLockMechanism | undefined {
  const forced = env.SPARROW_ARM_LOCK?.trim().toLowerCase();
  return forced === 'advisory' || forced === 'flock' ? forced : undefined;
}

/**
 * Which mechanism does this host offer?
 *
 * ADVISORY IS A CONCLUSION ABOUT ONE THING ONLY: the binary is not installed —
 * `ENOENT`, and nothing else. Every other way a probe can fail describes a
 * `flock` that IS there and did not work: `EACCES` (present, not executable),
 * `ETIMEDOUT`, `EIO`, a descriptor limit, something unrecognised. Publishing
 * without the kernel lock because the kernel lock is BROKEN is precisely the
 * silent downgrade this design forbids, so those answer `unavailable` and the
 * arm refuses, naming the code.
 *
 * WHAT IS CACHED: only a settled answer. `ENOENT` (a binary does not appear
 * mid-session) and a working `flock` are remembered for the process; a fault is
 * not — it may be a transient EIO or a chmod away from being fixed, and an arm
 * a minute later deserves a fresh look.
 *
 * A NON-ZERO EXIT IS NOT A FAULT: busybox's flock has no `--version` and exits
 * non-zero. The binary ran, which is the whole question here.
 */
export function detectArmLockMechanism(o: ArmLockOptions = {}, env: Env = {}): ArmLockDecision {
  if (o.mechanism !== undefined) return { mechanism: o.mechanism };
  // OPERATOR/TEST OVERRIDE. `SPARROW_ARM_LOCK=advisory` is also what an embedder
  // that has no CLI bundle to re-enter (the test suite driving `runCli`
  // in-process) must set: the helper is a real subprocess of the real binary.
  const forced = envForcedMechanism(env);
  if (forced !== undefined) return { mechanism: forced };
  if (probedMechanism !== undefined) return { mechanism: probedMechanism };
  const run = o.spawn ?? spawnSync;
  let failure: NodeJS.ErrnoException | undefined;
  try {
    const r = run(o.flockPath ?? 'flock', ['--version'], {
      stdio: 'ignore',
      timeout: 5_000,
      // The listener's PATH decides which `flock` this is a probe OF — the same
      // environment the helper will be spawned with, or the answer means nothing.
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    });
    if (r.error === undefined) {
      probedMechanism = 'flock';
      return { mechanism: 'flock' };
    }
    failure = r.error as NodeJS.ErrnoException;
  } catch (e) {
    failure = e as NodeJS.ErrnoException;
  }
  if (failure?.code === 'ENOENT') {
    probedMechanism = 'advisory';
    return { mechanism: 'advisory' };
  }
  return { mechanism: 'unavailable', code: failure?.code ?? 'UNKNOWN' };
}

/** TEST-ONLY: forget the per-process probe. */
export function __resetArmLockProbeForTests(): void {
  probedMechanism = undefined;
}

/* ------------------------------- the helper ------------------------------ */

/** What the parent hands the helper — everything, so it inherits no env. */
interface ArmHelperPayload {
  stateDir: string;
  nonce: string;
  listenerPid: number;
  kind: string;
  thread?: string;
  profile?: string;
  takeOver?: boolean;
}

export function encodeArmHelperPayload(p: ArmHelperPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

/**
 * THE CRITICAL SECTION, running as the process that holds the kernel lock.
 *
 * Returns the ONE JSON line the parent reads. It never throws and always exits
 * 0: the parent's decision is the line, never the status, so a status is free
 * to mean "the helper never got to speak".
 */
export function runArmPublishHelper(payload: string): string {
  const say = (o: Record<string, unknown>): string => JSON.stringify(o);
  let p: ArmHelperPayload;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ArmHelperPayload;
  } catch (e) {
    return say({ result: 'error', message: `unreadable payload: ${(e as Error)?.message}` });
  }
  const env: Env = {
    SPARROW_STATE_DIR: p.stateDir,
    ...(p.takeOver ? { SPARROW_AWAIT_TAKE_OVER: '1' } : {}),
  };

  // TEST-ONLY: hold the section open so a test can kill something mid-flight.
  const pause = process.env.SPARROW_ARM_HELPER_PAUSE;
  if (pause) {
    const ready = process.env.SPARROW_ARM_HELPER_READY;
    if (ready) {
      try {
        fs.writeFileSync(ready, String(process.pid));
      } catch {
        /* the test will time out and say so */
      }
    }
    const until = Date.now() + 30_000;
    while (!fs.existsSync(pause) && Date.now() < until) {
      /* spin: this process holds the lock while it does */
    }
  }

  try {
    // THE LISTENER MUST STILL BE THERE. We may have waited seconds for the lock,
    // and a record naming a dead owner is worse than no record: it tells every
    // hook a listener is live when nothing is listening. (`flock` FORKS before
    // exec — measured: our ppid is flock's, not the listener's — so the listener
    // is identified by the pid we were given, not by `process.ppid`.)
    if (!pidDemonstrablyAlive(p.listenerPid)) {
      return say({ result: 'aborted', reason: 'listener gone' });
    }
    assertMayArm(env, p.thread);
    const record: AwaitOwnerRecord = {
      version: 1,
      nonce: p.nonce,
      pid: p.listenerPid,
      startedAt: new Date().toISOString(),
      kind: p.kind,
      ...(p.profile ? { profile: p.profile } : {}),
      ...(p.thread ? { thread: p.thread } : {}),
      lock: 'flock',
    };
    const file = awaitOwnerPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${p.nonce}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    fs.renameSync(tmp, file); // atomic, and under the kernel lock
    clearAwaitCandidate(env, p.nonce);
    return say({ result: 'published', nonce: p.nonce });
  } catch (e) {
    if (e instanceof CliError) return say({ result: 'refused', message: e.message });
    return say({ result: 'error', message: String((e as Error)?.message ?? e) });
  }
}

/* ------------------------------ the parent ------------------------------- */

interface HelperOutcome {
  published: boolean;
  /** Set when the parent must fail: the message to exit 1 with. */
  refusal?: string;
}

/** Run the critical section under `flock` and interpret the one line it prints. */
function publishUnderFlock(
  env: Env,
  payload: ArmHelperPayload,
  o: ArmLockOptions,
): HelperOutcome {
  const lockFile = awaitArmLockPath(env);
  const waitMs = o.waitMs ?? ARM_LOCK_WAIT_MS;
  const run = o.spawn ?? spawnSync;
  const bundle = o.bundle ?? process.argv[1];
  if (!bundle) {
    return { published: false, refusal: armLockUnavailable(lockFile, 'no CLI entry to run') };
  }
  const waitSecs = Math.max(1, Math.ceil(waitMs / 1000));
  const r = run(
    o.flockPath ?? 'flock',
    [
      '-w',
      String(waitSecs),
      lockFile,
      process.execPath,
      bundle,
      ARM_HELPER_COMMAND,
      encodeArmHelperPayload(payload),
    ],
    {
      encoding: 'utf8',
      timeout: waitMs + 10_000,
      /* THE LISTENER'S ENVIRONMENT, not this process's: `flock` and `node` are
       * resolved from PATH, and an embedder that drives `runCli` with an env of
       * its own must get the binaries IT named. Merged over `process.env` so a
       * partial env (a test's, typically) still inherits everything it did not
       * set — the same shape `queueCodexAwaitWake` uses for `codex`. */
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    },
  );

  const line = String(r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (line !== undefined) {
    try {
      const said = JSON.parse(line) as { result?: string; message?: string; reason?: string };
      if (said.result === 'published') return { published: true };
      if (said.result === 'refused') {
        return { published: false, refusal: said.message ?? 'arming was refused' };
      }
      if (said.result === 'aborted') {
        // We are demonstrably alive (we are reading this), so the helper judging
        // otherwise means something is badly wrong — never a silent publish.
        return {
          published: false,
          refusal: armLockUnavailable(lockFile, `helper aborted: ${said.reason ?? 'unknown'}`),
        };
      }
      return {
        published: false,
        refusal: armLockUnavailable(lockFile, said.message ?? 'helper reported an error'),
      };
    } catch {
      /* fall through to the no-line handling */
    }
  }

  // NO LINE. The helper may still have committed the rename before it died, so
  // the record is the authority — never a blind retry.
  if (readAwaitOwner(env)?.nonce === payload.nonce) return { published: true };
  const stderr = String(r.stderr ?? '').trim().split('\n')[0] ?? '';
  if (r.error !== undefined) {
    return { published: false, refusal: armLockUnavailable(lockFile, r.error.message) };
  }
  // util-linux exits 1 when `-w` expires, and 64+ (EX_*) when it cannot even
  // open the lock file — measured: 66 with "cannot open lock file".
  if (r.status === 1 && stderr === '') return { published: false, refusal: armLockContention(lockFile, waitMs) };
  return {
    published: false,
    refusal: armLockUnavailable(lockFile, stderr || `flock exited ${String(r.status)}`),
  };
}

/**
 * How a publish landed.
 *
 * `published` — the record is on disk and this generation is FENCED: it can be
 * superseded, and it will stand down when it is.
 * `unfenced` — the record could not be written (an unwritable or vanished state
 * dir). The listener runs anyway, exactly as pre-0.1.20 did, and never stands
 * down: with no record of its own it cannot tell a successor from a stranger,
 * and being deaf is strictly worse than one duplicate wake. It is a fallback,
 * never ownership.
 */
export type AwaitPublication = 'published' | 'unfenced';

/** The one listener generation this process is (or is about to become). */
export interface AwaitGeneration {
  /** This generation's nonce — undefined until {@link publish}. */
  nonce(): string | undefined;
  /** Has this candidate gone live (fenced OR unfenced)? */
  published(): boolean;
  /** Is this generation actually FENCED — i.e. did its record reach disk? */
  fenced(): boolean;
  /**
   * Claim the state dir for this listener: write the record, newest wins.
   * Idempotent — re-publishing keeps the same nonce and re-writes nothing, so
   * the first call's outcome is the one that stands.
   *
   * THROWS {@link CliError} (exit 1) in exactly one case: a demonstrably live
   * listener on a DIFFERENT Codex thread published while this candidate was
   * still authenticating (see {@link assertMayArm}). Nothing is written on that
   * path — the incumbent keeps the state dir and this process stands down.
   */
  publish(): AwaitPublication;
  /**
   * Retire this generation's candidate marker — on its own publish, and again
   * on the listener's exit (a candidate that never published still has one).
   * No-op for anyone else's marker; never throws; idempotent.
   */
  clearCandidate(): void;
  /**
   * The CHECKPOINT. `undefined` while this listener still owns the state dir
   * (including before it has published, when it owns nothing and does nothing);
   * otherwise the nonce of the generation that superseded it.
   *
   * Call this immediately before EVERY side effect on shared state — the wake
   * line, a Codex queue, the event cursor, the heartbeat (including a signal
   * handler's `killed:` stamp) and presence — as well as on the periodic
   * heartbeat touch, which is what makes an idle listener notice at all.
   */
  supersededBy(): string | undefined;
}

/**
 * Can this state dir hold the owner record at all? Probed by WRITING (and
 * removing) a temp file: the question is never "does the directory exist" but
 * "will the rename that follows work", and only an attempt answers that.
 */
function stateDirWritable(env: Env): boolean {
  const probe = `${awaitOwnerPath(env)}.probe.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Has an operator set the take-over escape? (Read once, passed to the helper.) */
function takingOver(env: Env): boolean {
  const v = env.SPARROW_AWAIT_TAKE_OVER?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/**
 * Prepare (but do not yet publish) this listener's generation.
 *
 * @param kind the heartbeat listener kind this listener will stamp (`await` /
 *   `await:codex`) — recorded so a human reading the file can tell what holds it.
 */
export function prepareAwaitGeneration(opts: {
  env: Env;
  kind: string;
  profile?: string;
  /**
   * The Codex thread this listener bridges to — recorded so the NEXT candidate
   * can tell "re-arm me" from "replace a session I cannot speak for" (see
   * {@link assertMayArm}). Omitted by Claude Code and plain listeners.
   */
  thread?: string;
  /** Test seam: the `process.kill(pid, 0)` used by the publish-time recheck. */
  kill?: PidSignal;
  /** Injection for the arming lock (mechanism, binary, helper entry, spawn). */
  lock?: ArmLockOptions;
  /** One line at a time — `io.err`. Used once, to announce advisory mode. */
  err?(s: string): void;
}): AwaitGeneration {
  const { env, kind, profile, thread, kill, lock: lockOpts = {}, err } = opts;
  const nonce = crypto.randomBytes(8).toString('hex');
  // WHICH MECHANISM, decided once at arm time: it goes into both records, so a
  // reader (a test, `sparrow skill status`, an operator) can see whether this
  // listener's publication was kernel-serialised or merely advisory.
  const decision = detectArmLockMechanism(lockOpts, env);
  const mechanism = decision.mechanism === 'unavailable' ? undefined : decision.mechanism;
  // The note explains an ABSENT binary, so it is not printed when an operator
  // (or an embedder with no CLI bundle to re-enter) asked for advisory mode by
  // name — saying "no flock on PATH" to someone who typed `SPARROW_ARM_LOCK`
  // would simply be false. A BROKEN flock says nothing here either: it is not a
  // mode, and publish() refuses with the code it failed on.
  if (mechanism === 'advisory' && envForcedMechanism(env) === undefined) {
    err?.(`[await] ${ADVISORY_LOCK_NOTE}\n`);
  }
  // IMMEDIATELY — before credentials, before the network, before publish-late.
  // This is what turns the arming window from "no listener" into "one starting".
  writeAwaitCandidate(env, nonce, mechanism);
  let live = false;
  /** FALSE for an `unfenced` generation — one whose record never reached disk. */
  let onDisk = false;
  /** Sticky: once superseded, a listener never un-supersedes itself. */
  let lost: string | undefined;

  return {
    // Only a FENCED generation names itself: an unfenced listener tags nothing,
    // so its stamps are judged exactly as a pre-0.1.20 listener's are.
    nonce: () => (live && onDisk ? nonce : undefined),
    published: () => live,
    fenced: () => onDisk,
    publish(): AwaitPublication {
      if (live) return onDisk ? 'published' : 'unfenced';
      /* CAN THIS STATE DIR HOLD A RECORD AT ALL? Asked FIRST, because the answer
       * decides which kind of failure we are looking at. A dir that cannot be
       * written was always `unfenced` (pre-0.1.20 behaviour, never ownership)
       * and stays so; a dir that CAN be written but whose lock cannot be taken
       * is a real failure and refuses — it must never quietly degrade into an
       * unfenced publish that evicts nobody but believes it is listening. */
      if (!stateDirWritable(env)) return goLive('unfenced');
      // A flock that is installed and will not run is a FAULT, not a mode: the
      // kernel lock is unavailable, so nothing is published.
      if (decision.mechanism === 'unavailable') throw new CliError(flockBrokenRefusal(decision.code));
      if (mechanism === 'flock') {
        const outcome = publishUnderFlock(
          env,
          {
            stateDir: resolveStateDir(env),
            nonce,
            listenerPid: process.pid,
            kind,
            ...(thread ? { thread } : {}),
            ...(profile ? { profile } : {}),
            ...(takingOver(env) ? { takeOver: true } : {}),
          },
          lockOpts,
        );
        if (!outcome.published) throw new CliError(outcome.refusal ?? 'arming was refused');
        onDisk = true;
        return goLive('published');
      }
      // ADVISORY: 0.1.38 exactly — the re-check, then the rename, in-process.
      return publishAdvisory();
    },
    clearCandidate(): void {
      clearAwaitCandidate(env, nonce);
    },
    supersededBy(): string | undefined {
      if (lost !== undefined) return lost;
      if (!live) return undefined; // a candidate owns nothing and touches nothing
      // UNFENCED: no record of our own to compare against, so nothing can be
      // proven — keep listening (pre-0.1.20 behaviour) rather than stand down
      // for a record that may not be about us at all.
      if (!onDisk) return undefined;
      const current = readAwaitOwner(env);
      // No record (wiped state dir) or an unreadable one: fail open and keep
      // listening — being deaf is strictly worse than one duplicate wake.
      if (current === undefined || current.nonce === nonce) return undefined;
      lost = current.nonce;
      return lost;
    },
  };

  /** Go live, retire our candidate marker, and let the test seam observe it. */
  function goLive(result: AwaitPublication): AwaitPublication {
    live = true;
    // The published record now makes the same announcement, with more
    // authority — ours to retire, and only ours. (Under `flock` the helper has
    // already done this; a second call is a no-op.)
    clearAwaitCandidate(env, nonce);
    runPublishHook();
    return result;
  }

  /**
   * ADVISORY MODE — no `flock` binary on this host.
   *
   * The re-check and the rename are the same two operations 0.1.38 shipped, and
   * the same microsecond window sits between them. Everything the ordering
   * guarantee rests on still holds (newest-wins, the different-thread refusal,
   * publish-late); what is missing is the proof that two SIMULTANEOUS
   * publishers cannot interleave. Saying so once on stderr is the honest
   * treatment: refusing to arm would leave a macOS agent unable to listen at
   * all, which is a certain failure in place of an unlikely one.
   */
  function publishAdvisory(): AwaitPublication {
    assertMayArm(env, thread, kill);
    const record: AwaitOwnerRecord = {
      version: 1,
      nonce,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      kind,
      ...(profile ? { profile } : {}),
      ...(thread ? { thread } : {}),
      lock: 'advisory',
    };
    try {
      const file = awaitOwnerPath(env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${nonce}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
      fs.renameSync(tmp, file); // atomic: no reader ever sees half a record
      onDisk = true;
    } catch {
      /* best-effort: an unwritable state dir must not stop the listener */
    }
    return goLive(onDisk ? 'published' : 'unfenced');
  }
}
