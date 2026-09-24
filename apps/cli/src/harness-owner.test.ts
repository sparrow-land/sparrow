/**
 * WHO CAN THIS LISTENER WAKE? — the ancestry primitives behind `sparrow await`'s
 * orphan detection (see harness-owner.ts).
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  OFF_PROCFS_WALK_EVERY,
  PENDING_UNKNOWN_CAP,
  cappedNotice,
  createHarnessWatch,
  notRunningRefusal,
  neverOwnedNotice,
  orphanedNotice,
  standDownNotice,
  detectHarness,
  isAncestor,
  defaultParentReader,
  parseParentSnapshot,
  snapshotParentReader,
  type Ancestry,
} from './harness-owner.js';

describe('detectHarness', () => {
  it('names the Claude Code harness when CLAUDECODE and CLAUDE_PID are both set', () => {
    expect(detectHarness({ CLAUDECODE: '1', CLAUDE_PID: '4242' })).toEqual({ kind: 'claude', pid: 4242 });
    expect(detectHarness({ CLAUDECODE: 'true', CLAUDE_PID: ' 17 ' })).toEqual({ kind: 'claude', pid: 17 });
  });

  it('is null outside Claude Code', () => {
    expect(detectHarness({})).toBeNull();
    expect(detectHarness({ CLAUDE_PID: '4242' })).toBeNull();
    expect(detectHarness({ CLAUDECODE: '1' })).toBeNull();
    for (const off of ['', '0', 'false', 'no', 'off']) {
      expect(detectHarness({ CLAUDECODE: off, CLAUDE_PID: '4242' })).toBeNull();
    }
  });

  it('is null when CLAUDE_PID is not a positive integer', () => {
    for (const bad of ['', 'abc', '0', '-5', '12x', '1.5', '99999999999999999999']) {
      expect(detectHarness({ CLAUDECODE: '1', CLAUDE_PID: bad }), bad).toBeNull();
    }
  });
});

/** A scripted process tree: child → parent. A missing entry is unreadable. */
const tree =
  (edges: Record<number, number>) =>
  (pid: number): number | undefined =>
    edges[pid];

describe('isAncestor', () => {
  it('yes for a direct parent', () => {
    expect(isAncestor(100, 200, tree({ 200: 100, 100: 1 }))).toBe('yes');
  });

  it('yes for a grandparent and beyond', () => {
    expect(isAncestor(100, 400, tree({ 400: 300, 300: 200, 200: 100, 100: 1 }))).toBe('yes');
  });

  it('no when the chain reaches init without meeting the target', () => {
    expect(isAncestor(100, 400, tree({ 400: 300, 300: 1 }))).toBe('no');
    expect(isAncestor(100, 400, tree({ 400: 300, 300: 0 }))).toBe('no');
  });

  it('init is never an ancestor merely by ending the chain', () => {
    expect(isAncestor(100, 400, tree({ 400: 300, 300: 1 }))).toBe('no');
  });

  /* Every process descends from init, so ancestry to pid 1 proves nothing: a
   * disowned listener reparented to init would read as "yes". */
  it('a target of pid 1 is UNJUDGEABLE — distinct from a transient unknown', () => {
    expect(isAncestor(1, 400, tree({ 400: 300, 300: 1 }))).toBe('unjudgeable');
    expect(isAncestor(0, 400, tree({ 400: 1 }))).toBe('unjudgeable');
  });

  it('a process is not its own ancestor', () => {
    expect(isAncestor(400, 400, tree({ 400: 1 }))).toBe('no');
  });

  it('unknown on a cycle', () => {
    expect(isAncestor(100, 400, tree({ 400: 300, 300: 400 }))).toBe('unknown');
  });

  it('unknown past the 64-hop cap', () => {
    const edges: Record<number, number> = {};
    for (let p = 1000; p < 1100; p++) edges[p] = p + 1;
    expect(isAncestor(5, 1000, tree(edges))).toBe('unknown');
    // …but a target inside the cap is still found.
    expect(isAncestor(1050, 1000, tree(edges))).toBe('yes');
  });

  it('unknown when a link in the chain cannot be read', () => {
    expect(isAncestor(100, 400, tree({ 400: 300 }))).toBe('unknown');
    expect(isAncestor(100, 400, () => undefined)).toBe('unknown');
  });

  it('unknown for a nonsense starting pid', () => {
    expect(isAncestor(100, -1, tree({}))).toBe('unknown');
  });

  it('reads the real process tree: the test runner is an ancestor of its child', async () => {
    const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise((r) => kid.once('spawn', r));
      expect(defaultParentReader()(kid.pid!)).toBe(process.pid);
      expect(isAncestor(process.pid, kid.pid!)).toBe('yes');
      // …and the child is not an ancestor of the runner.
      expect(isAncestor(kid.pid!, process.pid)).toBe('no');
    } finally {
      kid.kill('SIGKILL');
    }
  });
});

