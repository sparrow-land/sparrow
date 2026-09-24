/**
 * Behavioral test for the shipped auto-status shell hook, exercised through a
 * real POSIX `sh` in an isolated HOME/state dir with a stub `curl` on PATH that
 * RECORDS every request (method + url + body) and answers `GET /me/rooms`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { awaitCommand } from './listener.js';

const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'hooks');
const SCRIPT = path.join(HOOKS_DIR, 'sparrow-auto-status.sh');

let stateDir: string;
let home: string;
let stubBin: string;
let curlLog: string;

/** Two active rooms + one archived (must be skipped). */
const ROOMS_JSON = JSON.stringify({
  items: [
    { room: { id: 'rom_a', name: 'A', orgId: 'org_1', kind: 'dm', archivedAt: null }, memberId: 'mem_a', roomRole: 'member' },
    { room: { id: 'rom_b', name: 'B', orgId: 'org_1', kind: 'project', archivedAt: null }, memberId: 'mem_b', roomRole: 'member' },
    { room: { id: 'rom_z', name: 'Z', orgId: 'org_1', kind: 'project', archivedAt: '2026-01-01T00:00:00Z' }, memberId: 'mem_z', roomRole: 'member' },
  ],
});

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-state-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-home-'));
  stubBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-bin-'));
  curlLog = path.join(stubBin, 'curl.log');
});

afterEach(() => {
  for (const d of [stateDir, home, stubBin]) fs.rmSync(d, { recursive: true, force: true });
});

function writeLoopState(state: string): void {
  fs.writeFileSync(path.join(stateDir, 'loop-state'), `${state}\n`);
}

/**
 * A heartbeat whose CONTENT is what a listener claimed (`await` while alive,
 * `killed:SIGTERM` / `stopped:SIGINT` on its way out) and whose mtime is
 * `ageSeconds` in the past.
 */
function writeHeartbeat(content: string, ageSeconds = 2): void {
  const f = path.join(stateDir, 'heartbeat');
  fs.writeFileSync(f, content ? `${content}\n` : '');
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(f, when, when);
}

/** Install a stub `curl` that logs each call and answers GET /me/rooms. */
function stubCurl({ fail = false }: { fail?: boolean } = {}): void {
  const body = fail
    ? '#!/bin/sh\nexit 22\n'
    : `#!/bin/sh
method=GET
url=
data=
prev=
for a in "$@"; do
  case "$a" in http://*|https://*) url=$a ;; esac
  if [ "$prev" = "-d" ]; then data=$a; fi
  prev=$a
done
case " $* " in *" -X POST "*) method=POST ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms) printf '%s' "$ROOMS_JSON" ;;
esac
exit 0
`;
  const p = path.join(stubBin, 'curl');
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

interface Run {
  stdout: string;
  code: number;
}

function runHook(mode: string, input = '{}', extraEnv: Record<string, string> = {}): Run {
  const env: Record<string, string> = {
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: home,
    SPARROW_STATE_DIR: stateDir,
    CURL_LOG: curlLog,
    ROOMS_JSON,
    SPARROW_SERVER: 'https://example.test',
    SPARROW_TOKEN: 'agk_test',
    ...extraEnv,
  };
  try {
    const stdout = execFileSync('sh', [SCRIPT, mode], { input, env, encoding: 'utf8' });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? '', code: e.status ?? 1 };
  }
}

/** Parsed curl log lines: "METHOD URL BODY". */
function log(): { method: string; url: string; body: string }[] {
  if (!fs.existsSync(curlLog)) return [];
  return fs
    .readFileSync(curlLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [method, url, ...rest] = l.split(' ');
      return { method: method!, url: url!, body: rest.join(' ') };
    });
}


/** Wait for a child to exit — resolving at once if it already has (the `exit`
 * event fires once, so attaching late would hang forever). */
function waitExit(child: { exitCode: number | null; once: (e: string, f: () => void) => unknown }): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

const statusPosts = () => log().filter((e) => e.method === 'POST' && /\/rooms\/[^/]+\/status$/.test(e.url));
const presencePosts = () => log().filter((e) => e.method === 'POST' && /\/me\/presence$/.test(e.url));

/* --- the pending record ----------------------------------------------------
 * Every mutation leaves ONE immutable, uniquely named file under
 * `auto-status-pending.d/`, and a publisher acknowledges exactly the names it
 * snapshotted. `pendingCount` counts records in EITHER layout — the directory
 * and the single-token file a pre-upgrade install leaves behind — so a test
 * that asserts "the record survived" means the same thing before and after the
 * migration, and cannot pass merely because the old path moved. */
const PENDING_DIR = () => path.join(stateDir, 'auto-status-pending.d');
const PENDING_LEGACY = () => path.join(stateDir, 'auto-status-pending');
const pendingNames = (): string[] =>
  fs.existsSync(PENDING_DIR()) ? fs.readdirSync(PENDING_DIR()).sort() : [];
const pendingCount = (): number => pendingNames().length + (fs.existsSync(PENDING_LEGACY()) ? 1 : 0);
/** Stamp one marker exactly as another hook's `mark_pending` would. */
function stampPending(name: string): void {
  fs.mkdirSync(PENDING_DIR(), { recursive: true });
  fs.writeFileSync(path.join(PENDING_DIR(), name), '');
}
/** The durable "this turn ended, idle is owed" flag (NOT the resume marker). */
const IDLE_OWED = () => path.join(stateDir, 'auto-status-idle-owed');
const NOTE_STAMP = () => path.join(stateDir, 'auto-status-note');

describe('sparrow-auto-status.sh — prompt mode', () => {
  it('sets a TTL-bounded (not sticky) working status in every non-archived room', () => {
    writeLoopState('engaged');
    writeHeartbeat('await'); // a live listener → no nudge on stdout
    stubCurl();
    const r = runHook('prompt', '{"prompt":"do the thing"}');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(''); // never pollute stdout
    const posts = statusPosts();
    const urls = posts.map((p) => p.url);
    expect(urls).toContain('https://example.test/api/v1/rooms/rom_a/status');
    expect(urls).toContain('https://example.test/api/v1/rooms/rom_b/status');
    expect(urls.some((u) => u.includes('rom_z'))).toBe(false); // archived skipped
    for (const p of posts) {
      expect(p.body).toContain('"state":"working"');
      expect(p.body).toContain('"ttlSeconds":600');
      expect(p.body).not.toContain('"sticky"');
    }
  });

  it('uses the generic "working" note by default (no prompt leakage)', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('prompt', '{"prompt":"my secret private prompt text"}');
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.body).toContain('"note":"working"');
      expect(p.body).not.toContain('secret');
    }
  });

  it('derives a short note from the prompt only when SPARROW_STATUS_NOTES=verbose', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('prompt', '{"prompt":"refactor the billing module carefully"}', {
      SPARROW_STATUS_NOTES: 'verbose',
    });
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0]!.body).toContain('refactor the billing module');
  });

  it('also heartbeats presence', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(presencePosts().length).toBe(1);
  });
});

describe('sparrow-auto-status.sh — stop mode', () => {
  it('sets idle in every non-archived room', () => {
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('stop');
    expect(r.code).toBe(0);
    const posts = statusPosts();
    const urls = posts.map((p) => p.url);
    expect(urls).toContain('https://example.test/api/v1/rooms/rom_a/status');
    expect(urls).toContain('https://example.test/api/v1/rooms/rom_b/status');
    for (const p of posts) expect(p.body).toContain('"state":"idle"');
  });
});

/**
 * The Notification hook fires for EVERY Claude Code notification type, not just
 * the ones that mean "a human is being asked something". Claude Code emits
 * `idle_prompt` ~60s after a turn ends when nobody has typed — and the old hook
 * turned that into a sticky "working / blocked — needs your input" that then
 * never cleared, so idle agents advertised themselves as blocked forever.
 * The mode now switches on `notification_type`: prompts → blocked, idle_prompt
 * → idle, everything else (including a missing type) → no-op.
 */
function notify(type: string | null, extra = ''): string {
  const t = type === null ? '' : `"notification_type":"${type}",`;
  return `{"session_id":"ses_1","hook_event_name":"Notification",${t}"cwd":"/tmp","permission_mode":"default","notification_data":{}${extra}}`;
}

describe('sparrow-auto-status.sh — notification mode', () => {
  for (const type of [
    'permission_prompt',
    'elicitation_dialog',
    'elicitation_url_dialog',
    'agent_needs_input',
  ]) {
    it(`sets a sticky working "blocked" status for ${type}`, () => {
      writeLoopState('engaged');
      stubCurl();
      runHook('notification', notify(type));
      const posts = statusPosts();
      expect(posts.length).toBeGreaterThan(0);
      for (const p of posts) {
        expect(p.body).toContain('"state":"working"');
        expect(p.body).toContain('"sticky":true');
        expect(p.body).toMatch(/blocked/);
      }
      expect(presencePosts().length).toBe(1);
    });
  }

  it('tolerates whitespace around the notification_type value', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', '{"hook_event_name":"Notification","notification_type" : "permission_prompt"}');
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p.body).toMatch(/blocked/);
  });

  it('an idle_prompt means the agent is NOT working: it posts idle, not blocked', () => {
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('notification', notify('idle_prompt'));
    expect(r.code).toBe(0);
    const posts = statusPosts();
    const urls = posts.map((p) => p.url);
    expect(urls).toContain('https://example.test/api/v1/rooms/rom_a/status');
    expect(urls).toContain('https://example.test/api/v1/rooms/rom_b/status');
    expect(urls.some((u) => u.includes('rom_z'))).toBe(false); // archived skipped
    for (const p of posts) {
      expect(p.body).toContain('"state":"idle"');
      expect(p.body).not.toMatch(/blocked/);
      expect(p.body).not.toContain('"working"');
    }
    // Not working → do not claim liveness with a presence heartbeat.
    expect(presencePosts().length).toBe(0);
  });

  it('idle_prompt leaves the resume marker in place so the next turn restores working', () => {
    writeLoopState('engaged');
    stubCurl();
    const marker = path.join(stateDir, 'auto-status-idle');

    // Marker already left by the Stop hook: idle_prompt must NOT consume it.
    runHook('stop');
    expect(fs.existsSync(marker)).toBe(true);
    runHook('notification', notify('idle_prompt'));
    expect(fs.existsSync(marker)).toBe(true);

    // ...and the next tool call still restores (TTL-bounded) working.
    const before = statusPosts().length;
    runHook('post-tool');
    const working = statusPosts().slice(before);
    expect(working.length).toBe(2);
    for (const p of working) {
      expect(p.body).toContain('"state":"working"');
      expect(p.body).toContain('"ttlSeconds":600');
    }
  });

  it('creates the resume marker when idle_prompt arrives without one', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('idle_prompt'));
    expect(fs.existsSync(path.join(stateDir, 'auto-status-idle'))).toBe(true);
  });

  // `quota_auto_resume_*` used to live here; it is handled now (see the
  // quota auto-resume describe below). Everything still unknown stays a no-op.
  for (const type of ['auth_success', 'elicitation_complete', 'brand_new_type']) {
    it(`is a no-op for ${type}`, () => {
      writeLoopState('engaged');
      stubCurl();
      const r = runHook('notification', notify(type));
      expect(r.code).toBe(0);
      expect(statusPosts()).toHaveLength(0);
      expect(presencePosts()).toHaveLength(0);
    });
  }

  it('is a no-op when notification_type is missing entirely', () => {
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('notification', notify(null));
    expect(r.code).toBe(0);
    expect(statusPosts()).toHaveLength(0);
    expect(presencePosts()).toHaveLength(0);
  });
});

describe('sparrow-auto-status.sh — post-tool mode', () => {
  it('refreshes presence but writes NO status', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('post-tool');
    expect(presencePosts().length).toBe(1);
    expect(statusPosts().length).toBe(0);
  });

  it('throttles: two rapid calls produce a single presence refresh', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('post-tool');
    runHook('post-tool');
    expect(presencePosts().length).toBe(1);
  });
});

/**
 * The autonomous-turn gap: `working` used to be set only on UserPromptSubmit,
 * so a session re-invoked by a monitor event or task notification (no prompt!)
 * ran its whole turn under the Stop hook's `idle` — agents doing real work read
 * as idle fleet-wide. The fix is a marker handshake: `stop` leaves a marker,
 * and the FIRST post-tool of the next turn restores `working`.
 */
describe('sparrow-auto-status.sh — idle→working resume handshake', () => {
  it('stop leaves a marker; the next post-tool restores TTL-bounded working and clears it', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop');
    expect(fs.existsSync(path.join(stateDir, 'auto-status-idle'))).toBe(true);

    runHook('post-tool');
    const posts = statusPosts();
    // idle (from stop) + one working restore per active room.
    const working = posts.filter((p) => p.body.includes('"working"'));
    expect(working.length).toBe(2); // rom_a + rom_b, never archived rom_z
    for (const p of working) expect(p.body).toMatch(/"ttlSeconds":600/);
    expect(fs.existsSync(path.join(stateDir, 'auto-status-idle'))).toBe(false);

    // The restore is once per stop: another post-tool writes no further status.
    runHook('post-tool');
    expect(statusPosts().length).toBe(posts.length);
  });

  it('a real prompt consumes the marker itself — no double-set from post-tool', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop');
    runHook('prompt', '{"prompt":"go"}');
    expect(fs.existsSync(path.join(stateDir, 'auto-status-idle'))).toBe(false);
    const before = statusPosts().length;
    runHook('post-tool');
    expect(statusPosts().length).toBe(before); // presence only
  });
});

describe('sparrow-auto-status.sh — guards', () => {
  it('writes nothing when paused', () => {
    writeLoopState('paused');
    stubCurl();
    const r = runHook('prompt', '{"prompt":"x"}');
    expect(r.code).toBe(0);
    expect(log()).toHaveLength(0);
  });

  it('writes nothing when loop-state is absent', () => {
    stubCurl();
    runHook('prompt', '{"prompt":"x"}');
    expect(log()).toHaveLength(0);
  });

  it('exits 0 silently when the server is down', () => {
    writeLoopState('engaged');
    writeHeartbeat('await'); // a live listener → nothing to nudge about
    stubCurl({ fail: true });
    const r = runHook('prompt', '{"prompt":"x"}');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits 0 silently with no credentials', () => {
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('prompt', '{"prompt":"x"}', { SPARROW_SERVER: '', SPARROW_TOKEN: '' });
    expect(r.code).toBe(0);
    // No creds → no room fan-out, no presence.
    expect(statusPosts()).toHaveLength(0);
  });
});

/**
 * THE RE-ARM NUDGE (prompt mode only).
 *
 * When a human interrupts a Claude Code session, the harness kills the process
 * tree — including the tracked background `sparrow await` that is the agent's
 * ONLY wake path. Nothing in the next turn told the agent about it: the Stop
 * hook fires at the END of a turn, and the heartbeat the dead listener left
 * behind still looked fresh. Three production sessions ended deaf and silent
 * in one day.
 *
 * A UserPromptSubmit hook's stdout IS injected into the agent's context, so
 * this is the one place where a hook can speak at the START of the turn that
 * can still fix it. One plain-text line, never JSON — and never a word in any
 * other mode, where stdout is a decision channel.
 */
