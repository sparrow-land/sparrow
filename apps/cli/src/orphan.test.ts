/**
 * A LISTENER THAT CANNOT WAKE ANYONE — in REAL processes.
 *
 * Under Claude Code (`CLAUDECODE=1`, `CLAUDE_PID=<harness>`), `sparrow await`
 * wakes the session by exiting, and only a DESCENDANT of the harness can do
 * that. A `( sparrow await & )` disowned inside a foreground Bash call is
 * reparented away within a second and then passes every other health check
 * while being unable to wake anybody.
 *
 * THE CONTRACT PINNED HERE.
 *   - Arming from a shell the harness is not an ancestor of is refused with one
 *     stderr line and exit 5, before anything touches the state dir.
 *     `--allow-unowned` skips the check.
 *   - A listener whose harness goes away (dead, or no longer an ancestor)
 *     stamps the heartbeat `orphaned <nonce>`, clears its working status in its
 *     rooms and its presence mark, says so on stderr and exits 5.
 *
 * WHY CHILD PROCESSES: ancestry and parent death are the subject, and neither
 * can be faked inside the test runner. Builds `dist/` and drives `dist/bin.js`
 * against a tiny upstream, like signals.test.ts.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { detectPidNamespace } from '@sparrow/skill';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * A test HOST that is itself inside a pid namespace (a CI container) is where
 * the rule deliberately does NOT refuse — `CLAUDE_PID` could be a host pid. The
 * refusal cases only mean anything outside one.
 */
const hostInPidNamespace = detectPidNamespace().inNamespace;

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(cliRoot, 'dist', 'bin.js');

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const until = async (want: () => boolean, ms = 15_000, what = 'the condition'): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!want()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await nap(25);
  }
};

const REFUSAL_RE =
  /^sparrow await: armed from a shell this Claude Code session does not own \(harness pid (\d+) is not an ancestor\): this listener could never wake your session\. Run it as a tracked background task, or pass --allow-unowned\.$/m;
const ORPHAN_RE =
  /^sparrow await: orphaned — the Claude Code session that armed this listener \(pid (\d+)\) is gone; standing down\.$/m;

/* ------------------------- a minimal live upstream ------------------------ */

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
  room: {
    id: 'room_dm',
    name: '',
    orgId: 'org_a',
    kind: 'dm',
    counterpart: { type: 'human', id: 'usr_o', displayName: 'Owner' },
  },
};

const meRoom = (id: string, archivedAt: string | null) => ({
  room: { id, name: id, orgId: 'org_a', kind: 'project', archivedAt },
  memberId: `mem_${id}`,
  roomRole: 'member',
});

