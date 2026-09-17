import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetArmLockProbeForTests,
  assertMayArm,
  detectArmLockMechanism,
  encodeArmHelperPayload,
  runArmPublishHelper,
  awaitArmLockPath,
  awaitCandidatePath,
  awaitOwnerPath,
  prepareAwaitGeneration,
  readAwaitOwner,
} from './await-owner.js';
import { CliError } from './util.js';

/* ==================================================================
 * THE CANDIDATE MARKER — `<state dir>/await-candidate.json`.
 *
 * The generation record is published LATE (credentials + a round trip), which
 * leaves a window where a listener is genuinely starting and nothing on disk
 * says so: the Stop hook, checking the published owner's pid, would see a dead
 * pid and block a turn whose re-arm is in flight. The marker closes that window
 * WITHOUT touching the publish-late guarantee — it is never read for eviction.
 * ================================================================== */

let stateDir: string;
/* The in-process default is ADVISORY: the flock helper is a subprocess of the
 * real CLI bundle, which a vitest worker is not. The flock-mode tests below opt
 * in explicitly (and drive `spawnSync` through an injected stand-in). */
const env = (): Record<string, string | undefined> => ({
  SPARROW_STATE_DIR: stateDir,
  SPARROW_ARM_LOCK: 'advisory',
});

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-await-owner-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const candidate = (): any => JSON.parse(fs.readFileSync(awaitCandidatePath(env()), 'utf8'));