describe('sparrow-auto-status.sh — prompt-mode re-arm nudge', () => {
  const NUDGE = /^Sparrow: your listener /;

  it('names a killed listener and its signal, and prescribes the re-arm', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM', 3); // FRESH — freshness must not save it
    stubCurl();
    const r = runHook('prompt', '{"prompt":"go"}');
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1); // exactly ONE line
    expect(lines[0]).toMatch(NUDGE);
    expect(lines[0]).toMatch(/was killed \(SIGTERM -- usually a session interrupt\)/);
    // Unbounded await — the CLI owns its own liveness, so the nudge no longer
    // hands back a command that burns a turn every 15 minutes.
    expect(lines[0]).toContain('sparrow await');
    expect(lines[0]).not.toContain('--timeout 900');
    expect(lines[0]).toContain('sparrow skill pause');
  });

  it('stays silent for a fresh LIVE claim whether or not it carries a generation tag', () => {
    writeLoopState('engaged');
    fs.writeFileSync(
      path.join(stateDir, 'await-owner.json'),
      `${JSON.stringify({ version: 1, nonce: '4f2c9a01bb33cd10', pid: 4242, startedAt: '2026-09-09T00:00:00.000Z', kind: 'await' })}\n`,
    );
    // Tagged and live, tagged and superseded, untagged: a fresh claim is never
    // a nudge — the tag must not turn one into a phantom "not running".
    for (const content of ['await 4f2c9a01bb33cd10', 'await b0b0b0b0b0b0b0b0', 'await']) {
      writeHeartbeat(content, 3);
      expect(runHook('prompt', '{"prompt":"go"}').stdout.trim()).toBe('');
    }
  });

  it('ignores a stamp left by a SUPERSEDED generation, and names a live one', () => {
    writeLoopState('engaged');
    const owner = (nonce: string): void =>
      fs.writeFileSync(
        path.join(stateDir, 'await-owner.json'),
        `${JSON.stringify({ version: 1, nonce, pid: 4242, startedAt: '2026-09-09T00:00:00.000Z', kind: 'await' })}\n`,
      );

    // The stamp names the generation that died; a NEWER one owns the state dir,
    // so this corpse says nothing about whether the agent can be woken.
    writeHeartbeat('killed:SIGTERM 4f2c9a01bb33cd10', 3);
    owner('b0b0b0b0b0b0b0b0');
    expect(runHook('prompt', '{"prompt":"go"}').stdout.trim()).toBe('');

    // Same stamp, and it IS the live generation: the nudge speaks as before.
    owner('4f2c9a01bb33cd10');
    const line = runHook('prompt', '{"prompt":"go"}').stdout.trim().split('\n')[0]!;
    expect(line).toMatch(/^Sparrow: your listener /);
    expect(line).toMatch(/was killed \(SIGTERM -- usually a session interrupt\)/);
    expect(line).not.toContain('4f2c9a01bb33cd10');
  });

  it('prescribes an unbounded await under Codex', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    const out = runHook('prompt', '{"prompt":"go"}', { CODEX_THREAD_ID: 'thread-123' }).stdout;
    expect(out).toContain('run `sparrow await`');
    expect(out).not.toContain('--timeout');
  });

  it('names SPARROW_PROFILE in the re-arm, identically to awaitCommand()', () => {
    // A shared machine: this hook is stamped with the profile it speaks for, so
    // the command it hands back must select that same store — a bare re-arm in a
    // fresh shell would arm the NEIGHBOUR who owns defaultProfile.
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    const want = awaitCommand({ profile: 'cubes-vm4-codex' });
    const out = runHook('prompt', '{"prompt":"go"}', { SPARROW_PROFILE: 'cubes-vm4-codex' }).stdout;
    expect(out).toContain(`run \`${want}\``);
    expect(out.replace(new RegExp(want, 'g'), '')).not.toContain('sparrow await');
  });

  it('stays byte-identical to the bare command when no profile is stamped', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    const out = runHook('prompt', '{"prompt":"go"}').stdout;
    expect(out).toContain(`run \`${awaitCommand()}\``);
    expect(out).not.toContain('--profile');
  });

  it('names SIGHUP too', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGHUP');
    stubCurl();
    expect(runHook('prompt', '{"prompt":"go"}').stdout).toContain('SIGHUP');
  });

  it('names an orphaned listener, whatever its age, and prescribes a tracked re-arm', () => {
    // `sparrow await` stood down: the Claude Code session that armed it is
    // gone, or it was armed as a disowned `( … & )` this session does not own.
    writeLoopState('engaged');
    fs.writeFileSync(
      path.join(stateDir, 'await-owner.json'),
      `${JSON.stringify({ version: 1, nonce: '4f2c9a01bb33cd10', pid: 4242, startedAt: '2026-09-09T00:00:00.000Z', kind: 'await' })}\n`,
    );
    stubCurl();
    for (const age of [3, 900]) {
      writeHeartbeat('orphaned 4f2c9a01bb33cd10', age);
      const lines = runHook('prompt', '{"prompt":"go"}').stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(NUDGE);
      expect(lines[0]).toContain(
        'your listener was orphaned (the Claude Code session that armed it is gone, or it was armed from a shell this session does not own)',
      );
      expect(lines[0]).toContain('run `sparrow await` as a tracked background task');
      expect(lines[0]).not.toMatch(/no listener has heartbeated/);
      expect(lines[0]).not.toContain('4f2c9a01bb33cd10');
    }
    // A superseded generation's orphaned stamp says nothing about the live one.
    writeHeartbeat('orphaned b0b0b0b0b0b0b0b0', 3);
    expect(runHook('prompt', '{"prompt":"go"}').stdout.trim()).toBe('');
  });

  it('calls a Ctrl-C stop what it is', () => {
    writeLoopState('engaged');
    writeHeartbeat('stopped:SIGINT');
    stubCurl();
    const out = runHook('prompt', '{"prompt":"go"}').stdout;
    expect(out).toMatch(/was stopped \(Ctrl-C\)/);
    expect(out).toContain('sparrow await');
    expect(out).not.toContain('--timeout 900');
  });

  it('handles the bare words with no signal suffix', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed');
    stubCurl();
    expect(runHook('prompt', '{"prompt":"go"}').stdout).toMatch(/was killed \(usually a session interrupt\)/);
    writeHeartbeat('stopped');
    expect(runHook('prompt', '{"prompt":"go"}').stdout).toMatch(/was stopped/);
  });

  it('nudges on a STALE heartbeat, saying how long nothing has beaten', () => {
    writeLoopState('engaged');
    writeHeartbeat('await', 600); // 10 min > the 120s window
    stubCurl();
    const out = runHook('prompt', '{"prompt":"go"}').stdout;
    expect(out).toMatch(/no listener has heartbeated for 10m/);
    expect(out).toContain('sparrow await');
    expect(out).not.toContain('--timeout 900');
  });

  it('nudges when there is no heartbeat at all', () => {
    writeLoopState('engaged');
    stubCurl();
    expect(runHook('prompt', '{"prompt":"go"}').stdout).toMatch(/no heartbeat at all/);
  });

  it('honors SPARROW_HEARTBEAT_MAX_AGE, exactly as the Stop hook does', () => {
    writeLoopState('engaged');
    writeHeartbeat('await', 30);
    stubCurl();
    expect(runHook('prompt', '{"prompt":"go"}', { SPARROW_HEARTBEAT_MAX_AGE: '10' }).stdout).toMatch(NUDGE);
    expect(runHook('prompt', '{"prompt":"go"}', { SPARROW_HEARTBEAT_MAX_AGE: '600' }).stdout.trim()).toBe('');
  });

  it('says NOTHING for a fresh await — the state we want', () => {
    writeLoopState('engaged');
    writeHeartbeat('await');
    stubCurl();
    expect(runHook('prompt', '{"prompt":"go"}').stdout.trim()).toBe('');
  });

  it('says nothing for a fresh watch/loop either — that is the Stop hook\'s call', () => {
    writeLoopState('engaged');
    stubCurl();
    for (const kind of ['watch', 'loop', '']) {
      writeHeartbeat(kind);
      expect(runHook('prompt', '{"prompt":"go"}').stdout.trim()).toBe('');
    }
  });

  it('still writes the working status alongside the nudge', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    const r = runHook('prompt', '{"prompt":"go"}');
    expect(r.stdout).toMatch(NUDGE);
    const posts = statusPosts();
    expect(posts.map((p) => p.url)).toContain('https://example.test/api/v1/rooms/rom_a/status');
    for (const p of posts) expect(p.body).toContain('"state":"working"');
    expect(presencePosts().length).toBe(1);
  });

  it('nudges even without credentials — a dead listener is worth saying anyway', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    const r = runHook('prompt', '{"prompt":"go"}', { SPARROW_SERVER: '', SPARROW_TOKEN: '' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(NUDGE);
    expect(statusPosts()).toHaveLength(0); // no creds, no fan-out
  });

  it('is silent when the loop is paused or absent (the sanctioned off switch)', () => {
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    expect(runHook('prompt', '{"prompt":"go"}').stdout.trim()).toBe(''); // absent
    writeLoopState('paused');
    expect(runHook('prompt', '{"prompt":"go"}').stdout.trim()).toBe('');
  });

  it('NEVER prints in any other mode — their stdout is a decision channel', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    for (const mode of ['post-tool', 'stop', 'notification']) {
      const r = runHook(mode, mode === 'notification' ? notify('permission_prompt') : '{}');
      expect(r.code, mode).toBe(0);
      expect(r.stdout.trim(), mode).toBe('');
    }
  });

  it('does not print when the mode is INFERRED as something other than prompt', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    const r = runHook('', '{"hook_event_name":"PostToolUse"}');
    expect(r.stdout.trim()).toBe('');
  });

  it('prints when the mode is INFERRED from a UserPromptSubmit event', () => {
    writeLoopState('engaged');
    writeHeartbeat('killed:SIGTERM');
    stubCurl();
    const r = runHook('', '{"hook_event_name":"UserPromptSubmit","prompt":"go"}');
    expect(r.stdout).toMatch(NUDGE);
  });
});

/**
 * WHOSE credentials the status fan-out speaks with — the same resolution ladder
 * as the Stop hook (env → `SPARROW_PROFILE` → `defaultProfile`), because a
 * project-scope install stamps `SPARROW_PROFILE` into every hook command so a
 * hook always acts as the agent that installed it. A named-but-missing profile
 * resolves to NOTHING: posting somebody else's working status is worse than
 * posting none.
 */
describe('sparrow-auto-status.sh — credential profile resolution', () => {
  let xdg: string;

  function writeCreds(creds: unknown): void {
    fs.mkdirSync(path.join(xdg, 'sparrow'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'sparrow', 'credentials.json'), JSON.stringify(creds));
  }

  beforeEach(() => {
    xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-xdg-'));
    writeCreds({
      profiles: {
        alpha: { server: 'https://alpha.test', token: 'agk_alpha', kind: 'agent' },
        beta: { server: 'https://beta.test', token: 'agk_beta', kind: 'agent' },
      },
      defaultProfile: 'beta',
    });
    writeLoopState('engaged');
    writeHeartbeat('await');
    stubCurl();
  });
  afterEach(() => fs.rmSync(xdg, { recursive: true, force: true }));

  /** Run with NO server/token in the env, so the credential store is consulted. */
  const runNoEnvCreds = (extra: Record<string, string> = {}): Run =>
    runHook('prompt', '{"prompt":"hi"}', {
      SPARROW_SERVER: '',
      SPARROW_TOKEN: '',
      XDG_CONFIG_HOME: xdg,
      ...extra,
    });

  it('falls back to the default profile when none is named', () => {
    expect(runNoEnvCreds().code).toBe(0);
    expect(statusPosts().map((p) => p.url)).toContain('https://beta.test/api/v1/rooms/rom_a/status');
  });

  it('uses the profile named by SPARROW_PROFILE, not the default', () => {
    expect(runNoEnvCreds({ SPARROW_PROFILE: 'alpha' }).code).toBe(0);
    const urls = statusPosts().map((p) => p.url);
    expect(urls).toContain('https://alpha.test/api/v1/rooms/rom_a/status');
    expect(urls.some((u) => u.includes('beta.test'))).toBe(false);
  });

  it('stays silent for a named-but-missing profile (never acts as the default)', () => {
    const r = runNoEnvCreds({ SPARROW_PROFILE: 'gamma' });
    expect(r.code).toBe(0);
    expect(statusPosts()).toEqual([]);
    expect(presencePosts()).toEqual([]);
  });

  it('env SPARROW_SERVER/SPARROW_TOKEN still win over the named profile', () => {
    const r = runHook('prompt', '{"prompt":"hi"}', {
      XDG_CONFIG_HOME: xdg,
      SPARROW_PROFILE: 'alpha',
    });
    expect(r.code).toBe(0);
    expect(statusPosts().map((p) => p.url)).toContain(
      'https://example.test/api/v1/rooms/rom_a/status',
    );
  });
});

/* =============================== USAGE LIMITS =============================== *
 * THE SILENT FAILURE (Jake, 2026-09-17). When a Claude Code session hits its
 * usage limit the agent looks perfectly ONLINE — the background `sparrow await`
 * still holds the stream, presence stays green — while every wake dies on the
 * limit and no turn ever runs. Nobody is told, in either direction.
 *
 * Claude Code fires `StopFailure` (NOT the plain `Stop` hook) when a turn ends
 * on an API error, naming it in `error_type`. Some of those errors mean "this
 * agent cannot run until something changes" and are worth saying out loud; the
 * rest are retried by Claude Code, or are the agent's own bug, and must stay
 * silent — a sticky status is expensive to get wrong.
 *
 * The marker protocol is the interesting part, and it is deliberately
 * paranoid: one FILE per block under `<state dir>/blocked/`, cleared only by
 * name from a snapshot, and only on EVIDENCE — a successful assistant turn in
 * the transcript after that marker was written. Prompt ids cannot order
 * anything (a delayed PostToolUse from prompt A differs from a newer marker for
 * prompt B exactly as much as a genuinely older one does), and a marker's age
 * is not evidence quota came back, so nothing expires.
 * ========================================================================== */
const BLOCKED_DIR = () => path.join(stateDir, 'blocked');
const markerFiles = (): string[] =>
  fs.existsSync(BLOCKED_DIR()) ? fs.readdirSync(BLOCKED_DIR()).filter((f) => f.endsWith('.json')).sort() : [];
const markers = (): Record<string, unknown>[] =>
  markerFiles().map((f) => JSON.parse(fs.readFileSync(path.join(BLOCKED_DIR(), f), 'utf8')) as Record<string, unknown>);

function stopFailure(errorType: string | null, extra = ''): string {
  const e = errorType === null ? '' : `"error_type":"${errorType}","error_message":"You've reached your limit.",`;
  return (
    `{"session_id":"ses_1","prompt_id":"pr_1","hook_event_name":"StopFailure",${e}` +
    `"transcript_path":"${path.join(stateDir, 'transcript.jsonl')}","cwd":"/tmp","permission_mode":"default"${extra}}`
  );
}

/** Append raw JSONL entries (exact ISO strings) to the session transcript. */
function writeTranscriptRaw(entries: { type: string; iso: string; apiError?: boolean }[]): string {
  const p = path.join(stateDir, 'transcript.jsonl');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    p,
    entries
      .map((e) =>
        JSON.stringify({
          type: e.type,
          timestamp: e.iso,
          ...(e.apiError ? { isApiErrorMessage: true, error: 'rate_limit' } : {}),
          message: { role: e.type, content: 'text we must never read' },
        }),
      )
      .join('\n') + '\n',
  );
  return p;
}

/** Write a JSONL transcript of `{type,timestamp,isApiErrorMessage}` entries. */
function writeTranscript(entries: { type: string; at: Date; apiError?: boolean }[]): string {
  const p = path.join(stateDir, 'transcript.jsonl');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    p,
    entries
      .map((e) =>
        JSON.stringify({
          type: e.type,
          timestamp: e.at.toISOString(),
          ...(e.apiError ? { isApiErrorMessage: true, error: 'rate_limit' } : {}),
          message: { role: e.type, content: 'text we must never read' },
        }),
      )
      .join('\n') + '\n',
  );
  return p;
}

/** Write a marker by hand, as StopFailure would have. */
function writeMarker(name: string, fields: Record<string, unknown>): string {
  fs.mkdirSync(BLOCKED_DIR(), { recursive: true });
  const f = path.join(BLOCKED_DIR(), name);
  fs.writeFileSync(f, JSON.stringify({ version: 1, reason: 'rate_limit', ...fields }));
  return f;
}

describe('sparrow-auto-status.sh — stop-failure mode', () => {
  const BLOCKING = [
    'rate_limit',
    'billing_error',
    'authentication_failed',
    'account_on_hold',
    'oauth_org_not_allowed',
    'cloud_credential_error',
  ];
  const RETRIED = ['overloaded', 'server_error', 'max_output_tokens', 'invalid_request', 'model_not_found', 'unknown'];

  it('records a marker and posts a usage-limit status for rate_limit', () => {
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('stop-failure', stopFailure('rate_limit'));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(''); // StopFailure output is discarded; write none
    expect(markers()).toHaveLength(1);
    const rec = markers()[0]!;
    expect(rec.version).toBe(1);
    expect(rec.reason).toBe('rate_limit');
    expect(rec.session).toBe('ses_1');
    expect(rec.prompt).toBe('pr_1');
    expect(new Date(rec.at as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.body).toContain('"state":"working"');
      expect(p.body).toContain('"sticky":true');
      expect(p.body).toContain('blocked — usage limit reached');
    }
  });

  it('accepts the older `error` spelling as a fallback', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', '{"session_id":"ses_1","hook_event_name":"StopFailure","error":"rate_limit"}');
    expect(markers()[0]!.reason).toBe('rate_limit');
  });

  it('names the reason for the other blocking errors', () => {
    for (const error of BLOCKING.filter((e) => e !== 'rate_limit')) {
      fs.rmSync(curlLog, { force: true });
      fs.rmSync(BLOCKED_DIR(), { recursive: true, force: true });
      writeLoopState('engaged');
      stubCurl();
      runHook('stop-failure', stopFailure(error));
      expect(markers()[0]!.reason).toBe(error);
      expect(statusPosts()[0]!.body).toContain(`blocked — ${error}`);
    }
  });

  it('appends the reset time if a payload ever carries one', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit', ',"resets_at":"2026-09-17T14:30:00Z"'));
    expect(markers()[0]!.resumesAt).toBe('2026-09-17T14:30:00Z');
    expect(statusPosts()[0]!.body).toMatch(/blocked — usage limit reached; resumes \d\d:\d\d/);
  });

  it('says NOTHING for an error Claude Code retries or that is our own bug', () => {
    for (const error of RETRIED) {
      writeLoopState('engaged');
      stubCurl();
      const r = runHook('stop-failure', stopFailure(error));
      expect(r.code).toBe(0);
      expect(markerFiles()).toEqual([]);
      expect(statusPosts()).toEqual([]);
    }
  });

  it('says nothing for a payload with no error field at all', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure(null));
    expect(markerFiles()).toEqual([]);
    expect(statusPosts()).toEqual([]);
  });

  it('honours the loop switch', () => {
    writeLoopState('paused');
    stubCurl();
    expect(runHook('stop-failure', stopFailure('rate_limit')).code).toBe(0);
    expect(markerFiles()).toEqual([]);
    expect(statusPosts()).toEqual([]);
  });

  it('still records the block when the status fan-out cannot run', () => {
    // No credentials: the network half is impossible, but the local marker is
    // what the Stop hook and the next prompt read, so it must still land.
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('stop-failure', stopFailure('rate_limit'), { SPARROW_SERVER: '', SPARROW_TOKEN: '' });
    expect(r.code).toBe(0);
    expect(markers()[0]!.reason).toBe('rate_limit');
  });

  it('writes into the state dir it was pointed at, and no other', () => {
    // One limited session must not take a neighbour offline: every marker lives
    // in the SPARROW_STATE_DIR the hook command was stamped with.
    const neighbour = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-other-'));
    fs.writeFileSync(path.join(neighbour, 'loop-state'), 'engaged\n');
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit'), { SPARROW_STATE_DIR: neighbour });
    expect(markerFiles()).toEqual([]); // this dir untouched
    expect(fs.readdirSync(path.join(neighbour, 'blocked'))).toHaveLength(1);
    fs.rmSync(neighbour, { recursive: true, force: true });
  });
});