interface Upstream {
  url: string;
  sseConns: () => number;
  /** Every `POST /rooms/:id/status` body, with its room. */
  statusPosts: () => Array<{ room: string; body: Record<string, unknown> }>;
  /** Every `POST /me/presence` body. */
  presencePosts: () => Array<Record<string, unknown>>;
  /** Make `/me/inbox` answer after `delayMs`: one waiting item when `item`, or a 426 when `upgrade`. */
  slowInbox: (opt: { delayMs: number; item: boolean; upgrade?: boolean } | undefined) => void;
  /** Park every `POST /me/presence` until released. */
  holdPresence: (on: boolean) => void;
  presenceParked: () => number;
  /** How many `/me/inbox` requests have ARRIVED (answered or not). */
  inboxAsks: () => number;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  let conns = 0;
  let inboxAsks = 0;
  let slow: { delayMs: number; item: boolean; upgrade?: boolean } | undefined;
  let holding = false;
  const parked: Array<() => void> = [];
  const statusPosts: Array<{ room: string; body: Record<string, unknown> }> = [];
  const presencePosts: Array<Record<string, unknown>> = [];
  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let s = '';
      req.on('data', (d: Buffer) => (s += d.toString()));
      req.on('end', () => {
        try {
          resolve(JSON.parse(s || '{}') as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });
  const json = (res: http.ServerResponse, body: unknown): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const u = req.url ?? '';
    if (req.method === 'POST' && u.startsWith('/api/v1/me/presence')) {
      void readBody(req).then((b) => {
        presencePosts.push(b);
        const answer = (): void => json(res, { onlineUntil: new Date(Date.now() + 60_000).toISOString() });
        if (holding) parked.push(answer);
        else answer();
      });
      return;
    }
    const status = /^\/api\/v1\/rooms\/([^/]+)\/status$/.exec(u);
    if (req.method === 'POST' && status) {
      void readBody(req).then((b) => {
        statusPosts.push({ room: decodeURIComponent(status[1]!), body: b });
        json(res, { status: null });
      });
      return;
    }
    if (u.startsWith('/api/v1/me/rooms')) {
      json(res, {
        items: [meRoom('room_a', null), meRoom('room_b', null), meRoom('room_old', '2026-01-01T00:00:00Z')],
        nextCursor: null,
      });
      return;
    }
    if (u.startsWith('/api/v1/me/events/log')) {
      json(res, { events: [], latest: 0 });
      return;
    }
    if (u.startsWith('/api/v1/me/events')) {
      conns += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      const hb = setInterval(() => res.write(': ping\n\n'), 100);
      req.on('close', () => clearInterval(hb));
      return;
    }
    if (u.startsWith('/api/v1/me/inbox')) {
      inboxAsks += 1;
      if (slow) {
        const { delayMs, item, upgrade } = slow;
        setTimeout(() => {
          if (upgrade) {
            res.writeHead(426, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'client_upgrade_required', message: 'too old' } }));
            return;
          }
          json(res, { items: item ? [waitingItem] : [], nextCursor: null });
        }, delayMs);
        return;
      }
      json(res, { items: [], nextCursor: null }); // empty: `await` holds the stream
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sseConns: () => conns,
    slowInbox: (opt) => {
      slow = opt;
    },
    inboxAsks: () => inboxAsks,
    holdPresence: (on) => {
      holding = on;
      if (!on) for (const answer of parked.splice(0)) answer();
    },
    presenceParked: () => parked.length,
    statusPosts: () => statusPosts.slice(),
    presencePosts: () => presencePosts.slice(),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/* ------------------------------- the harness ------------------------------ */

let upstream: Upstream;
let dirs: string[] = [];
let kids: ChildProcess[] = [];
/** Pids of grandchildren we started (never anything else): killed by number. */
let strays: number[] = [];

beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], { cwd: cliRoot, timeout: 180_000, stdio: 'ignore' });
  upstream = await startUpstream();
}, 200_000);

afterAll(async () => {
  await upstream.close();
});

