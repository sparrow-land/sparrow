/**
 * Behavioral test for the shipped Stop-hook shell script, exercised through a
 * real POSIX `sh` in an isolated HOME/state dir with a stub `curl` on PATH.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { awaitCommand } from './listener.js';

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

  it('is silent for a fresh await:codex heartbeat under Codex', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'await:codex');
    const r = runHook('{}', { CODEX_THREAD_ID: 'thread-123' });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('blocks a passive await heartbeat under Codex and prescribes an unbounded re-arm', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'await');
    const r = runHook('{}', { CODEX_THREAD_ID: 'thread-123' });
    const json = JSON.parse(r.stdout);
    expect(json.decision).toBe('block');
    expect(json.reason).toContain('passive');
    expect(json.reason).toContain('await:codex');
    expect(json.reason).toContain('run sparrow await as a tracked background task');
    expect(json.reason).not.toContain('--timeout');
  });

  /* ---------------- profile-qualified nudges (shared prescription) ----------------
   * A machine hosting several agents shares one credentials.json, so a bare
   * `sparrow await` typed into a fresh shell acts as whichever neighbour owns
   * defaultProfile. A project-scope install stamps SPARROW_PROFILE into the hook
   * command; when it is there the nudge must name it — and must render EXACTLY
   * what `awaitCommand()` renders, which is the one prescription every other
   * surface uses too.
   */
  it('names SPARROW_PROFILE in every re-arm it prescribes, identically to awaitCommand()', () => {
    const want = awaitCommand({ profile: 'cubes-vm4-codex' });
    expect(want).toBe('sparrow await --profile cubes-vm4-codex');
    for (const [heartbeat, extraEnv] of [
      ['killed:SIGTERM', {}],
      ['watch', {}],
      ['await', { CODEX_THREAD_ID: 'thread-123' }],
    ] as const) {
      writeLoopState('engaged');
      writeHeartbeat(5, heartbeat);
      const r = runHook('{}', { ...extraEnv, SPARROW_PROFILE: 'cubes-vm4-codex' });
      const json = JSON.parse(r.stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain(want);
      // No bare `sparrow await` survives anywhere in the reason.
      expect(json.reason.replace(new RegExp(want, 'g'), '')).not.toContain('sparrow await');
    }
    // The drift branch (no heartbeat at all) too.
    fs.rmSync(path.join(stateDir, 'heartbeat'), { force: true });
    const drift = JSON.parse(runHook('{}', { SPARROW_PROFILE: 'cubes-vm4-codex' }).stdout);
    expect(drift.reason).toContain(want);
  });

  it('stays byte-identical to the old bare command when no profile is stamped', () => {
    writeLoopState('engaged');
    writeHeartbeat(5, 'watch');
    const r = runHook();
    const json = JSON.parse(r.stdout);
    expect(json.reason).toContain(`Run ${awaitCommand()} as a tracked background task`);
    expect(json.reason).not.toContain('--profile');
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
      // Prescribes the wake path (unbounded — the CLI owns its own liveness)
      // and the sanctioned off-switch.
      expect(json.reason).toContain('sparrow await');
      expect(json.reason).not.toContain('--timeout 900');
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
      expect(json.reason).toContain('sparrow await');
      expect(json.reason).not.toContain('--timeout 900');
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
      expect(json.reason).toContain('sparrow await');
      expect(json.reason).not.toContain('--timeout 900');
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

    const writeOwner = (nonce: string): void =>
      fs.writeFileSync(
        path.join(stateDir, 'await-owner.json'),
        `${JSON.stringify({ version: 1, nonce, pid: 4242, startedAt: '2026-09-09T00:00:00.000Z', kind: 'await' })}\n`,
      );

    /* ---------------------------------------------------------------- *
     * GENERATION-TAGGED STAMPS. Arming `sparrow await` supersedes the
     * previous listener (newest wins), and that superseded process can be
     * killed minutes later — its `killed:` stamp then describes a corpse
     * while a healthy successor is listening. So a stamp may name the
     * generation that wrote it, and this hook believes it only while that
     * generation is the live one in `await-owner.json`.
     * ---------------------------------------------------------------- */
    it('trusts a LIVE claim tagged with the live generation (still passive under Codex)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await 4f2c9a01bb33cd10');
      writeOwner('4f2c9a01bb33cd10');
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      const json = JSON.parse(r.stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(/no verified queue bridge/);
    });

    it('IGNORES a LIVE claim from a superseded generation instead of inheriting it', () => {
      // The demotion this tag prevents: a stale plain `await` claim landing on
      // top of a live `await:codex` one would block the turn over a bridge the
      // successor demonstrably has.
      writeLoopState('engaged');
      writeHeartbeat(2, 'await 4f2c9a01bb33cd10');
      writeOwner('b0b0b0b0b0b0b0b0');
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(''); // unjudgeable — allow the stop
    });

    it('judges a tagged stamp that names the LIVE generation exactly as before', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIGTERM 4f2c9a01bb33cd10');
      writeOwner('4f2c9a01bb33cd10');
      const r = runHook();
      const json = JSON.parse(r.stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(/was killed/);
      expect(json.reason).toContain('SIGTERM'); // and the nonce never leaks in
      expect(json.reason).not.toContain('4f2c9a01bb33cd10');
    });

    it('IGNORES a stamp from a superseded generation (a successor is listening)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIGTERM 4f2c9a01bb33cd10');
      writeOwner('b0b0b0b0b0b0b0b0'); // a newer listener owns the state dir
      const r = runHook();
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(''); // unjudgeable, not "dead"
    });

    it('judges an UNTAGGED stamp as before, whatever the record says', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIGTERM'); // watch/loop, or a pre-0.1.20 CLI
      writeOwner('b0b0b0b0b0b0b0b0');
      expect(JSON.parse(runHook().stdout).decision).toBe('block');
    });

    it('judges a tagged stamp as before when there is no owner record at all', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'killed:SIGTERM 4f2c9a01bb33cd10');
      const r = runHook();
      const json = JSON.parse(r.stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('SIGTERM');
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

  /* ------------------- the listener process itself is gone ------------------- *
   * THE HOLE THIS CLOSES (incident, 2026-09-16). A Codex agent armed `sparrow
   * await` from a model-run shell command. That command runs inside a PID
   * namespace, so the listener was SIGKILLed the instant the command returned —
   * and SIGKILL is uncatchable, so it stamped NOTHING: no `killed:`, no
   * `stopped:`. The heartbeat it had already written stayed FRESH for the full
   * 120 s window, and this hook read "fresh await:codex" and allowed the stop.
   * The agent went deaf with a green light.
   *
   * So when the heartbeat is fresh AND we would allow, we check whether the
   * process that wrote it still exists — `await-owner.json` records its pid.
   * Only a DEMONSTRABLY absent process blocks: a permission error (the owner may
   * belong to another unix user) is unknown, and unknown always allows.
   *
   * WHAT THE CLAUSE PROVES IS ABSENCE, NOT KILLING (field report from vm8,
   * 2026-09-17). A normal wake-exit, a SIGKILL and a listener that failed at
   * startup are indistinguishable on disk — all three leave a fresh heartbeat
   * and no process — and the remedy is identical for all three: re-arm. So the
   * reason says what was observed and prescribes the fix, and offers the sandbox
   * story only as conditional troubleshooting, never as the detected cause.
   * ------------------------------------------------------------------------- */
  describe('a fresh heartbeat whose listener process is gone', () => {
    const writeOwner = (fields: Record<string, unknown>): void =>
      fs.writeFileSync(
        path.join(stateDir, 'await-owner.json'),
        `${JSON.stringify({ version: 1, startedAt: '2026-09-16T00:00:00.000Z', kind: 'await', ...fields })}\n`,
      );

    /** A pid that is certainly free: spawn `true` and reap it. */
    const deadPid = (): number => {
      const p = execFileSync('sh', ['-c', 'sh -c "exit 0" & p=$!; wait $!; printf %s "$p"'], {
        encoding: 'utf8',
      });
      return Number(p);
    };

    it('BLOCKS a fresh await:codex heartbeat when the owner pid is gone', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      const pid = deadPid();
      writeOwner({ nonce: 'f00d', pid });
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      const json = JSON.parse(r.stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain(`pid ${pid}`);
      expect(json.reason).toMatch(/no longer running/);
      expect(json.reason).toMatch(/heartbeat is still fresh/i);
      expect(json.reason).toContain(`run ${awaitCommand()} as a tracked background task`);
      expect(json.reason).toContain('sparrow pop');
      expect(json.reason).toContain('sparrow skill pause');
    });

    /**
     * THE REGRESSION (vm8, 2026-09-17). `sparrow await` exiting because work
     * arrived is the NORMAL end of a listener's life, and it looks exactly like
     * a SIGKILL from here: fresh heartbeat, no process. Blocking is right — the
     * turn really does end deaf — but telling the agent it "was killed by a
     * sandboxed shell" sends it hunting a sandbox bug that does not exist.
     */
    it('does not accuse anything of killing a listener that simply woke and exited', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await f00d'); // a plain wake-exit under Claude
      const pid = deadPid();
      writeOwner({ nonce: 'f00d', pid });
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('no longer running');
      expect(json.reason).toMatch(/re-arm/i);
      expect(json.reason).not.toMatch(/killed/i);
      expect(json.reason).not.toMatch(/SIGKILL/);
      // The sandbox is offered as a conditional, never asserted.
      expect(json.reason).toMatch(/if a freshly armed listener keeps disappearing/i);
    });

    it('BLOCKS a fresh plain await (Claude) whose owner pid is gone too', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await');
      const pid = deadPid();
      writeOwner({ nonce: 'f00d', pid });
      expect(JSON.parse(runHook().stdout).decision).toBe('block');
    });

    it('allows when the owner pid is ALIVE (this very test process)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d', pid: process.pid });
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows when the owner record names no pid at all (unchanged)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d' });
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows when there is no owner record at all (unchanged)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows a NONCE MISMATCH even with a dead pid (unjudgeable, unchanged)', () => {
      // The heartbeat belongs to a superseded generation; the owner record's pid
      // describes a different listener entirely, so neither can judge the other.
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex 4f2c9a01bb33cd10');
      writeOwner({ nonce: 'b0b0b0b0b0b0b0b0', pid: deadPid() });
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('applies the check when the heartbeat nonce MATCHES the owner', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex 4f2c9a01bb33cd10');
      writeOwner({ nonce: '4f2c9a01bb33cd10', pid: deadPid() });
      const json = JSON.parse(runHook('{}', { CODEX_THREAD_ID: 'thr_1' }).stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).not.toContain('4f2c9a01bb33cd10'); // the nonce never leaks
    });

    it('does not touch a heartbeat it could not judge anyway (empty kind)', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, '');
      writeOwner({ nonce: 'f00d', pid: deadPid() });
      const r = runHook();
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('still never wedges: stop_hook_active allows even a dead-pid heartbeat', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d', pid: deadPid() });
      const r = runHook('{"stop_hook_active":true}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    /* ------------------ the listener that is still STARTING ------------------ *
     * THE RACE (found in review, 2026-09-16). A listener exits on work, the
     * agent re-arms as the last act of the turn, and the new listener publishes
     * its owner record LATE — deliberately: it loads credentials and completes
     * one HTTP round trip before claiming ownership. A Stop hook firing inside
     * that window reads the OLD owner pid, finds it gone, and blocks a turn that
     * is doing exactly the right thing.
     *
     * So the listener drops `<state dir>/await-candidate.json` the instant its
     * process starts, before any network. It is not ownership and it is never
     * unlinked — it is the honest "something is arming" signal. It is NOT
     * evidence of a wake path, only a reason to be PATIENT: the hook then polls
     * for a published owner whose process exists, and blocks if the window
     * expires. That asymmetry is deliberate — a false block costs one
     * self-correcting turn, while a false allow ends the turn with no proven
     * wake path, which is the 11-hour incident itself. The sandbox case cannot
     * fake any of it: there the process is dead, so the candidate names a
     * corpse and the hook blocks at once.
     * ------------------------------------------------------------------------ */
    const writeCandidate = (fields: Record<string, unknown>, ageSeconds = 0): void => {
      const f = path.join(stateDir, 'await-candidate.json');
      fs.writeFileSync(
        f,
        `${JSON.stringify({ version: 1, nonce: 'cand', startedAt: new Date().toISOString(), ...fields })}\n`,
      );
      const when = new Date(Date.now() - ageSeconds * 1000);
      fs.utimesSync(f, when, when);
    };

    it('ALLOWS once the arming listener PUBLISHES ownership within the window', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'cand' });
      // The real thing: credentials, one round trip, then the owner record. The
      // writer must be its own process — execFileSync below blocks node's loop.
      const owner = path.join(stateDir, 'await-owner.json');
      const published = JSON.stringify({ version: 1, nonce: 'newgen', pid: process.pid, kind: 'await' });
      const writer = spawn('sh', ['-c', `sleep 0.3; printf '%s' '${published}' > '${owner}'`], {
        stdio: 'ignore',
        detached: true,
      });
      writer.unref();
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    /* ------------- the replacement is JUDGED, never inherited ------------- *
     * Reviewer case (2026-09-16): the old listener was `await:codex` (a proper
     * wake path) and the replacement comes up as a passive plain `await`. If the
     * wait path just answered "somebody is alive again", the turn would end on
     * the DEAD listener's good name. So when a replacement publishes, the whole
     * judgement is re-run against it: its kind, its freshness, its generation,
     * its own liveness.
     * ---------------------------------------------------------------------- */
    /** Publish a replacement owner (+ optional heartbeat) from a separate process. */
    const publishLater = (owner: Record<string, unknown>, heartbeat?: string, delay = 0.3): void => {
      const ownerPath = path.join(stateDir, 'await-owner.json');
      const hbPath = path.join(stateDir, 'heartbeat');
      const json = JSON.stringify({ version: 1, kind: 'await', ...owner });
      const hb = heartbeat === undefined ? '' : `printf '%s\n' '${heartbeat}' > '${hbPath}'; `;
      const w = spawn('sh', ['-c', `sleep ${delay}; ${hb}printf '%s' '${json}' > '${ownerPath}'`], {
        stdio: 'ignore',
        detached: true,
      });
      w.unref();
    };

    it('BLOCKS when the replacement comes up PASSIVE under Codex', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex aaaa');
      writeOwner({ nonce: 'aaaa', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'bbbb' });
      publishLater({ nonce: 'bbbb', pid: process.pid }, 'await bbbb');
      const json = JSON.parse(runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' }).stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('passive');
    });

    it('BLOCKS when the replacement stamps itself killed while we wait', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex aaaa');
      writeOwner({ nonce: 'aaaa', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'bbbb' });
      publishLater({ nonce: 'bbbb', pid: process.pid }, 'killed:SIGTERM bbbb');
      const json = JSON.parse(runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' }).stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(/was killed/);
      expect(json.reason).toContain('SIGTERM');
    });

    it('ALLOWS when the replacement is a real bridged wake path', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex aaaa');
      writeOwner({ nonce: 'aaaa', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'bbbb' });
      publishLater({ nonce: 'bbbb', pid: process.pid }, 'await:codex bbbb');
      const r = runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('BLOCKS when the replacement publishes but the heartbeat names a THIRD generation', () => {
      // Unjudgeable does not become "allow" here: we are on this path precisely
      // because the previous owner died, so nothing is left to give the benefit
      // of the doubt to.
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex aaaa');
      writeOwner({ nonce: 'aaaa', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'bbbb' });
      publishLater({ nonce: 'bbbb', pid: process.pid }, 'await:codex cccc');
      const json = JSON.parse(runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' }).stdout);
      expect(json.decision).toBe('block');
    });

    it('BLOCKS when the replacement itself is already gone', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex aaaa');
      writeOwner({ nonce: 'aaaa', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'bbbb' });
      const replacement = deadPid();
      publishLater({ nonce: 'bbbb', pid: replacement }, 'await:codex bbbb');
      const json = JSON.parse(runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' }).stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('no longer running');
    });

    it('BLOCKS when the candidate never publishes, after waiting out the window', () => {
      // A candidate is a reason to be PATIENT, never evidence of a wake path.
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'cand' });
      const started = Date.now();
      expect(JSON.parse(runHook('{}', { CODEX_THREAD_ID: 'thr_1' }).stdout).decision).toBe('block');
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThan(1_800);
      expect(elapsed).toBeLessThan(3_000);
    });

    it('BLOCKS immediately when the candidate names the generation that already published', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: 'f00d' }); // == the owner nonce
      const started = Date.now();
      expect(JSON.parse(runHook('{}', { CODEX_THREAD_ID: 'thr_1' }).stdout).decision).toBe('block');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('BLOCKS immediately when the candidate names the heartbeat generation', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex 4f2c9a01bb33cd10');
      writeOwner({ nonce: '4f2c9a01bb33cd10', pid: deadPid() });
      writeCandidate({ pid: process.pid, nonce: '4f2c9a01bb33cd10' });
      const started = Date.now();
      expect(JSON.parse(runHook('{}', { CODEX_THREAD_ID: 'thr_1' }).stdout).decision).toBe('block');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('BLOCKS when the candidate names a dead pid too', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      const pid = deadPid();
      writeOwner({ nonce: 'f00d', pid });
      writeCandidate({ pid: deadPid() });
      const started = Date.now();
      const json = JSON.parse(runHook('{}', { CODEX_THREAD_ID: 'thr_1' }).stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain(`pid ${pid}`);
      expect(Date.now() - started).toBeLessThan(500); // a corpse is not worth waiting for
    });

    it('BLOCKS when the candidate is STALE, live pid or not', () => {
      // A months-old marker from a listener whose pid has since been recycled is
      // not evidence that anything is starting now.
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d', pid: deadPid() });
      writeCandidate({ pid: process.pid }, 600);
      expect(JSON.parse(runHook('{}', { CODEX_THREAD_ID: 'thr_1' }).stdout).decision).toBe('block');
    });

    it('BLOCKS with no candidate at all, without waiting at all', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      writeOwner({ nonce: 'f00d', pid: deadPid() });
      const started = Date.now();
      expect(JSON.parse(runHook('{}', { CODEX_THREAD_ID: 'thr_1' }).stdout).decision).toBe('block');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('ignores a non-numeric pid rather than guessing', () => {
      writeLoopState('engaged');
      writeHeartbeat(2, 'await:codex');
      fs.writeFileSync(
        path.join(stateDir, 'await-owner.json'),
        JSON.stringify({ version: 1, nonce: 'f00d', pid: 'nope' }),
      );
      const r = runHook('{}', { CODEX_THREAD_ID: 'thr_1' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  /* ------------- the runtime the hook thinks it is running under ------------- *
   * MEASURED 2026-09-16: a Codex hook's environment has NO CODEX_THREAD_ID and
   * no CODEX_SESSION_ID. Keying Codex behaviour on that variable therefore made
   * this hook behave like Claude's inside Codex — a passive `await` heartbeat,
   * the exact thing it exists to catch, sailed through. The wrapper now exports
   * SPARROW_HOOK_RUNTIME=codex (and SPARROW_CODEX_THREAD when the payload names
   * a session), and the hook keys on those.
   * ------------------------------------------------------------------------- */
  describe('runtime detection without CODEX_THREAD_ID', () => {
    it('judges a passive await heartbeat as Codex on SPARROW_HOOK_RUNTIME alone', () => {
      writeLoopState('engaged');
      writeHeartbeat(5, 'await');
      const json = JSON.parse(runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' }).stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('passive');
      expect(json.reason).toContain('await:codex');
      expect(json.reason).toContain('Codex');
    });

    it('judges it as Codex on SPARROW_CODEX_THREAD alone too', () => {
      writeLoopState('engaged');
      writeHeartbeat(5, 'await');
      const json = JSON.parse(runHook('{}', { SPARROW_CODEX_THREAD: 'abc-123' }).stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('passive');
    });

    it('names Codex as the runtime it cannot wake, on the wrapper var alone', () => {
      writeLoopState('engaged');
      writeHeartbeat(5, 'watch'); // online-but-deaf: the reason names the runtime
      const json = JSON.parse(runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' }).stdout);
      expect(json.reason).toContain('can never wake Codex');
    });

    it('is unchanged for Claude: a fresh plain await still allows', () => {
      writeLoopState('engaged');
      writeHeartbeat(5, 'await');
      const r = runHook();
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  /* ------------------- a session that CANNOT run at all -------------------- *
   * When Claude Code hits its usage limit the CLI stands by: it closes the
   * stream and stamps the heartbeat `blocked` / `blocked:<reason>`. Blocking the
   * stop then helps nobody — the agent cannot run, so it cannot re-arm anything,
   * and the nudge would be actively wrong ("re-arm your listener" when the
   * listener is fine and the account is out of quota). Allow, silently, fresh or
   * stale: the usage-limit status and the prompt-time line carry that story.
   * ------------------------------------------------------------------------- */
  describe('a listener standing by on a usage limit', () => {
    const marker = (name = '20260917T180000-1.json'): void => {
      fs.mkdirSync(path.join(stateDir, 'blocked'), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'blocked', name),
        JSON.stringify({ version: 1, reason: 'rate_limit', at: '2026-09-17T18:00:00.900Z' }),
      );
    };
    const owner = (pid: number): void =>
      fs.writeFileSync(
        path.join(stateDir, 'await-owner.json'),
        JSON.stringify({ version: 1, nonce: 'f00d', pid, kind: 'await' }),
      );
    const deadPid = (): number =>
      Number(
        execFileSync('sh', ['-c', 'sh -c "exit 0" & p=$!; wait $!; printf %s "$p"'], {
          encoding: 'utf8',
        }),
      );

    for (const stamp of ['blocked', 'blocked:rate_limit', 'blocked:billing_error']) {
      it(`allows the stop silently for ${stamp} while a marker stands and the listener lives`, () => {
        writeLoopState('engaged');
        writeHeartbeat(3, stamp);
        marker();
        owner(process.pid);
        const r = runHook();
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe('');
      });
    }

    /**
     * FRESHNESS DOES NOT APPLY to a blocked stamp — a standing-by listener
     * heartbeats only on transitions, so the stamp is ancient by design. That is
     * exactly why the other two facts are required.
     */
    it('allows a very old blocked stamp while the evidence still holds', () => {
      writeLoopState('engaged');
      writeHeartbeat(9999, 'blocked:rate_limit');
      marker();
      owner(process.pid);
      expect(runHook().stdout.trim()).toBe('');
    });

    /**
     * A standby with NO recorded listener is not a standby — it is a marker and
     * a word, with nothing holding the stream. "Unknown counts as alive" applies
     * to a pid we are not allowed to signal, never to a pid nobody wrote down.
     */
    it('BLOCKS when there is no owner record at all (the reviewer case)', () => {
      writeLoopState('engaged');
      writeHeartbeat(500, 'blocked:rate_limit');
      marker();
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('standing by on a usage limit');
      expect(json.reason).toContain('no standing-by listener is recorded');
      expect(json.reason).toContain(`run ${awaitCommand()} as a tracked background task`);
      expect(json.reason).toContain('stand by again until the limit clears');
    });

    it('BLOCKS when the owner record has a non-numeric pid', () => {
      writeLoopState('engaged');
      writeHeartbeat(500, 'blocked:rate_limit');
      marker();
      fs.writeFileSync(
        path.join(stateDir, 'await-owner.json'),
        JSON.stringify({ version: 1, nonce: 'f00d', pid: 'x', kind: 'await' }),
      );
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('no standing-by listener is recorded');
    });

    /**
     * THE YEAR-2000 REPRO. A blocked stamp with no marker left behind it is not
     * a standby: `unblock` (or a resume) cleared the block, and the listener
     * should have re-stamped `await` within a cadence. Allowing on the word
     * alone let a killed listener bypass this hook indefinitely.
     */
    it('BLOCKS when the markers are gone: the standby should have ended', () => {
      writeLoopState('engaged');
      writeHeartbeat(9999, 'blocked:rate_limit'); // stamped in the year 2000, so to speak
      owner(process.pid);
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('no listener is running');
      expect(json.reason).not.toMatch(/killed/i); // nothing here says anything died
      expect(json.reason).toContain(awaitCommand());
    });

    it('BLOCKS when the standing-by listener process is gone', () => {
      writeLoopState('engaged');
      writeHeartbeat(300, 'blocked:rate_limit');
      marker();
      const pid = deadPid();
      owner(pid);
      const json = JSON.parse(runHook().stdout);
      expect(json.decision).toBe('block');
      expect(json.reason).toContain('standing by on a usage limit');
      expect(json.reason).toContain(`pid ${pid}`);
      expect(json.reason).toContain('is gone');
      expect(json.reason).toContain(`run ${awaitCommand()} as a tracked background task`);
      expect(json.reason).toContain('stand by again until the limit clears');
    });

    it('allows under Codex as well, where a plain await would be judged passive', () => {
      writeLoopState('engaged');
      writeHeartbeat(3, 'blocked:rate_limit');
      marker();
      owner(process.pid);
      const r = runHook('{}', { SPARROW_HOOK_RUNTIME: 'codex' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    /**
     * The other half of (5): allowing the stop hands off to
     * `sparrow-auto-status.sh stop`, which posts `idle` — and that would erase
     * the blocked explanation a human is relying on. The auto-status stop mode
     * re-reads the marker directory and does nothing while a block stands.
     */
    it('allows WITHOUT painting the blocked agent idle', () => {
      writeLoopState('engaged');
      writeHeartbeat(3, 'blocked:rate_limit');
      marker();
      owner(process.pid);
      const curlLog = stubRecordingCurl();
      const r = runHook('{}', {
        SPARROW_SERVER: 'https://example.test',
        SPARROW_TOKEN: 'agk_test',
        CURL_LOG: curlLog,
        ROOMS_JSON,
      });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(idlePosts(curlLog)).toHaveLength(0);
      const calls = fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8') : '';
      expect(calls).not.toContain('/me/presence');
    });

    it('ignores a SUPERSEDED generation blocked stamp exactly like any other', () => {
      writeLoopState('engaged');
      writeHeartbeat(3, 'blocked:rate_limit 4f2c9a01bb33cd10');
      fs.writeFileSync(
        path.join(stateDir, 'await-owner.json'),
        JSON.stringify({ version: 1, nonce: 'b0b0', pid: 4242, kind: 'await' }),
      );
      const r = runHook();
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(''); // unjudgeable → allow, same as before
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
