/**
 * Behavioral test for the shipped Stop-hook shell script, exercised through a
 * real POSIX `sh` in an isolated HOME/state dir with a stub `curl` on PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'hooks',
  'sparrow-stop-check.sh',
);

let stateDir: string;
let home: string;
let stubBin: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-hook-state-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-hook-home-'));
  stubBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-hook-bin-'));
});

afterEach(() => {
  for (const d of [stateDir, home, stubBin]) fs.rmSync(d, { recursive: true, force: true });
});

function writeLoopState(state: string): void {
  fs.writeFileSync(path.join(stateDir, 'loop-state'), `${state}\n`);
}

/**
 * Create a heartbeat file whose mtime is `ageSeconds` in the past. `content` is
 * what the listener wrote — the listener kind (`await` | `watch` | `loop`), or
 * '' for a legacy/third-party heartbeat that claims nothing.
 */
function writeHeartbeat(ageSeconds: number, content = ''): void {
  const f = path.join(stateDir, 'heartbeat');
  fs.writeFileSync(f, content ? `${content}\n` : '');
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(f, when, when);
}

/** Install a stub `curl` on PATH (real `node`, `sh`, coreutils remain). */
function stubCurl(body: string, exitCode = 0): void {
  const script =
    exitCode === 0
      ? `#!/bin/sh\nprintf '%s' '${body}'\n`
      : `#!/bin/sh\nexit ${exitCode}\n`;
  const p = path.join(stubBin, 'curl');
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
}

const ROOMS_JSON = JSON.stringify({
  items: [
    { room: { id: 'rom_a', archivedAt: null }, memberId: 'mem_a', roomRole: 'member' },
    { room: { id: 'rom_b', archivedAt: null }, memberId: 'mem_b', roomRole: 'member' },
  ],
});

/** Recording stub `curl` that logs each call and answers GET /me/rooms. */
function stubRecordingCurl(): string {
  const curlLog = path.join(stubBin, 'curl.log');
  const body = `#!/bin/sh
method=GET
url=
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; esac; done
case " $* " in *" -X POST "*) method=POST ;; esac
printf '%s %s\\n' "$method" "$url" >> "$CURL_LOG"
case "$url" in */me/rooms) printf '%s' "$ROOMS_JSON" ;; esac
exit 0
`;
  const p = path.join(stubBin, 'curl');
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return curlLog;
}

const idlePosts = (curlLog: string): string[] =>
  fs.existsSync(curlLog)
    ? fs
        .readFileSync(curlLog, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('POST ') && /\/rooms\/[^/]+\/status$/.test(l))
    : [];

interface Run {
  stdout: string;
  code: number;
}

function runHook(
  input = '{}',
  extraEnv: Record<string, string> = {},
): Run {
  const env: Record<string, string> = {
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: home,
    SPARROW_STATE_DIR: stateDir,
    ...extraEnv,
  };
  try {
    const stdout = execFileSync('sh', [SCRIPT], { input, env, encoding: 'utf8' });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? '', code: e.status ?? 1 };
  }
}