afterEach(() => {
  for (const kid of kids) if (kid.exitCode === null && !kid.killed) kid.kill('SIGKILL');
  kids = [];
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  strays = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A clean env for the CLI: never the developer's state dir, never THIS session's harness. */
function baseEnv(stateDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    SPARROW_STATE_DIR: stateDir,
    XDG_CONFIG_HOME: tmp('sparrow-orphan-config-'),
    HOME: tmp('sparrow-orphan-home-'),
    SPARROW_SERVER: upstream.url,
    SPARROW_TOKEN: 'agk_stub',
    SPARROW_ORPHAN_CHECK_MS: '100',
  };
}

/**
 * A LIVE process that is not an ancestor of anything we spawn: a sibling. (Not
 * pid 1 — a harness can BE pid 1, e.g. `claude` as a container entrypoint, so
 * init counts as an ancestor of every process on the host.)
 */
async function liveStranger(): Promise<number> {
  const kid = spawn('sleep', ['300'], { stdio: 'ignore' });
  kids.push(kid);
  await new Promise((r) => kid.once('spawn', r));
  return kid.pid!;
}

function spawnAwait(extraEnv: Record<string, string>, args: string[] = []) {
  const stateDir = tmp('sparrow-orphan-state-');
  const kid = spawn(process.execPath, [BIN, 'await', ...args], {
    env: { ...baseEnv(stateDir), ...extraEnv },
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
  return { stateDir, kid, ended, stdout: () => out, stderr: () => err };
}

const heartbeat = (stateDir: string): string => {
  const f = path.join(stateDir, 'heartbeat');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '<absent>';
};

const owner = (stateDir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(stateDir, 'await-owner.json'), 'utf8')) as Record<string, unknown>;

/* --------------------------------- arming -------------------------------- */

describe('sparrow await — arming from a shell the Claude Code session does not own', () => {
  it.skipIf(hostInPidNamespace)('refuses with exit 5 and one line, and writes nothing to the state dir', async () => {
    const stranger = await liveStranger();
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: String(stranger) });
    const { code } = await l.ended;
    expect(code).toBe(5);
    expect(l.stderr()).toMatch(REFUSAL_RE);
    expect(REFUSAL_RE.exec(l.stderr())?.[1]).toBe(String(stranger));
    expect(l.stderr().trim().split('\n')).toHaveLength(1);
    expect(l.stdout()).toBe('');
    const left = fs.existsSync(l.stateDir) ? fs.readdirSync(l.stateDir) : [];
    expect(left.filter((f) => /heartbeat|await-owner|candidate/.test(f))).toEqual([]);
  }, 30_000);

  it('--allow-unowned arms anyway — and never claims the session it cannot wake', async () => {
    const stranger = await liveStranger();
    const before = upstream.sseConns();
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: String(stranger) }, ['--allow-unowned']);
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    await until(() => fs.existsSync(path.join(l.stateDir, 'await-owner.json')));
    expect(l.stderr()).not.toMatch(REFUSAL_RE);
    // `harnessPid` means "my exit wakes that session" — false here, so absent.
    expect('harnessPid' in owner(l.stateDir)).toBe(false);
    expect(owner(l.stateDir).ppid).toBe(process.pid);
    // …and it is NOT monitored: the stranger stays "not an ancestor" on every tick.
    await nap(600);
    expect(l.kid.exitCode).toBeNull();
    expect(heartbeat(l.stateDir)).toMatch(/^await /);
    l.kid.kill('SIGTERM');
    expect((await l.ended).code).toBe(143);
  }, 30_000);

  /* Every process descends from init, so a session running as pid 1 (a
   * container entrypoint) cannot be told apart from it: never refused, never
   * recorded, never watched. */
  it('CLAUDE_PID=1: arms, records no harnessPid, and is not watched', async () => {
    const before = upstream.sseConns();
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: '1' });
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    await until(() => fs.existsSync(path.join(l.stateDir, 'await-owner.json')));
    expect(l.stderr()).not.toMatch(REFUSAL_RE);
    expect('harnessPid' in owner(l.stateDir)).toBe(false);
    await nap(600); // several ticks at SPARROW_ORPHAN_CHECK_MS=100
    expect(l.kid.exitCode).toBeNull();
    expect(heartbeat(l.stateDir)).toMatch(/^await /);
    l.kid.kill('SIGTERM');
    expect((await l.ended).code).toBe(143);
  }, 30_000);

  it('--allow-unowned from a TRUE ancestor still records no harnessPid and watches nothing', async () => {
    const before = upstream.sseConns();
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: String(process.pid) }, ['--allow-unowned']);
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    await until(() => fs.existsSync(path.join(l.stateDir, 'await-owner.json')));
    const rec = owner(l.stateDir);
    expect('harnessPid' in rec).toBe(false);
    expect(rec.ppid).toBe(process.pid);
    l.kid.kill('SIGTERM');
    expect((await l.ended).code).toBe(143);
  }, 30_000);

  it('arms normally when the harness IS an ancestor, and records it', async () => {
    const before = upstream.sseConns();
    // The test runner spawned the CLI: it is the CLI's parent.
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: String(process.pid) });
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    await until(() => fs.existsSync(path.join(l.stateDir, 'await-owner.json')));
    await nap(600); // several orphan checks: the runner is alive and still an ancestor
    expect(l.kid.exitCode).toBeNull();
    const rec = owner(l.stateDir);
    expect(rec.version).toBe(1);
    expect(rec.harnessPid).toBe(process.pid);
    expect(rec.ppid).toBe(process.pid);
    expect(rec.pid).toBe(l.kid.pid);
    l.kid.kill('SIGTERM');
    expect((await l.ended).code).toBe(143);
  }, 30_000);

  /* Outside a pid namespace a CLAUDE_PID that names nothing running can only
   * be a gone session: this listener could never wake it. (Inside one it is
   * not judged — see harness-owner.test.ts, with an injected detector.) */
  it.skipIf(hostInPidNamespace)('a harness pid that is not running: refused with exit 5, nothing written', async () => {
    const dead = spawn('true', [], { stdio: 'ignore' });
    const deadPid = dead.pid!;
    await new Promise((r) => dead.once('exit', r));
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: String(deadPid) });
    const { code } = await l.ended;
    expect(code).toBe(5);
    expect(l.stderr().trim()).toBe(
      `sparrow await: the Claude Code session named by CLAUDE_PID (pid ${deadPid}) is not running: this ` +
        'listener could never wake it. Start it from a live session as a tracked background task, ' +
        'or pass --allow-unowned.',
    );
    const left = fs.existsSync(l.stateDir) ? fs.readdirSync(l.stateDir) : [];
    expect(left.filter((f) => /heartbeat|await-owner|candidate/.test(f))).toEqual([]);
  }, 30_000);

  it('outside Claude Code nothing is checked', async () => {
    const stranger = await liveStranger();
    const before = upstream.sseConns();
    const l = spawnAwait({ CLAUDE_PID: String(stranger) }); // no CLAUDECODE
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    l.kid.kill('SIGTERM');
    expect((await l.ended).code).toBe(143);
  }, 30_000);
});