describe('sparrow-auto-status.sh — clearing a marker takes EVIDENCE', () => {
  it('removes a marker when the transcript shows a later successful turn', () => {
    writeLoopState('engaged');
    stubCurl();
    const at = new Date(Date.now() - 120_000);
    writeMarker('20260917T000000-1.json', { at: at.toISOString(), prompt: 'pr_1' });
    writeTranscript([
      { type: 'assistant', at: new Date(at.getTime() - 60_000) },
      { type: 'assistant', at: new Date(at.getTime() + 60_000) }, // after the marker
    ]);
    runHook('post-tool', stopFailure(null));
    expect(markerFiles()).toEqual([]);
  });

  /**
   * THE REVERSED-ORDER REGRESSION. A delayed PostToolUse from prompt A arrives
   * after prompt B's turn has already been rate-limited. Its prompt id differs
   * from the marker's — which is exactly what an *older* marker looks like too —
   * so id inequality must not be allowed to clear anything. The transcript says
   * what really happened: the last assistant entry is B's API error.
   */
  it('keeps a NEWER marker when the only later entry is an API error', () => {
    writeLoopState('engaged');
    stubCurl();
    const at = new Date(Date.now() - 30_000);
    writeMarker('20260917T000100-2.json', { at: at.toISOString(), prompt: 'pr_B' });
    writeTranscript([
      { type: 'assistant', at: new Date(at.getTime() - 120_000) },
      { type: 'assistant', at: new Date(at.getTime() + 5_000), apiError: true },
    ]);
    runHook('post-tool', '{"hook_event_name":"PostToolUse","prompt_id":"pr_A","transcript_path":"' +
      path.join(stateDir, 'transcript.jsonl') + '"}');
    expect(markerFiles()).toHaveLength(1);
  });

  it('keeps the marker when there is no prompt id and no transcript', () => {
    writeLoopState('engaged');
    stubCurl();
    writeMarker('20260917T000200-3.json', { at: new Date().toISOString() });
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(markerFiles()).toHaveLength(1);
  });

  it('keeps the marker when the transcript path is unreadable', () => {
    writeLoopState('engaged');
    stubCurl();
    writeMarker('20260917T000300-4.json', { at: new Date().toISOString() });
    runHook('post-tool', '{"hook_event_name":"PostToolUse","transcript_path":"/nope/missing.jsonl"}');
    expect(markerFiles()).toHaveLength(1);
  });

  it('keeps a marker written AFTER the hook took its snapshot', () => {
    // The race the unique filenames exist for: the hook clears what it read, and
    // a block recorded in the meantime has a name it never saw. Simulated by
    // leaving a second marker the transcript cannot vouch for.
    writeLoopState('engaged');
    stubCurl();
    const old = new Date(Date.now() - 300_000);
    writeMarker('20260917T000400-5.json', { at: old.toISOString() });
    writeMarker('20260917T990000-6.json', { at: new Date(Date.now() + 600_000).toISOString() });
    writeTranscript([{ type: 'assistant', at: new Date(old.getTime() + 60_000) }]);
    runHook('post-tool', stopFailure(null));
    expect(markerFiles()).toEqual(['20260917T990000-6.json']);
  });

  it('a prompt does NOT clear anything (an attempt is not restored quota)', () => {
    writeLoopState('engaged');
    stubCurl();
    writeMarker('20260917T000500-7.json', { at: new Date(Date.now() - 60_000).toISOString() });
    writeTranscript([{ type: 'assistant', at: new Date() }]);
    runHook('prompt', '{"prompt":"hi","hook_event_name":"UserPromptSubmit"}');
    expect(markerFiles()).toHaveLength(1);
  });
});

describe('sparrow-auto-status.sh — quota auto-resume notifications', () => {
  for (const type of ['quota_auto_resume_fired']) {
    it(`clears the markers and goes back to working on ${type}`, () => {
      writeLoopState('engaged');
      writeMarker('20260917T000600-8.json', { at: new Date().toISOString() });
      stubCurl();
      const r = runHook('notification', notify(type));
      expect(r.code).toBe(0);
      expect(markerFiles()).toEqual([]);
      const posts = statusPosts();
      expect(posts.length).toBeGreaterThan(0);
      for (const p of posts) {
        expect(p.body).toContain('"state":"working"');
        expect(p.body).toContain('"ttlSeconds":600');
        expect(p.body).not.toContain('blocked');
      }
    });
  }

  /**
   * A marker recorded WHILE the clear runs survives it (unique names, snapshot
   * delete) — and then it contradicts the `working` + presence the recovery
   * would post. So the fired branch re-reads the directory before writing
   * anything, and stays silent while any block stands.
   *
   * The injection is deterministic rather than timed: a spinning writer waits
   * for the old marker to disappear — which can only happen after the snapshot
   * was taken — and writes the new one right then.
   */
  it('posts nothing when a NEW marker survives its snapshot clear', () => {
    writeLoopState('engaged');
    stubCurl();
    const old = writeMarker('20260917T000900-11.json', { at: new Date().toISOString() });
    const fresh = path.join(BLOCKED_DIR(), '20260917T001000-12.json');
    const body = JSON.stringify({ version: 1, reason: 'rate_limit', at: new Date().toISOString() });
    const writer = spawn(
      'sh',
      ['-c', `while [ -f '${old}' ]; do :; done; printf '%s' '${body}' > '${fresh}'`],
      { stdio: 'ignore', detached: true },
    );
    writer.unref();
    // No env creds: the credential lookup spawns node between the clear and the
    // gate, so the injected marker is comfortably inside the window.
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-xdg-r-'));
    fs.mkdirSync(path.join(xdg, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { a: { server: 'https://example.test', token: 'agk_a' } }, defaultProfile: 'a' }),
    );
    runHook('notification', notify('quota_auto_resume_fired'), {
      SPARROW_SERVER: '',
      SPARROW_TOKEN: '',
      XDG_CONFIG_HOME: xdg,
    });
    expect(fs.existsSync(old)).toBe(false); // the snapshot's marker is gone
    expect(fs.existsSync(fresh)).toBe(true); // the newcomer survived
    expect(presencePosts()).toEqual([]);
    expect(statusPosts()).toEqual([]);
    fs.rmSync(xdg, { recursive: true, force: true });
  });

  it('says nothing at all when _stale or _disabled arrive with no block standing', () => {
    for (const type of ['quota_auto_resume_stale', 'quota_auto_resume_disabled']) {
      fs.rmSync(curlLog, { force: true });
      writeLoopState('engaged');
      stubCurl();
      runHook('notification', notify(type));
      expect(statusPosts()).toEqual([]);
      expect(presencePosts()).toEqual([]);
    }
  });

  it('names the quota type in the note when the payload carries one', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook(
      'notification',
      '{"hook_event_name":"Notification","notification_type":"quota_auto_resume_fired","notification_data":{"quota_type":"five_hour","resume_after_seconds":120}}',
    );
    expect(statusPosts()[0]!.body).toContain('quota five_hour resumed');
  });

  /**
   * `_stale` is NOT resumed work: Claude Code waited too long and is now waiting
   * for the user to press Enter. Treating it as a resume would clear a live
   * block and post `working` for a session that still cannot run.
   */
  it('KEEPS the markers on _stale and says a human must press Enter', () => {
    writeLoopState('engaged');
    writeMarker('20260917T000650-8b.json', { at: new Date().toISOString() });
    stubCurl();
    runHook('notification', notify('quota_auto_resume_stale'));
    expect(markerFiles()).toHaveLength(1);
    expect(presencePosts()).toEqual([]);
    expect(statusPosts()[0]!.body).toContain(
      'blocked — usage limit reset while asleep; needs a human to press Enter to continue',
    );
  });

  it('KEEPS the markers and says a human is needed when auto-resume is disabled', () => {
    writeLoopState('engaged');
    writeMarker('20260917T000700-9.json', { at: new Date().toISOString() });
    stubCurl();
    runHook('notification', notify('quota_auto_resume_disabled'));
    expect(markerFiles()).toHaveLength(1);
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0]!.body).toContain(
      'blocked — usage limit reached; auto-resume is off, needs a human to continue',
    );
  });

  /**
   * THE FAILED-RETRY CYCLE, end to end. A late auto-resume notification can
   * clear an episode that is still live. Recovery is not a guarantee about hook
   * ordering — it is the ordinary lifecycle: the next attempted turn fails, and
   * StopFailure writes a fresh marker.
   */
  it('re-blocks after a clear when the next attempted turn fails again', () => {
    writeLoopState('engaged');
    stubCurl();
    writeMarker('20260917T000800-10.json', { at: new Date().toISOString() });
    runHook('notification', notify('quota_auto_resume_fired'));
    expect(markerFiles()).toEqual([]);
    runHook('stop-failure', stopFailure('rate_limit', ',"x":1'));
    expect(markerFiles()).toHaveLength(1);
    expect(markers()[0]!.reason).toBe('rate_limit');
    expect(new Date(markers()[0]!.at as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('sparrow-auto-status.sh — the prompt-time blocked line', () => {
  const writeAgedMarker = (ageSeconds: number, reason = 'rate_limit'): string => {
    const at = new Date(Date.now() - ageSeconds * 1000);
    writeMarker(`2026-${ageSeconds}.json`, { at: at.toISOString(), reason });
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  };

  it('replaces the re-arm nudge with the standing-by line', () => {
    writeLoopState('engaged');
    const hhmm = writeAgedMarker(120);
    stubCurl();
    const r = runHook('prompt', '{"prompt":"hi"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Sparrow: this session hit its usage limit at ${hhmm} (rate_limit)`);
    expect(r.stdout).toContain('the listener is standing by and will reconnect when Claude Code resumes');
    expect(r.stdout).toContain('Nothing to re-arm.');
    expect(r.stdout).not.toMatch(/re-arm it: run/i); // not the listener nudge
  });

  it('wins over the dead-listener nudge (a limited session cannot re-arm anything)', () => {
    writeLoopState('engaged');
    writeAgedMarker(60);
    writeHeartbeat('killed:SIGTERM'); // would normally nag loudly
    stubCurl();
    const out = runHook('prompt', '{"prompt":"hi"}').stdout;
    expect(out).toContain('hit its usage limit');
    expect(out).not.toContain('was killed');
  });

  it('keeps speaking for an OLD marker: age is not evidence quota came back', () => {
    writeLoopState('engaged');
    writeAgedMarker(40 * 3600);
    stubCurl();
    expect(runHook('prompt', '{"prompt":"hi"}').stdout).toContain('hit its usage limit');
  });

  it('says nothing extra when there is no marker at all', () => {
    writeLoopState('engaged');
    writeHeartbeat('await');
    stubCurl();
    expect(runHook('prompt', '{"prompt":"hi"}').stdout.trim()).toBe('');
  });
});

describe('sparrow-auto-status.sh — debug capture', () => {
  const logFile = () => path.join(stateDir, 'hook-debug.log');

  it('writes nothing at all by default', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit'));
    expect(fs.existsSync(logFile())).toBe(false);
  });

  it('records the mode, event, error_type and the payload KEY NAMES only', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit'), { SPARROW_HOOK_DEBUG: '1' });
    const line = fs.readFileSync(logFile(), 'utf8').trim();
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /);
    expect(line).toContain('mode=stop-failure');
    expect(line).toContain('event=StopFailure');
    expect(line).toContain('error_type=rate_limit');
    expect(line).toContain('keys=');
    expect(line).toContain('session_id');
    expect(line).toContain('transcript_path');
    // Names, never values: the error message and the path itself stay out.
    expect(line).not.toContain("You've reached");
    expect(line).not.toContain(stateDir);
  });

  it('appends one line per invocation, including notifications', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('quota_auto_resume_fired'), { SPARROW_HOOK_DEBUG: '1' });
    runHook('stop', '{"hook_event_name":"Stop"}', { SPARROW_HOOK_DEBUG: '1' });
    const lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('notification_type=quota_auto_resume_fired');
    expect(lines[1]).toContain('mode=stop');
  });
});

/* ===================== THE MARKER BOUNDARY (review) ========================= *
 * Clearing compares a marker's `at` against transcript timestamps, so the two
 * must be comparable at full precision. The original bug was TRUNCATION: a
 * marker stamped at whole seconds (18:00:00Z) lost to a success at
 * 18:00:00.100Z that actually happened BEFORE the 18:00:00.900Z error, and a
 * delayed PostToolUse from that older prompt deleted a live marker.
 *
 * The fix is millisecond precision, NOT a different clock. Reading the boundary
 * out of the transcript looked tempting and is worse: nothing ties the last
 * error entry there to THIS StopFailure, so a transcript still holding
 * yesterday's error (this turn's entry not yet flushed) would date the marker
 * yesterday — and yesterday's success would then clear it immediately.
 *
 * Wall-clock at StopFailure time is conservative by construction: every entry
 * already in the transcript was written on this machine before this hook ran, so
 * any pre-existing success is strictly older than the boundary.
 * ========================================================================== */
