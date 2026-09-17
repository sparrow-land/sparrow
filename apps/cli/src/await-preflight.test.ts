import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PidNamespaceProbe } from '@sparrow/skill';
import { CliError } from './util.js';
import { codexAwaitPreflight } from './await-preflight.js';

/* ==================================================================
 * The Codex arming preflight (see await-preflight.ts).
 *
 * Both checks are keyed off a resolved Codex thread, so every case here
 * passes one: a non-Codex run never reaches this function at all (that
 * contract is covered end-to-end in cli.test.ts).
 * ================================================================== */

let stateDir: string;
const THREAD = 'thread-abc';

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-preflight-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

/** A probe over an in-memory /proc, counting reads so "never probed" is testable. */
function fakeProbe(files: Record<string, string>): PidNamespaceProbe & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFile(p: string): string | undefined {
      reads.push(p);
      return files[p];
    },
  };
}

/** A host with no sandbox: procfs readable, one pid, ordinary init. */
const hostProbe = (): PidNamespaceProbe & { reads: string[] } =>
  fakeProbe({ '/proc/self/status': 'Name:\tnode\nNSpid:\t4242\n', '/proc/1/comm': 'systemd\n' });

/** A Codex per-command sandbox: pid 1 is the sandbox supervisor (signal `init`). */
const sandboxProbe = (): PidNamespaceProbe & { reads: string[] } =>
  fakeProbe({ '/proc/self/status': 'Name:\tnode\nNSpid:\t4242\n', '/proc/1/comm': 'codex-linux-sandbox\n' });

/**
 * A NESTED namespace with an unremarkable init (signal `nspid`): the shape of a
 * per-command sandbox without a mount-proc, but ALSO the shape of
 * container-in-container and several CI runners — where a listener does outlive
 * the command. Weak evidence, so it may only warn.
 */
const nestedProbe = (): PidNamespaceProbe & { reads: string[] } =>
  fakeProbe({ '/proc/self/status': 'Name:\tnode\nNSpid:\t3125325\t5\n', '/proc/1/comm': 'systemd\n' });

function stamp(event: string, body: string): void {
  fs.mkdirSync(path.join(stateDir, 'hooks-fired'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'hooks-fired', event), `${body}\n`);
}

/** Run the preflight, collecting stderr; returns the lines it wrote. */
function run(
  opts: { env?: Record<string, string | undefined>; probe?: PidNamespaceProbe; thread?: string } = {},
): string[] {
  const lines: string[] = [];
  codexAwaitPreflight({
    env: opts.env ?? {},
    stateDir,
    thread: opts.thread ?? THREAD,
    err: (s) => lines.push(s),
    probe: opts.probe ?? hostProbe(),
  });
  return lines;
}

/* ==================================================================
 * THE SUB-AGENT REFUSAL (field incident, Codex 0.154).
 *
 * A spawned sub-agent ran `sparrow await` in the parent's project dir with the
 * parent's profile. Newest-wins handed it the state dir, and when work arrived
 * `codex queue --thread <child>` was refused (-32600, "direct app-server input
 * is not allowed for unloaded spawned sub-agents"): the root session's listener
 * was gone and nothing could be woken. In a spawned sub-agent shell
 * CODEX_SESSION_ID is the ROOT thread while CODEX_THREAD_ID is the child's own;
 * in a root shell the two are equal.
 * ================================================================== */