/* ------------------------------ the watch ------------------------------ */

/** Scriptable probes that also count what was asked. */
function probes(
  init: { alive?: boolean; ancestry?: Ancestry; now?: number; foreignNs?: boolean; procfs?: boolean } = {},
) {
  const st = {
    alive: init.alive ?? true,
    ancestry: init.ancestry ?? ('yes' as Ancestry),
    now: init.now ?? 1_000,
    foreignNs: init.foreignNs ?? false,
  };
  const calls = { alive: 0, ancestry: 0 };
  return {
    st,
    calls,
    p: {
      alive: () => {
        calls.alive++;
        return st.alive;
      },
      ancestry: () => {
        calls.ancestry++;
        return st.ancestry;
      },
      now: () => st.now,
      foreignPidNamespace: () => st.foreignNs,
      procfs: init.procfs ?? true,
    },
  };
}
const H = { kind: 'claude' as const, pid: 777 };

/**
 * Is the watch WATCHING (not pending, off or ended)? Observed from outside: only
 * a watch probes liveness on the activity path. Moves the clock past the
 * throttle, so it never consumes a real check's slot.
 */
const watched = (w: ReturnType<typeof createHarnessWatch>, pr: ReturnType<typeof probes>): boolean => {
  const n = pr.calls.alive;
  pr.st.now += 1e9;
  w.activity();
  return pr.calls.alive > n;
};

describe('createHarnessWatch — arming', () => {
  it('no harness: nothing is refused, recorded or watched', () => {
    const { p } = probes();
    const w = createHarnessWatch(null, { allowUnowned: false, checkMs: 15_000, probes: p });
    expect(w.arm()).toBe('ok');
    expect(w.armOwner()).toBeUndefined();
    expect(w.needsTimer()).toBe(false);
    expect(w.tick()).toBe('none');
    expect(w.activity()).toBe('none');
  });

  it('a live harness that is not an ancestor refuses', () => {
    const { p } = probes({ ancestry: 'no' });
    expect(createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: p }).arm()).toBe('not-ancestor');
  });

  it('a proven ancestor at arm time is the arm owner (recorded) and watched', () => {
    const pr = probes({ ancestry: 'yes' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('ok');
    expect(w.armOwner()).toEqual(H);
    expect(w.needsTimer()).toBe(true);
    expect(watched(w, pr)).toBe(true);
  });
});

describe('createHarnessWatch — --allow-unowned means no watch and no harnessPid, ever', () => {
  for (const ancestry of ['no', 'yes', 'unknown'] as const) {
    it(`ancestry ${ancestry}: arms, records nothing, watches nothing, never probes`, () => {
      const { calls, p } = probes({ ancestry });
      const w = createHarnessWatch(H, { allowUnowned: true, checkMs: 15_000, probes: p });
      expect(w.arm()).toBe('ok');
      expect(w.armOwner()).toBeUndefined();
      expect(w.needsTimer()).toBe(false);
      expect(w.tick()).toBe('none');
      expect(w.activity()).toBe('none');
      expect(calls).toEqual({ alive: 0, ancestry: 0 });
    });
  }
});