describe('sparrow-auto-status.sh — where the marker boundary comes from', () => {
  const base = '2026-09-17T18:00:00';

  it('stamps `at` from the wall clock, with milliseconds', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit'));
    const at = markers()[0]!.at as string;
    expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(new Date(at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(new Date(at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("does NOT let an earlier success clear it (the .100/.900 repro)", () => {
    writeLoopState('engaged');
    stubCurl();
    writeTranscriptRaw([
      { type: 'assistant', iso: `${base}.100Z` },
      { type: 'assistant', iso: `${base}.900Z`, apiError: true },
    ]);
    runHook('stop-failure', stopFailure('rate_limit'));
    expect(new Date(markers()[0]!.at as string).getTime()).toBeGreaterThan(Date.parse(`${base}.900Z`));
    runHook('post-tool', stopFailure(null)); // delayed, from the older prompt
    expect(markerFiles()).toHaveLength(1);
  });

  it('clears once a success lands after the boundary, by milliseconds', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit'));
    const at = Date.parse(markers()[0]!.at as string);
    writeTranscriptRaw([
      { type: 'assistant', iso: new Date(at - 50).toISOString() },
      { type: 'assistant', iso: new Date(at + 50).toISOString() },
    ]);
    runHook('post-tool', stopFailure(null));
    expect(markerFiles()).toEqual([]);
  });

  /**
   * THE REVIEWER'S CASE. The transcript still holds only YESTERDAY's episode —
   * this turn's error entry has not landed yet. A boundary read from the file
   * would be dated yesterday, and yesterday's success would clear the marker on
   * the very next tool call.
   */
  it("ignores the transcript's own history: yesterday cannot clear today", () => {
    writeLoopState('engaged');
    stubCurl();
    const yesterday = Date.now() - 24 * 3600_000;
    writeTranscriptRaw([
      { type: 'assistant', iso: new Date(yesterday).toISOString(), apiError: true },
      { type: 'assistant', iso: new Date(yesterday + 60_000).toISOString() },
    ]);
    runHook('stop-failure', stopFailure('rate_limit'));
    expect(new Date(markers()[0]!.at as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
    runHook('post-tool', stopFailure(null));
    expect(markerFiles()).toHaveLength(1);
  });

  it('stamps a boundary even with no transcript at all', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook(
      'stop-failure',
      '{"session_id":"ses_1","hook_event_name":"StopFailure","error_type":"rate_limit","transcript_path":"/nope/missing.jsonl"}',
    );
    expect(markers()[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});

/* ================= PRESENCE AND STATUS WHILE BLOCKED ======================== *
 * The half of the bug that made the whole feature cosmetic: the blocked note
 * went up, and then the very next hook took it straight back down. A
 * UserPromptSubmit posted `working` + a 300s presence heartbeat, PostToolUse
 * refreshed presence, and the quota-DISABLED notification refreshed it too — so
 * a session that could not run a single turn advertised itself as online and
 * working, which is exactly the state this feature exists to end. The CLI's
 * presence clear is one-shot per standby, so it cannot undo any of that.
 *
 * The rule now: while a marker stands, nothing claims otherwise. No presence, no
 * status write, from any mode except the one recording the block and the
 * notifications that clear it. The directory is re-read immediately before any
 * write, so a hook that overlapped the StopFailure cannot undo it either.
 * ========================================================================== */
describe('sparrow-auto-status.sh — silence while blocked', () => {
  const marker = (): string =>
    writeMarker('20260917T180000-1.json', { at: '2026-09-17T18:00:00.900Z', prompt: 'pr_1' });

  it('a prompt says its line and writes NOTHING to the server', () => {
    writeLoopState('engaged');
    marker();
    stubCurl();
    const r = runHook('prompt', '{"prompt":"hi"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hit its usage limit');
    expect(presencePosts()).toEqual([]);
    expect(statusPosts()).toEqual([]);
  });

  it('a PostToolUse with no evidence stays silent too', () => {
    writeLoopState('engaged');
    marker();
    writeTranscriptRaw([{ type: 'assistant', iso: '2026-09-17T17:59:00.000Z' }]);
    stubCurl();
    runHook('post-tool', stopFailure(null));
    expect(markerFiles()).toHaveLength(1);
    expect(presencePosts()).toEqual([]);
    expect(statusPosts()).toEqual([]);
  });

  it('a PostToolUse WITH evidence clears the marker and then works normally', () => {
    writeLoopState('engaged');
    marker();
    fs.writeFileSync(path.join(stateDir, 'auto-status-idle'), ''); // resume handshake
    writeTranscriptRaw([{ type: 'assistant', iso: '2026-09-17T18:00:01.000Z' }]);
    stubCurl();
    runHook('post-tool', stopFailure(null));
    expect(markerFiles()).toEqual([]);
    expect(presencePosts().length).toBeGreaterThan(0);
    expect(statusPosts()[0]!.body).toContain('"state":"working"');
  });

  it('the quota-disabled notification updates the note and nothing else', () => {
    writeLoopState('engaged');
    marker();
    stubCurl();
    runHook('notification', notify('quota_auto_resume_disabled'));
    expect(presencePosts()).toEqual([]);
    expect(statusPosts()[0]!.body).toContain('auto-resume is off, needs a human to continue');
  });

  it('an input-needed or idle notification is a no-op while blocked', () => {
    for (const type of ['permission_prompt', 'idle_prompt']) {
      fs.rmSync(curlLog, { force: true });
      writeLoopState('engaged');
      marker();
      stubCurl();
      runHook('notification', notify(type));
      expect(presencePosts()).toEqual([]);
      expect(statusPosts()).toEqual([]);
    }
  });

  it('a stop does not paint the blocked agent idle', () => {
    writeLoopState('engaged');
    marker();
    stubCurl();
    runHook('stop', '{"hook_event_name":"Stop"}');
    expect(statusPosts()).toEqual([]);
    expect(presencePosts()).toEqual([]);
  });

  it('the StopFailure note itself claims no presence', () => {
    // Recording the block must not re-green a session the CLI has just taken
    // off presence for its standby.
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit'));
    expect(statusPosts().length).toBeGreaterThan(0);
    expect(presencePosts()).toEqual([]);
  });

  it('a marker written between the StopFailure and a later hook still silences it', () => {
    // The overlap case: the gate re-reads the directory immediately before any
    // write, so a hook that started before the block landed still sees it.
    writeLoopState('engaged');
    stubCurl();
    runHook('stop-failure', stopFailure('rate_limit'));
    fs.rmSync(curlLog, { force: true });
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(presencePosts()).toEqual([]);
    expect(statusPosts()).toEqual([]);
  });
});

/* =========================== SUBAGENT INDICATOR ============================ *
 * "What is it actually doing?" — the question a human asks while a foreground
 * subagent runs and the parent sits there producing nothing. Claude Code fires
 * `SubagentStart` before a subagent's first turn and `SubagentStop` after its
 * last, both carrying `agent_id` and `agent_type`, and both discard their
 * output. Subagents are NOT separate OS processes, so nothing can be counted
 * from the process tree; the hooks are the only signal there is.
 *
 * One file per running subagent, named by agent id — the same
 * snapshot-by-name discipline as the usage-limit markers, for the same reason:
 * a stop must delete ITS OWN marker and nothing else.
 * ========================================================================== */
const SUBAGENT_DIR = () => path.join(stateDir, 'subagents');
const subagentFiles = (): string[] =>
  fs.existsSync(SUBAGENT_DIR()) ? fs.readdirSync(SUBAGENT_DIR()).sort() : [];
const subagentRecord = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(SUBAGENT_DIR(), name), 'utf8')) as Record<string, unknown>;

function subagentPayload(event: 'SubagentStart' | 'SubagentStop', id: string, type: string): string {
  return JSON.stringify({
    session_id: 'ses_1',
    prompt_id: 'pr_1',
    transcript_path: path.join(stateDir, 'transcript.jsonl'),
    cwd: '/tmp',
    scratchpad_dir: '/tmp/scratch',
    permission_mode: 'default',
    hook_event_name: event,
    agent_id: id,
    agent_type: type,
    effort: { level: 'medium' },
    ...(event === 'SubagentStop' ? { last_assistant_message: 'done' } : {}),
  });
}

/** Write a live subagent marker by hand. */
function writeSubagent(id: string, type: string, ageSeconds = 0): string {
  fs.mkdirSync(SUBAGENT_DIR(), { recursive: true });
  const f = path.join(SUBAGENT_DIR(), `${id}.json`);
  const at = new Date(Date.now() - ageSeconds * 1000);
  fs.writeFileSync(f, JSON.stringify({ version: 1, agent: id, type, at: at.toISOString() }));
  fs.utimesSync(f, at, at);
  return f;
}

describe('sparrow-auto-status.sh — subagent markers', () => {
  it('start writes exactly one marker, named by agent id', () => {
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'code-review'));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(''); // output is discarded; write none
    expect(subagentFiles()).toEqual(['ag_1.json']);
    const rec = subagentRecord('ag_1.json');
    expect(rec.version).toBe(1);
    expect(rec.agent).toBe('ag_1');
    expect(rec.type).toBe('code-review');
    expect(rec.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('stop deletes ITS OWN marker and leaves the others standing', () => {
    writeLoopState('engaged');
    stubCurl();
    writeSubagent('ag_1', 'explore');
    writeSubagent('ag_2', 'code-review');
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_1', 'explore'));
    expect(subagentFiles()).toEqual(['ag_2.json']);
  });

  it('a stop for an agent with no marker is a silent no-op', () => {
    writeLoopState('engaged');
    stubCurl();
    const r = runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_ghost', 'explore'));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(subagentFiles()).toEqual([]);
  });

  it('sanitises the agent id and type, and cannot write outside the directory', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', '../../escape', 'we*ird type!'));
    expect(fs.existsSync(path.join(os.tmpdir(), 'escape.json'))).toBe(false);
    expect(subagentFiles()).toEqual(['escape.json']);
    expect(subagentRecord('escape.json').type).toBe('weirdtype');
  });

  it('honours the loop switch', () => {
    writeLoopState('paused');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(subagentFiles()).toEqual([]);
  });

  it('writes into the state dir it was pointed at, and no other', () => {
    const neighbour = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-nb-'));
    fs.writeFileSync(path.join(neighbour, 'loop-state'), 'engaged\n');
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      SPARROW_STATE_DIR: neighbour,
    });
    expect(subagentFiles()).toEqual([]);
    expect(fs.readdirSync(path.join(neighbour, 'subagents'))).toEqual(['ag_1.json']);
    fs.rmSync(neighbour, { recursive: true, force: true });
  });
});

describe('sparrow-auto-status.sh — the subagent note', () => {
  const note = (): string => {
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    return (/"note":"([^"]*)"/.exec(posts[posts.length - 1]!.body) ?? [])[1] ?? '';
  };

  it('is the plain working note when nothing is running', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(note()).toBe('working');
  });

  it('names one subagent in the singular', () => {
    writeLoopState('engaged');
    writeSubagent('ag_1', 'explore');
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(note()).toBe('working (1 subagent: explore)');
  });

  it('lists two distinct types, sorted', () => {
    writeLoopState('engaged');
    writeSubagent('ag_1', 'explore');
    writeSubagent('ag_2', 'code-review');
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(note()).toBe('working (2 subagents: code-review, explore)');
  });

  it('counts repeats with a multiplier, and the count is AGENTS', () => {
    writeLoopState('engaged');
    writeSubagent('ag_1', 'explore');
    writeSubagent('ag_2', 'explore');
    writeSubagent('ag_3', 'code-review');
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(note()).toBe('working (3 subagents: code-review, 2× explore)');
  });

  it('names at most three types and counts the rest', () => {
    writeLoopState('engaged');
    writeSubagent('ag_1', 'explore');
    writeSubagent('ag_2', 'explore');
    writeSubagent('ag_3', 'code-review');
    writeSubagent('ag_4', 'general-purpose');
    writeSubagent('ag_5', 'plan');
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(note()).toBe('working (5 subagents: code-review, 2× explore, general-purpose +1 more)');
  });

  /**
   * THE 140-CHARACTER WALL. `STATUS_NOTE_MAX` is 140 and the API REJECTS a
   * longer note with 400 — it does not truncate — so the composer trims
   * deterministically and the result is pinned here.
   */
  it('never exceeds 140 characters, however long the type names are', () => {
    writeLoopState('engaged');
    for (let i = 0; i < 6; i++) writeSubagent(`ag_${i}`, `${'x'.repeat(40)}-${i}`);
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    const n = note();
    expect(n.length).toBeLessThanOrEqual(140);
    expect(n.startsWith('working (6 subagents:')).toBe(true);
    expect(n.endsWith(')')).toBe(true);
  });

  it('appends to a verbose prompt note too, still within 140', () => {
    writeLoopState('engaged');
    writeSubagent('ag_1', 'explore');
    stubCurl();
    runHook('prompt', '{"prompt":"refactor the billing module carefully"}', {
      SPARROW_STATUS_NOTES: 'verbose',
    });
    const n = note();
    expect(n).toContain('refactor the billing module');
    expect(n).toContain('(1 subagent: explore)');
    expect(n.length).toBeLessThanOrEqual(140);
  });

  it('ignores a marker older than 12h (a crash cannot pin a phantom)', () => {
    writeLoopState('engaged');
    writeSubagent('ag_old', 'explore', 13 * 3600);
    writeSubagent('ag_now', 'code-review');
    stubCurl();
    runHook('prompt', '{"prompt":"hi"}');
    expect(note()).toBe('working (1 subagent: code-review)');
  });
});

describe('sparrow-auto-status.sh — posting the subagent note', () => {
  const lastNote = (): string =>
    (/"note":"([^"]*)"/.exec(statusPosts()[statusPosts().length - 1]!.body) ?? [])[1] ?? '';

  it('start posts the composed note itself (a foreground subagent runs no tools)', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(lastNote()).toBe('working (1 subagent: explore)');
    expect(presencePosts().length).toBeGreaterThan(0);
  });

  it('stop posts the note the remaining subagents justify', () => {
    writeLoopState('engaged');
    writeSubagent('ag_2', 'code-review');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(lastNote()).toBe('working (2 subagents: code-review, explore)');
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_1', 'explore'));
    expect(lastNote()).toBe('working (1 subagent: code-review)');
  });

  it('the last subagent to stop restores the plain working note', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_1', 'explore'));
    expect(lastNote()).toBe('working');
  });

  it('post-tool reposts only when the composition CHANGED', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const after = statusPosts().length;
    // Nothing changed: the throttled tick refreshes presence, writes no status.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBe(after);
    // A marker appearing without its hook (the backstop's whole purpose). It
    // reposts even INSIDE the throttle window: the change check is local and
    // free, and a stale picture is what this exists to prevent.
    writeSubagent('ag_2', 'code-review');
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBeGreaterThan(after);
    expect(lastNote()).toBe('working (2 subagents: code-review, explore)');
  });

  it('writes the markers but posts NOTHING while a usage limit stands', () => {
    writeLoopState('engaged');
    writeMarker('20260917T180000-1.json', { at: new Date().toISOString() });
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(subagentFiles()).toEqual(['ag_1.json']); // bookkeeping still runs
    expect(statusPosts()).toEqual([]);
    expect(presencePosts()).toEqual([]);
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_1', 'explore'));
    expect(subagentFiles()).toEqual([]); // and so does the delete
    expect(statusPosts()).toEqual([]);
    expect(presencePosts()).toEqual([]);
  });

  it('sweeps markers older than 12h on its way through', () => {
    writeLoopState('engaged');
    writeSubagent('ag_old', 'explore', 13 * 3600);
    stubCurl();
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_ghost', 'explore'));
    expect(subagentFiles()).toEqual([]);
  });
});

/* ============== A CHILD'S BOUNDARIES MUST NOT SILENCE THE PARENT ============ *
 * Reviewer's sequence (2026-09-17): SubagentStart(a) → Notification
 * (permission_prompt) → SubagentStop(a) posted `working (1 subagent: …)`, then
 * `blocked — needs your input`, then plain `working` — while the parent was
 * still sitting on an unanswered permission prompt. The one note that tells a
 * human to go and DO something was erased by a child starting and finishing.
 *
 * So the needs-input condition is recorded in the state dir and composed onto,
 * not overwritten. It is cleared exactly where the hook already clears it: the
 * next prompt (back to working), the resume handshake, and the stop/idle path.
 * ========================================================================== */
describe('sparrow-auto-status.sh — needs-input survives subagent boundaries', () => {
  const lastNote = (): string =>
    (/"note":"([^"]*)"/.exec(statusPosts()[statusPosts().length - 1]!.body) ?? [])[1] ?? '';
  const needsInput = () => path.join(stateDir, 'needs-input');

  it("does not erase the parent's blocked note when a child stops", () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_a', 'explore'));
    expect(lastNote()).toBe('working (1 subagent: explore)');

    runHook('notification', notify('permission_prompt'));
    expect(lastNote()).toBe('blocked — needs your input (1 subagent: explore)');
    expect(fs.existsSync(needsInput())).toBe(true);

    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_a', 'explore'));
    expect(lastNote()).toBe('blocked — needs your input');
    expect(fs.existsSync(needsInput())).toBe(true); // still in force
  });

  it('composes onto the blocked note when a child STARTS while it stands', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('agent_needs_input'));
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_a', 'code-review'));
    expect(lastNote()).toBe('blocked — needs your input (1 subagent: code-review)');
  });

  it('the BACKSTOP composes onto it too, rather than reverting to working', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('permission_prompt'));
    // A marker appearing without its hook — what the backstop exists for.
    writeSubagent('ag_x', 'explore');
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(lastNote()).toBe('blocked — needs your input (1 subagent: explore)');
  });

  it('the next prompt clears it and goes back to working', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('permission_prompt'));
    runHook('prompt', '{"prompt":"go on then"}');
    expect(lastNote()).toBe('working');
    expect(fs.existsSync(needsInput())).toBe(false);
  });

  it('the stop path clears it (the turn is over, idle is the truth)', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('permission_prompt'));
    runHook('stop', '{"hook_event_name":"Stop"}');
    expect(fs.existsSync(needsInput())).toBe(false);
    expect(statusPosts()[statusPosts().length - 1]!.body).toContain('"state":"idle"');
  });

  it('the idle notification clears it as well', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('permission_prompt'));
    runHook('notification', notify('idle_prompt'));
    expect(fs.existsSync(needsInput())).toBe(false);
  });

  /**
   * THE RECOVERY BOUNDARY, pinned. A child's tool call is not evidence the
   * parent's permission wait resolved — a subagent running tools while the
   * parent sits on a dialog is exactly that case. Only the parent moving on
   * (the next prompt) or the turn ending clears it.
   */
  it('is NOT cleared by tool calls or subagent boundaries, only by a prompt', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('permission_prompt'));

    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(fs.existsSync(needsInput())).toBe(true);
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_c', 'explore'));
    expect(fs.existsSync(needsInput())).toBe(true);
    expect(lastNote()).toBe('blocked — needs your input (1 subagent: explore)');
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_c', 'explore'));
    expect(fs.existsSync(needsInput())).toBe(true);
    expect(lastNote()).toBe('blocked — needs your input');

    // Even the resume handshake, which starts a turn without a prompt, leaves
    // the ask standing — it is a tool call, not an answer.
    fs.writeFileSync(path.join(stateDir, 'auto-status-idle'), '');
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(fs.existsSync(needsInput())).toBe(true);
    expect(lastNote()).toBe('blocked — needs your input');

    runHook('prompt', '{"prompt":"yes, go ahead"}');
    expect(fs.existsSync(needsInput())).toBe(false);
    expect(lastNote()).toBe('working');
  });
});

/* ===================== THE PAYLOAD IS PARSED STRUCTURALLY =================== *
 * `payload_value` takes the first quoted string after a key — which is the NEXT
 * KEY'S VALUE when the field is null. Reviewer's case:
 * `{"agent_id":null,"agent_type":"Explore"}` named the marker file after the
 * type, inventing a subagent that never existed. Anything that NAMES A FILE has
 * to be read structurally.
 * ========================================================================== */
describe('sparrow-auto-status.sh — agent id and type are read structurally', () => {
  const raw = (body: Record<string, unknown>): string =>
    JSON.stringify({ hook_event_name: 'SubagentStart', ...body });

  it('writes NO marker when agent_id is null', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', raw({ agent_id: null, agent_type: 'Explore' }));
    expect(subagentFiles()).toEqual([]);
  });

  it('writes no marker when agent_id is absent entirely', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', raw({ agent_type: 'Explore' }));
    expect(subagentFiles()).toEqual([]);
  });

  it('writes no marker when agent_id is a number or an object', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', raw({ agent_id: 42, agent_type: 'Explore' }));
    runHook('subagent-start', raw({ agent_id: { id: 'nested' }, agent_type: 'Explore' }));
    expect(subagentFiles()).toEqual([]);
  });

  it('never takes an agent_id nested inside another object', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook(
      'subagent-start',
      raw({ tool_response: { agent_id: 'ag_nested' }, agent_type: 'Explore' }),
    );
    expect(subagentFiles()).toEqual([]);
  });

  it('records an unknown TYPE rather than borrowing the next key', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', raw({ agent_id: 'ag_1', agent_type: null, prompt_id: 'pr_zzz' }));
    expect(subagentFiles()).toEqual(['ag_1.json']);
    expect(subagentRecord('ag_1.json').type).toBe('unknown');
  });

  it('still writes exactly one correctly named marker for a normal payload', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'af21ccd826c2319bb', 'Explore'));
    expect(subagentFiles()).toEqual(['af21ccd826c2319bb.json']);
    expect(subagentRecord('af21ccd826c2319bb.json')).toMatchObject({
      agent: 'af21ccd826c2319bb',
      type: 'Explore',
    });
  });

  /**
   * NO NODE, NO MARKER. Structured extraction is the only way these fields are
   * read, so a host without node shows no subagents at all — honest and
   * harmless, where an anchored-sed fallback could still mistake a nested field
   * for a top-level one and invent an agent.
   */
  it('writes no marker and claims no subagents when node is unavailable', () => {
    const nodeless = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-nonode-'));
    for (const tool of ['sh', 'cat', 'sed', 'head', 'tr', 'cut', 'mkdir', 'date', 'stat', 'awk', 'sort', 'uniq', 'grep', 'rm', 'wc']) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(real, path.join(nodeless, tool));
    }
    fs.symlinkSync(path.join(stubBin, 'curl'), path.join(nodeless, 'curl'));
    writeLoopState('engaged');
    stubCurl();
    const r = execFileSync('sh', [SCRIPT, 'subagent-start'], {
      input: subagentPayload('SubagentStart', 'ag_1', 'explore'),
      encoding: 'utf8',
      env: {
        PATH: nodeless,
        HOME: home,
        SPARROW_STATE_DIR: stateDir,
        CURL_LOG: curlLog,
        SPARROW_SERVER: 'https://example.test',
        SPARROW_TOKEN: 'agk_test',
      },
    });
    expect(r).toBe('');
    expect(subagentFiles()).toEqual([]);
    expect(statusPosts().every((p) => !p.body.includes('subagent'))).toBe(true);
    fs.rmSync(nodeless, { recursive: true, force: true });
  });

  it('a stop with a null agent_id deletes nothing', () => {
    writeLoopState('engaged');
    stubCurl();
    writeSubagent('ag_1', 'explore');
    runHook('subagent-stop', JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: null }));
    expect(subagentFiles()).toEqual(['ag_1.json']);
  });
});

/* ================= A STALE SNAPSHOT MUST NOT WIN THE NOTE =================== *
 * Reviewer's repro (2026-09-17): hold `subagent-start(A)` at its `GET /me/rooms`
 * AFTER it has composed "1 agent"; let `subagent-start(B)` complete and post
 * "2 agents"; release A, which posts and stamps "1 agent" LAST — while both
 * marker files exist. The note then contradicts the directory, and a foreground
 * parent may issue no tool call at all until the child finishes, so the
 * post-tool backstop never gets to repair it.
 *
 * The fix has to make the LAST WRITER responsible for the final state, not the
 * last to be scheduled.
 * ========================================================================== */