describe('prepareAwaitGeneration — the candidate marker', () => {
  it('is written the moment a generation is CONSTRUCTED, before any publish', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await:codex' });

    const c = candidate();
    expect(c.version).toBe(1);
    expect(c.pid).toBe(process.pid);
    expect(typeof c.nonce).toBe('string');
    expect(c.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(Date.now() - Date.parse(c.startedAt)).toBeLessThan(5000);

    // …and this really is BEFORE the publish: nothing owns the state dir yet.
    expect(fs.existsSync(awaitOwnerPath(env()))).toBe(false);
    expect(gen.published()).toBe(false);
    expect(gen.nonce()).toBeUndefined();
  });

  it('carries the same nonce the generation goes on to publish', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await' });
    const armed = candidate().nonce;
    expect(gen.publish()).toBe('published');
    expect(readAwaitOwner(env())!.nonce).toBe(armed);
  });

  it('is retired by its own publish — the published record now says the same thing', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await' });
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(true);
    gen.publish();
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);
  });

  /* A marker is removed ONLY when it is this generation's own — the same
   * never-unlink-blindly rule the owner record follows. Otherwise a slow
   * candidate's cleanup would delete the marker of the listener that overtook
   * it, re-opening the very window the marker exists to close. */
  it('never removes a NEWER candidate\u2019s marker on publish', () => {
    const slow = prepareAwaitGeneration({ env: env(), kind: 'await' });
    prepareAwaitGeneration({ env: env(), kind: 'await' }); // overtakes it
    const newer = candidate().nonce;

    slow.publish();
    expect(candidate().nonce).toBe(newer);
  });

  it('a superseded listener\u2019s exit leaves the successor\u2019s marker alone', () => {
    const first = prepareAwaitGeneration({ env: env(), kind: 'await' });
    first.publish(); // its own marker is retired here
    const second = prepareAwaitGeneration({ env: env(), kind: 'await' });
    const successor = candidate().nonce;

    first.clearCandidate(); // the loser's exit path
    expect(candidate().nonce).toBe(successor);

    // And the successor still retires its own when it gets there.
    second.publish();
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);
  });

  /* ONE SLOT, BY DESIGN — the accepted cost, pinned here so a future reader
   * meets it as a decision rather than a surprise. */
  it('a failed newer candidate leaves the older one arming unannounced', () => {
    const slow = prepareAwaitGeneration({ env: env(), kind: 'await' });
    const doomed = prepareAwaitGeneration({ env: env(), kind: 'await' }); // overwrites the slot
    doomed.clearCandidate(); // it gave up (bad token, unreachable server)

    // Nothing on disk now says "a listener is arming", though `slow` still is:
    // a Stop hook firing in this window falls back to blocking. Bounded and
    // one-sided — the marker only ever optimises patience, never ownership.
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);

    // And `slow` is otherwise untouched: it publishes and fences as always.
    expect(slow.publish()).toBe('published');
    expect(readAwaitOwner(env())!.nonce).toBe(slow.nonce());
  });

  it('leaves no temp file behind when the write cannot be renamed into place', () => {
    // The target path is a DIRECTORY: the temp write succeeds, the rename does
    // not — the path a plain `existsSync` check would never reach.
    fs.mkdirSync(awaitCandidatePath(env()));

    expect(() => prepareAwaitGeneration({ env: env(), kind: 'await' })).not.toThrow();
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('clearing is idempotent and safe with no marker on disk at all', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await' });
    gen.clearCandidate();
    expect(() => gen.clearCandidate()).not.toThrow();
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);
  });

  it('a newer candidate simply overwrites the older one (no unlink, ever)', () => {
    prepareAwaitGeneration({ env: env(), kind: 'await' });
    const first = candidate().nonce;
    prepareAwaitGeneration({ env: env(), kind: 'await' });
    expect(candidate().nonce).not.toBe(first);
  });

  it('is atomic: no temp file is left behind', () => {
    prepareAwaitGeneration({ env: env(), kind: 'await' });
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('an unwritable state dir is skipped silently — arming is never blocked by it', () => {
    const blocker = path.join(stateDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const broken = { SPARROW_STATE_DIR: path.join(blocker, 'nested') };

    const gen = prepareAwaitGeneration({ env: broken, kind: 'await' });
    expect(fs.existsSync(path.join(blocker, 'nested'))).toBe(false);
    // The listener still runs — unfenced, exactly as a failed publish leaves it.
    expect(gen.publish()).toBe('unfenced');
    expect(gen.supersededBy()).toBeUndefined();
    expect(() => gen.clearCandidate()).not.toThrow();
  });
});

/* ==================================================================
 * THREAD-AWARE OWNERSHIP (field incident, Codex 0.154, 2026-09-17).
 *
 * Newest-wins is deliberate and stays. The ONE exception is proof: a live
 * listener bound to a DIFFERENT Codex thread cannot be woken on this one's
 * behalf, so replacing it makes the workspace deaf rather than re-pointing it.
 * Everything short of proof — a dead pid, no pid, an unreadable record, a kill
 * that failed for a reason we do not understand — supersedes exactly as before.
 * ================================================================== */

/** A live owner record for `thread`, owned by `pid` (default: this process). */
function ownerRecord(thread: string | undefined, pid = process.pid): void {
  fs.writeFileSync(
    awaitOwnerPath(env()),
    `${JSON.stringify({
      version: 1,
      nonce: 'deadbeefdeadbeef',
      pid,
      startedAt: new Date().toISOString(),
      kind: thread ? 'await:codex' : 'await',
      ...(thread ? { thread } : {}),
    })}\n`,
  );
}

/** `process.kill(pid, 0)` stand-ins for the three answers that matter. */
const alive = (): void => {};
const eperm = (): never => {
  throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
};
const esrch = (): never => {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
};
const weird = (): never => {
  throw Object.assign(new Error('something else entirely'), { code: 'EWHAT' });
};

describe('assertMayArm — only PROOF of a live different-thread owner blocks', () => {
  it('an empty state dir is nobody\u2019s', () => {
    expect(() => assertMayArm(env(), 'thread-mine', alive)).not.toThrow();
  });

  it('an owner with NO thread (Claude Code, or any pre-0.1.38 listener) is superseded', () => {
    ownerRecord(undefined);
    expect(() => assertMayArm(env(), 'thread-mine', alive)).not.toThrow();
  });

  it('the SAME thread re-arming is the everyday case and stays idempotent', () => {
    ownerRecord('thread-mine');
    expect(() => assertMayArm(env(), 'thread-mine', alive)).not.toThrow();
  });

  it('a non-Codex candidate never invokes the guard (newest-wins, unchanged)', () => {
    ownerRecord('thread-theirs');
    expect(() => assertMayArm(env(), undefined, alive)).not.toThrow();
  });

  it('refuses a LIVE owner on a different thread, naming its pid and thread', () => {
    ownerRecord('thread-theirs', 4242);
    let thrown: unknown;
    try {
      assertMayArm(env(), 'thread-mine', alive);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const message = (thrown as Error).message;
    expect(message.split('\n')).toHaveLength(1);
    expect(message).toContain('Codex thread thread-theirs (pid 4242)');
    expect(message).toContain('still running');
    expect(message).toContain('kill 4242');
    expect(message).toContain('SPARROW_AWAIT_TAKE_OVER=1');
  });

  it('EPERM is PROOF of life (someone else\u2019s process) — refused', () => {
    ownerRecord('thread-theirs', 4242);
    expect(() => assertMayArm(env(), 'thread-mine', eperm)).toThrow(CliError);
  });

  it('ESRCH is proof of ABSENCE — superseded, as today', () => {
    ownerRecord('thread-theirs', 4242);
    expect(() => assertMayArm(env(), 'thread-mine', esrch)).not.toThrow();
  });

  it('an unexpected kill error is UNKNOWN — superseded (a lock must not outlive its owner)', () => {
    ownerRecord('thread-theirs', 4242);
    expect(() => assertMayArm(env(), 'thread-mine', weird)).not.toThrow();
  });

  it('a record with no usable pid proves nothing — superseded', () => {
    ownerRecord('thread-theirs', 0);
    expect(() => assertMayArm(env(), 'thread-mine', alive)).not.toThrow();
  });

  it('an unreadable record proves nothing — superseded', () => {
    fs.writeFileSync(awaitOwnerPath(env()), 'not json at all\n');
    expect(() => assertMayArm(env(), 'thread-mine', alive)).not.toThrow();
  });

  it('SPARROW_AWAIT_TAKE_OVER=1 is the operator escape', () => {
    ownerRecord('thread-theirs', 4242);
    expect(() =>
      assertMayArm({ ...env(), SPARROW_AWAIT_TAKE_OVER: '1' }, 'thread-mine', alive),
    ).not.toThrow();
  });
});

describe('publish() re-checks ownership at the last possible moment', () => {
  it('records the Codex thread it bridges to', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await:codex', thread: 'thread-mine' });
    gen.publish();
    expect(readAwaitOwner(env())!.thread).toBe('thread-mine');
  });

  it('omits the thread entirely for a non-Codex listener', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await' });
    gen.publish();
    expect(readAwaitOwner(env())!.thread).toBeUndefined();
  });

  /* TWO concurrent starters would both pass a preflight-only guard: each reads
   * an empty (or dead) state dir, then both write. The recheck immediately
   * before the rename is what makes the loser stand down instead. */
  it('refuses to publish when a live different-thread owner appeared meanwhile', () => {
    const gen = prepareAwaitGeneration({
      env: env(),
      kind: 'await:codex',
      thread: 'thread-mine',
      kill: alive,
    });
    ownerRecord('thread-theirs', 4242); // …published between preflight and here

    expect(() => gen.publish()).toThrow(CliError);
    // The incumbent's record is untouched, and we never went live.
    expect(readAwaitOwner(env())!.thread).toBe('thread-theirs');
    expect(gen.published()).toBe(false);
    expect(gen.fenced()).toBe(false);
  });

  it('publishes over a DEAD different-thread owner (recovery is not a takeover)', () => {
    const gen = prepareAwaitGeneration({
      env: env(),
      kind: 'await:codex',
      thread: 'thread-mine',
      kill: esrch,
    });
    ownerRecord('thread-theirs', 4242);

    expect(gen.publish()).toBe('published');
    expect(readAwaitOwner(env())!.thread).toBe('thread-mine');
  });

  it('publishes over a live SAME-thread owner (the everyday re-arm)', () => {
    const gen = prepareAwaitGeneration({
      env: env(),
      kind: 'await:codex',
      thread: 'thread-mine',
      kill: alive,
    });
    ownerRecord('thread-mine', 4242);

    expect(gen.publish()).toBe('published');
    expect(readAwaitOwner(env())!.nonce).toBe(gen.nonce());
  });
});

