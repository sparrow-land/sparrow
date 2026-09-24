/**
 * WHO CAN THIS LISTENER WAKE? — the ancestry primitives behind `sparrow await`'s
 * orphan detection (see harness-owner.ts).
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { detectHarness, isAlive, isAncestor, readParentPid } from './harness-owner.js';

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

  it('pid 1 is never an ancestor — every chain ends there', () => {
    expect(isAncestor(1, 400, tree({ 400: 300, 300: 1 }))).toBe('no');
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

  it('unknown for nonsense pids', () => {
    expect(isAncestor(0, 400, tree({ 400: 1 }))).toBe('unknown');
    expect(isAncestor(100, -1, tree({}))).toBe('unknown');
  });

  it('reads the real process tree: the test runner is an ancestor of its child', async () => {
    const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise((r) => kid.once('spawn', r));
      expect(readParentPid(kid.pid!)).toBe(process.pid);
      expect(isAncestor(process.pid, kid.pid!)).toBe('yes');
      // …and the child is not an ancestor of the runner.
      expect(isAncestor(kid.pid!, process.pid)).toBe('no');
    } finally {
      kid.kill('SIGKILL');
    }
  });
});

describe('isAlive', () => {
  it('this process is alive', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('a spawned child that has been reaped is not', async () => {
    const kid = spawn('true', [], { stdio: 'ignore' });
    const pid = kid.pid!;
    await new Promise((r) => kid.once('exit', r));
    expect(isAlive(pid)).toBe(false);
  });

  it('EPERM means alive (it exists, it is simply not ours)', () => {
    const eperm = Object.assign(new Error('eperm'), { code: 'EPERM' });
    expect(
      isAlive(4242, () => {
        throw eperm;
      }),
    ).toBe(true);
  });

  it('nonsense pids are not alive', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });
});
