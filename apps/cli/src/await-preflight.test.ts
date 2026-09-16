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

/** A Codex per-command sandbox: pid 1 is the sandbox supervisor. */
const sandboxProbe = (): PidNamespaceProbe & { reads: string[] } =>
  fakeProbe({ '/proc/self/status': 'Name:\tnode\nNSpid:\t4242\n', '/proc/1/comm': 'codex-linux-sandbox\n' });

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
    expect(message).toContain('sparrow skill verify');
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
    expect(lines[0]).toContain(THREAD);
  });

  it('warns that the stamps belong to a different thread', () => {
    stamp('Stop', 'runtime thread-somebody-else');
    const lines = run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('different Codex thread');
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
