/**
 * Sparrow Claude Code skill installer — the PURE LIBRARY.
 *
 * Copies `assets/SKILL.md` + `assets/hooks/*.sh` into a `.claude/skills/sparrow/`
 * directory (project by default, `~/.claude/…` with `--user`), and idempotently
 * merges the Stop (and optional UserPromptSubmit) hook entries into the sibling
 * settings file — preserving every unrelated setting and hook. The same merge
 * writes `env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`, opting the session
 * out of Claude Code's memory-pressure reaper so a long idle stretch cannot
 * kill the background `sparrow await` that is a turn-based agent's only wake
 * path. Also seeds the state dir's `loop-state` to `engaged` on first install.
 *
 * ONE MACHINE, SEVERAL AGENTS. A project-scope install is deliberately PRIVATE
 * to this checkout and this agent:
 *   - hooks land in `.claude/settings.local.json` (personal, not committed);
 *     `--shared` opts into the committed `.claude/settings.json` instead;
 *   - every hook command carries `SPARROW_STATE_DIR="$CLAUDE_PROJECT_DIR/.sparrow"`
 *     and `SPARROW_PROFILE="<profile>"`, so a hook acts as the agent that
 *     installed it, on this project's own loop switch and heartbeat;
 *   - `.sparrow/` (and, unless `--shared`, `.claude/skills/sparrow/`) are added
 *     to `.git/info/exclude` so none of it can be committed by accident.
 * Both settings files are swept on every install, so a registration made by an
 * older version in the other file is removed: one registration, in one file.
 *
 * This module is SIDE-EFFECT-FREE: importing it never runs a command. The
 * `sparrow-skill` bin (`bin.ts`) and the `sparrow skill …` CLI subcommand both
 * drive it via {@link runSkill}, so there is one implementation and importing it
 * into the single-file API-served CLI bundle can never hijack `sparrow`.
 *
 * Runtime deps: node's own `fs`/`path`/`url` only.
 *
 * Subcommands: `install` (default) | `uninstall` | `pause` | `resume` | `status`.
 * Flags: `--user` (user scope instead of the project), `--shared` (project
 * scope: write the committed `.claude/settings.json`), `--profile <name>` (the
 * profile stamped into the hook commands).
 */
import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDED_ASSETS } from './assets-gen.js';
import { fileURLToPath } from 'node:url';
import {
  resolveStateDir,
  homeStateDir,
  readLoopState,
  writeLoopState,
  heartbeatAgeSeconds,
  type LoopState,
} from './state.js';

type Env = Record<string, string | undefined>;

/** Where the skill installs — the project's `.claude` or the user's `~/.claude`. */
export type Scope = 'project' | 'user';

/** Options for a single `sparrow-skill` invocation (all resolvable from the process). */
export interface RunSkillOptions {
  /** Project root (for project-scope installs). Default `process.cwd()`. */
  cwd?: string;
  /** HOME (for `~/.claude` user scope and `~/.sparrow` state). Default `$HOME`. */
  home?: string;
  /** Environment (for `$SPARROW_STATE_DIR` / server + token). Default `process.env`. */
  env?: Env;
  /** Sink for human-readable output. Default `process.stdout`. */
  log?: (msg: string) => void;
}

interface Resolved {
  scope: Scope;
  cwd: string;
  home: string;
  env: Env;
  log: (msg: string) => void;
  stateDir: string;
  /** Project scope: write the COMMITTED `.claude/settings.json` (`--shared`). */
  shared?: boolean;
  /** Profile stamped into project-scope hook commands (`undefined` = none known). */
  profile?: string;
}

/** The shell scripts this skill ships (copied into the skill's `hooks/` dir). */
const SCRIPTS: ReadonlyArray<string> = ['sparrow-stop-check.sh', 'sparrow-auto-status.sh'];

/**
 * Scripts SHIPPED BY PAST VERSIONS that this version no longer installs. An
 * upgrade (re-install over an older layout) prunes their hook entries from the
 * settings files and deletes the orphaned files — otherwise a retired hook keeps
 * firing forever (found live: v1's standalone presence hook survived a v2
 * re-install). Every event is swept, since old registrations may sit anywhere.
 */
