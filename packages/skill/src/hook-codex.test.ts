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
import { awaitCommand, sparrowCommand } from './listener.js';

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
  try {
    return execFileSync('sh', [script, ...args], {
      input: stdin,
      encoding: 'utf8',
      env: { PATH: process.env.PATH!, HOME: home, SPARROW_STATE_DIR: stateDir, ...env },
    });
  } catch (e) {
    // A script that exits before reading stdin (the no-argument wrapper does)
    // can close the pipe while node is still writing `input`: EPIPE with a
    // clean exit status is a successful run, not a failure. Seen on CI runners.
    const err = e as { code?: string; status?: number | null; stdout?: string };
    if (err.code === 'EPIPE' && (err.status ?? 0) === 0) return err.stdout ?? '';
    throw e;
  }
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
    expect(ctx).toContain('unbounded sparrow await');
    expect(ctx).not.toContain('--timeout 900');
  });

  it('recognizes a fresh Codex-bridged await listener', () => {
    writeHeartbeat(5, 'await:codex');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Codex-bridged');
    expect(ctx).toContain('can deliver the next turn');
  });

  /* ---------------------------------------------------------------- *
   * GENERATION TAGS. Arming `sparrow await` supersedes the previous
   * listener, and the loser can still be inside the window between its
   * ownership check and a heartbeat write. So both halves of the heartbeat
   * vocabulary — a LIVE claim and a DEAD stamp — may name the generation
   * that wrote them, and this hook believes one only while it names the
   * live generation in `await-owner.json`. Untagged, or no record at all,
   * is judged exactly as before.
   * ---------------------------------------------------------------- */
  const writeOwner = (nonce: string): void =>
    fs.writeFileSync(
      path.join(stateDir, 'await-owner.json'),
      `${JSON.stringify({ version: 1, nonce, pid: 4242, startedAt: '2026-09-09T00:00:00.000Z', kind: 'await' })}\n`,
    );
  const context = (): string =>
    (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext as string;

  it('trusts a LIVE claim tagged with the live generation', () => {
    writeHeartbeat(5, 'await:codex 4f2c9a01bb33cd10');
    writeOwner('4f2c9a01bb33cd10');
    const ctx = context();
    expect(ctx).toContain('Codex-bridged');
    expect(ctx).not.toContain('4f2c9a01bb33cd10'); // the tag never leaks into prose
  });

  it('ignores a LIVE claim from a SUPERSEDED generation (it cannot be judged)', () => {
    // Exactly the demotion this tag prevents: a stale plain `await` claim
    // written over a live `await:codex` one would read as "no queue bridge".
    writeHeartbeat(5, 'await 4f2c9a01bb33cd10');
    writeOwner('b0b0b0b0b0b0b0b0');
    const ctx = context();
    expect(ctx).toContain('cannot be judged');
    expect(ctx).not.toContain('no verified route');
  });

  it('trusts a DEAD stamp tagged with the live generation', () => {
    writeHeartbeat(5, 'killed:SIGTERM 4f2c9a01bb33cd10');
    writeOwner('4f2c9a01bb33cd10');
    expect(context()).toContain('Your listener was killed');
  });

  it('ignores a DEAD stamp from a SUPERSEDED generation', () => {
    writeHeartbeat(5, 'killed:SIGTERM 4f2c9a01bb33cd10');
    writeOwner('b0b0b0b0b0b0b0b0');
    const ctx = context();
    expect(ctx).not.toContain('Your listener was killed');
    expect(ctx).toContain('cannot be judged'); // fresh, but unjudgeable
  });

  it('judges untagged claims and stamps as before, whatever the record says', () => {
    writeOwner('b0b0b0b0b0b0b0b0');
    writeHeartbeat(5, 'await:codex');
    expect(context()).toContain('Codex-bridged');
    writeHeartbeat(5, 'killed:SIGTERM');
    expect(context()).toContain('Your listener was killed');
  });

  it('judges a tagged claim as before when there is no owner record at all', () => {
    writeHeartbeat(5, 'await:codex 4f2c9a01bb33cd10');
    expect(context()).toContain('Codex-bridged');
  });

  it('calls out a passive await heartbeat as lacking a verified Codex route', () => {
    writeHeartbeat(5, 'await');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('passive');
    expect(ctx).toContain('no verified route');
    expect(ctx).toContain('unbounded sparrow await');
  });

  it('calls out a hold-only listener as unable to wake you', () => {
    writeHeartbeat(5, 'watch');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('CANNOT wake you');
    expect(ctx).toContain('unbounded sparrow await');
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
    expect(ctx).toContain('unbounded sparrow await');
  });

  it('names SPARROW_PROFILE in every re-arm it prescribes, identically to awaitCommand()', () => {
    // Codex hooks inherit the stamped SPARROW_PROFILE; the injected context must
    // prescribe THAT store, not whichever neighbour owns defaultProfile.
    const want = awaitCommand({ profile: 'cubes-vm4-codex' });
    for (const hb of ['watch', 'await', 'killed:SIGTERM', 'garbage']) {
      writeHeartbeat(5, hb);
      const ctx = (
        JSON.parse(run(SESSION_START, [], { env: { SPARROW_PROFILE: 'cubes-vm4-codex' } })) as any
      ).hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain(want);
      expect(ctx.replace(new RegExp(want, 'g'), '')).not.toContain('sparrow await');
      expect(ctx).toContain(sparrowCommand('pop', { profile: 'cubes-vm4-codex' }));
    }
  });

  it('stays byte-identical to the bare commands when no profile is stamped', () => {
    writeHeartbeat(5, 'watch');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`unbounded ${awaitCommand()}`);
    expect(ctx).not.toContain('--profile');
  });

  it('says it cannot judge an empty (legacy / hand-rolled) heartbeat', () => {
    writeHeartbeat(5, '');
    const ctx = (JSON.parse(run(SESSION_START)) as any).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/cannot be judged/);
  });

  it('stays valid JSON for every listener state', () => {
    for (const hb of ['await', 'await:codex', 'watch', 'loop', '', 'killed:SIGHUP', 'stopped:SIGINT', 'garbage']) {
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

  /**
   * A HAND-RUN of the hook command is a script check, not evidence that Codex
   * invoked anything — but it writes the same stamp, which would otherwise turn
   * `verify` green on the strength of the agent's own typing. So the diagnostic
   * line `verify` prints carries `SPARROW_HOOK_SELFTEST=1`, and the wrapper
   * records WHICH kind of run made the stamp.
   */
  it('records a runtime stamp normally and a manual one under SPARROW_HOOK_SELFTEST', () => {
    const inner = innerHook('exit 0');
    run(WRAPPER, ['Stop', inner]);
    expect(fs.readFileSync(stamp('Stop'), 'utf8').trim()).toBe('runtime');

    run(WRAPPER, ['Stop', inner], { env: { SPARROW_HOOK_SELFTEST: '1' } });
    expect(fs.readFileSync(stamp('Stop'), 'utf8').trim()).toBe('manual');

    // …and back: a real firing after a self-test tells the truth again.
    run(WRAPPER, ['Stop', inner]);
    expect(fs.readFileSync(stamp('Stop'), 'utf8').trim()).toBe('runtime');
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

/* ------------------------- the stamp names the THREAD ----------------------- *
 * MEASURED, not assumed (2026-09-16): inside a Codex hook `CODEX_THREAD_ID` and
 * `CODEX_SESSION_ID` are both UNSET — only `CODEX_MANAGED_BY_NPM` survives into
 * the hook's environment. So the thread identity has to come from the hook
 * PAYLOAD on stdin, whose keys are snake_case (`hook_event_name`, `session_id`,
 * `cwd`, `turn_id`). The wrapper lifts `session_id` out of it, records it beside
 * the kind, and hands it to the inner hook as `SPARROW_CODEX_THREAD` — which is
 * what lets `sparrow await` ask "have hooks fired FOR THIS THREAD?" rather than
 * the far weaker "have hooks ever fired here?".
 * -------------------------------------------------------------------------- */
describe('sparrow-codex-hook.sh — the thread on the stamp', () => {
  function innerHook(body: string): string {
    const p = path.join(tmp, 'inner.sh');
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  }
  const stamp = (event: string) => path.join(stateDir, 'hooks-fired', event);
  const read = (event: string) => fs.readFileSync(stamp(event), 'utf8').trim();
  const payload = (extra: Record<string, string> = {}) =>
    JSON.stringify({ hook_event_name: 'Stop', turn_id: 't1', ...extra });

  it('writes `<kind> <thread>` from the payload session_id', () => {
    run(WRAPPER, ['Stop', innerHook('exit 0')], { stdin: payload({ session_id: 'abc-123' }) });
    expect(read('Stop')).toBe('runtime abc-123');
  });

  it('writes a bare kind when the payload carries no session_id', () => {
    run(WRAPPER, ['Stop', innerHook('exit 0')], { stdin: payload() });
    expect(read('Stop')).toBe('runtime');
  });

  it('keeps the manual/runtime distinction alongside the thread', () => {
    const inner = innerHook('exit 0');
    run(WRAPPER, ['Stop', inner], { stdin: payload({ session_id: 'abc-123' }), env: { SPARROW_HOOK_SELFTEST: '1' } });
    expect(read('Stop')).toBe('manual abc-123');
    run(WRAPPER, ['Stop', inner], { stdin: payload({ session_id: 'abc-123' }) });
    expect(read('Stop')).toBe('runtime abc-123');
  });

  it('sanitises a hostile session_id down to [A-Za-z0-9_-]', () => {
    run(WRAPPER, ['Stop', innerHook('exit 0')], {
      stdin: payload({ session_id: '../../evil id!$(touch /tmp/x)' }),
    });
    expect(read('Stop')).toBe('runtime evilidtouchtmpx');
  });

  it('caps the thread at 128 characters', () => {
    const long = 'a'.repeat(200);
    run(WRAPPER, ['Stop', innerHook('exit 0')], { stdin: payload({ session_id: long }) });
    expect(read('Stop')).toBe(`runtime ${'a'.repeat(128)}`);
  });

  it('hands the inner hook the thread and the runtime in its environment', () => {
    const inner = innerHook('printf "%s|%s" "${SPARROW_CODEX_THREAD:-}" "${SPARROW_HOOK_RUNTIME:-}"');
    const out = run(WRAPPER, ['Stop', inner], { stdin: payload({ session_id: 'abc-123' }) });
    expect(out).toBe('abc-123|codex');
  });

  it('still re-feeds the payload to the inner hook on stdin, byte for byte', () => {
    const body = payload({ session_id: 'abc-123' });
    expect(run(WRAPPER, ['Stop', innerHook('cat')], { stdin: body })).toBe(body);
  });

  it('keeps the decision channel and exit status intact while doing all that', () => {
    const decide = innerHook(`printf '{"decision":"block","reason":"x"}\\n'`);
    expect(run(WRAPPER, ['Stop', decide], { stdin: payload({ session_id: 'abc-123' }) })).toBe(
      '{"decision":"block","reason":"x"}\n',
    );
    expect(() => run(WRAPPER, ['Stop', innerHook('exit 3')], { stdin: payload() })).toThrow();
  });

  it('survives a payload that is not JSON at all', () => {
    run(WRAPPER, ['PostToolUse', innerHook('exit 0')], { stdin: 'not json{{' });
    expect(read('PostToolUse')).toBe('runtime');
  });

  /* ------------------ the thread is a TOP-LEVEL field, only ------------------ *
   * A regex over the whole payload picks whichever `session_id` it reaches
   * first, and Codex payloads NEST: a PostToolUse `tool_response` can carry a
   * `session_id` of its own (some other session, or another agent's). Stamping
   * that would make `hooksVerifiedForThread` answer about the wrong thread —
   * worse than answering "unverified", because it answers confidently.
   * -------------------------------------------------------------------------- */
  it('takes the TOP-LEVEL session_id when a nested object repeats the key', () => {
    run(WRAPPER, ['PostToolUse', innerHook('exit 0')], {
      stdin: '{"session_id":"real-thread","tool_response":{"session_id":"other-session"}}',
    });
    expect(read('PostToolUse')).toBe('runtime real-thread');
  });

  it('takes it even when the nested object comes FIRST', () => {
    run(WRAPPER, ['PostToolUse', innerHook('exit 0')], {
      stdin: '{"tool_response":{"session_id":"other-session"},"session_id":"real-thread"}',
    });
    expect(read('PostToolUse')).toBe('runtime real-thread');
  });

  it('claims NO thread when session_id exists only nested', () => {
    run(WRAPPER, ['PostToolUse', innerHook('exit 0')], {
      stdin: '{"hook_event_name":"PostToolUse","tool_response":{"session_id":"other-session"}}',
    });
    expect(read('PostToolUse')).toBe('runtime');
  });

  it('claims no thread for a non-string top-level session_id', () => {
    run(WRAPPER, ['PostToolUse', innerHook('exit 0')], { stdin: '{"session_id":42}' });
    expect(read('PostToolUse')).toBe('runtime');
  });

  it('claims no thread for malformed JSON, and still runs the child on the raw stdin', () => {
    const inner = innerHook('cat');
    const broken = '{"session_id": broken';
    expect(run(WRAPPER, ['PostToolUse', inner], { stdin: broken })).toBe(broken);
    expect(read('PostToolUse')).toBe('runtime');
  });

  it('claims no thread for empty stdin, and stamps anyway', () => {
    run(WRAPPER, ['Stop', innerHook('exit 0')], { stdin: '' });
    expect(read('Stop')).toBe('runtime');
  });

  it("preserves the child's stdout and non-zero exit status through the pipe", () => {
    const inner = innerHook(`printf '{"decision":"block","reason":"x"}\n'; exit 2`);
    let caught: { status?: number; stdout?: string } | undefined;
    try {
      run(WRAPPER, ['Stop', inner], { stdin: payload({ session_id: 'abc-123' }) });
    } catch (e) {
      caught = e as { status?: number; stdout?: string };
    }
    expect(caught?.status).toBe(2);
    expect(caught?.stdout).toBe('{"decision":"block","reason":"x"}\n');
  });

  /**
   * NO NODE, NO PROBLEM. `node` is the structural parser, but a hook must work
   * on a box where it is not on PATH — the fallback is an ANCHORED sed that
   * matches a `session_id` only while it is still at the top level (before any
   * nested `{`). Anything it cannot see that way reads as no thread at all:
   * unverified is the safe answer, a wrong thread is not.
   */
  describe('without node on PATH', () => {
    let nodeless: string;
    beforeEach(() => {
      nodeless = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cxhook-nonode-'));
      for (const tool of ['sh', 'cat', 'sed', 'head', 'tr', 'cut', 'mkdir']) {
        const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
        fs.symlinkSync(real, path.join(nodeless, tool));
      }
    });
    afterEach(() => fs.rmSync(nodeless, { recursive: true, force: true }));

    const runBare = (stdin: string, event = 'PostToolUse'): void => {
      execFileSync('sh', [WRAPPER, event, innerHook('exit 0')], {
        input: stdin,
        encoding: 'utf8',
        env: { PATH: nodeless, HOME: home, SPARROW_STATE_DIR: stateDir },
      });
    };

    it('still reads a plain top-level session_id', () => {
      runBare('{"hook_event_name":"PostToolUse","session_id":"abc-123","turn_id":"t1"}');
      expect(read('PostToolUse')).toBe('runtime abc-123');
    });

    it('still refuses to take a nested one', () => {
      runBare('{"hook_event_name":"PostToolUse","tool_response":{"session_id":"other-session"}}');
      expect(read('PostToolUse')).toBe('runtime');
    });

    it('takes the top-level key when a nested object repeats it AFTERWARDS', () => {
      runBare('{"session_id":"real-thread","tool_response":{"session_id":"other-session"}}');
      expect(read('PostToolUse')).toBe('runtime real-thread');
    });

    it('gives up rather than guess when the top-level key follows a nested object', () => {
      // The documented limit of the fallback: the first top-level key BEFORE any
      // nested object, else no thread.
      runBare('{"tool_response":{"session_id":"other-session"},"session_id":"real-thread"}');
      expect(read('PostToolUse')).toBe('runtime');
    });

    it('stamps, and stays silent, on junk', () => {
      runBare('not json{{');
      expect(read('PostToolUse')).toBe('runtime');
    });
  });
});