describe('sparrow-auto-status.sh — concurrent posts converge on the truth', () => {
  /** A curl stub that blocks on `GET /me/rooms` while the flag file exists. */
  function stubHangingCurl(flag: string): void {
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms)
    # ONE-SHOT: only the first caller (A) is held; everybody after it sails past.
    if [ -f "${flag}" ] && [ ! -f "${flag}.used" ]; then
      : > "${flag}.used"
      n=0
      while [ -f "${flag}" ] && [ "$n" -lt 200 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    printf '%s' "$ROOMS_JSON"
    ;;
esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  const notesPosted = (): string[] =>
    statusPosts().map((p) => (/"note":"([^"]*)"/.exec(p.body) ?? [])[1] ?? '');

  it('ends on the note the marker directory justifies, whoever was slow', async () => {
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    stubHangingCurl(flag);

    const env = {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      SPARROW_STATE_DIR: stateDir,
      CURL_LOG: curlLog,
      ROOMS_JSON,
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
    };

    // A: starts first, composes "1 agent", then hangs inside GET /me/rooms.
    const a = spawn('sh', [SCRIPT, 'subagent-start'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    a.stdin.end(subagentPayload('SubagentStart', 'ag_A', 'explore'));
    const deadline = Date.now() + 5_000;
    const sawRooms = (): boolean =>
      fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms');
    while (Date.now() < deadline && !sawRooms()) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // B: the second subagent starts while A is stuck. With the kernel lock it
    // QUEUES rather than abandoning, so it publishes as soon as A is done.
    const b = spawn('sh', [SCRIPT, 'subagent-start'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    b.stdin.end(subagentPayload('SubagentStart', 'ag_B', 'code-review'));
    await new Promise((r) => setTimeout(r, 300)); // let B mutate and queue

    // Release A; both then finish, in whatever order the kernel grants.
    fs.rmSync(flag, { force: true });
    await waitExit(a);
    await waitExit(b);

    // Both subagents are still running, so that is what the note must say —
    // whichever process happened to post last.
    expect(subagentFiles()).toEqual(['ag_A.json', 'ag_B.json']);
    const notes = notesPosted();
    expect(notes[notes.length - 1]).toBe('working (2 subagents: code-review, explore)');
    // …and the stamp must describe what was actually posted, so the backstop
    // does not sit on a lie.
    expect(fs.readFileSync(path.join(stateDir, 'auto-status-note'), 'utf8')).toBe(
      'working (2 subagents: code-review, explore)',
    );
    // Nothing left owing: the last publisher acknowledged every marker it saw.
    expect(pendingCount()).toBe(0);
  }, 40_000);
});


/* ================= THE LOCK IS THE KERNEL'S, AND THE BODY IS WHOLE ========= *
 * Two findings, one critical section.
 *
 * 1. NO RECLAMATION PROTOCOL. "Read the holder's pid, prove it dead, remove the
 *    lock" is not an atomic compare-and-delete: two reclaimers can both prove
 *    the same holder dead and both take the lock. Re-reading a token just before
 *    the unlink narrows the window without closing it. So the lock is a plain
 *    file that is NEVER unlinked and `flock` holds it — the kernel releases it
 *    however the holder ends, so there is nothing to reclaim and nothing to go
 *    stale. Where `flock` is absent there is NO lock at all, and convergence
 *    (compose immediately before posting, then re-check) is what corrects the
 *    note; that is honest and cannot wedge anything.
 *
 * 2. THE WHOLE BODY, COMPOSED INSIDE THE LOCK. Watching only the subagent list
 *    could not see the PARENT's condition change: a Notification writing
 *    `needs-input` while a held hook was mid-post left the final status as plain
 *    `working (1 subagent: …)` with the ask invisible.
 * ========================================================================== */
describe('sparrow-auto-status.sh — composing under the lock', () => {
  function stubHangingCurl(flag: string): void {
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms)
    if [ -f "${flag}" ] && [ ! -f "${flag}.used" ]; then
      : > "${flag}.used"
      n=0
      while [ -f "${flag}" ] && [ "$n" -lt 200 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    printf '%s' "$ROOMS_JSON"
    ;;
esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }
  const notes = (): string[] =>
    statusPosts().map((p) => (/"note":"([^"]*)"/.exec(p.body) ?? [])[1] ?? '');
  const hookEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: home,
    SPARROW_STATE_DIR: stateDir,
    CURL_LOG: curlLog,
    ROOMS_JSON,
    SPARROW_SERVER: 'https://example.test',
    SPARROW_TOKEN: 'agk_test',
    SPARROW_NOTE_BUDGET: '60', // ordering test: keep the deadline out of it
    ...extra,
  });

  it("ends on the PARENT's blocked note when it arrives mid-post", async () => {
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    stubHangingCurl(flag);

    // A composes `working (1 subagent: explore)` and stalls in GET /me/rooms.
    const a = spawn('sh', [SCRIPT, 'subagent-start'], { env: hookEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
    a.stdin.end(subagentPayload('SubagentStart', 'ag_A', 'explore'));
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms'))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // The parent becomes blocked while A is stuck. It records needs-input, loses
    // the lock, and posts nothing.
    runHook('notification', notify('permission_prompt'), { SPARROW_NOTE_BUDGET: '60' });
    expect(fs.existsSync(path.join(stateDir, 'needs-input'))).toBe(true);

    fs.rmSync(flag, { force: true });
    await waitExit(a);

    const posted = notes();
    expect(posted[posted.length - 1]).toBe('blocked — needs your input (1 subagent: explore)');
    expect(fs.readFileSync(path.join(stateDir, 'auto-status-note'), 'utf8')).toBe(
      'blocked — needs your input (1 subagent: explore)',
    );
  }, 25_000);

  it('the backstop repairs a parent-condition change with an unchanged subagent set', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_A', 'explore'));
    expect(notes()[notes().length - 1]).toBe('working (1 subagent: explore)');
    // The condition changes without any subagent changing.
    fs.writeFileSync(path.join(stateDir, 'needs-input'), new Date().toISOString());
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(notes()[notes().length - 1]).toBe('blocked — needs your input (1 subagent: explore)');
  });

  it('a holder killed mid-post blocks nobody: the kernel releases the lock', async () => {
    writeLoopState('engaged');
    stubCurl();
    const lockFile = path.join(stateDir, 'auto-status-note.lock');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockFile, '');
    const holder = spawn('sh', ['-c', `exec 9>>'${lockFile}'; flock 9; exec sleep 30`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    holder.kill('SIGKILL');
    await waitExit(holder);

    const started = Date.now();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(Date.now() - started).toBeLessThan(1_500); // no waiting on a corpse
    expect(notes()[notes().length - 1]).toBe('working (1 subagent: explore)');
  }, 15_000);

  it('a loser posts nothing and stamps nothing', async () => {
    writeLoopState('engaged');
    stubCurl();
    const lockFile = path.join(stateDir, 'auto-status-note.lock');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockFile, '');
    const holder = spawn('sh', ['-c', `exec 9>>'${lockFile}'; flock 9; exec sleep 12`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));

    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(subagentFiles()).toEqual(['ag_1.json']); // bookkeeping still runs
    expect(statusPosts()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'auto-status-note'))).toBe(false);
    holder.kill('SIGKILL');
    await waitExit(holder);
  }, 20_000);

  /**
   * WITHOUT `flock` there is no lock, by design — a lock with no safe
   * reclamation is worse than none. What corrects the note then is convergence:
   * compose immediately before the post, re-check afterwards, post again while
   * it keeps changing. This pins that the convergence path alone still lands on
   * the truth, which is the limitation the comment describes.
   */
  it('reaches the right note by convergence alone when flock is absent', () => {
    const nofl = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-nofl-'));
    for (const tool of ['sh', 'cat', 'sed', 'head', 'tr', 'cut', 'mkdir', 'rm', 'rmdir', 'date', 'stat', 'awk', 'sort', 'uniq', 'grep', 'wc', 'node', 'sleep', 'tail']) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(real, path.join(nofl, tool));
    }
    fs.symlinkSync(path.join(stubBin, 'curl'), path.join(nofl, 'curl'));
    writeLoopState('engaged');
    stubCurl();
    fs.writeFileSync(path.join(stateDir, 'needs-input'), new Date().toISOString());
    const r = execFileSync('sh', [SCRIPT, 'subagent-start'], {
      input: subagentPayload('SubagentStart', 'ag_1', 'explore'),
      encoding: 'utf8',
      env: {
        PATH: nofl,
        HOME: home,
        SPARROW_STATE_DIR: stateDir,
        CURL_LOG: curlLog,
        ROOMS_JSON,
        SPARROW_SERVER: 'https://example.test',
        SPARROW_TOKEN: 'agk_test',
      },
    });
    expect(r).toBe('');
    expect(notes()[notes().length - 1]).toBe('blocked — needs your input (1 subagent: explore)');
    fs.rmSync(nofl, { recursive: true, force: true });
  }, 15_000);
});

/* ===================== THE PENDING RECORD ================================= *
 * A bounded publisher can drop the LAST mutation: with three rounds, a fourth
 * marker arriving during round three is seen, the loop exits, and if every other
 * hook has given up, nobody publishes it. So the round cap bounds one hook's
 * WORK, and the pending record carries correctness: every mutation creates its
 * own uniquely named marker before AND after it mutates, a publisher unlinks
 * exactly the names it snapshotted before composing, and any later hook that
 * finds a marker publishes.
 *
 * What that buys is EVENTUAL repair, not immediate correctness — a
 * `SubagentStop` can be delayed for a whole task or never arrive after a crash.
 * Until a later hook runs, the note may be stale and the markers say so.
 * ========================================================================== */
describe('sparrow-auto-status.sh — the pending record', () => {
  const STAMP = () => path.join(stateDir, 'auto-status-note');
  const notes = (): string[] =>
    statusPosts().map((p) => (/"note":"([^"]*)"/.exec(p.body) ?? [])[1] ?? '');
  function stubHangingCurl(flag: string): void {
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms)
    if [ -f "${flag}" ] && [ ! -f "${flag}.used" ]; then
      : > "${flag}.used"
      n=0
      while [ -f "${flag}" ] && [ "$n" -lt 400 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    printf '%s' "$ROOMS_JSON"
    ;;
esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }
  // These tests hold a hook inside its fan-out for several seconds on purpose;
  // they are about ORDERING, so the publication budget is widened to keep the
  // deadline (a separate concern, covered below) out of the way.
  const hookEnv = (): Record<string, string> => ({
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: home,
    SPARROW_STATE_DIR: stateDir,
    CURL_LOG: curlLog,
    ROOMS_JSON,
    SPARROW_SERVER: 'https://example.test',
    SPARROW_TOKEN: 'agk_test',
    SPARROW_NOTE_BUDGET: '60',
  });

  it('is cleared by a normal single-hook post', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(pendingCount()).toBe(0);
    expect(fs.readFileSync(STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
  });

  /** MUTATION-THEN-ACK: a publisher must not acknowledge a marker that was not
   * in its snapshot — even though it posted in between. */
  it('does not acknowledge a mutation stamped after its snapshot', async () => {
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    stubHangingCurl(flag);

    const a = spawn('sh', [SCRIPT, 'subagent-start'], { env: hookEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
    a.stdin.end(subagentPayload('SubagentStart', 'ag_A', 'explore'));
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms'))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // A mutation completes while A is mid-post, exactly as another hook would
    // leave it: token stamped, marker written, token stamped again.
    stampPending('later-1');
    writeSubagent('ag_Z', 'code-review');
    stampPending('later-2');

    fs.rmSync(flag, { force: true });
    await waitExit(a);

    // A saw the unacknowledged markers, went round again, and published the truth.
    const posted = notes();
    expect(posted[posted.length - 1]).toBe('working (2 subagents: code-review, explore)');
    expect(pendingCount()).toBe(0);
  }, 40_000);

  /** ACK-THEN-MUTATION: a mutation after a publisher acknowledged leaves its own
   * new marker, and is repaired by the next hook rather than lost. */
  it('leaves a new marker for a mutation that lands after an ack, repaired later', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(pendingCount()).toBe(0);

    // A mutation that cannot publish: a usage limit stands, so the gate stops it
    // before any post. The token must be left behind as the record.
    writeMarker('20260917T180000-1.json', { at: new Date().toISOString() });
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_2', 'code-review'));
    expect(pendingCount()).toBeGreaterThan(0);
    expect(fs.readFileSync(STAMP(), 'utf8')).toBe('working (1 subagent: explore)'); // stale, and says so

    // The block clears; the next hook — whatever its mode — repairs the note.
    fs.rmSync(path.join(stateDir, 'blocked'), { recursive: true, force: true });
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(notes()[notes().length - 1]).toBe('working (2 subagents: code-review, explore)');
    expect(pendingCount()).toBe(0);
  });

  /**
   * THE REVIEWER'S FOUR-MARKER SEQUENCE. A is held while B, C and D each mutate
   * and queue. Whoever publishes last must leave the note and the stamp saying
   * FOUR — the round cap must not be able to drop the final mutation.
   */
  it('ends with all four subagents in the note and the stamp', async () => {
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    stubHangingCurl(flag);

    const a = spawn('sh', [SCRIPT, 'subagent-start'], { env: hookEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
    a.stdin.end(subagentPayload('SubagentStart', 'ag_A', 'explore'));
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms'))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const rest = [
      ['ag_B', 'code-review'],
      ['ag_C', 'general-purpose'],
      ['ag_D', 'plan'],
    ].map(([id, type]) => {
      const c = spawn('sh', [SCRIPT, 'subagent-start'], { env: hookEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
      c.stdin.end(subagentPayload('SubagentStart', id!, type!));
      return c;
    });
    await new Promise((r) => setTimeout(r, 500)); // they mutate, then queue

    fs.rmSync(flag, { force: true });
    for (const c of [a, ...rest]) await waitExit(c);

    expect(subagentFiles()).toEqual(['ag_A.json', 'ag_B.json', 'ag_C.json', 'ag_D.json']);
    const want = 'working (4 subagents: code-review, explore, general-purpose +1 more)';
    expect(notes()[notes().length - 1]).toBe(want);
    expect(fs.readFileSync(STAMP(), 'utf8')).toBe(want);
    expect(pendingCount()).toBe(0);
  }, 60_000);

  it('a queued waiter posts nothing when the body already matches the stamp', async () => {
    writeLoopState('engaged');
    stubCurl();
    // Publish once through a real boundary so the stamp is current.
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const before = statusPosts().length;
    expect(before).toBeGreaterThan(0);
    // A second hook with nothing to change must add no post at all.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBe(before);
  });
});

/* ===================== THE PUBLICATION BUDGET ============================== *
 * The binding limit is CODEX's, not Claude Code's. Codex registers these same
 * modes with explicit per-hook timeouts (provider-codex.ts: UserPromptSubmit and
 * PostToolUse 20s, Stop 30s), while Claude Code's default for a command hook
 * that sets no `timeout` is 600s. So the publication path must fit inside 20s —
 * and not just the lock wait: the fan-out and every round happen inside it too.
 *
 * One deadline covers the lot. A hook that reaches it stops, posts nothing
 * further, and leaves the token set: the same honest handoff as any other
 * budget exhaustion.
 * ========================================================================== */
describe('sparrow-auto-status.sh — the publication budget', () => {
  /** A curl stub that is SLOW and mutates the token on every call, so the
   * rounds would keep going forever if nothing bounded them. */
  function stubSlowChurningCurl(seconds: string): void {
    const body = `#!/bin/sh
url=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s\\n' "$method" "$url" >> "$CURL_LOG"
sleep ${seconds}
# Somebody else's mutation lands during every single call — a real one, so the
# composed BODY changes and a publisher would otherwise keep going round.
mkdir -p "$SPARROW_STATE_DIR/subagents" 2>/dev/null || true
n=$(ls "$SPARROW_STATE_DIR/subagents" | wc -l)
printf '{"version":1,"agent":"c%s","type":"churn%s","at":"2026-09-18T00:00:00.000Z"}' "$n" "$n" \
  > "$SPARROW_STATE_DIR/subagents/c$n.json"
mkdir -p "$SPARROW_STATE_DIR/auto-status-pending.d" 2>/dev/null || true
: > "$SPARROW_STATE_DIR/auto-status-pending.d/churn-$n"
case "$url" in */me/rooms) printf '%s' "$ROOMS_JSON" ;; esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }
  const statusPostCount = (): number => statusPosts().length;

  it('stops at the deadline, posts nothing further, and leaves the markers set', () => {
    writeLoopState('engaged');
    stubSlowChurningCurl('1');
    writeSubagent('ag_1', 'explore');
    stampPending('start');

    const started = Date.now();
    const r = runHook('post-tool', '{"hook_event_name":"PostToolUse"}', {
      SPARROW_NOTE_BUDGET: '3',
    });
    expect(r.code).toBe(0);
    // AT MOST one publication (two rooms) and no more, where three unbounded
    // rounds against this churning stub would have posted six times.
    //
    // The bound, not an exact count, is the honest assertion: `budget_left`
    // works in whole seconds, so the effective deadline is fuzzy by up to one
    // second and this fan-out either completes or is truncated one POST in.
    // Both are the budget doing its job, and pinning the count to 2 made this
    // test flake (seen 2026-09-18). What must hold either way is that the loop
    // stopped and the markers are still owed.
    expect(statusPostCount()).toBeGreaterThan(0);
    expect(statusPostCount()).toBeLessThanOrEqual(2);
    // The churn that landed during the fan-out is still owed, and says so.
    expect(pendingCount()).toBeGreaterThan(0);
    // And it did not sit there for three slow rounds.
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  it('the ordinary path finishes far inside the budget', () => {
    writeLoopState('engaged');
    stubCurl();
    const started = Date.now();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pendingCount()).toBe(0);
  });
});

/* ============== EVERY MODE, EXECUTED, WITH STDERR WATCHED ================== *
 * `sh -n` cannot catch an unset-variable abort, and a green suite did not catch
 * one either: `$SUBAGENT_NOTE_STAMP` was never assigned, and under `set -u` the
 * expansion killed the SUBSHELL it sat in — leaving an empty value, a spurious
 * post, and a stream of stderr nobody was reading. So these assert the exit
 * status AND that stderr is silent AND the side effect, for every mode.
 * ========================================================================== */
describe('sparrow-auto-status.sh — every mode runs clean', () => {
  const runFull = (mode: string, input: string, extra: Record<string, string> = {}) =>
    spawnSync('sh', [SCRIPT, mode], {
      input,
      encoding: 'utf8',
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        HOME: home,
        SPARROW_STATE_DIR: stateDir,
        CURL_LOG: curlLog,
        ROOMS_JSON,
        SPARROW_SERVER: 'https://example.test',
        SPARROW_TOKEN: 'agk_test',
        ...extra,
      },
    });

  const MODES: [string, string][] = [
    ['prompt', '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}'],
    ['post-tool', '{"hook_event_name":"PostToolUse"}'],
    ['notification', '{"hook_event_name":"Notification","notification_type":"permission_prompt","notification_data":{}}'],
    ['notification', '{"hook_event_name":"Notification","notification_type":"idle_prompt","notification_data":{}}'],
    ['notification', '{"hook_event_name":"Notification","notification_type":"quota_auto_resume_fired","notification_data":{}}'],
    ['stop', '{"hook_event_name":"Stop"}'],
    ['stop-failure', '{"hook_event_name":"StopFailure","error_type":"rate_limit","session_id":"s","prompt_id":"p"}'],
    ['subagent-start', '{"hook_event_name":"SubagentStart","agent_id":"ag_1","agent_type":"explore"}'],
    ['subagent-stop', '{"hook_event_name":"SubagentStop","agent_id":"ag_1","agent_type":"explore"}'],
  ];

  for (const [mode, input] of MODES) {
    const label = /"notification_type":"([a-z_]+)"/.exec(input)?.[1] ?? mode;
    it(`${mode} (${label}) exits 0 with nothing on stderr`, () => {
      writeLoopState('engaged');
      stubCurl();
      const r = runFull(mode, input);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  }

  // The paths added on 2026-09-18: the idle-owed flag (read at the top of every
  // publication round) and the legacy-token migration (run once per hook).
  for (const [mode, input] of MODES) {
    const label = /"notification_type":"([a-z_]+)"/.exec(input)?.[1] ?? mode;
    it(`${mode} (${label}) exits 0 with nothing on stderr while idle is owed`, () => {
      writeLoopState('engaged');
      stubCurl();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(IDLE_OWED(), '');
      fs.writeFileSync(PENDING_LEGACY(), 'legacy'); // …and a migration to do
      const r = runFull(mode, input);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(fs.existsSync(PENDING_LEGACY())).toBe(false); // converted, never dropped
    });
  }

  it('the post-tool backstop path runs and still refreshes presence', () => {
    // The exact path the unset variable broke: a stamp exists, nothing drifted,
    // so the backstop must fall through to the throttled presence refresh.
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const before = presencePosts().length;
    const r = runFull('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(presencePosts().length).toBeGreaterThan(before); // presence still fires
  });

  it('the backstop repairs a drift on that same path, cleanly', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    writeSubagent('ag_2', 'code-review'); // drift with no hook behind it
    stampPending('drift');
    const r = runFull('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(stateDir, 'auto-status-note'), 'utf8')).toBe(
      'working (2 subagents: code-review, explore)',
    );
  });
});

describe('sparrow-auto-status.sh — idle is published in order', () => {
  it('idle lands LAST when a slow publisher is still mid-fan-out', async () => {
    // THE BARRIER. A `subagent-start` is stuck in its fan-out holding the lock
    // when the turn ends. Before idle was part of the ordered path, it posted
    // straight past and the older `working (1 subagent: …)` landed afterwards,
    // resurrecting a finished turn.
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms)
    if [ -f "${flag}" ] && [ ! -f "${flag}.used" ]; then
      : > "${flag}.used"
      n=0
      while [ -f "${flag}" ] && [ "$n" -lt 100 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    printf '%s' "$ROOMS_JSON"
    ;;
esac
exit 0
`;
    fs.writeFileSync(path.join(stubBin, 'curl'), body);
    fs.chmodSync(path.join(stubBin, 'curl'), 0o755);
    const env = {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      SPARROW_STATE_DIR: stateDir,
      CURL_LOG: curlLog,
      ROOMS_JSON,
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      SPARROW_NOTE_BUDGET: '60',
    };

    const a = spawn('sh', [SCRIPT, 'subagent-start'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    a.stdin.end(subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms'))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Release A shortly, so the stop's wait is long enough to queue behind it.
    const releaser = spawn('sh', ['-c', `sleep 1; rm -f '${flag}'`], { stdio: 'ignore' });

    runHook('stop', '{"hook_event_name":"Stop"}', { SPARROW_NOTE_BUDGET: '60' });
    await waitExit(a);
    await waitExit(releaser);

    const posts = statusPosts();
    expect(posts[posts.length - 1]!.body).toContain('"state":"idle"');
    expect(fs.readFileSync(path.join(stateDir, 'auto-status-note'), 'utf8')).toBe('idle');
  }, 30_000);

  it('idle takes the lock like any other publication', () => {
    // With the lock held by somebody else, idle waits its turn rather than
    // racing — and when it cannot get in, it posts nothing at all.
    writeLoopState('engaged');
    stubCurl();
    const lockFile = path.join(stateDir, 'auto-status-note.lock');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockFile, '');
    const holder = spawn('sh', ['-c', `exec 9>>'${lockFile}'; flock 9; exec sleep 8`], { stdio: 'ignore' });
    const before = statusPosts().length;
    runHook('stop', '{"hook_event_name":"Stop"}');
    expect(statusPosts().length).toBe(before);
    holder.kill('SIGKILL');
  }, 20_000);
});

describe('sparrow-auto-status.sh — a broken lock degrades, it does not silence', () => {
  it('publishes anyway when flock exists but cannot be used', () => {
    // A `flock` that exits non-zero for a reason that is not contention (here: a
    // stub standing in for a read-only state dir or an NFS mount without
    // locking) must fall through to the unlocked path, not swallow every post.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-badlock-'));
    for (const tool of ['sh', 'cat', 'sed', 'head', 'tr', 'cut', 'mkdir', 'rm', 'rmdir', 'date', 'stat', 'awk', 'sort', 'uniq', 'grep', 'wc', 'node', 'sleep', 'tail']) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(real, path.join(bin, tool));
    }
    fs.symlinkSync(path.join(stubBin, 'curl'), path.join(bin, 'curl'));
    fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit 64\n'); // usage/enviroment failure
    fs.chmodSync(path.join(bin, 'flock'), 0o755);

    writeLoopState('engaged');
    stubCurl();
    const r = spawnSync('sh', [SCRIPT, 'subagent-start'], {
      input: subagentPayload('SubagentStart', 'ag_1', 'explore'),
      encoding: 'utf8',
      env: {
        PATH: bin,
        HOME: home,
        SPARROW_STATE_DIR: stateDir,
        CURL_LOG: curlLog,
        ROOMS_JSON,
        SPARROW_SERVER: 'https://example.test',
        SPARROW_TOKEN: 'agk_test',
      },
    });
    expect(r.status).toBe(0);
    expect(statusPosts().length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(stateDir, 'auto-status-note'), 'utf8')).toBe(
      'working (1 subagent: explore)',
    );
    fs.rmSync(bin, { recursive: true, force: true });
  }, 20_000);
});

describe('sparrow-auto-status.sh — an ack racing a mutation loses nothing', () => {
  /**
   * There is no compare-and-delete left to race. A publisher unlinks exactly the
   * NAMES it snapshotted, and names are never reused, so a mutation that
   * completes after the snapshot leaves a marker the publisher cannot touch.
   * This drives that interleaving — the ack lands between the mutation's two
   * stamps — and asserts the mutation's own record survives it.
   */
  it('keeps the later marker when the ack lands between the two stamps', async () => {
    writeLoopState('engaged');
    stubCurl();
    fs.mkdirSync(path.join(stateDir, 'subagents'), { recursive: true });

    // A mutator: stamp, (slow) mutate, stamp again — the second stamp landing
    // after the publisher has already acknowledged everything it saw.
    stampPending('mutator-before');
    const mutator = spawn('sh', ['-c',
      `sleep 1; printf '{"version":1,"agent":"ag_M","type":"plan","at":"2026-09-18T00:00:00.000Z"}' > '${path.join(stateDir, 'subagents', 'ag_M.json')}'; : > '${path.join(stateDir, 'auto-status-pending.d', 'mutator-after')}'`,
    ], { stdio: 'ignore' });

    // The publisher runs now, snapshots `mutator-before` with its own two, and
    // acknowledges exactly those.
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(pendingNames()).toEqual([]); // acknowledged, mid-mutation

    await waitExit(mutator);
    // …and the mutation's own second stamp is a NAME THAT WAS NEVER SNAPSHOTTED,
    // so nothing could have erased it.
    expect(pendingNames()).toEqual(['mutator-after']);
    expect(fs.existsSync(path.join(stateDir, 'subagents', 'ag_M.json'))).toBe(true);
  }, 20_000);
});

describe('sparrow-auto-status.sh — the prompt note never outranks the parent', () => {
  it('publishes the ask that arrives while the prompt is mid-post', async () => {
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms)
    if [ -f "${flag}" ] && [ ! -f "${flag}.used" ]; then
      : > "${flag}.used"
      n=0
      while [ -f "${flag}" ] && [ "$n" -lt 400 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    printf '%s' "$ROOMS_JSON"
    ;;
esac
exit 0
`;
    fs.writeFileSync(path.join(stubBin, 'curl'), body);
    fs.chmodSync(path.join(stubBin, 'curl'), 0o755);
    const env = {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      SPARROW_STATE_DIR: stateDir,
      CURL_LOG: curlLog,
      ROOMS_JSON,
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      SPARROW_NOTE_BUDGET: '60',
    };

    // The prompt composes `working` (its own note) and stalls in the fan-out.
    const p = spawn('sh', [SCRIPT, 'prompt'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end('{"hook_event_name":"UserPromptSubmit","prompt":"hi"}');
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms'))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    runHook('notification', notify('permission_prompt'), { SPARROW_NOTE_BUDGET: '60' });
    fs.rmSync(flag, { force: true });
    await waitExit(p);

    const posted = statusPosts().map((x) => (/"note":"([^"]*)"/.exec(x.body) ?? [])[1] ?? '');
    expect(posted[posted.length - 1]).toBe('blocked — needs your input');
    expect(fs.readFileSync(path.join(stateDir, 'auto-status-note'), 'utf8')).toBe(
      'blocked — needs your input',
    );
    // The ask is still in force, and the token's disposition matches what was
    // actually published: nothing is owed, because the ask WAS published.
    expect(fs.existsSync(path.join(stateDir, 'needs-input'))).toBe(true);
    expect(pendingCount()).toBe(0);
  }, 40_000);
});

/* ========== FINDING 1: A PENDING RECORD CANNOT BE ERASED =================== *
 * Reviewer, 2026-09-18. The old protocol wrote a unique VALUE to one reused
 * filename and acknowledged it with `cat`, compare, `rm` — a compare-and-delete
 * that is three steps, not one. Pause a publisher AFTER its equality test has
 * succeeded but BEFORE its `rm`; run a `notification(permission_prompt)` hook to
 * completion in the gap (it stamps, writes needs-input, stamps again, loses its
 * own lock wait and exits); release the publisher. Its `rm` then deleted a token
 * that recorded a mutation it never published, and the final state was:
 * needs-input standing, nothing owed on disk, note reading `working (1 subagent:
 * …)`, and no publisher left to repair it. The old double-stamp argument only
 * covered a clear landing BETWEEN the two stamps; this one lands after BOTH.
 *
 * The fix is per-mutation immutable names acknowledged from a snapshot, so both
 * of the notification's stamps produce names the publisher never saw.
 *
 * WHY THE BLOCK IS ON `rm` AND NOT ON `curl`: nothing but the `[` test runs
 * between the old compare and its unlink, so no curl stub can reach that window.
 * A one-shot sentinel on the unlink itself can, and it is the SAME point in both
 * protocols — the publisher's unlink — so the interleaving means the same thing
 * before and after the fix. No sleeps order anything here: the sentinel is
 * released only once the notification process has exited.
 * ========================================================================== */
describe('sparrow-auto-status.sh — a mutation completed before the unlink survives it', () => {
  /** A stub `rm` that blocks the FIRST unlink of a pending record (either
   * layout) while `sentinel` exists, then delegates to the real one. */
  function stubBlockingRm(sentinel: string): void {
    const realRm = execFileSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).trim();
    const p = path.join(stubBin, 'rm');
    fs.writeFileSync(p, `#!/bin/sh
for a in "$@"; do
  case "$a" in
    *auto-status-pending*)
      if [ ! -f '${sentinel}.used' ]; then
        : > '${sentinel}.used'
        n=0
        while [ -f '${sentinel}' ] && [ "$n" -lt 900 ]; do sleep 0.05; n=$((n + 1)); done
      fi
      ;;
  esac
done
exec ${realRm} "$@"
`);
    fs.chmodSync(p, 0o755);
  }

  const notes = (): string[] =>
    statusPosts().map((p) => (/"note":"([^"]*)"/.exec(p.body) ?? [])[1] ?? '');

  it('is still owed after a permission prompt lands across the publisher unlink', async () => {
    writeLoopState('engaged');
    stubCurl();
    const sentinel = path.join(stubBin, 'hold-rm');
    fs.writeFileSync(sentinel, '');
    stubBlockingRm(sentinel);

    const env = {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      SPARROW_STATE_DIR: stateDir,
      CURL_LOG: curlLog,
      ROOMS_JSON,
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      // A short budget so the publisher cannot repair anything itself once it is
      // released: by then its deadline is long gone and it must hand over.
      SPARROW_NOTE_BUDGET: '3',
    };

    // A publishes `working (1 subagent: explore)`, then stops at its unlink.
    const a = spawn('sh', [SCRIPT, 'subagent-start'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    a.stdin.end(subagentPayload('SubagentStart', 'ag_A', 'explore'));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !fs.existsSync(`${sentinel}.used`)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(`${sentinel}.used`)).toBe(true);

    // The parent is asked something, RIGHT ACROSS the unlink: it stamps, writes
    // needs-input, stamps again, loses its lock wait twice over, and exits.
    runHook('notification', notify('permission_prompt'), { SPARROW_NOTE_BUDGET: '20' });
    expect(fs.existsSync(path.join(stateDir, 'needs-input'))).toBe(true);

    fs.rmSync(sentinel, { force: true });
    await waitExit(a);

    // The publisher never published the ask — its body predates it…
    expect(notes()[notes().length - 1]).toBe('working (1 subagent: explore)');
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    // …so the record of it MUST still be on disk. This is the assertion the old
    // compare-and-delete failed: it unlinked a token it had never seen.
    expect(pendingCount()).toBeGreaterThan(0);

    // And the record is what gets the truth published.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(notes()[notes().length - 1]).toBe('blocked — needs your input (1 subagent: explore)');
    expect(pendingCount()).toBe(0);
  }, 90_000);
});

/* ========== FINDING 2: `idle` IS OWED, NOT MERELY INTENDED ================= *
 * Reviewer, 2026-09-18. Hold a `subagent-start` inside its locked `GET
 * /me/rooms` for longer than the stop mode's lock wait: the `stop` hook returns
 * when its wait expires WITHOUT posting idle, and the released holder publishes
 * `working (1 subagent: …)` with no idle publisher left anywhere. The intended
 * idle existed only as that one process's intention, so nothing could recover
 * it.
 *
 * The fix makes the intent durable state, written BEFORE the stop tries to
 * publish and read at the top of every publication round.
 * ========================================================================== */
describe('sparrow-auto-status.sh — idle is owed, not merely intended', () => {
  /** A curl stub that blocks the first `GET /me/rooms` while the flag exists. */
  function stubHangingCurl(flag: string): void {
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms)
    if [ -f "${flag}" ] && [ ! -f "${flag}.used" ]; then
      : > "${flag}.used"
      n=0
      while [ -f "${flag}" ] && [ "$n" -lt 900 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    printf '%s' "$ROOMS_JSON"
    ;;
esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  it('a holder released after the stop gave up publishes idle, not working', async () => {
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    stubHangingCurl(flag);

    const env = {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      SPARROW_STATE_DIR: stateDir,
      CURL_LOG: curlLog,
      ROOMS_JSON,
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      SPARROW_NOTE_BUDGET: '60',
    };
    const a = spawn('sh', [SCRIPT, 'subagent-start'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    a.stdin.end(subagentPayload('SubagentStart', 'ag_A', 'explore'));
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms'))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // The turn ends while the holder is stuck. The stop's 2s lock wait expires.
    const before = statusPosts().length;
    runHook('stop', '{"hook_event_name":"Stop"}', { SPARROW_NOTE_BUDGET: '2' });
    expect(statusPosts().length).toBe(before); // it published nothing at all…
    expect(fs.existsSync(IDLE_OWED())).toBe(true); // …but the intent is on disk

    fs.rmSync(flag, { force: true });
    await waitExit(a);

    // The holder finished its own (now stale) publication and then honoured the
    // stop, because the flag outlived the process that formed the intent.
    const posts = statusPosts();
    expect(posts[posts.length - 1]!.body).toContain('"state":"idle"');
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('idle');
    expect(fs.existsSync(IDLE_OWED())).toBe(false);
    expect(pendingCount()).toBe(0);
  }, 60_000);

  it('a stop whose wait expires is honoured by the NEXT hook to take the lock', async () => {
    writeLoopState('engaged');
    stubCurl();
    const lockFile = path.join(stateDir, 'auto-status-note.lock');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockFile, '');
    const holder = spawn('sh', ['-c', `exec 9>>'${lockFile}'; flock 9; exec sleep 30`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));

    // Nothing of this stop's own remains to check the lock again…
    runHook('stop', '{"hook_event_name":"Stop"}', { SPARROW_NOTE_BUDGET: '2' });
    expect(statusPosts()).toEqual([]);
    expect(fs.existsSync(IDLE_OWED())).toBe(true);

    holder.kill('SIGKILL');
    await waitExit(holder);

    // …so whoever takes the lock next owes idle, whatever its own mode was.
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[posts.length - 1]!.body).toContain('"state":"idle"');
    expect(posts.some((p) => p.body.includes('subagent'))).toBe(false);
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('idle');
    expect(fs.existsSync(IDLE_OWED())).toBe(false);
  }, 40_000);

  it('a prompt that resumes the turn cancels what idle was owed', () => {
    writeLoopState('engaged');
    stubCurl();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(IDLE_OWED(), ''); // a stop that never managed to publish
    runHook('prompt', '{"hook_event_name":"UserPromptSubmit","prompt":"go"}');
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[posts.length - 1]!.body).toContain('"state":"working"');
    expect(fs.existsSync(IDLE_OWED())).toBe(false);
  });
});

/* ========== FINDING 3: THE BUDGET BOUNDS THE WORK IN FLIGHT ================ *
 * Reviewer, 2026-09-18. `NOTE_DEADLINE` was consulted only at round entry, so a
 * round that began with a second left could still run a 5s room GET plus up to
 * MAX_ROOMS sequential 4s POSTs — far past the budget, and well past Codex's
 * binding 20s for the whole hook. `publish_idle` checked nothing at all.
 *
 * Now every step re-reads what is left, sizes its own `--max-time` from it, and
 * refuses to start with nothing left — and a fan-out that stops early SAYS SO,
 * so the stamp (which means "this is what every room was last told") is not
 * written and the pending markers are not acknowledged.
 * ========================================================================== */
describe('sparrow-auto-status.sh — the budget bounds the work in flight', () => {
  /** Eight active rooms: enough that a full fan-out cannot fit the budget. */
  const MANY_ROOMS = JSON.stringify({
    items: Array.from({ length: 8 }, (_, i) => ({
      room: { id: `rom_${i}`, name: `R${i}`, orgId: 'org_1', kind: 'project', archivedAt: null },
      memberId: `mem_${i}`,
      roomRole: 'member',
    })),
  });

  /** A curl that burns ~1s per call and records the `--max-time` it was given. */
  function stubSlowCurl(): void {
    const body = `#!/bin/sh
url=; mt=; prev=
for a in "$@"; do
  case "$a" in http://*|https://*) url=$a ;; esac
  [ "$prev" = "--max-time" ] && mt=$a
  prev=$a
done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s \\n' "$method" "$url" >> "$CURL_LOG"
printf '%s %s %s\\n' "$method" "$url" "$mt" >> "$CURL_LOG.mt"
sleep 1
case "$url" in */me/rooms) printf '%s' "$ROOMS_JSON" ;; esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  /** The `--max-time` of every PUBLICATION call (presence has its own timeout). */
  const publicationMaxTimes = (): number[] =>
    fs.existsSync(`${curlLog}.mt`)
      ? fs
          .readFileSync(`${curlLog}.mt`, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '' && !l.includes('/me/presence'))
          .map((l) => Number(l.trim().split(' ')[2]))
      : [];

  it('truncates the fan-out at the deadline, stamps nothing, and keeps the markers', () => {
    writeLoopState('engaged');
    stubSlowCurl();

    const started = Date.now();
    const r = runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      ROOMS_JSON: MANY_ROOMS,
      SPARROW_NOTE_BUDGET: '3',
    });
    const elapsed = Date.now() - started;
    expect(r.code).toBe(0);

    // (a) A REAL BOUND: the budget, plus at most one in-flight call's worth of
    // slack — not the old fixture's loose "under 8s".
    expect(elapsed).toBeLessThan(5_500);

    // (b) The fan-out stopped early rather than telling all eight rooms.
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThan(8);
    // …and no single call was allowed to outlast the budget.
    const mts = publicationMaxTimes();
    expect(mts.length).toBeGreaterThan(0);
    for (const mt of mts) expect(mt).toBeLessThanOrEqual(3);

    // (c) The stamp means "every room has this", so a truncated publication must
    // not write it — the post-tool backstop relies on that.
    expect(fs.existsSync(NOTE_STAMP())).toBe(false);

    // (d) …and nothing was acknowledged, so a later hook retries.
    expect(pendingCount()).toBeGreaterThan(0);
  }, 40_000);

  it('a complete fan-out inside the budget still stamps and acknowledges', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      SPARROW_NOTE_BUDGET: '8',
    });
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    expect(pendingCount()).toBe(0);
  });
});

describe('sparrow-auto-status.sh — pending markers migrate and are bounded', () => {
  it('converts a legacy single-token file rather than dropping it', () => {
    writeLoopState('engaged');
    stubCurl();
    // A usage limit stands, so nothing can publish and nothing can acknowledge:
    // whatever survives here is the migration alone.
    writeMarker('20260918T000000-1.json', { at: new Date().toISOString() });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(PENDING_LEGACY(), 'old-token-value');

    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');

    expect(fs.existsSync(PENDING_LEGACY())).toBe(false);
    expect(pendingNames()).toHaveLength(1);
  });

  it('bounds markers older than an hour without dropping the debt', () => {
    writeLoopState('engaged');
    stubCurl();
    writeMarker('20260918T000000-1.json', { at: new Date().toISOString() });
    stampPending('stale-one');
    stampPending('fresh-one');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(path.join(PENDING_DIR(), 'stale-one'), old, old);

    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');

    // The aged marker is replaced, not deleted: age cannot establish that a
    // publication is no longer owed (see the sweep's own section, and the
    // dedicated coverage below).
    expect(pendingNames()).toHaveLength(2);
    expect(pendingNames()).toContain('fresh-one');
    expect(pendingNames()).not.toContain('stale-one');
  });
});

/* ===== A DIALOG CANNOT BE OPEN ON A TURN THAT HAS ENDED ==================== *
 * Reviewer, second round. `IDLE_OWED` left standing by a stop that could not
 * publish made the NEXT publication idle — including a `permission_prompt`'s.
 * `publish_idle` then cleared every marker, including the two the ask had just
 * written, so the repair step found nothing owed and nothing could put it right:
 * the post-tool backstop cannot run, because the tool call is blocked on the
 * very dialog nobody has answered. The status read `idle` for exactly as long as
 * a human was being asked to act.
 *
 * It is a reachable ordering, not a theoretical one: an autonomous turn resumes
 * with no UserPromptSubmit and its first tool call needs permission, so the
 * Notification is the turn's FIRST hook with the previous stop's flag standing.
 * ========================================================================== */
describe('sparrow-auto-status.sh — being asked something cancels what idle was owed', () => {
  const notes = (): string[] =>
    statusPosts().map((p) => (/"note":"([^"]*)"/.exec(p.body) ?? [])[1] ?? '');

  for (const type of [
    'permission_prompt',
    'elicitation_dialog',
    'elicitation_url_dialog',
    'agent_needs_input',
  ]) {
    it(`publishes the ask, not idle, when ${type} arrives with idle owed`, () => {
      writeLoopState('engaged');
      stubCurl();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(IDLE_OWED(), ''); // a stop that never managed to publish

      runHook('notification', notify(type));

      const posts = statusPosts();
      expect(posts.length).toBeGreaterThan(0);
      expect(posts.some((p) => p.body.includes('"state":"idle"'))).toBe(false);
      expect(notes()[notes().length - 1]).toBe('blocked — needs your input');
      expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('blocked — needs your input');
      expect(fs.existsSync(IDLE_OWED())).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'needs-input'))).toBe(true);
      expect(pendingCount()).toBe(0);
    });
  }

  it('keeps the record of the ask when it cannot be published at all', async () => {
    writeLoopState('engaged');
    stubCurl();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(IDLE_OWED(), '');
    const lockFile = path.join(stateDir, 'auto-status-note.lock');
    fs.writeFileSync(lockFile, '');
    const holder = spawn('sh', ['-c', `exec 9>>'${lockFile}'; flock 9; exec sleep 30`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));

    runHook('notification', notify('permission_prompt'), { SPARROW_NOTE_BUDGET: '2' });
    expect(statusPosts()).toEqual([]); // it never got the lock…
    expect(fs.existsSync(IDLE_OWED())).toBe(false); // …but the turn is live
    expect(pendingCount()).toBeGreaterThan(0); // …and the ask is still owed

    holder.kill('SIGKILL');
    await waitExit(holder);

    // The next hook publishes the ASK. Before the fix it published `idle`,
    // because the flag the stop left behind had outlived the turn it described.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(notes()[notes().length - 1]).toBe('blocked — needs your input');
    expect(statusPosts().some((p) => p.body.includes('"state":"idle"'))).toBe(false);
  }, 40_000);
});