const RETIRED_SCRIPTS: ReadonlyArray<string> = ['sparrow-presence.sh'];

/**
 * A Notification hook's `matcher` is a regex over the event's `notification_type`,
 * and `''` means EVERY type — including `idle_prompt`, which Claude Code fires
 * ~60s after a turn ends when the human has not typed. Registered with `''`, our
 * notification hook turned that into a sticky "blocked — needs your input" that
 * never cleared, so idle agents advertised themselves as blocked indefinitely.
 * We now subscribe only to the types the hook actually handles (the script gates
 * on the type as well — belt and braces).
 */
const NOTIFICATION_MATCHER =
  'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|idle_prompt';

/**
 * The Claude Code hook registrations merged into the settings file. `sparrow-auto-status.sh`
 * is a single script fanned across three events, each passing its `mode` as the
 * command arg. The `Stop` event runs only `sparrow-stop-check.sh`, which itself
 * invokes auto-status (idle) on its allow paths — so a blocked stop never
 * flickers the agent idle (no separate Stop entry, no working→idle→working churn).
 */
type HookEvent = 'Stop' | 'UserPromptSubmit' | 'PostToolUse' | 'Notification';
const HOOKS: ReadonlyArray<{ file: string; event: HookEvent; mode?: string; matcher?: string }> = [
  { file: 'sparrow-stop-check.sh', event: 'Stop' },
  { file: 'sparrow-auto-status.sh', event: 'UserPromptSubmit', mode: 'prompt' },
  { file: 'sparrow-auto-status.sh', event: 'PostToolUse', mode: 'post-tool', matcher: '*' },
  {
    file: 'sparrow-auto-status.sh',
    event: 'Notification',
    mode: 'notification',
    matcher: NOTIFICATION_MATCHER,
  },
];

/** The two settings files Claude Code reads at a scope, in load order. */
const SETTINGS_FILES: ReadonlyArray<string> = ['settings.json', 'settings.local.json'];

/**
 * The Claude Code setting that keeps our wake listener alive.
 *
 * Claude Code ≥ 2.1.193 reaps tracked background shells: "On macOS and Linux,
 * Claude Code terminates running background tasks when the operating system
 * signals memory pressure, provided the session has been idle for at least 30
 * minutes and no turn or subagent is running"
 * (https://code.claude.com/docs/en/interactive-mode.md). For a turn-based
 * Sparrow agent the reaped task is EXACTLY its wake listener — the background
 * `sparrow await` — and "idle 30+ minutes with nothing running" is precisely
 * the stretch during which that listener is the only thing keeping the agent
 * reachable. The agent then sits deaf until a human types, which is the failure
 * this whole skill exists to prevent. (Confirmed live with strace: the SIGTERM's
 * `si_pid` is the session's own `claude` process.)
 *
 * So every install merges the documented opt-out into the settings file it
 * targets. It is a plain env var, so it only applies to sessions started AFTER
 * the write — until then the killed-stamp heartbeat plus the prompt-hook nudge
 * remain the recovery path.
 */
export const BG_REAP_OPT_OUT_KEY = 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP';
const BG_REAP_OPT_OUT_VALUE = '1';

/** The single line an install prints about the env opt-out it just wrote. */
const BG_REAP_INSTALL_NOTE =
  `settings env: ${BG_REAP_OPT_OUT_KEY}=1 (Claude Code's memory-pressure reaper would otherwise ` +
  `kill your await listener during long idle stretches; takes effect on the next Claude Code start)`;

/** Absolute path to the shipped `assets/` dir (sibling of the compiled `dist/`). */
export function assetsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
}

/** The `.claude` base dir for a scope. */
function claudeBaseDir(r: Resolved): string {
  return r.scope === 'user' ? path.join(r.home, '.claude') : path.join(r.cwd, '.claude');
}

/** Where the skill's files land: `<base>/skills/sparrow`. */
export function skillDir(r: Resolved): string {
  return path.join(claudeBaseDir(r), 'skills', 'sparrow');
}