describe('createHarnessWatch — a pending harness is retried', () => {
  it('unknown at arm, yes later: watched in memory, but never the arm owner', () => {
    const pr = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('ok');
    expect(w.needsTimer()).toBe(true);
    expect(watched(w, pr)).toBe(false);
    expect(w.tick()).toBe('none'); // still unknown
    pr.st.ancestry = 'yes';
    expect(w.tick()).toBe('none');
    expect(watched(w, pr)).toBe(true);
    // The record is written at arm time only: a late proof is never recorded.
    expect(w.armOwner()).toBeUndefined();
    pr.st.alive = false;
    expect(w.tick()).toBe('orphaned');
  });

  /* The arm would have refused this listener had it known: alive, and not an
   * ancestor. Learning it later must not leave it online-but-deaf — it stands
   * down exactly as an orphan does, with its own reason. */
  it('a definite NO while pending stands down as UNOWNED, terminally', () => {
    const pr = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    pr.st.ancestry = 'no';
    expect(w.tick()).toBe('unowned');
    const walks = pr.calls.ancestry;
    pr.st.ancestry = 'yes';
    expect(w.tick()).toBe('unowned');
    expect(w.activity()).toBe('unowned'); // the SAME ending on either path
    expect(w.ending()).toBe('unowned');
    expect(pr.calls.ancestry).toBe(walks);
    expect(w.armOwner()).toBeUndefined();
  });

  /* DEAD AT ARM. Outside a pid namespace nothing can explain an invisible
   * CLAUDE_PID but a session that is gone: this listener could never wake it,
   * so the arm refuses. Inside one, the pid may simply be the host's — not
   * judged, as ever. */
  it('a harness pid that is not running, outside a pid namespace: refused at arm', () => {
    const pr = probes({ alive: false, foreignNs: false });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('not-running');
    expect(w.armOwner()).toBeUndefined();
  });

  it('a harness pid that is not running, INSIDE a pid namespace: arms unjudged (OFF)', () => {
    const pr = probes({ alive: false, foreignNs: true });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('ok');
    expect(w.armOwner()).toBeUndefined();
    expect(w.needsTimer()).toBe(false);
  });

  it('--allow-unowned arms over a pid that is not running', () => {
    const pr = probes({ alive: false });
    const w = createHarnessWatch(H, { allowUnowned: true, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('ok');
  });

  /* `unjudgeable` (a target isAncestor can NEVER answer for, e.g. pid 1) is
   * not a transient unknown: retrying is pointless, so the arm switches the
   * watch OFF — no timer — and, like unknown, never refuses or records. */
  it('unjudgeable at arm: OFF — no refusal, no record, no timer', () => {
    const pr = probes({ ancestry: 'unjudgeable' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('ok');
    expect(w.armOwner()).toBeUndefined();
    expect(w.needsTimer()).toBe(false);
    expect(w.tick()).toBe('none');
    expect(w.activity()).toBe('none');
    // …and the real probes say exactly that for a harness that is pid 1.
    const real = createHarnessWatch({ kind: 'claude', pid: 1 }, { allowUnowned: false, checkMs: 15_000 });
    expect(real.arm()).toBe('ok');
    expect(real.needsTimer()).toBe(false);
  });

  /* ALIVE AT ARM, ANCESTRY UNREADABLE (macOS with `ps` failing, say) is not the
   * other-namespace case: we SAW the pid. If it then dies, the session is gone
   * and this listener can wake nobody — it must stand down, not wait forever
   * on an ancestry question that can no longer be answered. */
  it('seen alive at arm with unknown ancestry, then dead: orphaned', () => {
    const pr = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('ok');
    expect(w.tick()).toBe('none');
    pr.st.alive = false;
    expect(w.tick()).toBe('orphaned');
    expect(w.tick()).toBe('orphaned'); // terminal
  });

});

describe('createHarnessWatch — the two tick paths', () => {
  it('the TIMER path is never throttled: back-to-back ticks both probe', () => {
    const { calls, p } = probes();
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: p });
    w.arm();
    const before = calls.ancestry;
    expect(w.tick()).toBe('none');
    expect(w.tick()).toBe('none');
    expect(calls.ancestry - before).toBe(2);
  });

  it('the timer path orphans on death OR on losing ancestry, never on unknown', () => {
    const a = probes();
    const w1 = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: a.p });
    w1.arm();
    a.st.ancestry = 'no';
    expect(w1.tick()).toBe('orphaned');

    const b = probes();
    const w2 = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: b.p });
    w2.arm();
    b.st.ancestry = 'unknown';
    expect(w2.tick()).toBe('none');
  });

  it('the ACTIVITY path only probes liveness — never the ancestry walk — and is throttled', () => {
    const { st, calls, p } = probes({ now: 100_000 });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: p });
    w.arm();
    const walks = calls.ancestry;
    const lives = calls.alive;
    expect(w.activity()).toBe('none');
    expect(w.activity()).toBe('none'); // throttled: same instant
    expect(calls.alive - lives).toBe(1);
    st.ancestry = 'no'; // invisible to this path
    st.now += 15_000;
    expect(w.activity()).toBe('none');
    expect(calls.ancestry).toBe(walks);
    st.alive = false;
    st.now += 15_000;
    expect(w.activity()).toBe('orphaned');
  });

  it('the activity path does nothing while not watching', () => {
    const { calls, p } = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: p });
    w.arm();
    const lives = calls.alive;
    expect(w.activity()).toBe('none');
    expect(calls.alive).toBe(lives);
  });

  it('once orphaned it stays orphaned', () => {
    const { st, p } = probes();
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: p });
    w.arm();
    st.alive = false;
    expect(w.tick()).toBe('orphaned');
    st.alive = true;
    expect(w.tick()).toBe('orphaned');
    expect(w.activity()).toBe('orphaned');
  });
});