/* ===== "NO ROOMS" AND "I COULD NOT FIND OUT" ARE DIFFERENT ANSWERS ========= *
 * Reviewer, second round. `room_ids` returned 0 with empty output for a failed
 * GET just as it did for a profile with no rooms. Once the fan-out started
 * reporting completeness, that ambiguity read as "a complete fan-out with
 * nothing to do": the note was stamped as what every room was last told, and
 * every snapshotted marker was acknowledged — on a publication that reached
 * nobody, leaving nothing on disk to say so. Same class as finding 1, arrived at
 * from the other end.
 * ========================================================================== */
describe('sparrow-auto-status.sh — a failed room listing is not an empty one', () => {
  it('stamps nothing and acknowledges nothing when the listing fails', () => {
    writeLoopState('engaged');
    stubCurl({ fail: true }); // every call, the rooms GET included, exits 22
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));

    expect(statusPosts()).toEqual([]); // nobody was told anything…
    expect(fs.existsSync(NOTE_STAMP())).toBe(false); // …so nothing may claim they were
    expect(pendingCount()).toBeGreaterThan(0); // …and the mutation is still owed
  });

  it('a later hook repairs it once the listing works again', () => {
    writeLoopState('engaged');
    stubCurl({ fail: true });
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(pendingCount()).toBeGreaterThan(0);

    stubCurl(); // the server comes back
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect((/"note":"([^"]*)"/.exec(posts[posts.length - 1]!.body) ?? [])[1]).toBe(
      'working (1 subagent: explore)',
    );
    expect(pendingCount()).toBe(0);
  });

  it('a SUCCESSFUL listing with no rooms is complete, and does acknowledge', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      ROOMS_JSON: JSON.stringify({ items: [] }),
    });

    expect(statusPosts()).toEqual([]); // nothing to post to, vacuously
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    expect(pendingCount()).toBe(0);
  });

  it('a listing of only ARCHIVED rooms is complete too', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      ROOMS_JSON: JSON.stringify({
        items: [
          {
            room: { id: 'rom_z', name: 'Z', orgId: 'org_1', kind: 'project', archivedAt: '2026-01-01T00:00:00Z' },
            memberId: 'mem_z',
            roomRole: 'member',
          },
        ],
      }),
    });
    expect(statusPosts()).toEqual([]);
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    expect(pendingCount()).toBe(0);
  });

  it('an unparseable body is a failed listing, not an empty one', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      ROOMS_JSON: 'not json at all',
    });
    expect(statusPosts()).toEqual([]);
    expect(fs.existsSync(NOTE_STAMP())).toBe(false);
    expect(pendingCount()).toBeGreaterThan(0);
  });
});

