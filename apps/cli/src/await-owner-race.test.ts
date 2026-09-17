/**
 * TWO REAL PROCESSES RACING TO PUBLISH — the regression vm5 reproduced.
 *
 * INCIDENT (2026-09-17). The different-thread ownership guard and the record
 * rename were two separate operations, so two candidates in two processes could
 * BOTH pass the guard against an empty (or dead) state dir and BOTH rename: the
 * last write won, and a live listener on another Codex thread simply vanished.
 * In-process tests cannot show this — one thread cannot be between another
 * thread's check and its rename — so this drives the built module in real
 * children, exactly as the field repro did.
 *
 * THE SHAPE. A rendezvous AT the rename would deadlock by design once the lock
 * works (the second process cannot reach the rename while the first holds it).
 * So process A is made to PAUSE inside the critical section (the publish seam
 * runs under the lock), B is then observed CONTENDING — not published, the lock
 * still A's — and only then is A released. What B does next is the contract: it
 * refuses when it is a different thread and A is still alive, and supersedes
 * when it is the same thread.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(cliRoot, 'dist', 'await-owner.js');
/** The bundle the arming helper re-enters — the real `sparrow` entry point. */
const BIN = path.join(cliRoot, 'dist', 'bin.js');

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let scratch: string;
let child: string;

beforeAll(() => {
  // Build so the children run THIS working tree (dist mirrors src).
  execFileSync('npm', ['run', 'build'], { cwd: cliRoot, timeout: 180_000, stdio: 'ignore' });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-race-'));
  child = path.join(scratch, 'arm.mjs');
  fs.writeFileSync(
    child,
    `
import fs from 'node:fs';
const [moduleUrl, stateDir, thread, role, entered, release, lingerMs, bin, gate] =
  process.argv.slice(2);
const m = await import(moduleUrl);
const env = { SPARROW_STATE_DIR: stateDir };
const say = (o) => process.stdout.write(JSON.stringify({ pid: process.pid, ...o }) + '\\n');

// The helper — the process that HOLDS the kernel lock — is where the critical
// section runs, so the pause that makes contention observable lives there too.
if (role === 'holder') {
  process.env.SPARROW_ARM_HELPER_READY = entered;
  process.env.SPARROW_ARM_HELPER_PAUSE = release;
}

// A contender waits for the test's go-ahead, so that its pre-check provably
// runs while the holder is still inside the critical section — no assumption
// about how long a node start takes on a loaded machine.
if (gate) {
  const until = Date.now() + 15000;
  while (!fs.existsSync(gate) && Date.now() < until) { /* spin */ }
}

try {
  m.assertMayArm(env, thread); // the pre-check every arm does first
} catch (e) {
  say({ outcome: 'refused-precheck', message: e.message });
  process.exit(1);
}

const gen = m.prepareAwaitGeneration({
  env,
  kind: 'await:codex',
  thread,
  lock: { mechanism: 'flock', bundle: bin, waitMs: 3000 },
});
try {
  const result = gen.publish();
  say({ outcome: 'published', result, nonce: gen.nonce() });
} catch (e) {
  say({ outcome: 'refused-publish', message: e.message });
  process.exit(1);
}
// Linger so the other process sees a LIVE pid when it judges our record.
setTimeout(() => process.exit(0), Number(lingerMs));
`,
  );
}, 200_000);

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

interface Ran {
  pid: number;
  code: number | null;
  lines: Array<Record<string, any>>;
  last: Record<string, any>;
}

const running: Array<{ kill(): void }> = [];
afterEach(() => {
  for (const r of running.splice(0)) r.kill();
});