describe('neverOwnedNotice', () => {
  it('says what happened without contradicting itself, and what to do', () => {
    expect(neverOwnedNotice(42)).toBe(
      'sparrow await: orphaned — arming could not prove this listener descends from the Claude Code ' +
        'session (pid 42), and a later check shows it does not, so it cannot wake that session; ' +
        'standing down. Re-arm it as a tracked background task.',
    );
  });
});

/* WHICH LINE AN ORPHAN PRINTS is the watch's terminal state, whichever path
 * (timer or stream activity) reached it — never a second copy of that state. */
describe('standDownNotice follows the watch', () => {
  it('unowned (a later NO while pending) prints the never-a-descendant line, on either path', () => {
    const pr = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    pr.st.ancestry = 'no';
    expect(w.tick()).toBe('unowned');
    expect(w.activity()).toBe('unowned');
    expect(standDownNotice(w.ending(), 777)).toBe(neverOwnedNotice(777));
  });

  it('orphaned via the activity path prints the session-is-gone line', () => {
    const pr = probes({ now: 100_000 });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    pr.st.alive = false;
    expect(w.activity()).toBe('orphaned');
    expect(w.ending()).toBe('orphaned');
    expect(w.tick()).toBe('orphaned');
    expect(standDownNotice(w.ending(), 777)).toBe(orphanedNotice(777));
  });

  it('no ending yet', () => {
    const { p } = probes();
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: p });
    w.arm();
    expect(w.ending()).toBeUndefined();
  });
});

/* A PENDING harness is not walked forever: off Linux every walk is a blocking
 * `ps` per hop. After PENDING_UNKNOWN_CAP consecutive unknown answers the walks
 * stop. A harness SEEN ALIVE keeps a liveness-only watch (kill 0, no walk) so
 * its exit still stands the listener down; one never seen goes OFF. */
