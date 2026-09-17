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
 */
export function assertMayArm(env: Env, thread: string | undefined, kill?: PidSignal): void {
  if (!thread) return;
  const v = env.SPARROW_AWAIT_TAKE_OVER?.trim().toLowerCase();
  if (v !== undefined && v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off') return;
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
  try {
    afterPublishHook?.();
  } catch {
    /* a test seam must never break the listener */
  }
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
function writeAwaitCandidate(env: Env, nonce: string): void {
  const record: AwaitCandidateRecord = {
    version: 1,
    nonce,
    pid: process.pid,
    startedAt: new Date().toISOString(),
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
    };
  } catch {
    return undefined;
  }
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
}): AwaitGeneration {
  const { env, kind, profile, thread, kill } = opts;
  const nonce = crypto.randomBytes(8).toString('hex');
  // IMMEDIATELY — before credentials, before the network, before publish-late.
  // This is what turns the arming window from "no listener" into "one starting".
  writeAwaitCandidate(env, nonce);
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
      // THE LAST-MOMENT RECHECK. The preflight guard ran before this process
      // touched anything, which two concurrent starters would both pass: each
      // reads an empty (or dead) state dir, then both write. Re-reading here —
      // immediately before the rename — is what makes the loser stand down
      // instead of evicting a live listener it cannot speak for.
      assertMayArm(env, thread, kill);
      const record: AwaitOwnerRecord = {
        version: 1,
        nonce,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        kind,
        ...(profile ? { profile } : {}),
        ...(thread ? { thread } : {}),
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
      live = true;
      // The published record now makes the same announcement, with more
      // authority — ours to retire, and only ours.
      clearAwaitCandidate(env, nonce);
      runPublishHook();
      return onDisk ? 'published' : 'unfenced';
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
}