/**
 * The settings file our registration is WRITTEN to.
 *
 * A project-scope install is personal by default — `.claude/settings.local.json`
 * is gitignored by Claude Code's own conventions, so three agents sharing a
 * checkout do not fight over one committed file (and nobody's `SPARROW_PROFILE`
 * ships to the whole team). `--shared` is the deliberate opt-in to
 * `.claude/settings.json`. User scope has only the one file.
 */
export function settingsPath(r: Resolved): string {
  const file = r.scope === 'project' && !r.shared ? 'settings.local.json' : 'settings.json';
  return path.join(claudeBaseDir(r), file);
}

/** Both settings files at this scope — swept on every install and uninstall. */
function settingsCandidates(r: Resolved): string[] {
  return SETTINGS_FILES.map((f) => path.join(claudeBaseDir(r), f));
}

/**
 * The `command` string stored in the settings file for a hook script. Project
 * scope uses `$CLAUDE_PROJECT_DIR` (portable across machines/checkouts); user
 * scope uses an absolute path under `~/.claude` (no project dir applies).
 *
 * Project scope also STAMPS the identity and the state dir as an env prefix:
 * `$CLAUDE_PROJECT_DIR/.sparrow` keeps this checkout's loop switch, heartbeat
 * and auto-status markers to itself, and `SPARROW_PROFILE` makes the hook speak
 * as the agent that installed it rather than as whoever owns `defaultProfile`.
 */
function hookCommand(r: Resolved, file: string, mode?: string): string {
  if (r.scope === 'user') {
    const abs = path.join(claudeBaseDir(r), 'skills', 'sparrow', 'hooks', file);
    return mode ? `${abs} ${mode}` : abs;
  }
  const script = `$CLAUDE_PROJECT_DIR/.claude/skills/sparrow/hooks/${file}`;
  const prefix = [`SPARROW_STATE_DIR="$CLAUDE_PROJECT_DIR/.sparrow"`];
  if (r.profile) prefix.push(`SPARROW_PROFILE="${r.profile}"`);
  return `${prefix.join(' ')} ${script}${mode ? ` ${mode}` : ''}`;
}

/* ------------------------------ profile stamping ------------------------------ */

/**
 * Profile names we are willing to interpolate into a shell command. Anything
 * with a quote, `$`, or a backtick in it would be a command-injection footgun in
 * a file we write for someone else to execute, so it is dropped instead.
 */
const SAFE_PROFILE = /^[A-Za-z0-9._@:+-]+$/;

/**
 * `defaultProfile` from the credential store, if it has one.
 *
 * The store's directory resolves exactly as the CLI and MCP server resolve it —
 * `$SPARROW_CONFIG_DIR` (verbatim) > `$XDG_CONFIG_HOME/sparrow` >
 * `~/.config/sparrow` — so a sandboxed install stamps ITS profile into the hooks
 * rather than the operator's shared default.
 */