describe('sparrow-stop-check.sh', () => {
  it('is silent when loop-state is absent', () => {
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is silent when paused', () => {
    writeLoopState('paused');
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is silent when engaged with a fresh heartbeat', () => {
    writeLoopState('engaged');
    writeHeartbeat(5); // 5s old, well under the 120s window
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is silent when stop_hook_active is true (loop guard)', () => {
    writeLoopState('engaged'); // no heartbeat → would otherwise block
    const r = runHook('{"stop_hook_active":true}');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('emits a block decision when engaged with a stale heartbeat', () => {
    writeLoopState('engaged');
    writeHeartbeat(600); // 10 min old → stale
    const r = runHook();
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.decision).toBe('block');
    expect(json.reason).toMatch(/engaged but no listener is running/);
    expect(json.reason).toMatch(/sparrow skill pause/);
    expect(json.reason).toMatch(/sparrow-skill pause/);
    // Honest about scope: what it checks is that a LISTENER is alive, and the
    // turn-based fix is a re-armed wake command, not just any listener.
    expect(json.reason).toMatch(/sparrow await/);
  });

  it('emits a block decision when engaged with no heartbeat at all', () => {
    writeLoopState('engaged');
    const r = runHook();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).decision).toBe('block');
  });

  it('enriches the reason with an unread count from the API', () => {
    writeLoopState('engaged');
    stubCurl('{"items":[{"id":"msg_1"},{"id":"msg_2"}],"nextCursor":null}');
    const r = runHook('{}', {
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).reason).toMatch(/\+ 2 unread/);
  });

  it('still exits 0 and blocks when the API call fails', () => {
    writeLoopState('engaged');
    stubCurl('', 22); // curl failure
    const r = runHook('{}', {
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
    });
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.decision).toBe('block');
    // No count available → no unread suffix.
    expect(json.reason).not.toMatch(/unread/);
  });

  // --- auto-status interplay: idle fires on ALLOW, never on BLOCK ---
  it('sets idle across rooms on a non-blocking (allowed) stop', () => {
    writeLoopState('engaged');
    writeHeartbeat(5); // fresh → allow the stop
    const curlLog = stubRecordingCurl();
    const r = runHook('{}', {
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      CURL_LOG: curlLog,
      ROOMS_JSON,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(''); // allowed silently
    const posts = idlePosts(curlLog);
    expect(posts.some((l) => l.includes('/rooms/rom_a/status'))).toBe(true);
    expect(posts.some((l) => l.includes('/rooms/rom_b/status'))).toBe(true);
  });

  // --- the wake-path check: a fresh heartbeat is not enough on its own ---
  it('is silent when the fresh heartbeat is from await (a real wake path)', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'await');
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it.each(['watch', 'loop'] as const)(
    'blocks when the fresh heartbeat is from %s (holds you online, cannot wake you)',
    (kind) => {
      writeLoopState('engaged');
      writeHeartbeat(5, kind);
      const r = runHook();
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout);
      expect(json.decision).toBe('block');
      // Names the listener that IS alive, and why that is not enough.
      expect(json.reason).toContain(kind);
      expect(json.reason).toMatch(/never wake|cannot wake/i);
      // Prescribes the wake path and the sanctioned off-switch.
      expect(json.reason).toContain('sparrow await --timeout 900');
      expect(json.reason).toMatch(/sparrow skill pause/);
      // Not the drift message — this listener is alive.
      expect(json.reason).not.toMatch(/no listener is running/);
    },
  );

  it('allows an always-running agent to keep watch/loop by pausing or retrying (stop_hook_active)', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'watch');
    const r = runHook('{"stop_hook_active":true}');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is silent for a fresh legacy heartbeat with no kind (cannot judge)', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, ''); // older CLI / hand-rolled script
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is silent for a fresh heartbeat with unrecognized content', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'my-own-curl-loop');
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('enriches the hold-only block with the unread count too', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'watch');
    stubCurl('{"items":[{"id":"msg_1"},{"id":"msg_2"},{"id":"msg_3"}],"nextCursor":null}');
    const r = runHook('{}', {
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
    });
    expect(JSON.parse(r.stdout).reason).toMatch(/\+ 3 unread/);
  });

  it('does NOT set idle on a hold-only block', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'loop');
    const curlLog = stubRecordingCurl();
    const r = runHook('{}', {
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      CURL_LOG: curlLog,
      ROOMS_JSON,
    });
    expect(JSON.parse(r.stdout).decision).toBe('block');
    expect(idlePosts(curlLog)).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ *
   * The killed/stopped stamps.
   *
   * A Claude Code session interrupt (Esc / Ctrl-C) kills the tracked background
   * `sparrow await` — SIGTERM at the whole process tree. The heartbeat it last
   * touched then stays FRESH for the full 120s window, so this hook allowed the
   * next turn to end in silence while the agent was already deaf; that ended
   * three production sessions in one day. A dying listener now stamps the
   * heartbeat, and the stamp beats freshness in both directions.
   * ------------------------------------------------------------------ */
  describe('a listener that stamped the heartbeat on its way out', () => {
    it.each([
      ['killed:SIGTERM', 'SIGTERM'],
      ['killed:SIGHUP', 'SIGHUP'],
    ])('blocks a FRESH %s heartbeat, naming the signal', (content, signal) => {
      writeLoopState('engaged');
      writeHeartbeat(2, content); // fresh — the whole point
      const r = runHook();
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(/was killed/);
      expect(json.reason).toContain(signal);
      expect(json.reason).toContain('sparrow await --timeout 900');
      expect(json.reason).toMatch(/sparrow skill pause/);
      // Not the hold-only message — nothing is alive here.
      expect(json.reason).not.toMatch(/holds you online/);
    });

    it('blocks a FRESH stopped:SIGINT heartbeat as a deliberate Ctrl-C', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'stopped:SIGINT');
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(/was stopped \(Ctrl-C\)/);
      expect(json.reason).toContain('sparrow await --timeout 900');
      expect(json.reason).toMatch(/sparrow skill pause/);
    });

    it.each(['killed', 'stopped'])('blocks a STALE %s heartbeat too', (word) => {
      writeLoopState('engaged');
      writeHeartbeat(600, word);
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(word === 'killed' ? /was killed/ : /was stopped/);
    });

    it('handles a bare `killed` with no signal suffix (older CLI)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed');
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(/was killed \(usually a session interrupt\)/);
    });

    it('enriches the killed block with the unread count', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIGTERM');
      stubCurl('{"items":[{"id":"msg_1"}],"nextCursor":null}');
      const r = runHook('{}', {
        SPARROW_SERVER: 'https://example.test',
        SPARROW_TOKEN: 'agk_test',
      });
      expect(JSON.parse(r.stdout).reason).toMatch(/\+ 1 unread/);
    });

    it('does NOT set idle on a killed block (the turn is not really over)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIGTERM');
      const curlLog = stubRecordingCurl();
      const r = runHook('{}', {
        SPARROW_SERVER: 'https://example.test',
        SPARROW_TOKEN: 'agk_test',
        CURL_LOG: curlLog,
        ROOMS_JSON,
      });
      expect(JSON.parse(r.stdout).decision).toBe('block');
      expect(idlePosts(curlLog)).toHaveLength(0);
    });

    it('still never wedges: stop_hook_active allows even a killed heartbeat', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIGTERM');
      const r = runHook('{"stop_hook_active":true}');
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('stays silent when paused, whatever the stamp says', () => {
      writeLoopState('paused');
      writeHeartbeat(2, 'killed:SIGTERM');
      const r = runHook();
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('emits valid JSON even for a stamp carrying junk in the signal slot', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIG"TERM');
      const r = runHook();
      expect(() => JSON.parse(r.stdout)).not.toThrow();
      expect(JSON.parse(r.stdout).decision).toBe('block');
    });
  });

  it('does NOT set idle on a blocked stop (loop drift)', () => {
    writeLoopState('engaged'); // stale/no heartbeat → block
    const curlLog = stubRecordingCurl();
    const r = runHook('{}', {
      SPARROW_SERVER: 'https://example.test',
      SPARROW_TOKEN: 'agk_test',
      CURL_LOG: curlLog,
      ROOMS_JSON,
    });
    expect(JSON.parse(r.stdout).decision).toBe('block');
    expect(idlePosts(curlLog)).toHaveLength(0);
  });
});

