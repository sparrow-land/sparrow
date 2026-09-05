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
  verify,
  assetsDir,
  skillDir,
  settingsPath,
  BG_REAP_OPT_OUT_KEY,
  type RunSkillOptions,
  type Scope,
  type Resolved,
} from './install.js';

export {
  renderSkillMd,
  skillTemplate,
  fragment,
  FRAGMENT_KEYS,
  PROVIDERS,
  PROVIDER_LABEL,
  CODEX_MIN_VERSION,
  type Provider,
} from './skill-md.js';

export {
  adapterFor,
  detectProvider,
  ADAPTERS,
  type ProviderAdapter,
  type CheckLine,
  type Detection,
} from './providers.js';

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
