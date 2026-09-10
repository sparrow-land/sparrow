/**
 * ONE prescription for "the sparrow command this agent must run".
 *
 * A machine can host several agents under one unix user. They share one
 * `credentials.json` (or, when an agent is isolated, they do NOT — it exports
 * its own `SPARROW_CONFIG_DIR`), so a BARE `sparrow await` typed into a fresh
 * shell acts as whichever neighbour owns `defaultProfile`. Every surface that
 * tells an agent to run a sparrow command — the skill fragments, the three hook
 * nudges, the CLI's enroll banner, the Codex wake queue — therefore has to
 * qualify that command with the SAME rules, or one of them silently prescribes
 * somebody else's identity.
 *
 * So the rules live here, once:
 *   - a named profile  → `--profile <name>`
 *   - a custom store   → an `SPARROW_CONFIG_DIR=<dir>` prefix
 *   - neither          → the bare command, byte for byte as before
 *
 * WHAT CALLERS DECIDE, NOT THIS MODULE: whether a profile is worth naming. Pass
 * `profile` only when the bare command would resolve somewhere else (a
 * non-default profile, or any custom store). Pass `configDir` only where the
 * text is PRIVATE to one session — a queued Codex turn — never in a banner an
 * agent may paste into a room.
 */

/** The facts that qualify a prescribed command for ONE agent's credential store. */
export interface ListenerScope {
  /** Profile to name with `--profile`. Blank/absent → the bare command. */
  profile?: string;
  /** Custom `SPARROW_CONFIG_DIR` to prefix. Blank/absent → no prefix. */
  configDir?: string;
}

/** Tokens a POSIX shell reads literally — everything else gets quoted. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Render `value` so a POSIX shell passes it through unchanged. A plain word is
 * returned as-is (so the common case reads like something a human would type);
 * anything else is single-quoted, with embedded single quotes escaped the only
 * way `sh` allows — `'\''`.
 */
export function shellQuote(value: string): string {
  if (PLAIN_WORD.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * The prescribed `sparrow <subcommand>` for this scope. `subcommand` may carry
 * its own arguments (`'await --wake-on dm'`); the qualifier is appended after
 * them, which is where commander accepts a global flag.
 */
export function sparrowCommand(subcommand: string, scope: ListenerScope = {}): string {
  const profile = clean(scope.profile);
  const configDir = clean(scope.configDir);
  const prefix = configDir ? `SPARROW_CONFIG_DIR=${shellQuote(configDir)} ` : '';
  const qualifier = profile ? ` --profile ${shellQuote(profile)}` : '';
  return `${prefix}sparrow ${subcommand}${qualifier}`;
}

/** The wake command a turn-based agent re-arms every turn. */
export function awaitCommand(scope: ListenerScope = {}): string {
  return sparrowCommand('await', scope);
}

/** The turn-based harnesses whose presence we can read off the environment. */
export type TurnBasedRuntime = 'codex' | 'claude';

/**
 * Which turn-based harness is running this process, from its own environment.
 *
 * Deliberately narrower than {@link import('./providers.js').detectProvider},
 * which guesses from PROJECT FILES so that `skill install` can wire the right
 * adapter. This answers a different question — "does the process reading my
 * output think only when invoked?" — and only the harness's own variables can
 * answer it: Codex exports `CODEX_THREAD_ID` (the id its hooks inherit), Claude
 * Code exports `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`. Undefined means we do not
 * know, and callers must then say BOTH branches rather than guess one.
 */
export function detectTurnBasedRuntime(
  env: Record<string, string | undefined>,
): TurnBasedRuntime | undefined {
  if (clean(env.CODEX_THREAD_ID)) return 'codex';
  if (clean(env.CLAUDECODE) || clean(env.CLAUDE_CODE_ENTRYPOINT)) return 'claude';
  return undefined;
}
