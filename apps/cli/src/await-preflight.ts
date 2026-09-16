/**
 * Can `sparrow await` actually LISTEN from where it was just started?
 *
 * THE INCIDENT (2026-09-16). A Codex agent armed `sparrow await` from a
 * model-run shell command. Codex runs those inside a per-command PID namespace
 * (pid 1 is the `codex` supervisor), so the listener was SIGKILLed the instant
 * the command returned — uncatchable, nothing stamped, a heartbeat that stayed
 * fresh for its full window. The agent believed it was armed; it was deaf.
 * Separately, Codex's two silent trust gates meant none of the installed hooks
 * had ever fired, so nothing could re-arm the listener or block a deaf turn end,
 * and again nothing said so.
 *
 * ERGONOMICS RULE (product owner): no new flag for an agent to remember, no new
 * step in its loop. Codex is auto-detected from the environment, the CLI does
 * the right thing silently when it can, and when it cannot it says so ONCE, in
 * one line, naming the single command to run next.
 *
 * TWO CHECKS, TWO DIFFERENT KINDS OF CERTAINTY — which is why only one of them
 * is fatal:
 *
 *   1. THE SANDBOX is PROVABLE from the inside (the kernel says so: see
 *      `detectPidNamespace`). Arming there cannot work, so it refuses, exit 1.
 *   2. UNFIRED HOOKS are UNVERIFIED, not disproven. A stamp is missing whenever
 *      the hooks were installed but Codex has not been restarted yet, or the
 *      stamps belong to a sibling thread. And the Codex queue bridge wakes the
 *      agent WITHOUT any hook, so refusing on a maybe would cost more than it
 *      saves. It warns in one line and arms. `SPARROW_AWAIT_REQUIRE_HOOKS=1`
 *      makes it fatal for operators who want strictness.
 *
 * Both run before this process touches the network or the state dir, so a
 * refusal changes nothing — in particular it never publishes a generation that
 * would evict the healthy listener it is trying to replace.
 */
import {
  detectPidNamespace,
  hooksVerifiedForThread,
  resolveStateDir,
  type PidNamespaceProbe,
} from '@sparrow/skill';
import { CliError, type Env } from './util.js';

export interface CodexAwaitPreflightOpts {
  env: Env;
  /** The Codex thread this listener is bridging to (never empty). */
  thread: string;
  /** Where hook stamps live; defaults to the usual resolution from `env`. */
  stateDir?: string;
  /** One line at a time, newline included — `io.err`. */
  err(s: string): void;
  /** Injected /proc reader; the real filesystem by default. */
  probe?: PidNamespaceProbe;
}

/** Off only when explicitly switched off — an operator/test escape hatch. */
function switchedOff(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/** On only when explicitly switched on. */
function switchedOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== '' && !switchedOff(v);
}

/**
 * Worded to the DETECTED CONDITION, not to a certainty: the kernel tells us
 * about the namespace, not about what that namespace's owner will do when the
 * command returns. "Appears to be" is the honest claim, and the escape hatch is
 * named in the line itself for the operator who knows better.
 */
export const sandboxRefusal = (evidence: string): string =>
  `sparrow await refused to arm: this command appears to be running inside a sandbox PID namespace ` +
  `(${evidence}), where a background listener is killed the moment the command returns. Arm it from ` +
  "a hook instead (the Sparrow skill's hooks do this; `sparrow skill verify` shows whether they " +
  'fire) or run this command unsandboxed. Operators who know better can set ' +
  'SPARROW_AWAIT_SANDBOX_CHECK=0.';

/** The one line for each way hook verification can come up short. */
export function unverifiedHooksNote(
  reason: 'no-stamps' | 'manual-only' | 'other-thread',
  thread: string,
): string {
  const head = `Codex hooks have not been observed firing for this thread (${thread}): `;
  const tail = '`sparrow skill verify` shows the details.';
  switch (reason) {
    case 'manual-only':
      return (
        `${head}the only hook stamps on disk came from a hand run (SPARROW_HOOK_SELFTEST=1), not from ` +
        'Codex itself, so nothing will re-arm this listener when the turn ends or block a deaf turn end. ' +
        `Trust the project's hooks (review them with /hooks in Codex, or --dangerously-bypass-hook-trust ` +
        `headless) and restart Codex; ${tail}`
      );
    case 'other-thread':
      return (
        `${head}the stamps on disk were written by a different Codex thread, so the hooks are not running ` +
        `for this one and nothing will re-arm this listener when the turn ends. Restart Codex after ` +
        `trusting its hooks so this session stamps its own; ${tail}`
      );
    default:
      return (
        `${head}nothing will re-arm this listener when the turn ends or block a deaf turn end. ` +
        `If hooks were just installed, restart Codex after trusting them; ${tail}`
      );
  }
}

export const LEGACY_HOOKS_NOTE =
  'Codex hooks are firing, but this hook wrapper predates thread stamps, so it cannot confirm they ' +
  'belong to this Codex thread; `sparrow upgrade` refreshes the skill and its wrapper.';

/**
 * Refuse (or warn) BEFORE arming. Throws {@link CliError} (exit 1) for a sandbox
 * this listener cannot outlive, and — only under `SPARROW_AWAIT_REQUIRE_HOOKS` —
 * for hooks that have not been observed firing. Returns having written at most
 * one advisory line to stderr.
 */
export function codexAwaitPreflight(opts: CodexAwaitPreflightOpts): void {
  const { env, thread, err, probe } = opts;
  const stateDir = opts.stateDir ?? resolveStateDir(env);

  // 1. The sandbox: proof, so it is fatal — and checked first, because arming
  //    in a sandbox fails no matter how healthy the hooks are.
  if (!switchedOff(env.SPARROW_AWAIT_SANDBOX_CHECK)) {
    const sandbox = detectPidNamespace(probe);
    if (sandbox.inNamespace) throw new CliError(sandboxRefusal(sandbox.evidence));
  }

  // 2. The hooks: absence of a stamp is not evidence of absence.
  const hooks = hooksVerifiedForThread(stateDir, thread);
  if (hooks.verified) {
    if (hooks.legacy) err(`[await] ${LEGACY_HOOKS_NOTE}\n`);
    return;
  }
  const note = unverifiedHooksNote(hooks.reason, thread);
  if (switchedOn(env.SPARROW_AWAIT_REQUIRE_HOOKS)) throw new CliError(note);
  err(`[await] ${note}\n`);
}
