/**
 * The Claude Code adapter — today's behavior, moved behind the provider seam
 * and otherwise unchanged, byte for byte, so an existing install upgrades into
 * it without noticing.
 *
 * Playbook  → `.claude/skills/sparrow/SKILL.md` (+ `hooks/*.sh`).
 * Settings  → `.claude/settings.local.json` (personal) or `settings.json`
 *             (`--shared` / user scope). BOTH files are swept on every install
 *             and uninstall, so an older version's registration in the other
 *             file is removed: one registration, in one file, ever.
 * Events    → Stop, UserPromptSubmit, PostToolUse, Notification.
 * Also      → `env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`, which opts the
 *             session out of Claude Code's memory-pressure reaper so a long idle
 *             stretch cannot kill the background `sparrow await` that is a
 *             turn-based agent's only wake path.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CheckLine, ProviderAdapter, Resolved } from './providers.js';

/** The shell scripts a Claude Code install ships. */
const SCRIPTS: ReadonlyArray<string> = ['sparrow-stop-check.sh', 'sparrow-auto-status.sh'];

/**
 * Scripts SHIPPED BY PAST VERSIONS that this version no longer installs. An
 * upgrade (re-install over an older layout) prunes their hook entries from the
 * settings files and deletes the orphaned files — otherwise a retired hook keeps
 * firing forever (found live: v1's standalone presence hook survived a v2
 * re-install). Every event is swept, since old registrations may sit anywhere.
 */
export const RETIRED_SCRIPTS: ReadonlyArray<string> = ['sparrow-presence.sh'];

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
 * The Claude Code hook registrations merged into the settings file.
 * `sparrow-auto-status.sh` is a single script fanned across three events, each
 * passing its `mode` as the command arg. The `Stop` event runs only
 * `sparrow-stop-check.sh`, which itself invokes auto-status (idle) on its allow
 * paths — so a blocked stop never flickers the agent idle (no separate Stop
 * entry, no working→idle→working churn).
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

/** The `.claude` base dir for a scope. */
function claudeBaseDir(r: Resolved): string {
  return r.scope === 'user' ? path.join(r.home, '.claude') : path.join(r.cwd, '.claude');
}

/** Where the skill's files land: `<base>/skills/sparrow`. */
function skillDir(r: Resolved): string {
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
  return (
    groups
      .map((g) => ({
        ...g,
        hooks: Array.isArray(g.hooks)
          ? g.hooks.filter((h) => !targetsOurScript(h.command, file))
          : [],
      }))
      // Keep groups that still hold hooks OR that we never touched (defensive).
      .filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0)
  );
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

/* --------------------------------- adapter ---------------------------------- */

export const CLAUDE_ADAPTER: ProviderAdapter = {
  id: 'claude',
  label: 'Claude Code',
  scripts: SCRIPTS,
  skillDir,

  wire(r: Resolved): void {
    // Upgrade pruning: delete retired scripts' orphaned files (their hook
    // entries are stripped from both settings files by syncSettings below).
    for (const file of RETIRED_SCRIPTS) {
      fs.rmSync(path.join(skillDir(r), 'hooks', file), { force: true });
    }
    const sp = settingsPath(r);
    syncSettings(r, sp);
    r.log(`Hooks merged into ${sp} (Stop + UserPromptSubmit + PostToolUse + Notification).`);
    r.log(BG_REAP_INSTALL_NOTE);
    if (r.scope === 'project') {
      r.log(
        r.profile
          ? `Hooks run as profile "${r.profile}" with SPARROW_STATE_DIR=$CLAUDE_PROJECT_DIR/.sparrow.`
          : `Hooks run with SPARROW_STATE_DIR=$CLAUDE_PROJECT_DIR/.sparrow (no profile known — they will use defaultProfile).`,
      );
    }
  },

  unwire(r: Resolved): void {
    const cleaned = syncSettings(r);
    const where = cleaned.length > 0 ? cleaned.join(' and ') : settingsPath(r);
    r.log(`Hook entries stripped from ${where}.`);
  },

  gitExcludes(r: Resolved): string[] {
    // With `--shared` the skill dir is meant to be committed.
    return r.shared ? [] : ['.claude/skills/sparrow/'];
  },

  statusLines(r: Resolved): CheckLine[] {
    // Both files at this scope are read by Claude Code, so the opt-out counts
    // wherever it sits (a `--shared` install put it in the committed one).
    const optOutIn = settingsCandidates(r).find((f) => hasReaperOptOut(readSettings(f)));
    return [
      optOutIn
        ? { level: 'ok', text: `bg-reaper:  opt-out set (${BG_REAP_OPT_OUT_KEY}=1 in ${optOutIn})` }
        : {
            level: 'fail',
            text:
              `bg-reaper:  opt-out MISSING (${BG_REAP_OPT_OUT_KEY} not in ${settingsPath(r)}) — ` +
              `re-run 'sparrow skill install'; without it Claude Code may kill your await listener when idle`,
          },
    ];
  },

  verifyLines(r: Resolved): CheckLine[] {
    const lines: CheckLine[] = [];
    const registered = (event: string): boolean =>
      settingsCandidates(r).some((f) => {
        const groups = readSettings(f).hooks?.[event];
        return (
          Array.isArray(groups) &&
          groups.some((g) => (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('sparrow-')))
        );
      });
    for (const event of ['Stop', 'UserPromptSubmit', 'PostToolUse', 'Notification']) {
      lines.push(
        registered(event)
          ? { level: 'ok', text: `hook ${event}: registered` }
          : { level: 'fail', text: `hook ${event}: NOT registered — re-run 'sparrow skill install'` },
      );
    }
    // Claude Code has no trust gate in front of a settings-file hook: a
    // registered hook runs. So registration IS the verification here, and
    // saying otherwise would be inventing a doubt that does not exist.
    lines.push({
      level: 'ok',
      text: 'trust:      not applicable — Claude Code runs the hooks in a settings file it loads',
    });
    return lines;
  },

  postInstallNotes(): string[] {
    return [];
  },

  installMarkers(dir: string): string[] {
    return [path.join(dir, '.claude', 'skills', 'sparrow')];
  },
};
