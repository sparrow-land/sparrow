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

const sampleRoom = {
  id: 'room_dm',
  name: '',
  orgId: 'org_a',
  kind: 'dm',
  counterpart: { type: 'human', id: 'usr_o', displayName: 'Owner' },
};
/** One waiting work item — enough for `await` to have something to hand off. */
const waitingItem = {
  type: 'chat.message',
  id: 'msg_wait',
  from: { id: 'mem_owner', kind: 'human', displayName: 'Owner', avatarUrl: null },
  kind: 'dm',
  subject: null,
  preview: 'work for you',
  truncated: false,
  attachmentCount: 0,
  status: 'unread',
  createdAt: '2026-09-01T00:00:00Z',
  room: sampleRoom,
};

interface Upstream {
  url: string;
  /** How many SSE streams have been opened (the "listener is armed" signal). */
  sseConns: () => number;
  /** Put one item in (or take it out of) what `/me/inbox` reports. */
  setItem: (present: boolean) => void;
  /** Park `POST /me/presence` — the turn mark — until released. */
  holdPresence: (on: boolean) => void;
  presenceHeld: () => number;
  releasePresence: () => void;
  /** Push a `message.new` frame to every open stream (the tail path's wake). */
  deliver: () => void;
  /** Has anything CONSUMED the queue? (`await` never should.) */
  pops: () => number;
  reset: () => void;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  let conns = 0;
  const state = { item: false, holdPresence: false, pops: 0 };
  const parked: Array<() => void> = [];
  const streams = new Set<import('node:http').ServerResponse>();
  const server = http.createServer((req, res) => {
    const u = req.url ?? '';
    if (req.method === 'POST' && u.startsWith('/api/v1/me/presence')) {
      req.resume();
      const answer = (): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ onlineUntil: new Date(Date.now() + 60_000).toISOString() }));
      };
      if (state.holdPresence) parked.push(answer);
      else answer();
      return;
    }
    if (u.startsWith('/api/v1/me/events/log')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [], latest: 0 }));
      return;
    }
    if (u.startsWith('/api/v1/me/events')) {
      conns += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      streams.add(res);
      const hb = setInterval(() => res.write(': ping\n\n'), 200);
      req.on('close', () => {
        clearInterval(hb);
        streams.delete(res);
      });
      return;
    }
    if (u === '/api/v1/me/inbox/pop' && req.method === 'POST') {
      req.resume(); // `loop` drains on connect; an empty queue keeps it holding
      state.pops += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ item: null }));
      return;
    }
    if (u.startsWith('/api/v1/me/inbox')) {
      // Empty by default — so `await` holds the stream instead of waking at once.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: state.item ? [waitingItem] : [], nextCursor: null }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sseConns: () => conns,
    setItem: (present: boolean) => {
      state.item = present;
    },
    holdPresence: (on: boolean) => {
      state.holdPresence = on;
    },
    presenceHeld: () => parked.length,
    releasePresence: () => {
      state.holdPresence = false;
      for (const answer of parked.splice(0)) answer();
    },
    deliver: () => {
      for (const res of streams) {
        res.write(
          `id: 1\nevent: message.new\ndata: ${JSON.stringify({
            room: sampleRoom,
            messageId: 'msg_wait',
            from: { id: 'mem_owner', kind: 'human', displayName: 'Owner' },
            preview: 'work for you',
            kind: 'dm',
          })}\n\n`,
        );
      }
    },
    pops: () => state.pops,
    reset: () => {
      state.item = false;
      state.holdPresence = false;
      state.pops = 0;
      parked.length = 0;
    },
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

/**
 * An `await` stamp carries a SECOND token: the generation nonce that wrote it,
 * so a hook can discard a stamp left by a listener that was superseded before
 * the signal landed. This asserts the whole stamp — first token unchanged (so
 * every existing reader still parses it), tag equal to the live generation.
 */
const expectStamp = (stateDir: string, word: string): void => {
  const [stamp, tag, ...extra] = heartbeat(stateDir).split(/\s+/);
  expect(stamp).toBe(word);
  expect(extra).toEqual([]);
  const record = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'await-owner.json'), 'utf8'),
  ) as { nonce: string };
  expect(tag).toBe(record.nonce);
};

/* ------------------- the deferred hand-off (usage limit) ------------------ */

/**
 * Spawn a listener WITHOUT waiting for a stream: the hand-off cases wake before
 * one is ever opened, so the readiness signal is the caller's to choose.
 */
