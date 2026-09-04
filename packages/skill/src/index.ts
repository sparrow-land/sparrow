/**
 * `@sparrow/skill` — the Sparrow Claude Code skill, as an installable package.
 *
 * The library surface (consumed by the `sparrow` CLI so `sparrow skill …` shares
 * one implementation with the `npx sparrow-skill` bin) plus the loop-state and
 * heartbeat primitives that the CLI's `watch`/`loop` runtimes touch.
 */
export {
  runSkill,
  install,
  uninstall,
  pause,
  resume,
  status,
  assetsDir,
  skillDir,
  settingsPath,
  type RunSkillOptions,
  type Scope,
} from './install.js';

export {
  resolveStateDir,
  homeStateDir,
  findProjectRoot,
  readLoopState,
  writeLoopState,
  touchHeartbeat,
  heartbeatAgeSeconds,
  readHeartbeatKind,
  readHeartbeatState,
  markHeartbeatDead,
  loopStatePath,
  heartbeatPath,
  HEARTBEAT_THROTTLE_MS,
  // Test-only throttle reset — exported so downstream packages (the CLI's
  // heartbeat bridge) can test their own touch call sites deterministically.
  __resetHeartbeatThrottle,
  type LoopState,
  type ListenerKind,
  type DeadReason,
  type HeartbeatState,
} from './state.js';