/* ------------------------------- orphaned -------------------------------- */

/**
 * test ─ W (the "harness", CLAUDE_PID=$$) ─ R (reporter) ─ CLI. Killing W
 * orphans the CLI; R survives and records its exit status.
 */
function spawnTree(stateDir: string, opts: { harnessOutlivesReporter?: boolean; args?: string } = {}) {
  const work = tmp('sparrow-orphan-work-');
  const codeFile = path.join(work, 'code');
  const rpidFile = path.join(work, 'rpid');
  const inner = `echo $$ > "$RPID"; "$NODE" "$BIN" await ${opts.args ?? ''}; echo $? > "$CODE"`;
  // `exec sleep` keeps W (same pid) alive after R is gone — for the case where
  // the LISTENER is reparented away from a session that is still running.
  const tail = opts.harnessOutlivesReporter ? 'wait; exec sleep 300' : 'wait';
  const w = spawn('sh', ['-c', `CLAUDECODE=1 CLAUDE_PID=$$ sh -c '${inner}' & ${tail}`], {
    env: { ...baseEnv(stateDir), NODE: process.execPath, BIN, RPID: rpidFile, CODE: codeFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(w);
  let out = '';
  let err = '';
  w.stdout.on('data', (d: Buffer) => (out += d.toString()));
  w.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const code = (): string | undefined =>
    fs.existsSync(codeFile) ? fs.readFileSync(codeFile, 'utf8').trim() || undefined : undefined;
  const rpid = (): number => Number(fs.readFileSync(rpidFile, 'utf8').trim());
  const trackStrays = async (): Promise<void> => {
    await until(() => fs.existsSync(rpidFile));
    strays.push(rpid());
  };
  return { w, out: () => out, err: () => err, code, trackStrays, rpid };
}

describe('sparrow await — the session that armed it goes away', () => {
  /* ORPHANED WHILE A 426 IS IN FLIGHT: the first inbox read answers "upgrade
   * required" after the session is gone. The 426 hand-off CLAIMS the state dir
   * (it queues a repair turn) — for an orphan there is nobody to repair for:
   * no publish, no upgrade demand, exit 5. */
  it('orphaned while a 426 is in flight: never publishes, exits 5', async () => {
    const stateDir = tmp('sparrow-orphan-state-');
    upstream.slowInbox({ delayMs: 2500, item: false, upgrade: true });
    try {
      const asked = upstream.inboxAsks();
      const t = spawnTree(stateDir);
      await t.trackStrays();
      await until(() => upstream.inboxAsks() > asked, 15_000, 'the first inbox read');
      t.w.kill('SIGKILL');
      await until(() => t.code() !== undefined, 15_000, 'the CLI to exit');
      expect(t.code()).toBe('5');
      await until(() => ORPHAN_RE.test(t.err()), 5_000, 'the orphan line');
      expect(t.err()).not.toMatch(/upgrade/i);
      expect(fs.existsSync(path.join(stateDir, 'await-owner.json'))).toBe(false);
      expect(heartbeat(stateDir)).toBe('<absent>');
    } finally {
      upstream.slowInbox(undefined);
    }
  }, 45_000);

  /* AN ERROR AFTER THE STAND-DOWN is outranked (exit 5), never hidden: under
   * -v it is said on stderr, the way listener plumbing is. */
  it('an error thrown after orphaning (the in-flight 426) still exits 5, and -v reports it', async () => {
    const stateDir = tmp('sparrow-orphan-state-');
    upstream.slowInbox({ delayMs: 2500, item: false, upgrade: true });
    try {
      const asked = upstream.inboxAsks();
      const t = spawnTree(stateDir, { args: '-v' });
      await t.trackStrays();
      await until(() => upstream.inboxAsks() > asked, 15_000, 'the first inbox read');
      t.w.kill('SIGKILL');
      await until(() => t.code() !== undefined, 15_000, 'the CLI to exit');
      expect(t.code()).toBe('5');
      await until(() => ORPHAN_RE.test(t.err()), 5_000, 'the orphan line');
      expect(t.err()).toMatch(/^\[await\] error after standing down: .*too old/m);
      // …reported BEFORE the stand-down line.
      expect(t.err().indexOf('error after standing down')).toBeLessThan(t.err().search(ORPHAN_RE));
    } finally {
      upstream.slowInbox(undefined);
    }
  }, 45_000);

  /* ORPHANED DURING THE TURN MARK: the wake line is out and the hand-off is
   * planting its presence mark when the session goes. Exit 0 would tell a
   * harness "handled"; there is no session to hand off to — exit 5. */
  it('orphaned during the hand-off presence mark: no hand-off, exits 5 with the stamp', async () => {
    const stateDir = tmp('sparrow-orphan-state-');
    upstream.slowInbox({ delayMs: 0, item: true }); // work is waiting at once
    upstream.holdPresence(true);
    try {
      const parkedBefore = upstream.presenceParked();
      const t = spawnTree(stateDir);
      await t.trackStrays();
      await until(() => upstream.presenceParked() > parkedBefore, 15_000, 'the turn mark in flight');
      expect(t.out()).toContain('await.item'); // the wake line is out
      const rec = owner(stateDir);
      strays.push(rec.pid as number);
      t.w.kill('SIGKILL');
      await nap(500); // several 100 ms ticks: the orphan is declared mid-POST
      upstream.holdPresence(false);
      await until(() => t.code() !== undefined, 15_000, 'the CLI to exit');
      expect(t.code()).toBe('5');
      expect(heartbeat(stateDir)).toBe(`orphaned ${rec.nonce as string}`);
      await until(() => ORPHAN_RE.test(t.err()), 5_000, 'the orphan line');
    } finally {
      upstream.holdPresence(false);
      upstream.slowInbox(undefined);
    }
  }, 45_000);

  /* ORPHANED WHILE THE SESSION IS STILL ALIVE: the listener was reparented
   * away (ancestry `no`) but Claude Code is running — mid-turn, with the
   * `working` / `blocked — needs your input` note its hooks just posted. Those
   * are not ours to erase: stamp, presence, line, exit 5 — no idle posts. */
  it('orphaned while the session is ALIVE: stamps and leaves, but posts no idle', async () => {
    const stateDir = tmp('sparrow-orphan-state-');
    const statusBefore = upstream.statusPosts().length;
    const presenceBefore = upstream.presencePosts().length;
    const t = spawnTree(stateDir, { harnessOutlivesReporter: true });
    await t.trackStrays();
    await until(() => fs.existsSync(path.join(stateDir, 'await-owner.json')));
    const rec = owner(stateDir);
    strays.push(rec.pid as number);
    expect(rec.harnessPid).toBe(t.w.pid);
    await until(() => /^await /.test(heartbeat(stateDir)), 5_000, 'the live claim');

    process.kill(t.rpid(), 'SIGKILL'); // R dies: the CLI is reparented away from W…
    await until(() => ORPHAN_RE.test(t.err()), 10_000, 'the orphan line');
    expect(t.w.exitCode).toBeNull(); // …and W, the "session", is still running
    await until(() => {
      try {
        process.kill(rec.pid as number, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000, 'the CLI to exit');

    expect(ORPHAN_RE.exec(t.err())?.[1]).toBe(String(t.w.pid));
    expect(heartbeat(stateDir)).toBe(`orphaned ${rec.nonce as string}`);
    expect(upstream.statusPosts().slice(statusBefore)).toEqual([]);
    expect(upstream.presencePosts().slice(presenceBefore)).toContainEqual({ ttlSeconds: 0 });
  }, 45_000);

  /* STANDING BY BEHIND A USAGE LIMIT (a blocked marker stands) when the human
   * closes the window. Two rules: the nap must end at once (not after the 30 s
   * standby cadence), and the `blocked — usage limit` note the human needs must
   * NOT be overwritten with idle — only presence is cleared, as the hook's
   * blocked gate does. */
  it('orphaned while standing by: exits within a tick, posts no idle, keeps presence cleared', async () => {
    const stateDir = tmp('sparrow-orphan-state-');
    fs.mkdirSync(path.join(stateDir, 'blocked'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'blocked', 'marker.json'),
      `${JSON.stringify({ version: 1, reason: 'rate_limit', at: new Date().toISOString() })}\n`,
    );
    const statusBefore = upstream.statusPosts().length;
    const presenceBefore = upstream.presencePosts().length;
    const t = spawnTree(stateDir); // default 30 s standby cadence: NOT overridden
    await t.trackStrays();
    await until(() => heartbeat(stateDir).startsWith('blocked:'), 15_000, 'standby');
    const rec = owner(stateDir);
    strays.push(rec.pid as number);
    expect(rec.harnessPid).toBe(t.w.pid);

    const t0 = Date.now();
    t.w.kill('SIGKILL');
    await until(() => t.code() !== undefined, 10_000, 'the CLI to exit');
    expect(Date.now() - t0).toBeLessThan(5_000); // a tick (100 ms) + exit, never the 30 s nap

    expect(t.code()).toBe('5');
    expect(heartbeat(stateDir)).toBe(`orphaned ${rec.nonce as string}`);
    await until(() => ORPHAN_RE.test(t.err()), 5_000, 'the orphan line');
    expect(upstream.statusPosts().slice(statusBefore)).toEqual([]); // the blocked note stands
    expect(upstream.presencePosts().slice(presenceBefore)).toContainEqual({ ttlSeconds: 0 });
  }, 45_000);

  /* ORPHANED DURING THE PRE-STREAM LOOK. The first inbox read is a round trip;
   * a session that dies inside it must not get a wake line (nobody reads it),
   * and the listener must not publish a generation on the way out and fall
   * into the SUPERSEDED path (exit 4). Exit 5, and nothing claimed. */
  it('orphaned while the first inbox read is in flight: exit 5, no wake, nothing claimed', async () => {
    const stateDir = tmp('sparrow-orphan-state-');
    const work = tmp('sparrow-orphan-work-');
    const codeFile = path.join(work, 'code');
    const rpidFile = path.join(work, 'rpid');
    upstream.slowInbox({ delayMs: 2500, item: true });
    try {
      const asked = upstream.inboxAsks();
      const inner = 'echo $$ > "$RPID"; "$NODE" "$BIN" await; echo $? > "$CODE"';
      const w = spawn('sh', ['-c', `CLAUDECODE=1 CLAUDE_PID=$$ sh -c '${inner}' & wait`], {
        env: { ...baseEnv(stateDir), NODE: process.execPath, BIN, RPID: rpidFile, CODE: codeFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      kids.push(w);
      let out = '';
      let err = '';
      w.stdout.on('data', (d: Buffer) => (out += d.toString()));
      w.stderr.on('data', (d: Buffer) => (err += d.toString()));
      await until(() => fs.existsSync(rpidFile));
      strays.push(Number(fs.readFileSync(rpidFile, 'utf8').trim()));
      await until(() => upstream.inboxAsks() > asked, 15_000, 'the first inbox read');

      w.kill('SIGKILL'); // …while that read is still parked upstream

      await until(
        () => fs.existsSync(codeFile) && fs.readFileSync(codeFile, 'utf8').trim() !== '',
        15_000,
        'the CLI to exit',
      );
      expect(fs.readFileSync(codeFile, 'utf8').trim()).toBe('5');
      await until(() => ORPHAN_RE.test(err), 5_000, 'the orphan line');
      expect(err).not.toMatch(/superseded/);
      expect(out).toBe(''); // no wake line for a session that is gone
      expect(fs.existsSync(path.join(stateDir, 'await-owner.json'))).toBe(false);
      expect(heartbeat(stateDir)).toBe('<absent>');
    } finally {
      upstream.slowInbox(undefined);
    }
  }, 45_000);

  it('stamps `orphaned <nonce>`, clears status + presence, and exits 5', async () => {
    const stateDir = tmp('sparrow-orphan-state-');
    const work = tmp('sparrow-orphan-work-');
    const codeFile = path.join(work, 'code');
    const rpidFile = path.join(work, 'rpid');
    const before = upstream.sseConns();
    const statusBefore = upstream.statusPosts().length;
    const presenceBefore = upstream.presencePosts().length;

    /* THE TREE:  test ─ W (the "harness", CLAUDE_PID=$$) ─ R (reporter) ─ CLI.
     * W is killed; R survives it and records the CLI's exit status, which only
     * a parent can observe. */
    const inner = 'echo $$ > "$RPID"; "$NODE" "$BIN" await; echo $? > "$CODE"';
    const w = spawn('sh', ['-c', `CLAUDECODE=1 CLAUDE_PID=$$ sh -c '${inner}' & wait`], {
      env: { ...baseEnv(stateDir), NODE: process.execPath, BIN, RPID: rpidFile, CODE: codeFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    kids.push(w);
    let err = '';
    w.stderr.on('data', (d: Buffer) => (err += d.toString()));
    w.stdout.resume();

    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    await until(() => fs.existsSync(path.join(stateDir, 'await-owner.json')));
    await until(() => fs.existsSync(rpidFile));
    strays.push(Number(fs.readFileSync(rpidFile, 'utf8').trim()));
    const rec = owner(stateDir);
    strays.push(rec.pid as number);
    expect(rec.harnessPid).toBe(w.pid);
    await until(() => /^await /.test(heartbeat(stateDir)), 5_000, 'the live claim');
    await nap(400); // still owned: nothing has happened yet
    expect(fs.existsSync(codeFile)).toBe(false);

    w.kill('SIGKILL');
    await until(() => fs.existsSync(codeFile) && fs.readFileSync(codeFile, 'utf8').trim() !== '', 15_000, 'the CLI to exit');

    expect(fs.readFileSync(codeFile, 'utf8').trim()).toBe('5');
    expect(heartbeat(stateDir)).toBe(`orphaned ${rec.nonce as string}`);
    await until(() => ORPHAN_RE.test(err), 5_000, 'the orphan line');
    expect(ORPHAN_RE.exec(err)?.[1]).toBe(String(w.pid));

    // Idle posted to every live room of the profile — never the archived one.
    const posts = upstream.statusPosts().slice(statusBefore);
    expect(posts.map((p) => p.room).sort()).toEqual(['room_a', 'room_b']);
    for (const p of posts) expect(p.body.state).toBe('idle');
    // …and the presence mark cleared.
    expect(upstream.presencePosts().slice(presenceBefore)).toContainEqual({ ttlSeconds: 0 });
  }, 45_000);
});