function spawnListener(args: string[], extraEnv: Record<string, string> = {}): {
  stateDir: string;
  binDir: string;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
  kill: (signal: NodeJS.Signals) => void;
} {
  const stateDir = tmp('sparrow-sig-state-');
  const configHome = tmp('sparrow-sig-config-');
  const home = tmp('sparrow-sig-home-');
  // A stand-in `codex` on PATH: if the bridge is ever rung, it leaves a file.
  const binDir = tmp('sparrow-sig-bin-');
  const codexLog = path.join(binDir, 'queued.log');
  fs.writeFileSync(path.join(binDir, 'codex'), `#!/bin/sh\necho "$@" >> ${codexLog}\n`, {
    mode: 0o755,
  });
  const kid = spawn(process.execPath, [BIN, ...args], {
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      SPARROW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: configHome,
      HOME: home,
      SPARROW_SERVER: upstream.url,
      SPARROW_TOKEN: 'agk_stub',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(kid);
  let out = '';
  let err = '';
  kid.stdout.on('data', (d: Buffer) => (out += d.toString()));
  kid.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    kid.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { stateDir, binDir, ended, stdout: () => out, stderr: () => err, kill: (sg) => kid.kill(sg) };
}

const until = async (want: () => boolean, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!want()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await nap(25);
  }
};

const bridgeRang = (binDir: string): boolean => fs.existsSync(path.join(binDir, 'queued.log'));

/**
 * Drive a real listener into the DEFERRED HAND-OFF: its wake line is printed,
 * the turn mark is in flight, a usage-limit marker lands, and the hand-off is
 * left waiting for the limit to lift.
 *
 * `--timeout 60` and a 5 s standby cadence make the wait long on purpose: a
 * listener that answers a signal only when its nap ends would be caught here.
 */
async function intoDeferredHandoff(where: 'initial' | 'tail'): Promise<ReturnType<typeof spawnListener>> {
  upstream.reset();
  upstream.holdPresence(true);
  if (where === 'initial') upstream.setItem(true);
  const before = upstream.sseConns();
  const l = spawnListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json'], {
    SPARROW_BLOCKED_POLL_MS: '5000',
    CODEX_THREAD_ID: 'thread-signal',
  });
  if (where === 'tail') {
    await until(() => upstream.sseConns() > before); // streaming first…
    upstream.setItem(true);
    upstream.deliver(); // …then work arrives live
  }
  let gone = false;
  void l.ended.then(() => {
    gone = true;
  });
  await until(() => upstream.presenceHeld() >= 1 || gone); // the wake line is out
  expect(gone, `the listener exited instead of waking: ${l.stderr()}`).toBe(false);
  expect(l.stdout()).toContain('await.item');
  fs.mkdirSync(path.join(l.stateDir, 'blocked'), { recursive: true });
  fs.writeFileSync(
    path.join(l.stateDir, 'blocked', 'marker.json'),
    `${JSON.stringify({ version: 1, reason: 'rate_limit', at: new Date().toISOString() })}\n`,
  );
  upstream.releasePresence();
  await until(() => heartbeat(l.stateDir).startsWith('blocked:'));
  return l;
}

describe('sparrow await — a deferred hand-off still answers signals', () => {
  // One upstream serves every test in this file: leaving an item (or a parked
  // presence post) behind would change what the NEXT listener does.
  afterEach(() => upstream.reset());

  for (const where of ['initial', 'tail'] as const) {
    it(`${where}: SIGINT ends the wait at once, hands nothing off`, async () => {
      const l = await intoDeferredHandoff(where);
      const t0 = Date.now();
      l.kill('SIGINT');
      const { code } = await l.ended;

      expect(Date.now() - t0).toBeLessThan(1500); // NOT the 5 s standby cadence
      expect(code).toBe(0); // an interrupted listener exits quietly, as ever
      expect(heartbeat(l.stateDir).split(/\s+/)[0]).toBe('stopped:SIGINT');
      expect(bridgeRang(l.binDir)).toBe(false); // no turn queued on the way out
      expect(upstream.pops()).toBe(0); // and the item is still unread
    }, 40_000);

    it(`${where}: SIGTERM ends the wait at once, hands nothing off`, async () => {
      const l = await intoDeferredHandoff(where);
      const t0 = Date.now();
      l.kill('SIGTERM');
      const { code } = await l.ended;

      expect(Date.now() - t0).toBeLessThan(1500);
      expect(code).toBe(143);
      expect(heartbeat(l.stateDir).split(/\s+/)[0]).toBe('killed:SIGTERM');
      expect(bridgeRang(l.binDir)).toBe(false);
      expect(upstream.pops()).toBe(0);
    }, 40_000);
  }

  /* The first signal owns the STAMP; every signal owns the EXIT. A SIGTERM
   * after a SIGINT used to be swallowed whole — `fired` was set, the handler
   * returned before `process.exit`, and the process had to be killed by hand. */
  it('a SIGTERM after a SIGINT is never swallowed', async () => {
    const l = await intoDeferredHandoff('initial');
    const t0 = Date.now();
    l.kill('SIGINT');
    l.kill('SIGTERM');
    const { code, signal } = await l.ended;

    expect(Date.now() - t0).toBeLessThan(1500);
    expect(code === 0 || code === 143 || signal !== null).toBe(true); // it LEFT
    // Whichever arrived first owns the stamp; both are terminal words.
    expect(heartbeat(l.stateDir).split(/\s+/)[0]).toMatch(/^(stopped:SIGINT|killed:SIGTERM)$/);
    expect(bridgeRang(l.binDir)).toBe(false);
  }, 40_000);

  /* The other direction: a NORMAL wake aborts the same controller a signal
   * would, and must still be treated as a hand-off, not an interruption. */
  it('a wake with no marker still hands off and rings the bridge', async () => {
    upstream.reset();
    upstream.setItem(true);
    const l = spawnListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json'], {
      CODEX_THREAD_ID: 'thread-signal',
    });
    const { code } = await l.ended;

    expect(code).toBe(0);
    expect(l.stdout()).toContain('await.item');
    await until(() => bridgeRang(l.binDir), 5000);
    expect(upstream.pops()).toBe(0); // woken, never consumed
  }, 40_000);
});

