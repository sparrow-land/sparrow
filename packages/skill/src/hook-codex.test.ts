/**
 * Behavioral tests for the two Codex-only shell hooks, exercised through a real
 * POSIX `sh` in an isolated HOME/state dir — the same way the Claude hooks are
 * tested, because a hook that misbehaves is invisible in production.
 *
 *   sparrow-session-start.sh — Codex has no per-turn system channel, so the
 *     come-online protocol is INJECTED via a SessionStart hook's
 *     `hookSpecificOutput.additionalContext` (live-verified on codex-cli
 *     0.153.3). It must be silent when the loop switch says so, and its output
 *     must be valid JSON — a malformed payload is dropped with a stderr warning
 *     nobody reads.
 *
 *   sparrow-codex-hook.sh — the wrapper every installed Codex hook runs through.
 *     It stamps `<state dir>/hooks-fired/<Event>` and then EXECs the real hook,
 *     handing over stdin, stdout and the exit status untouched. Those stamps are
 *     the only honest evidence that Codex's two silent trust gates are open.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'hooks');
const SESSION_START = path.join(HOOKS, 'sparrow-session-start.sh');
const WRAPPER = path.join(HOOKS, 'sparrow-codex-hook.sh');

let stateDir: string;
let home: string;
let tmp: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cxhook-state-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cxhook-home-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cxhook-tmp-'));
});

afterEach(() => {
  for (const d of [stateDir, home, tmp]) fs.rmSync(d, { recursive: true, force: true });
});

function writeLoopState(state: string): void {
  fs.writeFileSync(path.join(stateDir, 'loop-state'), `${state}\n`);
}

function writeHeartbeat(ageSeconds: number, content = ''): void {
  const f = path.join(stateDir, 'heartbeat');
  fs.writeFileSync(f, content ? `${content}\n` : '');
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(f, when, when);
}

/** Run a script with a real `sh`, returning stdout (stderr is surfaced on error). */
function run(
  script: string,
  args: string[] = [],
  { stdin = '{}', env = {} as Record<string, string> } = {},
): string {
  return execFileSync('sh', [script, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env.PATH!, HOME: home, SPARROW_STATE_DIR: stateDir, ...env },
  });
}

/* --------------------------- sparrow-session-start ------------------------- */

describe('sparrow-session-start.sh — the loop switch', () => {
  it('prints NOTHING when the loop switch is absent', () => {
    expect(run(SESSION_START)).toBe('');
  });

  it('prints NOTHING when the loop is paused', () => {
    writeLoopState('paused');
    expect(run(SESSION_START)).toBe('');
  });

  it('speaks only when engaged', () => {
    writeLoopState('engaged');
    expect(run(SESSION_START)).not.toBe('');
  });
});

describe('sparrow-session-start.sh — the injected payload', () => {
  beforeEach(() => writeLoopState('engaged'));

  it('emits the exact envelope Codex injects as context', () => {
    const parsed = JSON.parse(run(SESSION_START)) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
  });

  it('names the state dir, the playbook and its $sparrow invocation', () => {
    const ctx = (JSON.parse(run(SESSION_START, [], { env: { SPARROW_SKILL_PATH: '/proj/.agents/skills/sparrow/SKILL.md' } })) as any)
      .hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(stateDir);
    expect(ctx).toContain('/proj/.agents/skills/sparrow/SKILL.md');
    expect(ctx).toContain('$sparrow');
    expect(ctx).toContain('sparrow pop');
    expect(ctx).toMatch(/never pipe/i);
  });

  /** The listener vocabulary has to match the Stop hook's, or they contradict. */
  it('tells an agent with no listener to arm one', () => {
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('No listener is running');
    expect(ctx).toContain('sparrow await --timeout 900');
  });

  it('leaves a live, wake-capable `await` alone', () => {
    writeHeartbeat(5, 'await');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/already running/);
  });

  it('calls out a hold-only listener as unable to wake you', () => {
    writeHeartbeat(5, 'watch');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('CANNOT wake you');
    expect(ctx).toContain('sparrow await --timeout 900');
  });

  it('treats a STALE heartbeat as no listener', () => {
    writeHeartbeat(9999, 'await');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('No listener is running');
  });

  it('names a terminal stamp, whatever its age', () => {
    writeHeartbeat(1, 'killed:SIGTERM');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('was killed');
    expect(ctx).toContain('sparrow await --timeout 900');
  });

  it('says it cannot judge an empty (legacy / hand-rolled) heartbeat', () => {
    writeHeartbeat(5, '');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/cannot be judged/);
  });

  it('stays valid JSON for every listener state', () => {
    for (const hb of ['await', 'watch', 'loop', '', 'killed:SIGHUP', 'stopped:SIGINT', 'garbage']) {
      writeHeartbeat(5, hb);
      expect(() => JSON.parse(run(SESSION_START))).not.toThrow();
    }
  });
});

