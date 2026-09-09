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
 * cursor, no presence, no Codex queue).
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

type Env = Record<string, string | undefined>;

/** What the arming listener publishes to claim the state dir. */
export interface AwaitOwnerRecord {
  version: 1;
  /** The generation id. The only thing supersession is ever decided on. */
  nonce: string;
  /** Diagnostic only — never signalled, never probed for liveness. */
  pid: number;
  startedAt: string;
  kind: string;
  profile?: string;
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
   */
  publish(): AwaitPublication;
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
}): AwaitGeneration {
  const { env, kind, profile } = opts;
  const nonce = crypto.randomBytes(8).toString('hex');
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
      const record: AwaitOwnerRecord = {
        version: 1,
        nonce,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        kind,
        ...(profile ? { profile } : {}),
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
      runPublishHook();
      return onDisk ? 'published' : 'unfenced';
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