describe('codexAwaitPreflight — spawned sub-agent (FATAL: the wake path cannot exist)', () => {
  const subagentEnv = { CODEX_THREAD_ID: 'thread-child', CODEX_SESSION_ID: 'thread-root' };

  it('refuses before anything else — including the sandbox probe', () => {
    const probe = sandboxProbe(); // would also refuse, and must never be asked
    let thrown: unknown;
    try {
      run({ env: subagentEnv, probe, thread: 'thread-child' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const message = (thrown as Error).message;
    expect(message.split('\n')).toHaveLength(1);
    expect(message).toContain('spawned Codex sub-agent (thread thread-child, session thread-root)');
    expect(message).toContain("cannot be woken by Codex");
    expect(message).toContain('Leave listening to the root session');
    expect(message).toContain('SPARROW_AWAIT_SUBAGENT=1');
    expect(probe.reads).toEqual([]);
  });

  it('a ROOT shell (the two ids agree) is not a sub-agent', () => {
    stamp('Stop', 'runtime thread-root');
    expect(
      run({
        env: { CODEX_THREAD_ID: 'thread-root', CODEX_SESSION_ID: 'thread-root' },
        thread: 'thread-root',
      }),
    ).toEqual([]);
  });

  /* An OBSERVED signal, not a documented contract: when the session id is not
   * there at all we know nothing, and refusing on ignorance would strand every
   * Codex build that does not export it. */
  it('a missing CODEX_SESSION_ID is UNKNOWN, never proof of a sub-agent', () => {
    stamp('Stop', 'runtime thread-child');
    expect(run({ env: { CODEX_THREAD_ID: 'thread-child' }, thread: 'thread-child' })).toEqual([]);
  });

  it('SPARROW_AWAIT_SUBAGENT=1 lets an operator arm anyway', () => {
    stamp('Stop', 'runtime thread-child');
    expect(
      run({ env: { ...subagentEnv, SPARROW_AWAIT_SUBAGENT: '1' }, thread: 'thread-child' }),
    ).toEqual([]);
  });
});

describe('codexAwaitPreflight — sandbox check (FATAL: provable from the inside)', () => {
  it('refuses to arm inside a Codex sandbox, naming the evidence and the way out', () => {
    stamp('Stop', `runtime ${THREAD}`);
    let thrown: unknown;
    try {
      run({ probe: sandboxProbe() });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const message = (thrown as Error).message;
    // ONE line — an agent reads the first line and nothing else.
    expect(message.split('\n')).toHaveLength(1);
    expect(message).toContain('pid 1 is codex-linux-sandbox');
    expect(message).toContain('killed the moment the command returns');
    expect(message).toContain('SPARROW_AWAIT_SANDBOX_CHECK=0');
    // The way out is a place the listener OUTLIVES this command. No hook starts
    // `sparrow await` — the installed hooks instruct, block and heartbeat — so
    // the line must never send the reader to one.
    expect(message).toContain('re-run it unsandboxed');
    expect(message).toContain('sparrow harness --codex');
    expect(message).not.toContain('Arm it from a hook');
  });

  it('only WARNS for a nested namespace whose init is not a known supervisor', () => {
    stamp('Stop', `runtime ${THREAD}`);
    const lines = run({ probe: nestedProbe() });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('nested PID namespace');
    expect(lines[0]).toContain('NSpid lists 2 pids');
    expect(lines[0]).toContain('a persistent container is fine');
    expect(lines[0]).toContain('sparrow harness');
    expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1);
  });

  it('SPARROW_AWAIT_SANDBOX_CHECK=0 silences the nested-namespace warning too', () => {
    stamp('Stop', `runtime ${THREAD}`);
    expect(run({ env: { SPARROW_AWAIT_SANDBOX_CHECK: '0' }, probe: nestedProbe() })).toEqual([]);
  });

  it('arms on an ordinary host (no namespace) without a word', () => {
    stamp('Stop', `runtime ${THREAD}`);
    expect(run()).toEqual([]);
  });

  it('SPARROW_AWAIT_SANDBOX_CHECK=0 skips the check entirely (never probes)', () => {
    stamp('Stop', `runtime ${THREAD}`);
    const probe = sandboxProbe();
    expect(run({ env: { SPARROW_AWAIT_SANDBOX_CHECK: '0' }, probe })).toEqual([]);
    expect(probe.reads).toEqual([]);
  });
});

describe('codexAwaitPreflight — hook verification (ADVISORY: absence is not proof)', () => {
  it('warns but still arms when no hook has ever fired', () => {
    const lines = run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(THREAD);
    expect(lines[0]).toContain('have not been observed firing');
    expect(lines[0]).toContain('sparrow skill verify');
    // UNVERIFIED, not broken: the note may not assert that the hooks are dead.
    expect(lines[0]).toContain('no verified Stop-hook safety net');
    expect(lines[0]).toContain('if they are not running');
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1);
  });

  it('SPARROW_AWAIT_REQUIRE_HOOKS=1 makes the same message fatal', () => {
    const warning = run()[0]!.trim();
    let thrown: unknown;
    try {
      run({ env: { SPARROW_AWAIT_REQUIRE_HOOKS: '1' } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(`[await] ${(thrown as Error).message}`).toBe(warning);
  });

  it('is silent when a runtime stamp names THIS thread', () => {
    stamp('Stop', `runtime ${THREAD}`);
    expect(run()).toEqual([]);
  });

  it('arms with one note when the stamp predates thread ids (older wrapper)', () => {
    stamp('Stop', 'runtime');
    const lines = run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sparrow upgrade');
    expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1);
  });

  it('warns that a hand run is not evidence when only manual stamps exist', () => {
    stamp('Stop', 'manual');
    const lines = run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('hand run');
    expect(lines[0]).toContain('not evidence Codex runs them');
    expect(lines[0]).toContain(THREAD);
  });

  it('warns that the stamps belong to a different thread', () => {
    stamp('Stop', 'runtime thread-somebody-else');
    const lines = run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('different Codex thread');
    // One stamp file per EVENT, not per thread: a sibling session simply wrote
    // last. The note says so instead of claiming the hooks are not running.
    expect(lines[0]).toContain('a sibling session may simply have written last');
    expect(lines[0]).toContain('nothing proves they fire for this one');
    expect(lines[0]).toContain(THREAD);
  });

  it('is fatal for manual-only and other-thread too under SPARROW_AWAIT_REQUIRE_HOOKS', () => {
    stamp('Stop', 'manual');
    expect(() => run({ env: { SPARROW_AWAIT_REQUIRE_HOOKS: '1' } })).toThrow(CliError);
    stamp('Stop', 'runtime thread-somebody-else');
    expect(() => run({ env: { SPARROW_AWAIT_REQUIRE_HOOKS: '1' } })).toThrow(CliError);
  });

  it('checks the sandbox BEFORE the hooks: the fatal answer wins', () => {
    // No stamps either, so both checks have something to say.
    expect(() => run({ probe: sandboxProbe() })).toThrow(/sandbox PID namespace/);
  });
});
