/**
 * `pidAlive` — the one "is this pid running?" probe the hooks' readers, the
 * CLI's arming guard and its harness watch all share.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isPid, pidAlive, type PidSignal } from './pid.js';

describe('pidAlive', () => {
  it('this process is alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('a spawned child that has been reaped is not', async () => {
    const kid = spawn('true', [], { stdio: 'ignore' });
    const pid = kid.pid!;
    await new Promise((r) => kid.once('exit', r));
    expect(pidAlive(pid)).toBe(false);
  });

  /* `kill(0, 0)` and `kill(-n, 0)` signal a process GROUP and succeed, so
   * without the guard pid 0 read as alive on every host. */
  it('0, negative, fractional and NaN pids are never alive — and never signalled', () => {
    const calls: number[] = [];
    const kill = (pid: number): void => {
      calls.push(pid);
    };
    for (const bad of [0, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pidAlive(bad, kill), String(bad)).toBe(false);
    }
    expect(pidAlive(0)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('EPERM means alive (it exists, it is simply not ours); ESRCH and anything else do not', () => {
    const throwing = (code: string) => (): void => {
      throw Object.assign(new Error(code), { code });
    };
    expect(pidAlive(4242, throwing('EPERM'))).toBe(true);
    expect(pidAlive(4242, throwing('ESRCH'))).toBe(false);
    expect(pidAlive(4242, throwing('EINVAL'))).toBe(false);
    expect(pidAlive(4242, () => {})).toBe(true);
  });

  it('asks with signal 0', () => {
    const seen: Array<[number, number]> = [];
    const probe: PidSignal = (pid, sig) => {
      seen.push([pid, sig]);
    };
    pidAlive(4242, probe);
    seen.length = 0;
    pidAlive(4242, (pid, sig) => {
      seen.push([pid, sig]);
    });
    expect(seen).toEqual([[4242, 0]]);
  });
});

/* THE ONE "is this a pid?" predicate: the liveness guard, the owner-record
 * readers and the CLI's record writer all ask it. */
describe('isPid', () => {
  it('a positive safe integer is a pid', () => {
    for (const ok of [1, 2, 4242, 2 ** 31]) expect(isPid(ok), String(ok)).toBe(true);
  });

  it('nothing else is', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '42', null, undefined, {}, 2 ** 60]) {
      expect(isPid(bad), String(bad)).toBe(false);
    }
  });
});