/* ===== A BROKEN CLOCK DEGRADES, IT DOES NOT SILENCE ======================== *
 * `budget_left` is the one thing every publication step now consults, so what
 * it does with an unusable `date` decides whether a host with a broken clock
 * publishes at all. Reporting 0 would be the natural floor and would mean never
 * posting anything again; it reports the WHOLE budget instead, so each call is
 * still bounded and the round cap is what stops the hook. These drive the hook
 * with `date` actually broken — both spellings, missing and garbage — rather
 * than reasoning about the branch.
 * ========================================================================== */
describe('sparrow-auto-status.sh — the budget with no usable clock', () => {
  /** A PATH with every tool the hook needs, and a `date` that behaves as given. */
  function clocklessBin(dateBody: string): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-as-noclock-'));
    for (const tool of ['sh', 'cat', 'sed', 'head', 'tr', 'cut', 'mkdir', 'rm', 'rmdir', 'stat', 'awk', 'sort', 'uniq', 'grep', 'wc', 'node', 'sleep', 'tail', 'flock']) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(real, path.join(bin, tool));
    }
    fs.symlinkSync(path.join(stubBin, 'curl'), path.join(bin, 'curl'));
    fs.writeFileSync(path.join(bin, 'date'), dateBody);
    fs.chmodSync(path.join(bin, 'date'), 0o755);
    return bin;
  }

  /** A curl that records the `--max-time` each publication call was given. */
  function stubCurlRecordingMaxTime(): void {
    const body = `#!/bin/sh
url=; mt=; prev=; data=
for a in "$@"; do
  case "$a" in http://*|https://*) url=$a ;; esac
  [ "$prev" = "--max-time" ] && mt=$a
  [ "$prev" = "-d" ] && data=$a
  prev=$a
done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
printf '%s %s %s\\n' "$method" "$url" "$mt" >> "$CURL_LOG.mt"
case "$url" in */me/rooms) printf '%s' "$ROOMS_JSON" ;; esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  const publicationMaxTimes = (): number[] =>
    fs.existsSync(`${curlLog}.mt`)
      ? fs
          .readFileSync(`${curlLog}.mt`, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '' && !l.includes('/me/presence'))
          .map((l) => Number(l.trim().split(' ')[2]))
      : [];

  for (const [label, dateBody] of [
    ['a `date` that always fails', '#!/bin/sh\nexit 1\n'],
    ['a `date` that prints garbage', "#!/bin/sh\nprintf 'not-a-time\\n'\nexit 0\n"],
  ] as [string, string][]) {
    it(`still publishes, bounded, with ${label}`, () => {
      const bin = clocklessBin(dateBody);
      writeLoopState('engaged');
      stubCurlRecordingMaxTime();
      const r = spawnSync('sh', [SCRIPT, 'subagent-start'], {
        input: subagentPayload('SubagentStart', 'ag_1', 'explore'),
        encoding: 'utf8',
        env: {
          PATH: bin,
          HOME: home,
          SPARROW_STATE_DIR: stateDir,
          CURL_LOG: curlLog,
          ROOMS_JSON,
          SPARROW_SERVER: 'https://example.test',
          SPARROW_TOKEN: 'agk_test',
          SPARROW_NOTE_BUDGET: '2',
        },
      });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // NOT SILENCE: the publication still happened and was acknowledged.
      expect(statusPosts().length).toBe(2);
      expect(fs.existsSync(NOTE_STAMP())).toBe(true);
      expect(pendingCount()).toBe(0);
      // …and STILL BOUNDED: `budget_left` reported the whole budget, so every
      // call was capped by it rather than running unbounded or being refused.
      const mts = publicationMaxTimes();
      expect(mts.length).toBeGreaterThan(0);
      for (const mt of mts) expect(mt).toBe(2);
      fs.rmSync(bin, { recursive: true, force: true });
    });
  }
});

/** The durable "some rooms hold a body the others do not" record. */
const DIVERGED = () => path.join(stateDir, 'auto-status-diverged');

/* ===== DEFECT 3: DELIVERED, NOT ATTEMPTED ================================== *
 * Reviewer, third round. The POST was written `curl … || true` with the counter
 * incrementing underneath it, so a fan-out whose every write was refused still
 * reported COMPLETE: the stamp claimed rooms had been told what they had never
 * heard, and every pending marker was acknowledged. Same error as the failed
 * listing, one level down — the listing learned to distinguish "could not find
 * out" from "nothing to do", while each individual write still read "refused,
 * 500, or timed out" as "delivered".
 * ========================================================================== */
describe('sparrow-auto-status.sh — a room is told only when the POST succeeds', () => {
  /** A curl whose status POSTs fail for the room ids in `failing` (all, if empty). */
  function stubCurlStatusPostsFail(failing: string[] = []): void {
    const guard =
      failing.length === 0
        ? '  */status) exit 22 ;;'
        : failing.map((id) => `  */rooms/${id}/status) exit 22 ;;`).join('\n') + '\n  */status) exit 0 ;;';
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms) printf '%s' "$ROOMS_JSON"; exit 0 ;;
${guard}
esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  const ONE_ROOM = JSON.stringify({
    items: [
      { room: { id: 'rom_only', name: 'O', orgId: 'org_1', kind: 'dm', archivedAt: null }, memberId: 'm', roomRole: 'member' },
    ],
  });

  it('a single room whose status POST is refused is not a complete fan-out', () => {
    writeLoopState('engaged');
    stubCurlStatusPostsFail();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      ROOMS_JSON: ONE_ROOM,
    });

    // It tried (and the repair step retried once, which is the loop doing its
    // job) — every attempt aimed at the one room, and none of them landed.
    expect(statusPosts().length).toBeGreaterThan(0);
    for (const p of statusPosts()) expect(p.url).toContain('rom_only');
    expect(fs.existsSync(NOTE_STAMP())).toBe(false); // …and never claimed success
    expect(pendingCount()).toBeGreaterThan(0); // …so the mutation is still owed
  });

  it('a mixed fan-out — some delivered, some refused — is partial too', () => {
    writeLoopState('engaged');
    stubCurlStatusPostsFail(['rom_b']); // rom_a takes it, rom_b refuses
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));

    const urls = statusPosts().map((p) => p.url);
    expect(urls.some((u) => u.includes('rom_a'))).toBe(true);
    expect(urls.some((u) => u.includes('rom_b'))).toBe(true); // both attempted
    expect(fs.existsSync(NOTE_STAMP())).toBe(false);
    expect(pendingCount()).toBeGreaterThan(0);
  });

  it('a later hook repairs it once the rooms accept writes again', () => {
    writeLoopState('engaged');
    stubCurlStatusPostsFail();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(pendingCount()).toBeGreaterThan(0);

    stubCurl();
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    const posts = statusPosts();
    expect((/"note":"([^"]*)"/.exec(posts[posts.length - 1]!.body) ?? [])[1]).toBe(
      'working (1 subagent: explore)',
    );
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    expect(pendingCount()).toBe(0);
  });
});

/* ===== DEFECT 4: A DIVERGENT FAN-OUT IS DURABLE STATE ====================== *
 * Coordinator, third round. Body B reaches some rooms and not others: correctly
 * nothing is stamped and nothing acknowledged, so the stamp still reads A. The
 * state then REVERTS to A, the next publisher composes A, finds it equal to the
 * stamp, posts nothing and acknowledges everything — and the rooms that took B
 * show it forever, because the drift check compares one composed body against
 * one global stamp and they agree.
 *
 * Step 1 here is driven by BUDGET TRUNCATION rather than a failed POST, so that
 * this test isolates defect 4: truncation was already reported as partial before
 * defect 3 was fixed, and the only thing that can make this test pass is the
 * divergence record.
 * ========================================================================== */
describe('sparrow-auto-status.sh — rooms left behind by a partial fan-out are healed', () => {
  const EIGHT_ROOMS = JSON.stringify({
    items: Array.from({ length: 8 }, (_, i) => ({
      room: { id: `rom_${i}`, name: `R${i}`, orgId: 'org_1', kind: 'project', archivedAt: null },
      memberId: `mem_${i}`,
      roomRole: 'member',
    })),
  });

  /** A curl that succeeds but burns ~1s per call, so the budget truncates. */
  function stubSlowCurl(): void {
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
sleep 1
case "$url" in */me/rooms) printf '%s' "$ROOMS_JSON" ;; esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  const noteOf = (e: { body: string }): string => (/"note":"([^"]*)"/.exec(e.body) ?? [])[1] ?? '';

  it('republishes a body equal to the stamp while some rooms still disagree', () => {
    writeLoopState('engaged');
    stubCurl();
    const env = { ROOMS_JSON: EIGHT_ROOMS, SPARROW_NOTE_BUDGET: '30' };

    // Stamp A, delivered everywhere.
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), env);
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    expect(statusPosts().length).toBe(8);
    expect(fs.existsSync(DIVERGED())).toBe(false);
    expect(pendingCount()).toBe(0);

    // 1. B reaches SOME of the eight and the budget stops the rest.
    stubSlowCurl();
    const beforeB = statusPosts().length;
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_2', 'code-review'), {
      ROOMS_JSON: EIGHT_ROOMS,
      SPARROW_NOTE_BUDGET: '3',
    });
    const bPosts = statusPosts().slice(beforeB);
    expect(bPosts.length).toBeGreaterThan(0);
    expect(bPosts.length).toBeLessThan(8); // …and not all of them
    for (const p of bPosts) expect(noteOf(p)).toBe('working (2 subagents: code-review, explore)');
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)'); // unmoved
    expect(pendingCount()).toBeGreaterThan(0);
    expect(fs.existsSync(DIVERGED())).toBe(true); // the divergence is on disk

    // 2. The composition REVERTS to exactly what the stamp already says.
    stubCurl();
    const beforeC = statusPosts().length;
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_2', 'code-review'), env);

    // 3. It is published anyway, to every room — the stamp was true of none.
    const cPosts = statusPosts().slice(beforeC);
    expect(cPosts.length).toBe(8);
    for (const p of cPosts) expect(noteOf(p)).toBe('working (1 subagent: explore)');
    expect(fs.existsSync(DIVERGED())).toBe(false); // healed
    expect(pendingCount()).toBe(0); // …and only now acknowledged
  }, 40_000);

  it('a fan-out that DISPATCHED nothing records no divergence', () => {
    // The listing itself fails, so no write was ever in flight and no room can
    // hold anything unexpected — the markers alone carry the debt. (Contrast a
    // fan-out whose writes went out and failed: see the ambiguous-write case,
    // where a failure response proves nothing about what the server applied.)
    writeLoopState('engaged');
    stubCurl({ fail: true });
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(log().some((e) => /\/rooms\/[^/]+\/status$/.test(e.url))).toBe(false);
    expect(fs.existsSync(DIVERGED())).toBe(false);
    expect(pendingCount()).toBeGreaterThan(0);
  });

  it('a listing that finds NO rooms clears the divergence, vacuously', () => {
    // The decision, made explicit: "no room disagrees with the stamp" is true of
    // an empty room set, and `post_note` already stamps "every room was told
    // this" on the same vacuous grounds. Doing one and not the other would be
    // incoherent, and holding the flag would make every future publication post
    // unconditionally to nobody, forever.
    writeLoopState('engaged');
    stubCurl();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(DIVERGED(), '');
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'), {
      ROOMS_JSON: JSON.stringify({ items: [] }),
    });
    expect(fs.existsSync(DIVERGED())).toBe(false);
    expect(pendingCount()).toBe(0);
  });

  it('the repair step fires on divergence alone, with no markers left', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(pendingCount()).toBe(0);
    // Divergence with an empty pending directory: only `repair_owed` can see it.
    fs.writeFileSync(DIVERGED(), '');
    const before = statusPosts().length;
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBeGreaterThan(before);
    expect(fs.existsSync(DIVERGED())).toBe(false);
  });
});

/* ===== DEFECT 5: AN IDLE PUBLICATION MUST NOT WIPE WHAT ARRIVED DURING IT == *
 * Reviewer, third round, under real flock. Hold `stop` inside its locked room
 * GET; run a `permission_prompt` notification to completion; release the stop.
 * The ask behaved correctly — it cleared the idle intent and wrote its own
 * markers — but the stop was already inside `publish_idle`, whose `pending_clear`
 * deleted EVERY marker including those two. Nothing reconciled afterwards,
 * because idle was a short-circuit exit from `publish_rounds` and the repair
 * step is skipped for the `stop` mode. Final state: idle on the board, a human
 * being asked to act, and nothing on disk owed.
 * ========================================================================== */
describe('sparrow-auto-status.sh — an ask arriving during an idle publication', () => {
  function stubHangingCurl(flag: string): void {
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms)
    if [ -f "${flag}" ] && [ ! -f "${flag}.used" ]; then
      : > "${flag}.used"
      n=0
      while [ -f "${flag}" ] && [ "$n" -lt 900 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    printf '%s' "$ROOMS_JSON"
    ;;
esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }
  const noteOf = (e: { body: string }): string => (/"note":"([^"]*)"/.exec(e.body) ?? [])[1] ?? '';

  it('survives it, and the ask is what stands at the end', async () => {
    writeLoopState('engaged');
    const flag = path.join(stubBin, 'hang');
    fs.writeFileSync(flag, '');
    stubHangingCurl(flag);

    const env = {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      SPARROW_STATE_DIR: stateDir,
      CURL_LOG: curlLog,
      ROOMS_JSON,
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      SPARROW_NOTE_BUDGET: '60',
    };
    // The stop records that idle is owed, then stalls inside its room GET.
    const s = spawn('sh', [SCRIPT, 'stop'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    s.stdin.end('{"hook_event_name":"Stop"}');
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(curlLog) && fs.readFileSync(curlLog, 'utf8').includes('/me/rooms'))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // The ask lands mid-flight: it cancels the intent and records itself.
    runHook('notification', notify('permission_prompt'), { SPARROW_NOTE_BUDGET: '2' });
    expect(fs.existsSync(path.join(stateDir, 'needs-input'))).toBe(true);
    expect(fs.existsSync(IDLE_OWED())).toBe(false);

    fs.rmSync(flag, { force: true });
    await waitExit(s);

    // The idle that was already dispatched lands — a race resolving in the open
    // — and the SAME publisher then goes round again and posts the ask over it.
    const posts = statusPosts();
    expect(posts.some((p) => p.body.includes('"state":"idle"'))).toBe(true);
    expect(noteOf(posts[posts.length - 1]!)).toBe('blocked — needs your input');
    // The note and the needs-input record agree, and nothing is left owed.
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('blocked — needs your input');
    expect(fs.existsSync(path.join(stateDir, 'needs-input'))).toBe(true);
    expect(pendingCount()).toBe(0);
    expect(fs.existsSync(IDLE_OWED())).toBe(false);
  }, 60_000);

  it('an ask that lands BEFORE dispatch wins outright, with no idle at all', async () => {
    // The intent is read as late as it can be. Here the stop is stuck waiting
    // for the lock rather than mid-fan-out, so the ask cancels it before any
    // idle is composed and nobody ever sees idle.
    writeLoopState('engaged');
    stubCurl();
    fs.mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, 'auto-status-note.lock');
    fs.writeFileSync(lockFile, '');
    const holder = spawn('sh', ['-c', `exec 9>>'${lockFile}'; flock 9; exec sleep 30`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));

    runHook('stop', '{"hook_event_name":"Stop"}', { SPARROW_NOTE_BUDGET: '2' });
    expect(fs.existsSync(IDLE_OWED())).toBe(true);
    runHook('notification', notify('permission_prompt'), { SPARROW_NOTE_BUDGET: '2' });
    expect(fs.existsSync(IDLE_OWED())).toBe(false);

    holder.kill('SIGKILL');
    await waitExit(holder);

    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    const posts = statusPosts();
    expect(posts.some((p) => p.body.includes('"state":"idle"'))).toBe(false);
    expect(noteOf(posts[posts.length - 1]!)).toBe('blocked — needs your input');
  }, 40_000);

  it('an INCOMPLETE idle leaves both the owed flag and the markers', () => {
    writeLoopState('engaged');
    stubCurl({ fail: true }); // the rooms listing cannot even be made
    runHook('stop', '{"hook_event_name":"Stop"}');
    expect(fs.existsSync(IDLE_OWED())).toBe(true);
    expect(pendingCount()).toBeGreaterThan(0);
    expect(fs.existsSync(NOTE_STAMP())).toBe(false);

    // …and the next hook to take the lock finishes the job.
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const posts = statusPosts();
    expect(posts[posts.length - 1]!.body).toContain('"state":"idle"');
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('idle');
    expect(fs.existsSync(IDLE_OWED())).toBe(false);
    expect(pendingCount()).toBe(0);
  });
});

/* ===== DEFECT 6: THE SWEEP MUST BOUND STORAGE, NOT DISCARD THE DEBT ======== *
 * Coordinator, third round. A marker carries no note — it carries the single
 * fact "a publication is owed", and the body is composed from CURRENT state at
 * publish time. So age says nothing about whether the publication is still
 * owed, and deleting markers on age destroyed the only repair signal there was:
 * after an outage the sweep cleared the debt, the absent-stamp rule made the
 * backstop stand down, the repair step found nothing owed, and a live subagent
 * was never shown at all.
 * ========================================================================== */
describe('sparrow-auto-status.sh — the sweep coalesces the debt, it does not drop it', () => {
  const ageFile = (p: string, seconds: number): void => {
    const when = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(p, when, when);
  };

  it('still publishes a live subagent after an outage longer than the threshold', () => {
    writeLoopState('engaged');
    // The listing fails, so markers are written and no stamp is ever created.
    stubCurl({ fail: true });
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(fs.existsSync(NOTE_STAMP())).toBe(false);
    expect(pendingCount()).toBeGreaterThan(0);

    // The outage lasts past the sweep threshold.
    for (const n of pendingNames()) ageFile(path.join(PENDING_DIR(), n), 2 * 3600);

    // The network comes back and an ordinary tool call runs.
    stubCurl();
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');

    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0); // a status IS posted
    expect((/"note":"([^"]*)"/.exec(posts[posts.length - 1]!.body) ?? [])[1]).toBe(
      'working (1 subagent: explore)', // …and it names the live subagent
    );
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    expect(pendingCount()).toBe(0); // the debt is acknowledged, not discarded
  });

  it('collapses many aged markers to exactly one rather than keeping them all', () => {
    writeLoopState('engaged');
    stubCurl();
    // A usage limit stands, so nothing can publish: what is left is the sweep.
    writeMarker('20260918T000000-1.json', { at: new Date().toISOString() });
    for (let i = 0; i < 12; i += 1) {
      stampPending(`aged-${i}`);
      ageFile(path.join(PENDING_DIR(), `aged-${i}`), 2 * 3600);
    }
    stampPending('fresh-one');
    expect(pendingCount()).toBe(13);

    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');

    // Twelve aged markers became one; the fresh one is untouched.
    expect(pendingNames()).toHaveLength(2);
    expect(pendingNames()).toContain('fresh-one');
    expect(pendingNames().filter((n) => n.startsWith('aged-'))).toEqual([]);
  });

  it('the coalesced marker is not itself swept on the next run', () => {
    writeLoopState('engaged');
    stubCurl();
    writeMarker('20260918T000000-1.json', { at: new Date().toISOString() });
    stampPending('aged-one');
    ageFile(path.join(PENDING_DIR(), 'aged-one'), 2 * 3600);

    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(pendingNames()).toHaveLength(1);
    const coalesced = pendingNames()[0]!;
    expect(coalesced).not.toBe('aged-one');

    // A second run must not reduce it to nothing: the debt has no way to reach
    // zero except by being published.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(pendingNames()).toEqual([coalesced]);
  });
});

/* ===== DEFECT 7: A FAILED RESPONSE DOES NOT PROVE THE WRITE DID NOT LAND === *
 * Reviewer, fourth round, against a real local HTTP server. Baseline body A
 * succeeds everywhere; the server then APPLIES body B and drops the connection
 * before replying; the desired state reverts to A. With divergence marked only
 * after a confirmed delivery, nothing was marked — the client saw a failure and
 * concluded no room's contents had changed — so the next publisher found A equal
 * to the stamp, posted nothing, acknowledged everything, and the room held B
 * forever. Precisely the defect 4 failure, reintroduced by trusting a failure
 * response to prove a negative.
 *
 * A timeout, a dropped connection and a lost response are indistinguishable from
 * a refusal at the client, so ANY dispatched write makes divergence possible and
 * only confirmed delivery everywhere makes it impossible.
 * ========================================================================== */
describe('sparrow-auto-status.sh — a write that may have landed counts as divergence', () => {
  const applied = () => path.join(stubBin, 'server-applied.log');

  /** A curl whose status POSTs APPLY the body (recording it) and then fail
   * without replying — the ambiguous outcome a client cannot tell from a
   * refusal. The room listing and presence behave normally. */
  function stubCurlAppliesThenDrops(): void {
    const body = `#!/bin/sh
