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
import { CliError, envSwitchedOff as switchedOff, envSwitchedOn as switchedOn, type Env } from './util.js';

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


/**
 * THE SPAWNED SUB-AGENT (field incident, Codex 0.154, 2026-09-17).
 *
 * A sub-agent Codex spawned ran `sparrow await` in the parent's project dir with
 * the parent's profile. Newest-wins did exactly what it promises and handed it
 * the state dir; the root session's listener stood down. Then work arrived and
 * the bridge ran `codex queue --thread <child>`, which Codex REFUSED (-32600,
 * "direct app-server input is not allowed for unloaded spawned sub-agents").
 * The wake path did not merely fail — for a sub-agent it cannot exist — and the
 * workspace went deaf with unread work in the queue.
 *
 * THE SIGNAL IS OBSERVED, NOT DOCUMENTED (measured by vm5 on a real run): in a
 * spawned sub-agent shell CODEX_SESSION_ID carries the ROOT thread id while
 * CODEX_THREAD_ID carries the child's own; in a root shell the two are equal.
 * So the refusal fires ONLY when both are present and they DIFFER. A missing
 * session id is ignorance, not evidence, and refusing on ignorance would strand
 * every Codex build that does not export it.
 */
export const subagentRefusal = (thread: string, session: string): string =>
  `sparrow await refused to arm: this shell belongs to a spawned Codex sub-agent (thread ${thread}, ` +
  `session ${session}), and a sub-agent's listener cannot be woken by Codex, so arming here would ` +
  "silently replace the root session's listener. Leave listening to the root session: post your " +
  'update and let it drain. Operators who know better can set SPARROW_AWAIT_SUBAGENT=1.';

/**
 * Worded to the DETECTED CONDITION, not to a certainty: the kernel tells us
 * about the namespace, not about what that namespace's owner will do when the
 * command returns. "Appears to be" is the honest claim, and the escape hatch is
 * named in the line itself for the operator who knows better.
 *
 * THE WAY OUT IS A PLACE THE LISTENER OUTLIVES THIS COMMAND — and that is NOT
 * "arm it from a hook": every hook the skill installs instructs, blocks or
 * heartbeats, and not one of them starts `sparrow await`. Sending a trapped
 * agent to a hook would be sending it nowhere.
 */
export const sandboxRefusal = (evidence: string): string =>
  `sparrow await refused to arm: this command appears to be running inside a sandbox PID namespace ` +
  `(${evidence}), where a background listener is killed the moment the command returns. Run it where ` +
  'it outlives this command: re-run it unsandboxed (in Codex, request approval to run this command ' +
  'outside the sandbox), or run `sparrow harness --codex` on a host that stays up. Operators who know ' +
  'better can set SPARROW_AWAIT_SANDBOX_CHECK=0.';

/**
 * The weaker signal: a nested PID namespace with an ordinary init.
 *
 * NOT A REFUSAL. This is what a per-command sandbox without a `--mount-proc`
 * looks like — and equally what container-in-container, nested CI runners and
 * several agent harnesses look like, where a background listener DOES outlive
 * the command that started it. Refusing here would strand every one of those.
 * So it names the condition, names what to check after the turn, and arms.
 */
export const nestedNamespaceNote = (evidence: string): string =>
  `this command is running inside a nested PID namespace (${evidence}). If that namespace belongs to ` +
  'a per-command sandbox, this listener dies when the command returns; a persistent container is ' +
  'fine. `sparrow skill verify` after this turn should still show a live listener; if it does not, ' +
  're-run unsandboxed or use `sparrow harness`.';

/**
 * The one line for each way hook verification can come up short.
 *
 * EVERY ONE OF THESE IS A STATEMENT ABOUT EVIDENCE, NEVER ABOUT THE HOOKS. A
 * missing stamp is a fresh install before its Codex restart; a manual stamp is a
 * script check that proves nothing either way; and stamps naming another thread
 * are what a sibling session leaves behind, since there is one stamp file per
 * EVENT rather than per thread. "The hooks are not running" would be a claim the
 * CLI cannot support — and would send an agent chasing a working install.
 */
export function unverifiedHooksNote(
  reason: 'no-stamps' | 'manual-only' | 'other-thread',
  thread: string,
): string {
  const head = `Codex hooks have not been observed firing for this thread (${thread})`;
  const tail = '`sparrow skill verify` shows the details.';
  // The consequence is always CONDITIONAL — "if they are not running" — because
  // the stamps are missing evidence, not evidence of absence.
  const consequence =
    'this listener has no verified Stop-hook safety net: if they are not running, nothing re-arms ' +
    'it when the turn ends.';
  switch (reason) {
    case 'manual-only':
      return (
        `${head}: the only stamps on disk came from a hand run (SPARROW_HOOK_SELFTEST=1), which is not ` +
        `evidence Codex runs them, so ${consequence} Trust the project's hooks (review them with /hooks in ` +
        `Codex, or --dangerously-bypass-hook-trust headless) and restart Codex; ${tail}`
      );
    case 'other-thread':
      return (
        `${head}: the stamps on disk name a different Codex thread (a sibling session may simply have ` +
        `written last), so nothing proves they fire for this one and ${consequence} If hooks were just ` +
        `installed, restart Codex after trusting them; ${tail}`
      );
    default:
      return (
        `${head}, so ${consequence} If hooks were just installed, restart Codex after trusting them; ${tail}`
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

  // 0. The spawned sub-agent — FIRST, before even the sandbox probe. Every other
  //    check asks "will this listener survive?"; this one asks whether it could
  //    ever be woken at all, and for a sub-agent the answer is no at any exit.
  const shellThread = env.CODEX_THREAD_ID?.trim();
  const shellSession = env.CODEX_SESSION_ID?.trim();
  if (
    shellThread &&
    shellSession &&
    shellThread !== shellSession &&
    !switchedOn(env.SPARROW_AWAIT_SUBAGENT)
  ) {
    throw new CliError(subagentRefusal(shellThread, shellSession));
  }

  // 1. The sandbox — checked first, because arming inside one fails no matter
  //    how healthy the hooks are. ONLY the supervisor identity is strong enough
  //    to refuse on (see nestedNamespaceNote for why a bare nested namespace is
  //    not), so the two signals part company here.
  if (!switchedOff(env.SPARROW_AWAIT_SANDBOX_CHECK)) {
    const sandbox = detectPidNamespace(probe);
    if (sandbox.signal === 'init') throw new CliError(sandboxRefusal(sandbox.evidence));
    if (sandbox.signal === 'nspid') err(`[await] ${nestedNamespaceNote(sandbox.evidence)}\n`);
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
