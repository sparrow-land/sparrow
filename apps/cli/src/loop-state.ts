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
import fs from 'node:fs';
import {
  heartbeatPath,
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
export function touchHeartbeat(
  env: Env = process.env,
  kind?: ListenerKind,
  force = false,
  /**
   * The `await` generation this claim belongs to (see `await-owner.ts`),
   * written as a second token so a reader can discard a LIVE claim from a
   * listener that has since been superseded — the check/write window is real,
   * and an untagged claim would quietly demote the successor's kind.
   * `watch`/`loop` pass nothing.
   */
  generation?: string,
): void {
  touchHeartbeatAt(resolveStateDir(env), { kind, force, generation });
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
  /**
   * The `await` generation nonce this stamp belongs to (see
   * `await-owner.ts`), appended as a second token so a reader can discard a
   * stamp written by a listener that has since been superseded. `watch`/`loop`
   * pass nothing: they have no generation, and their stamps are judged as
   * before.
   */
  generation?: string,
): void {
  markHeartbeatDeadAt(resolveStateDir(env), reason, signal, generation);
}

/**
 * Stamp the heartbeat `blocked:<reason>` — the listener is alive and DELIBERATELY
 * not listening, because the agent behind it cannot take a turn (a Claude Code
 * usage limit; see await-blocked.ts).
 *
 * A THIRD WORD next to `killed`/`stopped`, and deliberately not one of them: the
 * process is fine, the stream is closed on purpose, and it will come back by
 * itself. Readers that know the word can say so; the skill's heartbeat reader
 * treats any word it does not know as UNJUDGEABLE, which is the correct answer
 * for an older reader meeting a newer listener — never "there is a listener".
 *
 * Written here rather than through `@sparrow/skill`'s `markHeartbeatDead`
 * because that one's vocabulary is the two DEAD reasons, and standby is not a
 * death. Same file, same shape (`<word> [generation]`), same fresh mtime:
 * content is what disqualifies a heartbeat, never age.
 */
export function markHeartbeatBlocked(
  env: Env = process.env,
  reason = 'blocked',
  /** The `await` generation nonce, so a superseded listener's stamp is discardable. */
  generation?: string,
  now: number = Date.now(),
): void {
  try {
    const dir = resolveStateDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const file = heartbeatPath(dir);
    const word = `blocked:${reason}`;
    fs.writeFileSync(file, generation ? `${word} ${generation}\n` : `${word}\n`);
    try {
      const when = new Date(now);
      fs.utimesSync(file, when, when);
    } catch {
      // leave the OS-assigned mtime (still "fresh")
    }
  } catch {
    // best-effort: a listener must never crash over a heartbeat
  }
}

/**
 * Stamp the heartbeat `orphaned` — an `await` whose Claude Code session is gone
 * (the harness pid died, or it is no longer this process's ancestor), so the
 * listener could never wake anyone and is standing down (exit 5).
 *
 * A FOURTH WORD, next to `killed`/`stopped`/`blocked`, and deliberately not
 * `killed:<something>`: nothing killed this process — it noticed it had been
 * abandoned and left. Written here for the same reason as
 * {@link markHeartbeatBlocked}: `@sparrow/skill`'s `markHeartbeatDead` speaks
 * only the two signal reasons, and a reader that does not know this word treats
 * it as UNJUDGEABLE — never as a live listener. Same file, same shape
 * (`orphaned [generation]`), same fresh mtime.
 */
export function markHeartbeatOrphaned(
  env: Env = process.env,
  /** The `await` generation nonce, so a superseded listener's stamp is discardable. */
  generation?: string,
  now: number = Date.now(),
): void {
  try {
    const dir = resolveStateDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const file = heartbeatPath(dir);
    fs.writeFileSync(file, generation ? `orphaned ${generation}\n` : 'orphaned\n');
    try {
      const when = new Date(now);
      fs.utimesSync(file, when, when);
    } catch {
      // leave the OS-assigned mtime (still "fresh")
    }
  } catch {
    // best-effort: a listener must never crash over a heartbeat
  }
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
