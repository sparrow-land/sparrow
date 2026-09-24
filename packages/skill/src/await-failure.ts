/**
 * Why the listener died, when it managed to say so.
 *
 * A Codex queue rejection is the one death that leaves everything else looking
 * healthy: the listener woke, could not deliver the turn into the session, and
 * exited. The CLI records it in `<state dir>/await-last-failure.json`; this is
 * the skill package's reader (the package cannot import the CLI).
 *
 * THE NONCE GATE IS THE POINT. Arming supersedes the previous listener, and a
 * superseded generation's complaint says nothing about the listener that owns
 * this state dir now — so a record is returned ONLY while its nonce matches the
 * live `await-owner.json` nonce. Anything unreadable, malformed, unmatched or
 * untagged reads as "nothing to report": this runs inside `status`, where a
 * throw would be worse than silence.
 */
import fs from 'node:fs';
import path from 'node:path';

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

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** The last recorded failure of the CURRENT listener generation, if any. */
export function readAwaitFailure(stateDir: string): AwaitFailure | undefined {
  const record = readJson(path.join(stateDir, 'await-last-failure.json'));
  const owner = readJson(path.join(stateDir, 'await-owner.json'));
  if (!record || !owner) return undefined;
  const nonce = str(record.nonce);
  if (!nonce || nonce !== str(owner.nonce)) return undefined;
  const error = str(record.error);
  if (!error) return undefined;
  return {
    ...(str(record.thread) ? { thread: str(record.thread) } : {}),
    ...(str(record.at) ? { at: str(record.at) } : {}),
    ...(str(record.kind) ? { kind: str(record.kind) } : {}),
    error,
  };
}

/**
 * The live generation's nonce from `await-owner.json`, when it names one. Used
 * to gate a generation-tagged heartbeat stamp exactly as the hooks do: a
 * superseded listener's stamp says nothing about the one on watch now.
 */
export function readAwaitOwnerNonce(stateDir: string): string | undefined {
  return str(readJson(path.join(stateDir, 'await-owner.json'))?.nonce);
}

/**
 * The Claude Code session pid that armed the live listener (`harnessPid`, from
 * `CLAUDE_PID` at arm time), or `undefined` when the record names none — an
 * older CLI, a non-Claude harness, or no record at all.
 */
export function readAwaitHarnessPid(stateDir: string): number | undefined {
  const v = readJson(path.join(stateDir, 'await-owner.json'))?.harnessPid;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Is `pid` running? EPERM means it exists under another user: alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
