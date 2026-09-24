/**
 * Is this pid running? The one liveness probe the skill's `status`, the CLI's
 * arming guard and its harness watch all share.
 */
/** `process.kill(pid, 0)`, injectable so every answer is testable. */
export type PidSignal = (pid: number, signal: 0) => void;

/**
 * Is `value` a pid at all — a positive safe integer? The ONE predicate: 0 and
 * negatives name process GROUPS to `kill`, and NaN, fractions, strings and
 * out-of-range numbers are simply not pids.
 */
export function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Is `pid` running? The call succeeding, or EPERM (it exists under another
 * user), is alive; ESRCH or anything else is not.
 *
 * Only a positive integer is ever asked about: `kill(0, 0)` and `kill(-n, 0)`
 * signal a process GROUP and succeed, so without the guard pid 0 would read as
 * alive on every host (and NaN/fractions are simply not pids).
 */
export function pidAlive(
  pid: number,
  kill: PidSignal = (p, s) => {
    process.kill(p, s);
  },
): boolean {
  if (!isPid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