describe('createHarnessWatch — the pending cap', () => {
  it('is 8 ticks (two minutes at the 15 s cadence)', () => {
    expect(PENDING_UNKNOWN_CAP).toBe(8);
  });

  it('seen alive: after the cap, no more walks — but a later exit still orphans', () => {
    const pr = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    const atArm = pr.calls.ancestry;
    for (let i = 0; i < PENDING_UNKNOWN_CAP - 1; i++) expect(w.tick()).toBe('none');
    // The cap is REPORTED, exactly once: `await` prints one line for it.
    expect(w.tick()).toBe('capped');
    expect(pr.calls.ancestry - atArm).toBe(PENDING_UNKNOWN_CAP);
    for (let i = 0; i < 20; i++) expect(w.tick()).toBe('none');
    expect(pr.calls.ancestry - atArm).toBe(PENDING_UNKNOWN_CAP); // capped
    expect(w.needsTimer()).toBe(true); // the liveness half still matters
    expect(w.armOwner()).toBeUndefined();
    pr.st.ancestry = 'yes'; // too late to matter: never walked again
    expect(w.tick()).toBe('none');
    pr.st.alive = false;
    expect(w.tick()).toBe('orphaned');
  });

  it('seen alive, capped: the activity path still catches the exit', () => {
    const pr = probes({ ancestry: 'unknown', now: 100_000 });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    for (let i = 0; i < PENDING_UNKNOWN_CAP; i++) w.tick();
    pr.st.alive = false;
    expect(w.activity()).toBe('orphaned');
  });

  it('a yes BEFORE the cap still starts the full watch', () => {
    const pr = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    for (let i = 0; i < PENDING_UNKNOWN_CAP - 1; i++) expect(w.tick()).toBe('none');
    pr.st.ancestry = 'yes';
    expect(w.tick()).toBe('none');
    expect(watched(w, pr)).toBe(true);
    // …a FULL watch: losing ancestry now orphans, which liveness alone could not see.
    pr.st.ancestry = 'no';
    expect(w.tick()).toBe('orphaned');
  });

  it('unjudgeable answers while pending count toward the cap like unknown', () => {
    const pr = probes({ ancestry: 'unknown' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    pr.st.ancestry = 'unjudgeable';
    const atArm = pr.calls.ancestry;
    const seen: string[] = [];
    for (let i = 0; i < PENDING_UNKNOWN_CAP + 5; i++) seen.push(w.tick());
    expect(seen.filter((t) => t === 'capped')).toHaveLength(1);
    expect(pr.calls.ancestry - atArm).toBe(PENDING_UNKNOWN_CAP);
  });
});

/* OFF LINUX, ONE SPAWN PER WALK. Without /proc each hop used to be its own
 * synchronous `ps` (2 s timeout): 4-6 per walk, every 15 s, per listener. A walk
 * now takes one `ps -axo pid=,ppid=` snapshot and resolves the chain in memory. */
describe('the ps snapshot (non-Linux ancestry)', () => {
  it('parses `pid ppid` lines, tolerating padding, blank and junk lines', () => {
    const map = parseParentSnapshot('    1     0\n  400   300\n\n  300 1\nPID PPID\n  x y\n 12 5 extra\n');
    expect([...map.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 0],
      [300, 1],
      [400, 300],
    ]);
  });

  const fakePs = (out: string, status = 0) => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status, stdout: out };
    };
    return { calls, run };
  };

  it('a walk of N hops performs ONE spawn', () => {
    const ps = fakePs('600 500\n500 400\n400 300\n300 200\n200 100\n100 1\n');
    expect(isAncestor(100, 600, snapshotParentReader(ps.run))).toBe('yes');
    expect(ps.calls).toHaveLength(1);
    expect(ps.calls[0]).toEqual({ cmd: 'ps', args: ['-axo', 'pid=,ppid='] });
    // …and a second walk (a new reader) takes a fresh snapshot.
    expect(isAncestor(7, 600, snapshotParentReader(ps.run))).toBe('no');
    expect(ps.calls).toHaveLength(2);
  });

  it('no spawn at all until the walk asks', () => {
    const ps = fakePs('1 0\n');
    snapshotParentReader(ps.run);
    expect(ps.calls).toHaveLength(0);
  });

  it('a failed snapshot, or a pid missing from it, is unknown', () => {
    expect(isAncestor(100, 600, snapshotParentReader(fakePs('', 1).run))).toBe('unknown');
    expect(isAncestor(100, 600, snapshotParentReader(fakePs('600 500\n').run))).toBe('unknown');
    const throwing = () => {
      throw new Error('ENOENT');
    };
    expect(isAncestor(100, 600, snapshotParentReader(throwing))).toBe('unknown');
  });
});

