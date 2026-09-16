/**
 * Am I inside a per-command sandbox that will kill my listener?
 *
 * THE INCIDENT (2026-09-16). A Codex agent armed `sparrow await` from a
 * model-run shell command. Codex's per-command sandbox is a PID NAMESPACE with
 * its own init, and when the command that owns the namespace returns,
 * everything left inside it is SIGKILLed — `setsid`, `nohup`, a
 * double-fork, all of it. The listener died within milliseconds of the tool call
 * finishing, stamped nothing on its way out (SIGKILL is uncatchable), and left a
 * heartbeat that stayed FRESH for the full 120 s window. The agent believed it
 * was listening; it was deaf, and nothing said so.
 *
 * So arming has to refuse up front, which means detecting the namespace. The
 * rules below are deliberately narrow, and each is measured rather than guessed:
 *
 *   1. `/proc/self/status` carrying an `NSpid:` line with TWO OR MORE numbers:
 *      the kernel is saying this process has a pid in more than one namespace,
 *      i.e. a NESTED PID namespace. Measured inside `unshare -Urpf` (no /proc
 *      remount) on this host: `NSpid:\t3125325\t5`.
 *   2. Otherwise `/proc/1/comm` naming a sandbox supervisor we KNOW — `codex`,
 *      `codex-linux-sandbox`, or `bwrap` (bubblewrap, what Codex bundles and
 *      what Flatpak and several agent sandboxes use). This is the remounted-
 *      procfs shape (`unshare -Urpf --mount-proc`), where NSpid collapses to a
 *      single number and pid 1's identity is the only evidence left.
 *
 * THE REAL SAMPLE (codex-cli 0.153.4, `codex exec -s workspace-write`, measured
 * 2026-09-16): inside the sandbox `/proc/1/comm` is `codex` — NOT
 * `codex-linux-sandbox` — and `/proc/self/status` shows a single-value
 * `NSpid:\t4`, because the bundled bubblewrap remounts /proc. Outside it is pid
 * 1 `systemd` with the ordinary host NSpid. (`/proc/self/ns/pid` equals
 * `/proc/1/ns/pid` in BOTH cases, which is why that tempting-looking check is
 * not used here: it proves nothing.)
 *
 * AND NOTHING ELSE. In particular an arbitrary, unrecognized `/proc/1/comm` is
 * NOT evidence: every Docker container has its entrypoint at pid 1 with a
 * single-field NSpid, and a container is not a per-command sandbox — a listener
 * armed there outlives the command that started it. Treating "pid 1 isn't
 * systemd" as a sandbox would refuse to arm on every containerized agent in the
 * fleet. When we cannot read procfs at all (macOS, a locked-down mount) the
 * answer is false with `procfs unreadable`: the caller may say so out loud, but
 * it must not block an agent on a guess.
 */
import fs from 'node:fs';

/**
 * Where the facts come from. `readFile` returns the file's contents, or
 * `undefined` for ANY failure — missing, unreadable, a directory, an EIO from a
 * weird mount. Injected so the rules above are testable without a real sandbox.
 */
export interface PidNamespaceProbe {
  readFile(path: string): string | undefined;
}

/**
 * The verdict, plus the one-line reason a CLI can print verbatim.
 *
 * READ THE FIELD NAME LITERALLY. `inNamespace` says a PID namespace was
 * DETECTED — nothing stronger. Multiple `NSpid` fields prove a NESTED PID
 * namespace, which some container setups (a container inside a container, some
 * CI runners) also show; a pid 1 named `codex` is consistent with the Codex
 * sandbox as reproduced on 2026-09-16, not universal proof that this particular
 * namespace tears its children down. The evidence string therefore states only
 * what was observed, and the caller decides what to do about it.
 */
export interface PidNamespaceReport {
  inNamespace: boolean;
  /**
   * What was observed, never a conclusion about the harness — e.g.
   * `NSpid lists 2 pids (nested PID namespace)`, `pid 1 is codex`,
   * `procfs unreadable`.
   */
  evidence: string;
}

/** Init names that mean "per-command sandbox", not "container". */
const SANDBOX_INITS = new Set(['codex', 'codex-linux-sandbox', 'bwrap']);

const STATUS_PATH = '/proc/self/status';
const INIT_COMM_PATH = '/proc/1/comm';

/** The real filesystem, with every error swallowed. */
const defaultProbe: PidNamespaceProbe = {
  readFile(p: string): string | undefined {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** How many pids the `NSpid:` line lists, or 0 when there is no usable line. */
function nspidCount(status: string): number {
  for (const line of status.split('\n')) {
    if (!line.startsWith('NSpid:')) continue;
    const pids = line.slice('NSpid:'.length).trim().split(/\s+/).filter((t) => /^\d+$/.test(t));
    if (pids.length > 0) return pids.length;
  }
  return 0;
}

/**
 * Is this process inside a PID namespace that a sandbox supervisor owns?
 *
 * Never throws, and never guesses: an unreadable procfs reads as `false` with
 * the evidence saying so, so a caller can distinguish "no sandbox" from "cannot
 * tell" without either one becoming a hard failure.
 */
export function detectPidNamespace(probe: PidNamespaceProbe = defaultProbe): PidNamespaceReport {
  const status = probe.readFile(STATUS_PATH);
  const comm = probe.readFile(INIT_COMM_PATH);

  if (status !== undefined) {
    const count = nspidCount(status);
    if (count >= 2) {
      return { inNamespace: true, evidence: `NSpid lists ${count} pids (nested PID namespace)` };
    }
  }

  if (comm !== undefined) {
    const init = comm.trim();
    if (SANDBOX_INITS.has(init)) return { inNamespace: true, evidence: `pid 1 is ${init}` };
  }

  if (status === undefined && comm === undefined) {
    return { inNamespace: false, evidence: 'procfs unreadable' };
  }
  return { inNamespace: false, evidence: 'no PID namespace detected' };
}