function defaultProfileName(env: Env, home: string): string | undefined {
  const scoped = env.SPARROW_CONFIG_DIR?.trim();
  const dir = scoped || path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'sparrow');
  try {
    const raw = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
    const parsed = JSON.parse(raw) as { defaultProfile?: unknown };
    const name = typeof parsed.defaultProfile === 'string' ? parsed.defaultProfile.trim() : '';
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which profile a project-scope install stamps: the explicit `--profile`, else
 * `$SPARROW_PROFILE` (the session's identity), else the store's `defaultProfile`.
 * `undefined` when none of the three can name one — the stamp is then omitted
 * entirely and the hooks fall back to `defaultProfile` at run time.
 */
function stampedProfile(env: Env, home: string, explicit?: string): string | undefined {
  const candidate = explicit?.trim() || env.SPARROW_PROFILE?.trim() || defaultProfileName(env, home);
  if (!candidate) return undefined;
  return SAFE_PROFILE.test(candidate) ? candidate : undefined;
}

/* ----------------------------- settings.json merge ---------------------------- */

interface HookEntry {
  type: 'command';
  command: string;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [k: string]: unknown;
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  /** Claude Code's env block — shared with the user's own vars; never clobbered. */
  env?: Record<string, unknown>;
  [k: string]: unknown;
}

function readSettings(file: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** True when a stored hook command targets our script `file` (basename match). */
function targetsOurScript(command: unknown, file: string): boolean {
  return typeof command === 'string' && command.includes(file);
}

/** Drop every hook entry (across all groups) that references our script `file`. */
function stripOurHook(groups: HookGroup[], file: string): HookGroup[] {
  return groups
    .map((g) => ({
      ...g,
      hooks: Array.isArray(g.hooks) ? g.hooks.filter((h) => !targetsOurScript(h.command, file)) : [],
    }))
    // Keep groups that still hold hooks OR that we never touched (defensive).
    .filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
}

/**
 * Idempotently add our hook to `event`, and MIGRATE it across matcher changes.
 *
 * `stripOurHook` first drops our command from EVERY group under the event — not
 * just the one whose matcher we are about to write — and discards any group left
 * empty. That is what makes a matcher change safe: an install over an older
 * settings file (e.g. our Notification hook registered under `matcher: ''`)
 * ends with exactly one registration, under the current matcher, instead of the
 * old entry surviving alongside the new one and firing the hook twice — on
 * precisely the notification types the new matcher exists to exclude. Other
 * people's hooks sharing the old group are left untouched, and the group
 * survives if any of them remain.
 */
function upsertHook(
  settings: Settings,
  event: string,
  file: string,
  command: string,
  matcher = '',
): void {
  settings.hooks ??= {};
  const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const groups = stripOurHook(existing, file);
  let group = groups.find((g) => (g.matcher ?? '') === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    groups.push(group);
  }
  group.hooks.push({ type: 'command', command });
  settings.hooks[event] = groups;
}

/** Remove our hook from `event`; prune the event key if nothing else remains. */
function removeHook(settings: Settings, event: string, file: string): void {
  if (!settings.hooks || !Array.isArray(settings.hooks[event])) return;
  const groups = stripOurHook(settings.hooks[event], file);
  if (groups.length > 0) settings.hooks[event] = groups;
  else delete settings.hooks[event];
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

/** Remove every registration of `file` from every event in `settings`. */
function removeEverywhere(settings: Settings, file: string): void {
  if (!settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) removeHook(settings, event, file);
}

/* ----------------------- settings env: the reaper opt-out ---------------------- */

/** The settings' `env` block, if it is a plain object (arrays/scalars ignored). */
function envBlock(settings: Settings): Record<string, unknown> | undefined {
  const env = settings.env;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return undefined;
  return env as Record<string, unknown>;
}

/**
 * Merge `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` into `settings.env`,
 * creating the block when absent. Every other env var in there is somebody
 * else's, so this only ever writes the one key — and writing the same value
 * twice is what makes a re-install idempotent.
 */
function setReaperOptOut(settings: Settings): void {
  const env = envBlock(settings) ?? {};
  env[BG_REAP_OPT_OUT_KEY] = BG_REAP_OPT_OUT_VALUE;
  settings.env = env;
}

/**
 * Remove ONLY our key from `settings.env`, dropping the block if that empties
 * it (so an uninstall leaves a settings file it never touched byte-identical,
 * and one we did touch back the way we found it).
 */
function removeReaperOptOut(settings: Settings): void {
  const env = envBlock(settings);
  if (!env || !(BG_REAP_OPT_OUT_KEY in env)) return;
  delete env[BG_REAP_OPT_OUT_KEY];
  if (Object.keys(env).length === 0) delete settings.env;
}

/** True when this settings object carries the opt-out (any truthy-ish value). */
function hasReaperOptOut(settings: Settings): boolean {
  const value = envBlock(settings)?.[BG_REAP_OPT_OUT_KEY];
  return value !== undefined && value !== '' && value !== '0' && value !== false;
}

/**
 * Sweep BOTH settings files, then write our registrations into `target` (pass
 * `undefined` to only sweep — that is `uninstall`).
 *
 * Sweeping both is what makes the settings.local.json default safe on upgrade: a
 * project that registered our hooks in the committed `settings.json` under an
 * older version gets them removed there and re-added in the file this install
 * actually targets. One registration total, and never two hooks racing to post
 * the same status. A non-target file is only rewritten when it really changed.
 */
function syncSettings(r: Resolved, target?: string): string[] {
  const written: string[] = [];
  for (const sp of settingsCandidates(r)) {
    const isTarget = target !== undefined && sp === target;
    if (!isTarget && !fs.existsSync(sp)) continue;
    const settings = readSettings(sp);
    const before = JSON.stringify(settings);
    for (const file of [...RETIRED_SCRIPTS, ...SCRIPTS]) removeEverywhere(settings, file);
    if (isTarget) {
      for (const { file, event, mode, matcher } of HOOKS) {
        upsertHook(settings, event, file, hookCommand(r, file, mode), matcher ?? '');
      }
      setReaperOptOut(settings);
    } else if (target === undefined) {
      // Uninstall: strip our env opt-out from BOTH files, since an older (or
      // `--shared`) install may have written it into the other one. On INSTALL
      // the non-target file is left alone — `env` is a namespace shared with
      // the user's own vars, and a duplicate of the same value is harmless
      // (unlike a duplicate hook, which would fire twice).
      removeReaperOptOut(settings);
    }
    if (isTarget || JSON.stringify(settings) !== before) {
      writeSettings(sp, settings);
      written.push(sp);
    }
  }
  return written;
}

/* ------------------------------- git exclusion -------------------------------- */

/**
 * The `.git` directory governing `startDir`, walking up — handling the `.git`
 * FILE a worktree/submodule uses (`gitdir: <path>`). `undefined` outside a repo.
 */
function findGitDir(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.git');
    try {
      const st = fs.statSync(candidate);
      // A directory merely NAMED .git is not a repo (debris in /tmp once made
      // the walk — and then the exclude writer — treat all of /tmp as a repo).
      // HEAD is present in every real .git dir, bare or not, from `git init` on.
      if (st.isDirectory() && fs.existsSync(path.join(candidate, 'HEAD'))) return candidate;
      if (st.isDirectory()) return undefined;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(candidate, 'utf8'));
        if (m?.[1]) return path.resolve(dir, m[1].trim());
        return undefined;
      }
    } catch {
      // not here — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Append `entries` to `.git/info/exclude` (creating it as needed), skipping any
 * already listed. This is the LOCAL ignore file — untracked and personal, so
 * excluding one agent's private state never shows up in anybody's diff.
 * Returns `false` when there is no repo here (nothing to do).
 */
function addGitExcludes(gitDir: string, entries: string[]): boolean {
  try {
    const file = path.join(gitDir, 'info', 'exclude');
    let current = '';
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      // absent — we create it below
    }
    const have = new Set(current.split('\n').map((l) => l.trim()));
    const missing = entries.filter((e) => !have.has(e));
    if (missing.length > 0) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const sep = current === '' || current.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(file, `${sep}${missing.join('\n')}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------- commands ---------------------------------- */

/** Install: copy assets, merge hooks, seed loop-state. Returns exit code 0. */
export function install(r: Resolved): number {
  const dir = skillDir(r);
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Assets: prefer the real files shipped with the npx package; fall back to the
  // embedded copies when running from a single-file bundle (no assets dir).
  const haveDir = fs.existsSync(path.join(assetsDir(), 'SKILL.md'));
  const writeAsset = (rel: string, dest: string): void => {
    if (haveDir) fs.copyFileSync(path.join(assetsDir(), ...rel.split('/')), dest);
    else fs.writeFileSync(dest, EMBEDDED_ASSETS[rel]!);
  };

  // SKILL.md
  writeAsset('SKILL.md', path.join(dir, 'SKILL.md'));

  // hook scripts (executable)
  for (const file of SCRIPTS) {
    const dest = path.join(hooksDir, file);
    writeAsset(`hooks/${file}`, dest);
    fs.chmodSync(dest, 0o755);
  }

  // Upgrade pruning: delete retired scripts' orphaned files (their hook entries
  // are stripped from both settings files by syncSettings below).
  for (const file of RETIRED_SCRIPTS) {
    fs.rmSync(path.join(hooksDir, file), { force: true });
  }

  const sp = settingsPath(r);
  syncSettings(r, sp);

  // The state dir exists from here on (project scope: `<project>/.sparrow`), and
  // the loop switch is seeded on first install — never clobbering an existing one.
  fs.mkdirSync(r.stateDir, { recursive: true });
  if (readLoopState(r.stateDir) === undefined) writeLoopState(r.stateDir, 'engaged');

  r.log(`Sparrow skill installed (${r.scope} scope): ${dir}`);
  r.log(`Hooks merged into ${sp} (Stop + UserPromptSubmit + PostToolUse + Notification).`);
  r.log(BG_REAP_INSTALL_NOTE);
  if (r.scope === 'project') {
    r.log(
      r.profile
        ? `Hooks run as profile "${r.profile}" with SPARROW_STATE_DIR=$CLAUDE_PROJECT_DIR/.sparrow.`
        : `Hooks run with SPARROW_STATE_DIR=$CLAUDE_PROJECT_DIR/.sparrow (no profile known — they will use defaultProfile).`,
    );
    // Local state must never land in a commit: exclude it from THIS clone only.
    // With `--shared` the skill dir is meant to be committed, so only `.sparrow/`
    // is excluded.
    const gitDir = findGitDir(r.cwd);
    const entries = r.shared ? ['.sparrow/'] : ['.sparrow/', '.claude/skills/sparrow/'];
    if (gitDir && addGitExcludes(gitDir, entries)) {
      r.log(`added ${entries.join(' and ')} to .git/info/exclude`);
    }
  }
  r.log(`Loop switch: ${readLoopState(r.stateDir)} (${path.join(r.stateDir, 'loop-state')}).`);
  r.log(`Pause anytime with 'sparrow skill pause' (or 'sparrow-skill pause' / 'npx sparrow-skill pause').`);
  return 0;
}

/** Uninstall: remove hook entries (from BOTH settings files) and the skill dir. */
export function uninstall(r: Resolved): number {
  const cleaned = syncSettings(r);
  fs.rmSync(skillDir(r), { recursive: true, force: true });
  const where = cleaned.length > 0 ? cleaned.join(' and ') : settingsPath(r);
  r.log(`Sparrow skill removed (${r.scope} scope). Hook entries stripped from ${where}.`);
  r.log(`Loop state left untouched at ${r.stateDir} (delete it manually if desired).`);
  return 0;
}

/** Best-effort sticky "loop paused" status, if creds + a room are in the env. */
async function tryStickyStatus(r: Resolved, note: string): Promise<void> {
  const server = r.env.SPARROW_SERVER?.trim();
  const token = r.env.SPARROW_TOKEN?.trim();
  const room = (r.env.SPARROW_ROOM ?? r.env.SPARROW_DM_ROOM)?.trim();
  if (!server || !token || !room) return;
  try {
    await fetch(`${server.replace(/\/+$/, '')}/api/v1/rooms/${room}/status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'working', note, sticky: true }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // silent — the sticky status is a nicety, not a requirement
  }
}

/** Flip the loop switch to `paused` (the sanctioned off-switch). */
export async function pause(r: Resolved): Promise<number> {
  writeLoopState(r.stateDir, 'paused');
  await tryStickyStatus(r, 'loop paused');
  r.log(`Sparrow loop paused (${r.stateDir}). The Stop hook will stay silent until you resume.`);
  return 0;
}

/** Flip the loop switch back to `engaged`. */
export function resume(r: Resolved): number {
  writeLoopState(r.stateDir, 'engaged');
  r.log(`Sparrow loop engaged (${r.stateDir}). Re-start your loop ('sparrow watch' / 'sparrow loop') to come online.`);
  return 0;
}

/** Print the current loop switch, heartbeat freshness, and install state. */
export function status(r: Resolved): number {
  const state = readLoopState(r.stateDir) ?? '(unset)';
  const age = heartbeatAgeSeconds(r.stateDir);
  const hb = age === undefined ? 'no heartbeat' : `heartbeat ${age}s ago`;
  const installed = fs.existsSync(path.join(skillDir(r), 'SKILL.md'));
  // Both files at this scope are read by Claude Code, so the opt-out counts
  // wherever it sits (a `--shared` install put it in the committed one).
  const optOutIn = settingsCandidates(r).find((f) => hasReaperOptOut(readSettings(f)));
  r.log(`loop-state: ${state}`);
  r.log(`heartbeat:  ${hb}`);
  r.log(`state dir:  ${r.stateDir}`);
  r.log(`skill:      ${installed ? 'installed' : 'not installed'} (${r.scope} scope, ${skillDir(r)})`);
  r.log(
    optOutIn
      ? `bg-reaper:  opt-out set (${BG_REAP_OPT_OUT_KEY}=1 in ${optOutIn})`
      : `bg-reaper:  opt-out MISSING (${BG_REAP_OPT_OUT_KEY} not in ${settingsPath(r)}) — ` +
          `re-run 'sparrow skill install'; without it Claude Code may kill your await listener when idle`,
  );
  return 0;
}

/* ---------------------------------- dispatch --------------------------------- */

/** Parsed `sparrow-skill` argv: the subcommand plus its flags. */
interface ParsedArgv {
  sub: string;
  user: boolean;
  shared: boolean;
  profile?: string;
}

function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  let user = false;
  let shared = false;
  let profile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--user') user = true;
    else if (a === '--shared') shared = true;
    else if (a === '--profile') profile = argv[++i];
    else if (a.startsWith('--profile=')) profile = a.slice('--profile='.length);
    else positional.push(a);
  }
  return { sub: (positional[0] ?? 'install').toLowerCase(), user, shared, profile };
}

/**
 * Which state dir this invocation acts on.
 *
 * `--user` is pinned to `~/.sparrow` — that is what a user-scope install's
 * unstamped hooks read. A project-scope INSTALL always uses `<cwd>/.sparrow`,
 * because that is exactly what it stamps into the hook commands. Every other
 * project-scope subcommand (pause/resume/status) DISCOVERS the project by
 * walking up from the cwd, so running it from a subdirectory still hits the same
 * switch and, outside any project, falls back to `~/.sparrow`.
 * `$SPARROW_STATE_DIR` overrides all of it.
 */
function stateDirFor(p: ParsedArgv, env: Env, home: string, cwd: string): string {
  const override = env.SPARROW_STATE_DIR?.trim();
  if (override) return override;
  if (p.user) return homeStateDir({ ...env, HOME: home });
  if (p.sub === 'install') return path.join(cwd, '.sparrow');
  return resolveStateDir({ ...env, HOME: home }, cwd);
}

function resolve(opts: RunSkillOptions, p: ParsedArgv): Resolved {
  const env = opts.env ?? (process.env as Env);
  const home = opts.home ?? env.HOME ?? process.env.HOME ?? '';
  const cwd = opts.cwd ?? process.cwd();
  const scope: Scope = p.user ? 'user' : 'project';
  return {
    scope,
    cwd,
    home,
    env,
    log: opts.log ?? ((m: string) => process.stdout.write(`${m}\n`)),
    stateDir: stateDirFor(p, env, home, cwd),
    shared: p.shared,
    profile: scope === 'project' ? stampedProfile(env, home, p.profile) : undefined,
  };
}

/**
 * Parse `argv` (subcommand + flags) and run it. Shared by the `sparrow-skill`
 * bin and the `sparrow skill …` CLI subcommand. Returns a process exit code.
 */
export async function runSkill(argv: string[], opts: RunSkillOptions = {}): Promise<number> {
  const parsed = parseArgv(argv);
  const r = resolve(opts, parsed);
  switch (parsed.sub) {
    case 'install':
      return install(r);
    case 'uninstall':
      return uninstall(r);
    case 'pause':
      return pause(r);
    case 'resume':
      return resume(r);
    case 'status':
      return status(r);
    default:
      r.log(
        `Unknown command '${parsed.sub}'. Use: install | uninstall | pause | resume | status ` +
          `[--user] [--shared] [--profile <name>].`,
      );
      return 1;
  }
}

export type { LoopState };
