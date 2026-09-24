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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  let conns = 0;
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
        json(res, { onlineUntil: new Date(Date.now() + 60_000).toISOString() });
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
  it('refuses with exit 5 and one line, and writes nothing to the state dir', async () => {
    // pid 1 is alive and is never counted as an ancestor.
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: '1' });
    const { code } = await l.ended;
    expect(code).toBe(5);
    expect(l.stderr()).toMatch(REFUSAL_RE);
    expect(REFUSAL_RE.exec(l.stderr())?.[1]).toBe('1');
    expect(l.stderr().trim().split('\n')).toHaveLength(1);
    expect(l.stdout()).toBe('');
    const left = fs.existsSync(l.stateDir) ? fs.readdirSync(l.stateDir) : [];
    expect(left.filter((f) => /heartbeat|await-owner|candidate/.test(f))).toEqual([]);
  }, 30_000);

  it('--allow-unowned arms anyway', async () => {
    const before = upstream.sseConns();
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: '1' }, ['--allow-unowned']);
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    await until(() => fs.existsSync(path.join(l.stateDir, 'await-owner.json')));
    expect(l.stderr()).not.toMatch(REFUSAL_RE);
    // …and it is NOT monitored: pid 1 stays "not an ancestor" on every tick.
    await nap(600);
    expect(l.kid.exitCode).toBeNull();
    expect(heartbeat(l.stateDir)).toMatch(/^await /);
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

  it('a harness pid that is already dead is not judged (it may live in another pid namespace)', async () => {
    const dead = spawn('true', [], { stdio: 'ignore' });
    const deadPid = dead.pid!;
    await new Promise((r) => dead.once('exit', r));
    const before = upstream.sseConns();
    const l = spawnAwait({ CLAUDECODE: '1', CLAUDE_PID: String(deadPid) });
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    await nap(600);
    expect(l.kid.exitCode).toBeNull();
    l.kid.kill('SIGTERM');
    expect((await l.ended).code).toBe(143);
  }, 30_000);

  it('outside Claude Code nothing is checked', async () => {
    const before = upstream.sseConns();
    const l = spawnAwait({ CLAUDE_PID: '1' }); // no CLAUDECODE
    await until(() => upstream.sseConns() > before, 15_000, 'the stream to open');
    l.kid.kill('SIGTERM');
    expect((await l.ended).code).toBe(143);
  }, 30_000);
});

/* ------------------------------- orphaned -------------------------------- */

describe('sparrow await — the session that armed it goes away', () => {
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