/* ---------------------------- sparrow-codex-hook --------------------------- */

describe('sparrow-codex-hook.sh — the firing stamp', () => {
  /** A trivial inner hook that proves stdin, stdout and exit status pass through. */
  function innerHook(body: string): string {
    const p = path.join(tmp, 'inner.sh');
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  }

  const stamp = (event: string) => path.join(stateDir, 'hooks-fired', event);

  it('stamps the event it was told it is, creating the directory', () => {
    const inner = innerHook('exit 0');
    run(WRAPPER, ['Stop', inner]);
    expect(fs.existsSync(stamp('Stop'))).toBe(true);
  });

  it('passes stdin THROUGH to the real hook untouched', () => {
    const inner = innerHook('cat');
    const payload = '{"hook_event_name":"Stop","stop_hook_active":false}';
    expect(run(WRAPPER, ['Stop', inner], { stdin: payload })).toBe(payload);
  });

  it("passes the hook's stdout through — the Stop decision channel is untouched", () => {
    const inner = innerHook(`printf '{"decision":"block","reason":"x"}\\n'`);
    expect(run(WRAPPER, ['Stop', inner])).toBe('{"decision":"block","reason":"x"}\n');
  });

  it('passes extra args along (the auto-status mode)', () => {
    const inner = innerHook('printf "%s" "$1"');
    expect(run(WRAPPER, ['UserPromptSubmit', inner, 'prompt'])).toBe('prompt');
  });

  it("adopts the inner hook's exit status", () => {
    const inner = innerHook('exit 3');
    expect(() => run(WRAPPER, ['Stop', inner])).toThrow();
  });

  /**
   * The stamp is written BEFORE the hook runs, and unconditionally: it answers
   * "did Codex's trust gates let this fire?", which is true whether or not the
   * hook then decides to do nothing (loop paused, no credentials, …).
   */
  it('stamps even when the inner hook is a no-op or missing', () => {
    run(WRAPPER, ['PostToolUse', innerHook('exit 0')]);
    expect(fs.existsSync(stamp('PostToolUse'))).toBe(true);
    run(WRAPPER, ['SessionStart', path.join(tmp, 'does-not-exist.sh')]);
    expect(fs.existsSync(stamp('SessionStart'))).toBe(true);
  });

  it('refreshes the stamp mtime on every firing', () => {
    const inner = innerHook('exit 0');
    run(WRAPPER, ['Stop', inner]);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stamp('Stop'), old, old);
    run(WRAPPER, ['Stop', inner]);
    expect(fs.statSync(stamp('Stop')).mtimeMs).toBeGreaterThan(old.getTime());
  });

  it('cannot be made to write outside the state dir by a path-ish event name', () => {
    run(WRAPPER, ['../../escape', innerHook('exit 0')]);
    expect(fs.existsSync(path.join(os.tmpdir(), 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'hooks-fired', 'escape'))).toBe(true);
  });

  it('exits 0 silently when called with no arguments at all', () => {
    expect(run(WRAPPER)).toBe('');
  });
});
