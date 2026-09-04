/**
 * Loop-state + heartbeat bridge for the `sparrow` CLI.
 *
 * Thin, process-defaulted wrappers over the shared `@sparrow/skill` primitives so
 * the CLI's `watch`/`loop` runtimes can touch a heartbeat (proving the loop is
 * alive to the skill's Stop hook) and read/write the sanctioned `loop-state`
 * switch — with ONE implementation shared with the `sparrow-skill` bin.
 *
 * WHICH state dir: `resolveStateDir` picks `$SPARROW_STATE_DIR`, else the
 * nearest project above the cwd (`<project>/.sparrow` — what a project-scope
 * skill install creates and stamps into its hooks), else `~/.sparrow`. That is
 * what keeps three agents in three checkouts, under one unix user, from sharing
 * one heartbeat and one pause. `skillInstall` (= `runSkill`) lets a `sparrow skill …` subcommand drive
 * the exact same install/pause/resume/status logic as `npx sparrow-skill`.
 */
import {
  resolveStateDir,
  readLoopState as readLoopStateAt,
  writeLoopState as writeLoopStateAt,
  touchHeartbeat as touchHeartbeatAt,
  markHeartbeatDead as markHeartbeatDeadAt,
  runSkill,
  type DeadReason,
  type ListenerKind,
  type LoopState,
} from '@sparrow/skill';

type Env = Record<string, string | undefined>;

/**
 * Touch the state dir's `heartbeat` (throttled ~15s) — call from await/watch/loop
 * activity, naming the listener doing the touching. The kind is what lets the
 * skill's Stop hook tell a WAKE PATH (`await` exits when work arrives, which
 * re-invokes a turn-based agent) from a hold-only listener (`watch`/`loop` keep
 * a turn-based agent online but deaf). Omitting it writes an empty heartbeat,
 * which the hook reads as "unknown listener, cannot judge".
 */
export function touchHeartbeat(env: Env = process.env, kind?: ListenerKind): void {
  touchHeartbeatAt(resolveStateDir(env), { kind });
}

/**
 * Stamp the state dir's `heartbeat` as DEAD (`killed:<signal>` | `stopped:<signal>`)
 * — what a listener does as it dies, so the next turn's hooks know there is no
 * listener instead of trusting an mtime the corpse left fresh. Synchronous and
 * best-effort: safe to call from a signal handler.
 */
export function markHeartbeatDead(
  env: Env = process.env,
  reason: DeadReason = 'killed',
  signal?: string,
): void {
  markHeartbeatDeadAt(resolveStateDir(env), reason, signal);
}

/** Read the loop switch (`engaged` | `paused` | `undefined`). */
export function readLoopState(env: Env = process.env): LoopState | undefined {
  return readLoopStateAt(resolveStateDir(env));
}

/** Write the loop switch. */
export function writeLoopState(state: LoopState, env: Env = process.env): void {
  writeLoopStateAt(resolveStateDir(env), state);
}

/**
 * Re-export of `@sparrow/skill`'s `runSkill` so a `sparrow skill <sub>` command
 * shares the npx bin's implementation. Signature: `skillInstall(argv, { cwd,
 * home, env, log }) => Promise<exitCode>`.
 */
export { runSkill as skillInstall };
export type { DeadReason, ListenerKind, LoopState };