url=; data=; prev=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; [ "$prev" = "-d" ] && data=$a; prev=$a; done
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$CURL_LOG"
case "$url" in
  */me/rooms) printf '%s' "$ROOMS_JSON"; exit 0 ;;
  */status)
    # The server APPLIES it, then the connection drops before the reply.
    printf '%s %s\\n' "$url" "$data" >> '${applied()}'
    exit 22
    ;;
esac
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  const noteOf = (e: { body: string }): string => (/"note":"([^"]*)"/.exec(e.body) ?? [])[1] ?? '';
  const serverHolds = (): string =>
    fs.existsSync(applied()) ? fs.readFileSync(applied(), 'utf8').trim().split('\n').pop()! : '';

  it('republishes after an applied-but-unacknowledged write, even on a revert', () => {
    writeLoopState('engaged');
    stubCurl();

    // Baseline: A, delivered and confirmed everywhere.
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
    expect(fs.existsSync(DIVERGED())).toBe(false);
    expect(pendingCount()).toBe(0);

    // B is applied by the server; the response never arrives.
    stubCurlAppliesThenDrops();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_2', 'code-review'));
    expect(serverHolds()).toContain('working (2 subagents: code-review, explore)');
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working (1 subagent: explore)'); // unmoved
    expect(pendingCount()).toBeGreaterThan(0);
    // The client cannot know the write landed — so it must assume it might have.
    expect(fs.existsSync(DIVERGED())).toBe(true);

    // The state reverts to exactly what the stamp says.
    stubCurl();
    const before = statusPosts().length;
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_2', 'code-review'));

    // It is republished anyway, to every room, rather than skipped.
    const after = statusPosts().slice(before);
    expect(after.length).toBe(2);
    for (const p of after) expect(noteOf(p)).toBe('working (1 subagent: explore)');
    expect(fs.existsSync(DIVERGED())).toBe(false);
    expect(pendingCount()).toBe(0);
  });

  it('marks divergence even when NOT ONE write was confirmed', () => {
    // The case the old `_ps_sent > 0` rule got backwards: every response failed,
    // so nothing was confirmed — and every one of those writes may have landed.
    writeLoopState('engaged');
    stubCurlAppliesThenDrops();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(statusPosts().length).toBeGreaterThan(0);
    expect(fs.existsSync(DIVERGED())).toBe(true);
    expect(fs.existsSync(NOTE_STAMP())).toBe(false);
    expect(pendingCount()).toBeGreaterThan(0);
  });

  it('the ordinary case sets and clears it on the same pass, leaving nothing behind', () => {
    // The flag is set on the first POST of every fan-out, so the thing to prove
    // is that a confirmed fan-out does not leave it standing.
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(statusPosts().length).toBe(2);
    expect(fs.existsSync(DIVERGED())).toBe(false);
    expect(pendingCount()).toBe(0);

    // …and a second, entirely ordinary hook still posts nothing extra.
    const before = statusPosts().length;
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBe(before);
    expect(fs.existsSync(DIVERGED())).toBe(false);
  });
});

/* ===================== A BOUNDED `working` ================================= *
 * Observed 2026-09-24: the Stop hook set idle, three minutes later `working`
 * was re-posted with no turn running, and nothing cleared it for 2.5 hours —
 * the human saw "working" on an idle agent. Whatever re-posted it, a sticky
 * `working` from prompt/post-tool has no timer and lapses only on idle. So the
 * ordinary `working` is TTL'd (600s, the server max) and every throttled
 * post-tool tick re-posts the SAME note to keep a live turn alive (same text,
 * so `sinceAt` is preserved). Sticky is kept only where no tool call can fire
 * to refresh it — a running subagent — and where a human must see the note: a
 * blocked ask or a usage limit.
 * =========================================================================== */
describe('sparrow-auto-status.sh — a bounded working status', () => {
  const isTtl = (body: string): boolean => body.includes('"ttlSeconds":600') && !body.includes('"sticky"');
  const isSticky = (body: string): boolean => body.includes('"sticky":true') && !body.includes('ttlSeconds');
  /** Pretend the last note publication happened `ageSeconds` ago. */
  const ageNoteStamp = (ageSeconds: number): void => {
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(NOTE_STAMP(), when, when);
  };
  const ageThrottle = (ageSeconds: number): void => {
    const f = path.join(stateDir, 'auto-status-post');
    if (!fs.existsSync(f)) return;
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(f, when, when);
  };

  it('prompt posts working with ttlSeconds 600 and NOT sticky', () => {
    writeLoopState('engaged');
    writeHeartbeat('await');
    stubCurl();
    runHook('prompt', '{"prompt":"go"}');
    const posts = statusPosts();
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.body).toContain('"state":"working"');
      expect(p.body).toContain('"note":"working"');
      expect(isTtl(p.body)).toBe(true);
    }
  });

  it('post-tool re-posts the current note with the TTL on the throttle, never changing its text', () => {
    writeLoopState('engaged');
    writeHeartbeat('await');
    stubCurl();
    runHook('prompt', '{"prompt":"go"}');
    const afterPrompt = statusPosts().length;

    // Straight after the prompt the note is fresh: presence only.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBe(afterPrompt);

    // Later in the same turn: the throttle has elapsed and the note is ageing.
    ageNoteStamp(60);
    ageThrottle(60);
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    const refresh = statusPosts().slice(afterPrompt);
    expect(refresh).toHaveLength(2);
    for (const p of refresh) {
      expect(p.body).toContain('"note":"working"'); // same text: sinceAt survives
      expect(isTtl(p.body)).toBe(true);
    }
    expect(fs.readFileSync(NOTE_STAMP(), 'utf8')).toBe('working');

    // Inside the throttle window again: nothing more.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBe(afterPrompt + 2);
  });

  it('post-tool never refreshes a note it did not see posted, nor an idle one', () => {
    writeLoopState('engaged');
    stubCurl();
    // No stamp at all: a tool call must not start writing the status.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts()).toHaveLength(0);
    // After a stop the stamp reads idle; the resume handshake owns the comeback,
    // and once it has run, an idle stamp is never "refreshed" into working.
    fs.writeFileSync(NOTE_STAMP(), 'idle');
    ageNoteStamp(60);
    ageThrottle(60);
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts()).toHaveLength(0);
  });

  it('subagent-start is sticky; the last subagent-stop goes back to the TTL', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const start = statusPosts();
    expect(start.length).toBeGreaterThan(0);
    for (const p of start) expect(isSticky(p.body)).toBe(true);

    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_1', 'explore'));
    const stop = statusPosts().slice(start.length);
    expect(stop.length).toBeGreaterThan(0);
    for (const p of stop) {
      expect(p.body).toContain('"note":"working"');
      expect(isTtl(p.body)).toBe(true);
    }
  });

  it('a subagent-stop that leaves others running keeps the summary sticky', () => {
    writeLoopState('engaged');
    writeSubagent('ag_2', 'code-review');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const before = statusPosts().length;
    runHook('subagent-stop', subagentPayload('SubagentStop', 'ag_1', 'explore'));
    const stop = statusPosts().slice(before);
    expect(stop.length).toBeGreaterThan(0);
    for (const p of stop) {
      expect(p.body).toContain('"note":"working (1 subagent: code-review)"');
      expect(isSticky(p.body)).toBe(true);
    }
  });

  it('the post-tool refresh of a subagent note stays sticky', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    const before = statusPosts().length;
    ageNoteStamp(60);
    ageThrottle(60);
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    const refresh = statusPosts().slice(before);
    expect(refresh.length).toBeGreaterThan(0);
    for (const p of refresh) expect(isSticky(p.body)).toBe(true);
  });

  it('a blocked ask stays sticky', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('permission_prompt'));
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.body).toContain('blocked');
      expect(isSticky(p.body)).toBe(true);
    }
  });

  it('a resumed quota is ordinary work: TTL, not sticky', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('notification', notify('quota_auto_resume_fired'));
    const posts = statusPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(isTtl(p.body)).toBe(true);
  });

  it('stop still posts idle everywhere', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('prompt', '{"prompt":"go"}');
    const before = statusPosts().length;
    runHook('stop');
    const idle = statusPosts().slice(before);
    expect(idle).toHaveLength(2);
    for (const p of idle) expect(p.body).toBe('{"state":"idle"}');
  });
});