/** Spawn one arming process; resolves when it exits. */
function arm(opts: {
  stateDir: string;
  thread: string;
  role?: 'holder' | 'plain';
  entered?: string;
  release?: string;
  lingerMs?: number;
  /** Hold this contender until the file appears (the test's starting gun). */
  gate?: string;
}): { pid: number; done: Promise<Ran>; stdout: () => string } {
  const kid = spawn(
    process.execPath,
    [
      child,
      pathToFileURL(MODULE).href,
      opts.stateDir,
      opts.thread,
      opts.role ?? 'plain',
      opts.entered ?? path.join(opts.stateDir, 'entered'),
      opts.release ?? path.join(opts.stateDir, 'release'),
      String(opts.lingerMs ?? 0),
      BIN,
      opts.gate ?? '',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  running.push({ kill: () => kid.exitCode === null && kid.kill('SIGKILL') });
  let out = '';
  kid.stdout.on('data', (c) => (out += String(c)));
  kid.stderr.on('data', () => {});
  const done = new Promise<Ran>((resolve) =>
    kid.on('exit', (code) => {
      const lines = out
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      resolve({ pid: kid.pid!, code, lines, last: lines[lines.length - 1] ?? {} });
    }),
  );
  return { pid: kid.pid!, done, stdout: () => out };
}

function freshStateDir(): string {
  return fs.mkdtempSync(path.join(scratch, 'state-'));
}

const ownerOf = (stateDir: string): any =>
  JSON.parse(fs.readFileSync(path.join(stateDir, 'await-owner.json'), 'utf8'));

/** Wait for a file to appear (the child's "I am inside the lock" signal). */
async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    await nap(20);
  }
}

