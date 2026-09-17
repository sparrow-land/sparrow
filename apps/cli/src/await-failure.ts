/**
 * `<state dir>/await-last-failure.json` — the listener's last words.
 *
 * WHY IT EXISTS (field incident, Codex 0.154, 2026-09-17). When the Codex wake
 * bridge is REFUSED — a spawned sub-agent's thread cannot be queued into, a
 * thread that no longer exists, an app-server that says no — the listener has
 * already printed the reason to a stderr nobody will read again: the shell that
 * armed it is gone, and the next turn starts fresh. All the next turn could see
 * was a heartbeat stamped `killed:CODEX_QUEUE`, which says THAT the wake path
 * broke and nothing about why, so the agent had to guess.
 *
 * So the sentence is left on disk instead. It is DIAGNOSTIC ONLY: nothing reads
 * it to make a decision, no exit code depends on it, and a record that cannot be
 * written changes nothing (every write here is best-effort). A reader shows it
 * only while its `nonce` matches the current owner record — otherwise it is some
 * earlier listener's complaint about a generation that has since been replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from '@sparrow/skill';

type Env = Record<string, string | undefined>;

/** How much of the error line is kept — enough to read, never a stack dump. */
export const AWAIT_FAILURE_ERROR_MAX = 300;

export interface AwaitFailureRecord {
  version: 1;
  /**
   * The generation that failed, when it had one. ABSENT for an unfenced
   * listener — a reader that cannot match a nonce should say nothing rather
   * than attribute the failure to whoever owns the state dir now.
   */
  nonce?: string;
  /** The Codex thread the queue was refused for. */
  thread: string;
  at: string;
  /** What kind of wake path failed. One value today; a union tomorrow. */
  kind: 'codex-queue';
  /** First line of the error, capped at {@link AWAIT_FAILURE_ERROR_MAX}. */
  error: string;
}

/** `<state dir>/await-last-failure.json`. */
export function awaitFailurePath(env: Env): string {
  return path.join(resolveStateDir(env), 'await-last-failure.json');
}

/** The readable half of a thrown value: first line, capped, never a stack. */
export function failureLine(error: unknown, max = AWAIT_FAILURE_ERROR_MAX): string {
  const raw = String((error as Error)?.message ?? error ?? '');
  return (raw.split('\n')[0] ?? '').trim().slice(0, max);
}

/**
 * Record why the wake path failed. Best-effort and atomic (temp + rename);
 * never throws, and a failed write leaves no temp file behind.
 */
export function writeAwaitFailure(
  env: Env,
  what: { nonce?: string; thread: string; error: unknown; kind?: AwaitFailureRecord['kind'] },
): void {
  const record: AwaitFailureRecord = {
    version: 1,
    ...(what.nonce ? { nonce: what.nonce } : {}),
    thread: what.thread,
    at: new Date().toISOString(),
    kind: what.kind ?? 'codex-queue',
    error: failureLine(what.error),
  };
  let tmp: string | undefined;
  try {
    const file = awaitFailurePath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    fs.renameSync(tmp, file);
    tmp = undefined;
  } catch {
    /* a diagnostic that cannot be written is not worth an exception */
    if (tmp !== undefined) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing further to try */
      }
    }
  }
}

/** The recorded failure, or `undefined` when absent, unreadable or malformed. */
export function readAwaitFailure(env: Env): AwaitFailureRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(awaitFailurePath(env), 'utf8')) as Partial<AwaitFailureRecord>;
    if (typeof raw?.thread !== 'string' || typeof raw.error !== 'string') return undefined;
    return {
      version: 1,
      ...(typeof raw.nonce === 'string' && raw.nonce ? { nonce: raw.nonce } : {}),
      thread: raw.thread,
      at: typeof raw.at === 'string' ? raw.at : '',
      kind: 'codex-queue',
      error: raw.error,
    };
  } catch {
    return undefined;
  }
}
