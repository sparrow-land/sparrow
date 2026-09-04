/**
 * WHAT A DYING LISTENER LEAVES BEHIND — in a REAL process.
 *
 * INCIDENT. `sparrow await --timeout 900` runs as a tracked background task and
 * its EXIT is a turn-based agent's wake signal. When the human interrupts the
 * Claude Code session (Esc / Ctrl-C), the harness kills the whole process tree:
 * SIGTERM/SIGHUP straight at the listener. The agent was then deaf — no
 * listener — while `~/.sparrow/heartbeat` still looked FRESH for up to 120s, so
 * the Stop hook let the next turn end in silence and nothing told the agent its
 * wake path was gone. Three sessions in a row died that way in one day.
 *
 * THE CONTRACT PINNED HERE. A listener stamps the heartbeat on its way out:
 * `killed:SIGTERM` / `killed:SIGHUP` (nobody asked — exit 143 / 129, no wake
 * line) and `stopped:SIGINT` (a deliberate Ctrl-C — today's silent exit 0).
 * Normal exits (a wake, a --timeout) stamp nothing: the turn that follows owns
 * those.
 *
 * WHY A CHILD PROCESS. Signals are the subject. Emitting `process.emit('SIGTERM')`
 * inside vitest would run the handler but never prove the process actually dies
 * with the conventional code — and the handler calls `process.exit`, which would
 * take the test runner with it. So this builds the CLI and drives the real
 * `dist/bin.js` against a real (tiny) SSE upstream, then kills it for real.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(cliRoot, 'dist', 'bin.js');

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------- a minimal live upstream ------------------------ */

