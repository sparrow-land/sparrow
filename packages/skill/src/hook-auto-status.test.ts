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