/* ==================================================================
 * PUBLISHING ATOMICALLY — the arming lock
 *
 * Two modes, and nothing in between: where a `flock` binary exists the kernel
 * holds the lock across the critical section (which runs in the helper process
 * that holds it, so a death releases it and there is nothing to reclaim), and
 * where it does not, ownership checks are advisory and say so. Every failure
 * that is NOT "the binary is absent" refuses and publishes nothing.
 * ================================================================== */

const lockPath = (): string => awaitArmLockPath(env());
const candidateRecord = (): any => JSON.parse(fs.readFileSync(awaitCandidatePath(env()), 'utf8'));

/** A `spawnSync` stand-in: records calls, answers with a canned result. */
function fakeSpawn(reply: (args: string[]) => any): any & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (_cmd: string, args: string[]) => {
    calls.push(args);
    return reply(args);
  };
  (fn as any).calls = calls;
  return fn as any;
}
const helperArgs = { status: 0, stdout: '', stderr: '', error: undefined };
/** What the parent hands the helper, decoded — the payload is the last arg. */
const payloadOf = (args: string[]): any =>
  JSON.parse(Buffer.from(args[args.length - 1]!, 'base64url').toString('utf8'));

beforeEach(() => __resetArmLockProbeForTests());

describe('which mechanism this host offers', () => {
  it('uses flock when the binary answers at all (busybox exits non-zero)', () => {
    expect(detectArmLockMechanism({ spawn: fakeSpawn(() => ({ ...helperArgs, status: 1 })) })).toBe(
      'flock',
    );
  });

  it('falls to advisory ONLY when the binary is absent', () => {
    const missing = fakeSpawn(() => ({ ...helperArgs, error: new Error('spawn flock ENOENT') }));
    expect(detectArmLockMechanism({ spawn: missing })).toBe('advisory');
  });

  it('probes once per process', () => {
    const probe = fakeSpawn(() => ({ ...helperArgs, status: 0 }));
    detectArmLockMechanism({ spawn: probe });
    detectArmLockMechanism({ spawn: probe });
    expect(probe.calls).toHaveLength(1);
  });
});

