/**
 * PID-namespace detection — the primitive behind "`sparrow await` refuses to arm
 * inside a sandbox that will SIGKILL it the moment the command returns".
 *
 * The rules are pinned against facts measured on a real host (2026-09-16):
 *
 *   • `unshare -Urpf` WITHOUT remounting /proc leaves the outer procfs visible,
 *     so `/proc/self/status` carries a two-field `NSpid:\t3125325\t5` — the
 *     giveaway, whatever pid 1 happens to be called.
 *   • `unshare -Urpf --mount-proc` remounts procfs inside the namespace, so
 *     NSpid collapses to a single `5` and the only evidence left is
 *     `/proc/1/comm` — which under a real `codex exec -s workspace-write` reads
 *     `codex` (measured 2026-09-16), and under other sandboxes
 *     `codex-linux-sandbox` or `bwrap`.
 *   • A DOCKER container looks superficially identical to the second case —
 *     single-field NSpid, an arbitrary `/proc/1/comm` (its entrypoint) — and it
 *     is NOT a per-command sandbox: a listener started there outlives the
 *     command. So an unrecognized pid 1 must read as NOT sandboxed. Guessing
 *     here would refuse to arm on every containerized agent we have.
 */
import { describe, expect, it } from 'vitest';
import { detectPidNamespace, type PidNamespaceProbe } from './sandbox.js';

/** A probe over a fixed procfs snapshot; anything absent reads as unreadable. */
function fakeProbe(files: Record<string, string>): PidNamespaceProbe {
  return { readFile: (p: string) => files[p] };
}

const STATUS_HOST = ['Name:\tnode', 'Pid:\t3125325', 'NSpid:\t3125325', 'Threads:\t7'].join('\n');
const STATUS_NS = ['Name:\tnode', 'Pid:\t3125325', 'NSpid:\t3125325\t5', 'Threads:\t7'].join('\n');

describe('detectPidNamespace', () => {
  it('reads an ordinary host as NOT namespaced', () => {
    const r = detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_HOST, '/proc/1/comm': 'systemd\n' }));
    expect(r).toEqual({ inNamespace: false, evidence: 'no PID namespace detected', signal: 'none' });
  });

  it('reads a two-field NSpid as namespaced, whatever pid 1 is', () => {
    const r = detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_NS, '/proc/1/comm': 'systemd\n' }));
    expect(r.inNamespace).toBe(true);
    expect(r.evidence).toBe('NSpid lists 2 pids (nested PID namespace)');
    expect(r.signal).toBe('nspid');
  });

  /**
   * The pid-1 rule is evaluated FIRST. A real sandbox can show both signals at
   * once (nested NSpid *and* a supervisor at pid 1), and `init` is the stronger,
   * actionable one — the CLI refuses on it, where it only warns on `nspid`.
   */
  it('reports init, not nspid, when BOTH signals are present', () => {
    const r = detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_NS, '/proc/1/comm': 'codex\n' }));
    expect(r).toEqual({ inNamespace: true, evidence: 'pid 1 is codex', signal: 'init' });
  });

  it('reads codex-linux-sandbox as pid 1 as namespaced even with a single NSpid', () => {
    const r = detectPidNamespace(
      fakeProbe({ '/proc/self/status': STATUS_HOST, '/proc/1/comm': 'codex-linux-sandbox\n' }),
    );
    expect(r.inNamespace).toBe(true);
    expect(r.evidence).toBe('pid 1 is codex-linux-sandbox');
    expect(r.signal).toBe('init');
  });

  /**
   * The REAL sample, byte for byte: codex-cli 0.153.4 under
   * `codex exec -s workspace-write` with its bundled bubblewrap, measured
   * 2026-09-16. /proc is remounted, so NSpid is a single `4` and the only
   * evidence is pid 1 — which is called `codex`, not `codex-linux-sandbox`.
   */
  it('reads the measured Codex workspace-write sandbox as namespaced', () => {
    const status = ['Name:\tsh', 'Pid:\t4', 'NSpid:\t4', 'Threads:\t1'].join('\n');
    expect(detectPidNamespace(fakeProbe({ '/proc/self/status': status, '/proc/1/comm': 'codex\n' }))).toEqual({
      inNamespace: true,
      evidence: 'pid 1 is codex',
      signal: 'init',
    });
  });

  it('reads bwrap as pid 1 as namespaced too', () => {
    const r = detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_HOST, '/proc/1/comm': 'bwrap\n' }));
    expect(r).toEqual({ inNamespace: true, evidence: 'pid 1 is bwrap', signal: 'init' });
  });

  it('reads a Docker container (single NSpid, arbitrary pid 1) as NOT namespaced', () => {
    const r = detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_HOST, '/proc/1/comm': 'node\n' }));
    expect(r).toEqual({ inNamespace: false, evidence: 'no PID namespace detected', signal: 'none' });
  });

  /**
   * A container nested inside another PID namespace shows the two-field NSpid
   * too. The report says exactly that — a nested PID namespace was detected —
   * and leaves the "so my listener will be killed" inference to the caller.
   */
  it('reads a nested-namespace container as namespaced, on the NSpid evidence alone', () => {
    const r = detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_NS, '/proc/1/comm': 'node\n' }));
    expect(r).toEqual({ inNamespace: true, evidence: 'NSpid lists 2 pids (nested PID namespace)', signal: 'nspid' });
  });

  it('never guesses when procfs is unreadable: not namespaced, and says why', () => {
    const r = detectPidNamespace(fakeProbe({}));
    expect(r).toEqual({ inNamespace: false, evidence: 'procfs unreadable', signal: 'none' });
  });

  it('still judges on whichever file it CAN read', () => {
    expect(detectPidNamespace(fakeProbe({ '/proc/1/comm': 'codex-linux-sandbox' }))).toEqual({
      inNamespace: true,
      evidence: 'pid 1 is codex-linux-sandbox',
      signal: 'init',
    });
    expect(detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_NS }))).toEqual({
      inNamespace: true,
      evidence: 'NSpid lists 2 pids (nested PID namespace)',
      signal: 'nspid',
    });
    // One file readable, and it says nothing → a verdict, not "unreadable".
    expect(detectPidNamespace(fakeProbe({ '/proc/self/status': STATUS_HOST }))).toEqual({
      inNamespace: false,
      evidence: 'no PID namespace detected',
      signal: 'none',
    });
  });

  it('counts however many pids NSpid lists', () => {
    const three = ['NSpid:\t3125325\t99\t5'].join('\n');
    expect(detectPidNamespace(fakeProbe({ '/proc/self/status': three })).evidence).toBe(
      'NSpid lists 3 pids (nested PID namespace)',
    );
  });

  it('ignores a malformed NSpid line rather than calling it evidence', () => {
    const junk = 'NSpid:\n';
    const r = detectPidNamespace(fakeProbe({ '/proc/self/status': junk, '/proc/1/comm': 'systemd' }));
    expect(r.inNamespace).toBe(false);
    expect(r.signal).toBe('none');
  });

  /**
   * The default probe must never throw: it runs on the arming path of every
   * `sparrow await`, including on macOS, where /proc does not exist at all.
   */
  it('works with no probe at all, swallowing every filesystem error', () => {
    const r = detectPidNamespace();
    expect(typeof r.inNamespace).toBe('boolean');
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(['init', 'nspid', 'none']).toContain(r.signal);
  });
});