/* INSIDE A PID NAMESPACE. Two very different cases look alike from here:
 *  - a sandboxed Bash: CLAUDE_PID is a HOST pid, and a sandbox-local process
 *    can share its number — EPERM says "alive", the walk ends at the
 *    namespace's init, and a correctly armed listener would be refused;
 *  - Claude Code itself running in a container: CLAUDE_PID is a pid of THIS
 *    namespace and really is our ancestor.
 * So only a proven `yes` counts; `no`/`unknown` are unjudgeable. */
describe('createHarnessWatch — a detected pid namespace', () => {
  it('a colliding, live, non-ancestor pid: unjudgeable — no refusal, record, retries or seen-alive', () => {
    for (const ancestry of ['no', 'unknown'] as const) {
      const pr = probes({ foreignNs: true, ancestry });
      const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
      expect(w.arm(), ancestry).toBe('ok');
      expect(w.armOwner()).toBeUndefined();
      expect(w.needsTimer()).toBe(false); // no retries
      pr.st.alive = false; // the colliding pid exits: that is not our session dying
      expect(w.tick()).toBe('none');
      expect(w.activity()).toBe('none');
    }
  });

  it('Claude Code in a container (ancestry YES): watched and recorded exactly as outside', () => {
    const pr = probes({ foreignNs: true, ancestry: 'yes' });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    expect(w.arm()).toBe('ok');
    expect(w.armOwner()).toEqual(H); // → harnessPid in await-owner.json
    expect(w.needsTimer()).toBe(true);
    expect(watched(w, pr)).toBe(true);
    pr.st.alive = false;
    expect(w.tick()).toBe('orphaned');
  });
});

/* OFF LINUX a walk is a `ps` spawn; on Linux /proc is free. While WATCHING,
 * liveness is probed every tick everywhere, the walk every tick with procfs
 * and every OFF_PROCFS_WALK_EVERY-th tick without. */
describe('createHarnessWatch — walk cadence while watching', () => {
  it('with procfs: every tick walks', () => {
    const pr = probes({ procfs: true });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    const walks = pr.calls.ancestry;
    for (let i = 0; i < 8; i++) w.tick();
    expect(pr.calls.ancestry - walks).toBe(8);
  });

  it('without procfs: liveness every tick, the walk once every 4', () => {
    expect(OFF_PROCFS_WALK_EVERY).toBe(4);
    const pr = probes({ procfs: false });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    const walks = pr.calls.ancestry;
    const lives = pr.calls.alive;
    for (let i = 0; i < 8; i++) expect(w.tick()).toBe('none');
    expect(pr.calls.alive - lives).toBe(8);
    expect(pr.calls.ancestry - walks).toBe(2);
  });

  it('without procfs: death is still caught on the very next tick', () => {
    const pr = probes({ procfs: false });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    w.tick();
    pr.st.alive = false;
    expect(w.tick()).toBe('orphaned');
  });

  it('without procfs: a lost ancestry is caught within 4 ticks', () => {
    const pr = probes({ procfs: false });
    const w = createHarnessWatch(H, { allowUnowned: false, checkMs: 15_000, probes: pr.p });
    w.arm();
    pr.st.ancestry = 'no';
    const seen: string[] = [];
    for (let i = 0; i < OFF_PROCFS_WALK_EVERY; i++) seen.push(w.tick());
    expect(seen).toContain('orphaned');
  });
});

describe('cappedNotice', () => {
  it('names the session and the count, and says what is still watched', () => {
    expect(cappedNotice(42)).toBe(
      'sparrow await: could not prove this listener descends from the Claude Code session (pid 42) ' +
        'after 8 tries; watching only whether that session is still running',
    );
  });
});

describe('notRunningRefusal', () => {
  it('is the one line an arm over a dead CLAUDE_PID prints', () => {
    expect(notRunningRefusal(42)).toBe(
      'sparrow await: the Claude Code session named by CLAUDE_PID (pid 42) is not running: this ' +
        'listener could never wake it. Start it from a live session as a tracked background task, ' +
        'or pass --allow-unowned.',
    );
  });
});
