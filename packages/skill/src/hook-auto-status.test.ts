/**
 * Behavioral test for the shipped auto-status shell hook, exercised through a
 * real POSIX `sh` in an isolated HOME/state dir with a stub `curl` on PATH that
 * RECORDS every request (method + url + body) and answers `GET /me/rooms`.
 */
import { execFileSync, spawn } from 'node:child_process';
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

describe('sparrow-auto-status.sh — prompt mode', () => {
  it('sets a sticky working status in every non-archived room', () => {
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
      expect(p.body).toContain('"sticky":true');
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

    // ...and the next tool call still restores sticky working.
    const before = statusPosts().length;
    runHook('post-tool');
    const working = statusPosts().slice(before);
    expect(working.length).toBe(2);
    for (const p of working) {
      expect(p.body).toContain('"state":"working"');
      expect(p.body).toContain('"sticky":true');
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
 * and the FIRST post-tool of the next turn restores sticky `working`.
 */
describe('sparrow-auto-status.sh — idle→working resume handshake', () => {
  it('stop leaves a marker; the next post-tool restores sticky working and clears it', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('stop');
    expect(fs.existsSync(path.join(stateDir, 'auto-status-idle'))).toBe(true);

    runHook('post-tool');
    const posts = statusPosts();
    // idle (from stop) + one working restore per active room.
    const working = posts.filter((p) => p.body.includes('"working"'));
    expect(working.length).toBe(2); // rom_a + rom_b, never archived rom_z
    for (const p of working) expect(p.body).toMatch(/"sticky":true/);
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

  it('still writes the sticky working status alongside the nudge', () => {
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
        expect(p.body).toContain('"sticky":true');
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
    // Nothing left owing: the handoff token was cleared by whoever published last.
    expect(fs.existsSync(path.join(stateDir, 'auto-status-pending'))).toBe(false);
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
    runHook('notification', notify('permission_prompt'));
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

/* ===================== THE HANDOFF TOKEN ================================== *
 * A bounded publisher can drop the LAST mutation: with three rounds, a fourth
 * marker arriving during round three is seen, the loop exits, and if every other
 * hook has given up, nobody publishes it. So the round cap bounds one hook's
 * WORK, and the token carries correctness: every mutation stamps it before AND
 * after, a publisher clears it only when the value is exactly the one it
 * observed before composing, and any later hook that finds it set publishes.
 *
 * What that buys is EVENTUAL repair, not immediate correctness — a
 * `SubagentStop` can be delayed for a whole task or never arrive after a crash.
 * Until a later hook runs, the note may be stale and the token says so.
 * ========================================================================== */
describe('sparrow-auto-status.sh — the handoff token', () => {
  const TOKEN = () => path.join(stateDir, 'auto-status-pending');
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
  const hookEnv = (): Record<string, string> => ({
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: home,
    SPARROW_STATE_DIR: stateDir,
    CURL_LOG: curlLog,
    ROOMS_JSON,
    SPARROW_SERVER: 'https://example.test',
    SPARROW_TOKEN: 'agk_test',
  });

  it('is cleared by a normal single-hook post', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(fs.existsSync(TOKEN())).toBe(false);
    expect(fs.readFileSync(STAMP(), 'utf8')).toBe('working (1 subagent: explore)');
  });

  /** MUTATION-THEN-CLEAR: a publisher must not clear a token newer than the one
   * it observed — even though it posted in between. */
  it('does not clear a token stamped by a mutation that landed mid-post', async () => {
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
    fs.writeFileSync(TOKEN(), 'later-1');
    writeSubagent('ag_Z', 'code-review');
    fs.writeFileSync(TOKEN(), 'later-2');

    fs.rmSync(flag, { force: true });
    await waitExit(a);

    // A saw the newer token, went round again, and published the truth.
    const posted = notes();
    expect(posted[posted.length - 1]).toBe('working (2 subagents: code-review, explore)');
    expect(fs.existsSync(TOKEN())).toBe(false);
  }, 40_000);

  /** CLEAR-THEN-MUTATION: a mutation after a publisher cleared must re-set it,
   * and be repaired by the next hook rather than lost. */
  it('is re-set by a mutation that lands after a clear, and repaired later', () => {
    writeLoopState('engaged');
    stubCurl();
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_1', 'explore'));
    expect(fs.existsSync(TOKEN())).toBe(false);

    // A mutation that cannot publish: a usage limit stands, so the gate stops it
    // before any post. The token must be left behind as the record.
    writeMarker('20260917T180000-1.json', { at: new Date().toISOString() });
    runHook('subagent-start', subagentPayload('SubagentStart', 'ag_2', 'code-review'));
    expect(fs.existsSync(TOKEN())).toBe(true);
    expect(fs.readFileSync(STAMP(), 'utf8')).toBe('working (1 subagent: explore)'); // stale, and says so

    // The block clears; the next hook — whatever its mode — repairs the note.
    fs.rmSync(path.join(stateDir, 'blocked'), { recursive: true, force: true });
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(notes()[notes().length - 1]).toBe('working (2 subagents: code-review, explore)');
    expect(fs.existsSync(TOKEN())).toBe(false);
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
    expect(fs.existsSync(TOKEN())).toBe(false);
  }, 60_000);

  it('a queued waiter posts nothing when the body already matches the stamp', async () => {
    writeLoopState('engaged');
    stubCurl();
    writeSubagent('ag_1', 'explore');
    // Publish once so the stamp is current.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    const before = statusPosts().length;
    expect(before).toBeGreaterThan(0);
    // A second hook with nothing to change must add no post at all.
    runHook('post-tool', '{"hook_event_name":"PostToolUse"}');
    expect(statusPosts().length).toBe(before);
  });
});