describe('advisory mode (no flock on this host)', () => {
  // No SPARROW_ARM_LOCK here: this describes a host where `flock` is genuinely
  // absent, which is the only case that earns the stderr note.
  const advisory = (extra: Record<string, unknown> = {}): any => ({
    env: { SPARROW_STATE_DIR: stateDir },
    kind: 'await',
    lock: { mechanism: 'advisory' as const },
    ...extra,
  });

  it('publishes exactly as 0.1.38 did, and says once that it is advisory', () => {
    const err: string[] = [];
    const gen = prepareAwaitGeneration(advisory({ err: (s: string) => err.push(s) }));

    expect(err).toHaveLength(1);
    expect(err[0]).toContain('arming lock unavailable (no flock on PATH)');
    expect(err[0]).toContain('advisory');
    expect(err[0]!.trimEnd().split('\n')).toHaveLength(1);
    expect(gen.publish()).toBe('published');
    expect(readAwaitOwner(env())!.nonce).toBe(gen.nonce());
  });

  it('records the mechanism in both the candidate and the owner record', () => {
    const gen = prepareAwaitGeneration(advisory());
    expect(candidateRecord().lock).toBe('advisory');
    gen.publish();
    expect(readAwaitOwner(env())!.lock).toBe('advisory');
  });

  it('still refuses a live different-thread incumbent (the guard is unchanged)', () => {
    ownerRecord('thread-theirs', 4242);
    const gen = prepareAwaitGeneration(
      advisory({ kind: 'await:codex', thread: 'thread-mine', kill: alive }),
    );
    expect(() => gen.publish()).toThrow(CliError);
    expect(readAwaitOwner(env())!.thread).toBe('thread-theirs');
  });

  it('stays unfenced when the state dir cannot be written at all', () => {
    const blocker = path.join(stateDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const gen = prepareAwaitGeneration({
      env: { SPARROW_STATE_DIR: path.join(blocker, 'nested') },
      kind: 'await',
      lock: { mechanism: 'advisory' },
    });
    expect(gen.publish()).toBe('unfenced');
  });
});

describe('flock mode — the parent reads exactly one line from the helper', () => {
  const underFlock = (spawn: any, extra: Record<string, unknown> = {}): any =>
    prepareAwaitGeneration({
      env: env(),
      kind: 'await:codex',
      thread: 'thread-mine',
      lock: { mechanism: 'flock', spawn, bundle: '/fake/sparrow.mjs', waitMs: 3000 },
      ...extra,
    });

  it('runs the helper under flock, passing the whole decision in the payload', () => {
    const spawn = fakeSpawn(() => ({ ...helperArgs, stdout: '{"result":"published"}\n' }));
    expect(underFlock(spawn).publish()).toBe('published');

    const args = spawn.calls[0]!;
    expect(args.slice(0, 2)).toEqual(['-w', '3']);
    expect(args[2]).toBe(lockPath());
    expect(args[3]).toBe(process.execPath);
    expect(args[4]).toBe('/fake/sparrow.mjs');
    expect(args[5]).toBe('__arm-publish');
    const payload = payloadOf(args);
    expect(payload).toMatchObject({ kind: 'await:codex', thread: 'thread-mine', listenerPid: process.pid });
    expect(payload.stateDir).toBe(stateDir);
  });

  it('turns the helper’s refusal into exit 1, verbatim, having published nothing', () => {
    const spawn = fakeSpawn(() => ({
      ...helperArgs,
      stdout: `${JSON.stringify({ result: 'refused', message: 'a listener for Codex thread X (pid 9) …' })}\n`,
    }));
    const gen = underFlock(spawn);
    expect(() => gen.publish()).toThrow('a listener for Codex thread X (pid 9) …');
    expect(gen.published()).toBe(false);
  });

  it('refuses when the helper aborted — we are alive, so that is not a silent pass', () => {
    const spawn = fakeSpawn(() => ({
      ...helperArgs,
      stdout: '{"result":"aborted","reason":"listener gone"}\n',
    }));
    expect(() => underFlock(spawn).publish()).toThrow(/helper aborted: listener gone/);
  });

  it('reads a bare flock timeout (exit 1, nothing said) as contention', () => {
    const spawn = fakeSpawn(() => ({ ...helperArgs, status: 1 }));
    expect(() => underFlock(spawn).publish()).toThrow(/is held by another publisher/);
  });

  it('refuses — never downgrades to advisory — when the lock file cannot be opened', () => {
    const spawn = fakeSpawn(() => ({
      ...helperArgs,
      status: 66,
      stderr: `flock: cannot open lock file ${lockPath()}: Permission denied\n`,
    }));
    const gen = underFlock(spawn);
    expect(() => gen.publish()).toThrow(/could not be taken \(flock: cannot open lock file/);
    expect(gen.published()).toBe(false);
    expect(candidateRecord().lock).toBe('flock'); // still flock: the binary is there
  });

  /* A helper that renamed and then died says nothing — but the record is on
   * disk, and the record is the authority. Never a blind retry. */
  it('believes the RECORD when the helper dies after committing the rename', () => {
    const spawn = fakeSpawn((args) => {
      const p = payloadOf(args);
      fs.writeFileSync(
        awaitOwnerPath(env()),
        `${JSON.stringify({ version: 1, nonce: p.nonce, pid: p.listenerPid, startedAt: new Date().toISOString(), kind: p.kind, thread: p.thread, lock: 'flock' })}\n`,
      );
      return { ...helperArgs, status: null, stdout: '' }; // killed before reporting
    });
    const gen = underFlock(spawn);
    expect(gen.publish()).toBe('published');
    expect(readAwaitOwner(env())!.nonce).toBe(gen.nonce());
  });

  it('refuses when the helper dies WITHOUT committing (no record, no line)', () => {
    const spawn = fakeSpawn(() => ({ ...helperArgs, status: null, stdout: '' }));
    const gen = underFlock(spawn);
    expect(() => gen.publish()).toThrow(/could not be taken/);
    expect(fs.existsSync(awaitOwnerPath(env()))).toBe(false);
    expect(gen.published()).toBe(false);
  });

  it('never spawns anything when the state dir cannot hold a record', () => {
    const blocker = path.join(stateDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const spawn = fakeSpawn(() => ({ ...helperArgs, stdout: '{"result":"published"}\n' }));
    const gen = prepareAwaitGeneration({
      env: { SPARROW_STATE_DIR: path.join(blocker, 'nested') },
      kind: 'await',
      lock: { mechanism: 'flock', spawn, bundle: '/fake/sparrow.mjs' },
    });
    expect(gen.publish()).toBe('unfenced');
    expect(spawn.calls).toEqual([]);
  });
});

/* With the REAL binary: a lock file we cannot open is a hard failure, never a
 * reason to fall back to advisory. (Skipped as root, who can open anything.) */
describe.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
  'flock mode against the real binary',
  () => {
    it('refuses when the lock file cannot be opened, and stays in flock mode', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(awaitArmLockPath(env()), '');
      fs.chmodSync(awaitArmLockPath(env()), 0o000);

      const gen = prepareAwaitGeneration({
        env: env(),
        kind: 'await',
        // A bundle that never runs: flock fails before it can exec anything.
        lock: { mechanism: 'flock', bundle: '/nonexistent/sparrow.mjs' },
      });
      expect(() => gen.publish()).toThrow(/could not be taken/);
      expect(gen.published()).toBe(false);
      expect(fs.existsSync(awaitOwnerPath(env()))).toBe(false);
      expect(candidateRecord().lock).toBe('flock'); // never downgraded
    });
  },
);

describe('the helper itself (it IS the critical section)', () => {
  const payload = (over: Record<string, unknown> = {}): string =>
    encodeArmHelperPayload({
      stateDir,
      nonce: 'f00dcafef00dcafe',
      listenerPid: process.pid,
      kind: 'await:codex',
      thread: 'thread-mine',
      ...over,
    } as any);

  it('renames the record, stamps the mechanism, and retires the candidate', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      awaitCandidatePath(env()),
      `${JSON.stringify({ version: 1, nonce: 'f00dcafef00dcafe', pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );

    const said = JSON.parse(runArmPublishHelper(payload()));
    expect(said).toEqual({ result: 'published', nonce: 'f00dcafef00dcafe' });
    const owner = readAwaitOwner(env())!;
    expect(owner.nonce).toBe('f00dcafef00dcafe');
    expect(owner.pid).toBe(process.pid); // the LISTENER's pid, never the helper's
    expect(owner.lock).toBe('flock');
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);
  });

  it('reports the ownership refusal instead of renaming', () => {
    ownerRecord('thread-theirs', process.pid); // live, different thread
    const said = JSON.parse(runArmPublishHelper(payload()));
    expect(said.result).toBe('refused');
    expect(said.message).toContain('Codex thread thread-theirs');
    expect(readAwaitOwner(env())!.thread).toBe('thread-theirs');
  });

  /* A record naming a dead owner is worse than no record: every hook reads it
   * as a live listener. The helper may have waited seconds for the lock. */
  it('ABORTS rather than publish a record naming a listener that has gone', () => {
    const said = JSON.parse(runArmPublishHelper(payload({ listenerPid: 4194305 })));
    expect(said).toEqual({ result: 'aborted', reason: 'listener gone' });
    expect(fs.existsSync(awaitOwnerPath(env()))).toBe(false);
  });

  it('honours the operator take-over escape it was handed', () => {
    ownerRecord('thread-theirs', process.pid);
    const said = JSON.parse(runArmPublishHelper(payload({ takeOver: true })));
    expect(said.result).toBe('published');
    expect(readAwaitOwner(env())!.thread).toBe('thread-mine');
  });

  it('never throws, whatever it is handed', () => {
    const said = JSON.parse(runArmPublishHelper('not-base64-json'));
    expect(said.result).toBe('error');
  });
});