/* --------------------------------- tests --------------------------------- */

describe('sparrow await — termination stamps the heartbeat', () => {
  it('SIGTERM (a session interrupt) leaves `killed:SIGTERM` and exits 143', async () => {
    const l = await startListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json']);
    l.kill('SIGTERM');
    const { code, signal } = await l.ended;
    // 128 + 15, from OUR handler — not a default kill (which reports signal, not code).
    expect(code).toBe(143);
    expect(signal).toBeNull();
    expectStamp(l.stateDir, 'killed:SIGTERM');
    // No wake line: there is no agent left to read one.
    expect(l.stdout().trim()).toBe('');
  }, 40_000);

  it('SIGHUP leaves `killed:SIGHUP` and exits 129', async () => {
    const l = await startListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json']);
    l.kill('SIGHUP');
    const { code } = await l.ended;
    expect(code).toBe(129);
    expectStamp(l.stateDir, 'killed:SIGHUP');
    expect(l.stdout().trim()).toBe('');
  }, 40_000);

  it('SIGINT (a deliberate Ctrl-C) leaves `stopped:SIGINT` and keeps exit 0', async () => {
    const l = await startListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json']);
    l.kill('SIGINT');
    const { code } = await l.ended;
    expect(code).toBe(0); // unchanged behaviour: interrupted, silently
    expectStamp(l.stateDir, 'stopped:SIGINT');
    expect(l.stdout().trim()).toBe('');
  }, 40_000);

  /**
   * A LATE SIGNAL FROM A SUPERSEDED LISTENER. Re-arming supersedes the previous
   * listener (see await-owner.ts), and the harness may kill that old process
   * seconds later — long after its successor took over the state dir. Its
   * `killed:SIGTERM` stamp would then report the LIVE listener as dead, and the
   * next Stop hook would demand a re-arm that is already running. So the stamp
   * is vetoed once the generation record names someone else: retirement is
   * silent, whichever way the old process finally dies.
   */
  it('a superseded listener stamps NOTHING when it is killed afterwards', async () => {
    const l = await startListener(['await', '--timeout', '60', '--poll-seconds', '0', '--json']);
    const hbFile = path.join(l.stateDir, 'heartbeat');
    // Wait for the child to PUBLISH its own generation first: an open socket is
    // not proof it has claimed the state dir, and a record written before its
    // publish would simply be overwritten (newest wins).
    const ownerFile = path.join(l.stateDir, 'await-owner.json');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !fs.existsSync(ownerFile)) await nap(25);
    expect(fs.existsSync(ownerFile), 'listener never published its generation').toBe(true);
    // A newer generation publishes and owns the heartbeat from here on.
    fs.writeFileSync(
      path.join(l.stateDir, 'await-owner.json'),
      `${JSON.stringify({ version: 1, nonce: 'cafebabecafebabe', pid: 999999, startedAt: new Date().toISOString(), kind: 'await' })}\n`,
    );
    fs.writeFileSync(hbFile, 'await\n');
    l.kill('SIGTERM');

    const { code } = await l.ended;
    // Either the signal arrived first (143) or the listener had already noticed
    // it was superseded and stood down (4). Both must leave the successor's
    // heartbeat free of any DEAD stamp. One thing IS allowed: the old listener's
    // periodic live touch can land in the window between the successor's publish
    // and its next ownership check — that claim carries the OLD generation's
    // nonce, which every reader discards (see await-owner.ts), so it is noise,
    // not a false-dead. It must never carry the successor's nonce.
    expect([143, 4]).toContain(code);
    const hb = heartbeat(l.stateDir);
    expect(hb).toMatch(/^await( [0-9a-f]{16})?$/);
    expect(hb).not.toContain('cafebabecafebabe');
    expect(hb).not.toMatch(/killed|stopped/);
    expect(l.stdout().trim()).toBe(''); // and never a wake line
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