/**
 * WHOSE credentials the hook speaks with. Three agents share one unix user (and
 * one `~/.config/sparrow/credentials.json`) while working in different
 * workspaces, so the hook must resolve the SAME profile the agent's commands
 * use: `SPARROW_SERVER`+`SPARROW_TOKEN` from the env first, else the profile
 * named by `SPARROW_PROFILE` (which a project-scope install stamps into the hook
 * command), else `defaultProfile`.
 *
 * The sharp edge is a NAMED-but-missing profile: falling back to the default
 * there would make the hook count somebody else's inbox — so it resolves
 * nothing and stays silent about unread.
 */
describe('sparrow-stop-check.sh — credential profile resolution', () => {
  let xdg: string;
  let authLog: string;

  /** A stub curl that records the `authorization:` header of every call. */
  function stubAuthRecordingCurl(items = 2): void {
    const body = `#!/bin/sh
for a in "$@"; do
  case "$a" in authorization:*) printf '%s\\n' "$a" >> "$AUTH_LOG" ;; esac
done
printf '%s' '{"items":[${Array.from({ length: items }, (_, i) => `{"id":"m${i}"}`).join(',')}]}'
exit 0
`;
    const p = path.join(stubBin, 'curl');
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  function writeCreds(creds: unknown): void {
    fs.mkdirSync(path.join(xdg, 'sparrow'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'sparrow', 'credentials.json'), JSON.stringify(creds));
  }

  const auths = (): string[] =>
    fs.existsSync(authLog) ? fs.readFileSync(authLog, 'utf8').trim().split('\n').filter(Boolean) : [];

  beforeEach(() => {
    xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-hook-xdg-'));
    authLog = path.join(stubBin, 'auth.log');
    writeCreds({
      profiles: {
        alpha: { server: 'https://alpha.test', token: 'agk_alpha', kind: 'agent' },
        beta: { server: 'https://beta.test', token: 'agk_beta', kind: 'agent' },
      },
      defaultProfile: 'beta',
    });
    stubAuthRecordingCurl();
  });
  afterEach(() => fs.rmSync(xdg, { recursive: true, force: true }));

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    XDG_CONFIG_HOME: xdg,
    AUTH_LOG: authLog,
    ...extra,
  });

  it('uses the default profile when no profile is named', () => {
    writeLoopState('engaged');
    const r = runHook('{}', env());
    expect(JSON.parse(r.stdout).reason).toMatch(/\+ 2 unread/);
    expect(auths()).toEqual(['authorization: Bearer agk_beta']);
  });

  it('uses the profile named by SPARROW_PROFILE, not the default', () => {
    writeLoopState('engaged');
    const r = runHook('{}', env({ SPARROW_PROFILE: 'alpha' }));
    expect(JSON.parse(r.stdout).reason).toMatch(/\+ 2 unread/);
    expect(auths()).toEqual(['authorization: Bearer agk_alpha']);
  });

  it('resolves NOTHING for a named-but-missing profile (never falls back to the default)', () => {
    writeLoopState('engaged');
    const r = runHook('{}', env({ SPARROW_PROFILE: 'gamma' }));
    const json = JSON.parse(r.stdout);
    // Still blocks (the loop drift is real) — it just cannot count unread.
    expect(json.decision).toBe('block');
    expect(json.reason).not.toMatch(/unread/);
    expect(auths()).toEqual([]);
  });

  it('env SPARROW_SERVER/SPARROW_TOKEN still win over every profile', () => {
    writeLoopState('engaged');
    const r = runHook(
      '{}',
      env({
        SPARROW_PROFILE: 'alpha',
        SPARROW_SERVER: 'https://env.test',
        SPARROW_TOKEN: 'agk_env',
      }),
    );
    expect(JSON.parse(r.stdout).reason).toMatch(/\+ 2 unread/);
    expect(auths()).toEqual(['authorization: Bearer agk_env']);
  });
});