describe('two processes publishing at once', () => {
  it('serialises them: the contender waits, then REFUSES a live different thread', async () => {
    const stateDir = freshStateDir();
    const entered = path.join(stateDir, 'entered');
    const release = path.join(stateDir, 'release');

    // A enters the critical section and stops there, holding the lock.
    const a = arm({ stateDir, thread: 'thread-A', role: 'holder', entered, release, lingerMs: 2500 });
    await waitForFile(entered);
    // The lock file is a bare inode the kernel locks — never written, never
    // unlinked. The helper that holds it announced itself through `entered`.
    expect(fs.existsSync(path.join(stateDir, 'await-arming.lock'))).toBe(true);
    const helperPid = Number(fs.readFileSync(entered, 'utf8'));
    expect(helperPid).toBeGreaterThan(0);
    expect(helperPid).not.toBe(a.pid); // it is a child of A, under flock

    // B arrives and is made to contend: it cannot be inside, and cannot publish.
    const gate = path.join(stateDir, 'gate-b');
    const b = arm({ stateDir, thread: 'thread-B', gate });
    fs.writeFileSync(gate, 'go'); // …starting only now, with A demonstrably inside
    await nap(400);
    expect(b.stdout()).toBe(''); // not published, not refused: contending
    expect(fs.existsSync(path.join(stateDir, 'await-owner.json'))).toBe(false);

    fs.writeFileSync(release, 'go');
    const [ranA, ranB] = [await a.done, await b.done];

    expect(ranA.last.outcome).toBe('published');
    expect(ranA.code).toBe(0);
    // B got the lock, re-read the record, found A alive on another thread.
    expect(ranB.last.outcome, `A=${JSON.stringify(ranA.lines)} B=${JSON.stringify(ranB.lines)}`).toBe(
      'refused-publish',
    );
    expect(ranB.code).toBe(1);
    expect(ranB.last.message).toContain(`Codex thread thread-A (pid ${a.pid})`);
    expect(ranB.last.message).toContain('SPARROW_AWAIT_TAKE_OVER=1');

    // EXACTLY ONE published, and the record is the winner's.
    expect([ranA, ranB].filter((r) => r.last.outcome === 'published')).toHaveLength(1);
    expect(ownerOf(stateDir).nonce).toBe(ranA.last.nonce);
    expect(ownerOf(stateDir).lock).toBe('flock');
    // Never unlinked: two processes must always lock the SAME inode.
    expect(fs.existsSync(path.join(stateDir, 'await-arming.lock'))).toBe(true);
  }, 60_000);

  /* THE WHOLE REASON THE KERNEL HOLDS IT: a holder that dies releases it, with
   * nothing left behind to reclaim and no pid for anyone to reason about. */
  it('releases on a SIGKILLed holder, and the next arm acquires at once', async () => {
    const stateDir = freshStateDir();
    const entered = path.join(stateDir, 'entered');
    const release = path.join(stateDir, 'release');

    const a = arm({ stateDir, thread: 'thread-A', role: 'holder', entered, release });
    await waitForFile(entered);
    process.kill(Number(fs.readFileSync(entered, 'utf8')), 'SIGKILL'); // the HELPER

    const started = Date.now();
    const b = arm({ stateDir, thread: 'thread-B' });
    const ranB = await b.done;
    // Acquired immediately — not after the 3 s budget, which is what a lock
    // that outlived its owner would have cost.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ranB.last.outcome).toBe('published');

    const ranA = await a.done;
    // A's helper never spoke and never renamed, so A publishes NOTHING.
    expect(ranA.last.outcome).toBe('refused-publish');
    expect(ranA.last.message).toContain('could not be taken');
    expect(ownerOf(stateDir).nonce).toBe(ranB.last.nonce);
  }, 60_000);

  /* A record naming a dead listener is worse than no record: every hook reads
   * it as a live wake path. The helper checks before it renames. */
  it('publishes nothing when the LISTENER dies while its helper holds the lock', async () => {
    const stateDir = freshStateDir();
    const entered = path.join(stateDir, 'entered');
    const release = path.join(stateDir, 'release');

    const a = arm({ stateDir, thread: 'thread-A', role: 'holder', entered, release, lingerMs: 5000 });
    await waitForFile(entered);
    process.kill(a.pid, 'SIGKILL'); // the LISTENER, while its helper waits
    await nap(100);
    fs.writeFileSync(release, 'go'); // the helper resumes, and looks up

    const started = Date.now();
    const b = arm({ stateDir, thread: 'thread-B' });
    const ranB = await b.done;
    expect(Date.now() - started).toBeLessThan(3000); // the kernel let go
    expect(ranB.last.outcome).toBe('published');
    // Nothing anywhere names the dead listener.
    expect(ownerOf(stateDir).nonce).toBe(ranB.last.nonce);
    expect(ownerOf(stateDir).pid).toBe(b.pid);
  }, 60_000);

  it('refuses with the contention line when the holder outlasts the budget', async () => {
    const stateDir = freshStateDir();
    const entered = path.join(stateDir, 'entered');
    const release = path.join(stateDir, 'release');

    const a = arm({ stateDir, thread: 'thread-A', role: 'holder', entered, release });
    await waitForFile(entered);
    const gate = path.join(stateDir, 'gate-b');
    const b = arm({ stateDir, thread: 'thread-B', gate });
    fs.writeFileSync(gate, 'go');
    const ranB = await b.done; // …with the pause still held

    expect(ranB.last.outcome).toBe('refused-publish');
    expect(ranB.last.message).toContain('is held by another publisher');
    expect(ranB.last.message).toContain('did not clear within 3 s');
    expect(fs.existsSync(path.join(stateDir, 'await-owner.json'))).toBe(false);

    fs.writeFileSync(release, 'go');
    expect((await a.done).last.outcome).toBe('published');
  }, 60_000);

  it('same thread: the contender supersedes, newest-wins, no refusal', async () => {
    const stateDir = freshStateDir();
    const entered = path.join(stateDir, 'entered');
    const release = path.join(stateDir, 'release');

    const a = arm({ stateDir, thread: 'thread-same', role: 'holder', entered, release, lingerMs: 2500 });
    await waitForFile(entered);
    const gate = path.join(stateDir, 'gate-b');
    const b = arm({ stateDir, thread: 'thread-same', gate });
    fs.writeFileSync(gate, 'go');
    await nap(400);
    expect(b.stdout()).toBe(''); // still waiting on the lock

    fs.writeFileSync(release, 'go');
    const [ranA, ranB] = [await a.done, await b.done];

    expect(ranA.last.outcome).toBe('published');
    expect(ranB.last.outcome).toBe('published');
    expect(ranB.code).toBe(0);
    expect(ownerOf(stateDir).nonce).toBe(ranB.last.nonce); // newest wins, as always
    expect(ownerOf(stateDir).thread).toBe('thread-same');
  }, 60_000);
});