interface Upstream {
  url: string;
  /** How many SSE streams have been opened (the "listener is armed" signal). */
  sseConns: () => number;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  let conns = 0;
  const server = http.createServer((req, res) => {
    const u = req.url ?? '';
    if (u.startsWith('/api/v1/me/events/log')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [], latest: 0 }));
      return;
    }
    if (u.startsWith('/api/v1/me/events')) {
      conns += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      const hb = setInterval(() => res.write(': ping\n\n'), 200);
      req.on('close', () => clearInterval(hb));
      return;
    }
    if (u === '/api/v1/me/inbox/pop' && req.method === 'POST') {
      req.resume(); // `loop` drains on connect; an empty queue keeps it holding
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ item: null }));
      return;
    }
    if (u.startsWith('/api/v1/me/inbox')) {
      // Nothing waiting — so `await` holds the stream instead of waking at once.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [], nextCursor: null }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sseConns: () => conns,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/* ------------------------------- the harness ------------------------------ */

let upstream: Upstream;
let dirs: string[] = [];
let kids: ChildProcess[] = [];

beforeAll(async () => {
  // Build so the child runs THIS working tree (dist mirrors src).
  execFileSync('npm', ['run', 'build'], { cwd: cliRoot, timeout: 180_000, stdio: 'ignore' });
  upstream = await startUpstream();
}, 200_000);

afterAll(async () => {
  await upstream.close();
});

afterEach(() => {
  for (const kid of kids) if (kid.exitCode === null && !kid.killed) kid.kill('SIGKILL');
  kids = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface Listener {
  stateDir: string;
  /** Resolves with the child's exit code + signal once it is gone. */
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  kill: (signal: NodeJS.Signals) => void;
}

/** Spawn a real listener, armed and streaming, in its own state dir. */
async function startListener(args: string[]): Promise<Listener> {
  const stateDir = tmp('sparrow-sig-state-');
  const configHome = tmp('sparrow-sig-config-');
  const home = tmp('sparrow-sig-home-');
  const before = upstream.sseConns();
  const kid = spawn(process.execPath, [BIN, ...args], {
    env: {
      PATH: process.env.PATH,
      // NEVER the developer's real ~/.sparrow: every listener here stamps a
      // heartbeat, and a stray `killed` in the real state dir would block the
      // next Stop hook of the session running these tests.
      SPARROW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: configHome,
      HOME: home,
      SPARROW_SERVER: upstream.url,
      SPARROW_TOKEN: 'agk_stub',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(kid);
  let out = '';
  kid.stdout.on('data', (d: Buffer) => (out += d.toString()));
  kid.stderr.resume();
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    kid.on('exit', (code, signal) => resolve({ code, signal }));
  });

  // The signal handlers are armed before the stream opens, so a live SSE
  // connection is proof the listener is ready to be killed.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && upstream.sseConns() <= before) await nap(25);
  expect(upstream.sseConns(), 'listener never opened its stream').toBeGreaterThan(before);

  return { stateDir, ended, stdout: () => out, kill: (s) => kid.kill(s) };
}

const heartbeat = (stateDir: string): string => {
  const f = path.join(stateDir, 'heartbeat');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '<absent>';
};

/* --------------------------------- tests --------------------------------- */

describe('sparrow await — termination stamps the heartbeat', () => {
  it('SIGTERM (a session interrupt) leaves `killed:SIGTERM` and exits 143', async () => {
    const l = await startListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json']);
    l.kill('SIGTERM');
    const { code, signal } = await l.ended;
    // 128 + 15, from OUR handler — not a default kill (which reports signal, not code).
    expect(code).toBe(143);
    expect(signal).toBeNull();
    expect(heartbeat(l.stateDir)).toBe('killed:SIGTERM');
    // No wake line: there is no agent left to read one.
    expect(l.stdout().trim()).toBe('');
  }, 40_000);

  it('SIGHUP leaves `killed:SIGHUP` and exits 129', async () => {
    const l = await startListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json']);
    l.kill('SIGHUP');
    const { code } = await l.ended;
    expect(code).toBe(129);
    expect(heartbeat(l.stateDir)).toBe('killed:SIGHUP');
    expect(l.stdout().trim()).toBe('');
  }, 40_000);

  it('SIGINT (a deliberate Ctrl-C) leaves `stopped:SIGINT` and keeps exit 0', async () => {
    const l = await startListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json']);
    l.kill('SIGINT');
    const { code } = await l.ended;
    expect(code).toBe(0); // unchanged behaviour: interrupted, silently
    expect(heartbeat(l.stateDir)).toBe('stopped:SIGINT');
    expect(l.stdout().trim()).toBe('');
  }, 40_000);

  it('a --timeout expiry stamps NOTHING dead — the next turn owns that', async () => {
    const l = await startListener(['await', '--timeout', '1', '--poll-seconds', '0', '--json']);
    const { code } = await l.ended;
    expect(code).toBe(2); // nothing was waiting
    expect(JSON.parse(l.stdout().trim()).type).toBe('await.timeout');
    // Whatever the heartbeat says, it must not claim the listener was killed.
    expect(heartbeat(l.stateDir)).not.toMatch(/killed|stopped/);
  }, 40_000);
});

describe('sparrow watch/loop — the hold-only listeners stamp too', () => {
  it('watch: SIGTERM leaves `killed:SIGTERM` and exits 143', async () => {
    const l = await startListener(['watch', '--poll-seconds', '0', '--json']);
    l.kill('SIGTERM');
    const { code } = await l.ended;
    expect(code).toBe(143);
    expect(heartbeat(l.stateDir)).toBe('killed:SIGTERM');
  }, 40_000);

  it('watch: SIGINT leaves `stopped:SIGINT`', async () => {
    const l = await startListener(['watch', '--poll-seconds', '0', '--json']);
    l.kill('SIGINT');
    await l.ended;
    expect(heartbeat(l.stateDir)).toBe('stopped:SIGINT');
  }, 40_000);

  it('loop: SIGHUP leaves `killed:SIGHUP` and exits 129', async () => {
    const l = await startListener(['loop', '--poll-seconds', '0', '--json']);
    l.kill('SIGHUP');
    const { code } = await l.ended;
    expect(code).toBe(129);
    expect(heartbeat(l.stateDir)).toBe('killed:SIGHUP');
  }, 40_000);
});
