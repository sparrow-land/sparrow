/**
 * The listener's OWNER RECORD and the FAILURE RECORD it gates.
 *
 * Why the listener died, when it managed to say so: a Codex queue rejection is
 * the one death that leaves everything else looking healthy (the listener woke,
 * could not deliver the turn into the session, and exited). The CLI records it
 * in `<state dir>/await-last-failure.json`; this is the skill package's reader
 * (the package cannot import the CLI). THE NONCE GATE IS THE POINT: arming
 * supersedes the previous listener, and a superseded generation's complaint
 * says nothing about the one that owns this state dir now, so a record counts
 * ONLY while its nonce matches the live `await-owner.json` nonce. Anything
 * unreadable, malformed, unmatched or untagged reads as "nothing to report".
 *
 * ONE READ of `<state dir>/await-owner.json` for `sparrow skill status`.
 *
 * `status` prints the owner (the Claude Code session that armed the listener),
 * gates an `orphaned` stamp on the live generation, and gates the "listener
 * died" failure record on it too. Reading the record separately for each let
 * one status print lines from DIFFERENT generations when a re-arm landed in
 * between. So `status` takes this snapshot once and derives every line from it.
 *
 * Fail-open like the other readers: anything unreadable or malformed reads as
 * "no record".
 */
import path from 'node:path';
import { isPid } from './pid.js';
import { readJsonRecord as readJson } from './state.js';

export interface AwaitFailure {
  /** The Codex thread the queue was rejected for, when the record names one. */
  thread?: string;
  /** ISO timestamp the CLI wrote. */
  at?: string;
  /** `codex-queue` today; kept open so a new kind reads rather than throws. */
  kind?: string;
  /** First line of the error, already capped by the writer. */
  error: string;
}

export interface OwnerSnapshot {
  /** The live generation nonce, when the record names one. */
  nonce?: string;
  /** The Claude Code session pid that armed the listener (`CLAUDE_PID`). */
  harnessPid?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** The owner record, parsed once; `undefined` when there is none. */
export function readOwnerSnapshot(stateDir: string): OwnerSnapshot | undefined {
  const owner = readJson(path.join(stateDir, 'await-owner.json'));
  return owner ? ownerSnapshotOf(owner) : undefined;
}

/**
 * The shared fields of an owner record ALREADY PARSED — the one definition of
 * a valid nonce (a non-blank string) and `harnessPid` (a pid). The CLI's
 * `readAwaitOwner` derives them from its own single read with this, so the two
 * readers can never disagree.
 */
export function ownerSnapshotOf(owner: Record<string, unknown>): OwnerSnapshot {
  const nonce = str(owner.nonce);
  const pid = owner.harnessPid;
  return {
    ...(nonce ? { nonce } : {}),
    ...(isPid(pid) ? { harnessPid: pid } : {}),
  };
}

/**
 * The last recorded failure, gated on THIS snapshot's nonce -- the same rule
 * as `readAwaitFailure`, without a second read of the owner record.
 */
export function readFailureFor(stateDir: string, owner: OwnerSnapshot | undefined): AwaitFailure | undefined {
  const record = readJson(path.join(stateDir, 'await-last-failure.json'));
  if (!record || !owner?.nonce) return undefined;
  const nonce = str(record.nonce);
  if (!nonce || nonce !== owner.nonce) return undefined;
  const error = str(record.error);
  if (!error) return undefined;
  return {
    ...(str(record.thread) ? { thread: str(record.thread) } : {}),
    ...(str(record.at) ? { at: str(record.at) } : {}),
    ...(str(record.kind) ? { kind: str(record.kind) } : {}),
    error,
  };
}

/** The last recorded failure of the CURRENT listener generation, if any. */
export function readAwaitFailure(stateDir: string): AwaitFailure | undefined {
  return readFailureFor(stateDir, readOwnerSnapshot(stateDir));
}
