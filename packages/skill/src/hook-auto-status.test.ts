/**
 * Behavioral test for the shipped auto-status shell hook, exercised through a
 * real POSIX `sh` in an isolated HOME/state dir with a stub `curl` on PATH that
 * RECORDS every request (method + url + body) and answers `GET /me/rooms`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  for (const type of ['auth_success', 'elicitation_complete', 'quota_auto_resume_fired', 'brand_new_type']) {
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
    expect(lines[0]).toContain('sparrow await --timeout 900');
    expect(lines[0]).toContain('sparrow skill pause');
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
    expect(out).toContain('sparrow await --timeout 900');
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
    expect(out).toContain('sparrow await --timeout 900');
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
