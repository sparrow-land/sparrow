/**
 * The Codex adapter — `sparrow skill install --codex`.
 *
 * Every fact below was verified against a live, authenticated `codex-cli
 * 0.153.3` on 2026-09-04; none of it is inferred from Claude Code's shapes,
 * which is exactly where a port of this goes wrong.
 *
 * Playbook  → `.agents/skills/sparrow/SKILL.md` (Codex's own skills system —
 *             YAML frontmatter `name` + `description`, invoked as `$sparrow`),
 *             plus a SHORT delimited section appended to the project's
 *             `AGENTS.md`. Short on purpose: `AGENTS.md` has a 32KiB budget and
 *             truncation is silent at a file boundary, so the fragment is a
 *             pointer, not a copy.
 * Hooks     → `.codex/hooks.json`, whose schema is NOT Claude Code's:
 *             `{description?, hooks: {<Event>: [{hooks: [{type, command,
 *             timeout?}]}]}}` — events nested UNDER a `hooks` key. A
 *             Claude-shaped file fails with a parse warning on stderr and the
 *             hooks then silently never run, so getting this wrong is invisible.
 * Events    → Stop (`decision:block` re-arm works, and the retry carries
 *             `stop_hook_active` — live-verified), SessionStart (its
 *             `hookSpecificOutput.additionalContext` reaches the model —
 *             live-verified), UserPromptSubmit (plain stdout is injected, same
 *             as Claude Code — live-verified) and PostToolUse. There is NO
 *             `Notification` event in Codex, so nothing sets "blocked — needs
 *             your input"; the playbook says so rather than pretending.
 * Payloads  → snake_case (`hook_event_name`, `session_id`, `cwd`, `turn_id`,
 *             `stop_hook_active`, `prompt`) with PascalCase event VALUES, i.e.
 *             byte-identical to what our shell hooks already parse. The two
 *             shared scripts are therefore reused unmodified.
 * Env       → there is no `$CLAUDE_PROJECT_DIR` equivalent in a Codex hook, so
 *             every path is baked ABSOLUTE at install time. Nothing is written
 *             to `[shell_environment_policy]`: in 0.153.3 the `*KEY/*SECRET/
 *             *TOKEN` stripping is OFF by default, and relying on that default
 *             is precisely the version-fragility trap — the credential-file
 *             ladder stays the only credential path.
 * Config    → `.codex/config.toml` gets a managed block with the two documented
 *             inline prerequisites. Note the TOML footgun: a bare key written
 *             after a `[table]` header lands INSIDE that table, so
 *             {@link managedToml} always emits top-level keys first.
 * Trust     → an untrusted project has its whole `.codex/` layer ignored, and a
 *             non-managed hook needs per-hook review on top of that. NEITHER
 *             gate reports anything. The installer cannot open them, so it
 *             prints exactly what a human must do — and `status`/`verify` read
 *             per-event FIRING STAMPS instead of checking that files exist.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CODEX_MIN_VERSION } from './skill-md.js';
import type { CheckLine, Env, ProviderAdapter, Resolved } from './providers.js';

/** Scripts a Codex install ships: the two shared ones plus its own two. */
const SCRIPTS: ReadonlyArray<string> = [
  'sparrow-stop-check.sh',
  'sparrow-auto-status.sh',
  'sparrow-session-start.sh',
  'sparrow-codex-hook.sh',
];

/** The wrapper every installed hook runs through (and our merge marker). */
const WRAPPER = 'sparrow-codex-hook.sh';

/** Codex hook events we wire, in the order `status` reports them. */
export const CODEX_EVENTS: ReadonlyArray<string> = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
];

const HOOKS: ReadonlyArray<{ event: string; script: string; mode?: string; timeout: number }> = [
  { event: 'SessionStart', script: 'sparrow-session-start.sh', timeout: 10 },
  { event: 'UserPromptSubmit', script: 'sparrow-auto-status.sh', mode: 'prompt', timeout: 20 },
  { event: 'PostToolUse', script: 'sparrow-auto-status.sh', mode: 'post-tool', timeout: 20 },
  { event: 'Stop', script: 'sparrow-stop-check.sh', timeout: 30 },
];

/** Top-level `description` we claim in a hooks.json we created ourselves. */
const HOOKS_DESCRIPTION = 'sparrow skill hooks (sparrow skill install --codex)';

const AGENTS_BEGIN = '<!-- BEGIN SPARROW SKILL -->';
const AGENTS_END = '<!-- END SPARROW SKILL -->';
const TOML_BEGIN = '# >>> sparrow (managed) — written by `sparrow skill install --codex` >>>';
const TOML_END = '# <<< sparrow (managed) <<<';

/* --------------------------------- paths ----------------------------------- */

/** Where the playbook lives: Codex reads `.agents/skills` and `~/.agents/skills`. */
function skillDir(r: Resolved): string {
  const base = r.scope === 'user' ? r.home : r.cwd;
  return path.join(base, '.agents', 'skills', 'sparrow');
}

/**
 * The `.codex` directory this scope writes. User scope honors `$CODEX_HOME`,
 * which is the same override Codex itself reads — a sandboxed agent with its own
 * `CODEX_HOME` must not have its hooks written into the operator's `~/.codex`.
 */
export function codexDir(r: Resolved): string {
  if (r.scope === 'user') return r.env.CODEX_HOME?.trim() || path.join(r.home, '.codex');
  return path.join(r.cwd, '.codex');
}

function hooksJsonPath(r: Resolved): string {
  return path.join(codexDir(r), 'hooks.json');
}

function configTomlPath(r: Resolved): string {
  return path.join(codexDir(r), 'config.toml');
}

/**
 * The instructions file our pointer goes in: the project's `AGENTS.md`, or
 * `$CODEX_HOME/AGENTS.md` for a user-scope install (Codex's global brief).
 */
function agentsMdPath(r: Resolved): string {
  return r.scope === 'user' ? path.join(codexDir(r), 'AGENTS.md') : path.join(r.cwd, 'AGENTS.md');
}

/** Shell-quote a path for the `command` string Codex runs through a shell. */
function q(p: string): string {
  return `"${p.replace(/(["$`\\])/g, '\\$1')}"`;
}

/**
 * The command string for one hook. Absolute throughout: a Codex hook payload
 * carries no project-dir variable, and the hook's cwd is not guaranteed, so
 * anything relative would resolve somewhere else on some machine.
 */
function hookCommand(r: Resolved, h: (typeof HOOKS)[number]): string {
  const hooks = path.join(skillDir(r), 'hooks');
  const prefix = [`SPARROW_STATE_DIR=${q(r.stateDir)}`];
  if (r.profile) prefix.push(`SPARROW_PROFILE="${r.profile}"`);
  if (h.script === 'sparrow-session-start.sh') {
    prefix.push(`SPARROW_SKILL_PATH=${q(path.join(skillDir(r), 'SKILL.md'))}`);
  }
  const parts = [
    prefix.join(' '),
    q(path.join(hooks, WRAPPER)),
    h.event,
    q(path.join(hooks, h.script)),
  ];
  if (h.mode) parts.push(h.mode);
  return parts.join(' ');
}

/* ------------------------------- hooks.json -------------------------------- */

interface CodexHookCmd {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}
interface CodexHookGroup {
  hooks: CodexHookCmd[];
  [k: string]: unknown;
}
export interface CodexHooksFile {
  description?: string;
  hooks?: Record<string, CodexHookGroup[]>;
  [k: string]: unknown;
}

function readHooksFile(file: string): CodexHooksFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as CodexHooksFile;
  } catch {
    return {};
  }
}

/** True when this stored command is one of OURS (current shape or an older one). */
function isOurs(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return command.includes(WRAPPER) || SCRIPTS.some((s) => s !== WRAPPER && command.includes(s));
}

/**
 * Drop every entry of ours from every event, and prune whatever that empties.
 *
 * The user's `hooks.json` is very likely to hold hooks of their own — possibly
 * in the same group as ours — so this filters at ENTRY level and only discards a
 * group once it is genuinely empty. Sweeping ALL events (not just the four we
 * write) is what lets a future version move a hook to a different event without
 * leaving the old registration firing forever.
 */
function stripOurs(file: CodexHooksFile): void {
  const events = file.hooks;
  if (typeof events !== 'object' || events === null) return;
  for (const event of Object.keys(events)) {
    const groups = events[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({
        ...g,
        hooks: Array.isArray(g.hooks) ? g.hooks.filter((h) => !isOurs(h.command)) : [],
      }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) events[event] = kept;
    else delete events[event];
  }
  if (Object.keys(events).length === 0) delete file.hooks;
}

/**
 * Write our four registrations into `file`, preserving everything foreign.
 *
 * Ours go in their OWN group rather than joining an existing one: Codex runs the
 * entries of a group together, and putting a hook of ours beside somebody else's
 * would make an uninstall's group-pruning decisions depend on their hooks.
 */
export function mergeCodexHooks(file: CodexHooksFile, r: Resolved): CodexHooksFile {
  stripOurs(file);
  const events = (file.hooks ??= {});
  for (const h of HOOKS) {
    const groups = Array.isArray(events[h.event]) ? events[h.event]! : [];
    groups.push({
      hooks: [{ type: 'command', command: hookCommand(r, h), timeout: h.timeout }],
    });
    events[h.event] = groups;
  }
  // Never overwrite a description somebody else wrote — it is the only place
  // Codex's `/hooks` review shows a human what this file is.
  if (typeof file.description !== 'string' || file.description.trim() === '') {
    file.description = HOOKS_DESCRIPTION;
  }
  return file;
}

/**
 * Parse-validate a hooks.json against the REAL 0.153.3 schema.
 *
 * This is the check that would have caught the Claude-shaped file: Codex accepts
 * it as JSON, fails to deserialize it, prints one warning to stderr, and runs no
 * hooks at all. Returns the problems found, empty when the file is well-formed.
 */
export function validateCodexHooks(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['hooks.json is not a JSON object'];
  }
  const file = raw as Record<string, unknown>;
  // The Claude shape puts events at the TOP level; Codex nests them under `hooks`.
  if (!('hooks' in file)) {
    problems.push(
      "hooks.json has no top-level `hooks` key — this is the Claude Code shape, which Codex rejects with a stderr warning and then runs NO hooks (expected: {\"hooks\": {\"<Event>\": [{\"hooks\": [...]}]}})",
    );
    return problems;
  }
  const events = file.hooks;
  if (typeof events !== 'object' || events === null || Array.isArray(events)) {
    problems.push('hooks.json `hooks` is not an object of event → groups');
    return problems;
  }
  for (const [event, groups] of Object.entries(events as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      problems.push(`hooks.${event} is not an array of groups`);
      continue;
    }
    for (const g of groups) {
      if (typeof g !== 'object' || g === null || !Array.isArray((g as CodexHookGroup).hooks)) {
        problems.push(`hooks.${event} has a group without a \`hooks\` array`);
        continue;
      }
      for (const h of (g as CodexHookGroup).hooks) {
        if (typeof h !== 'object' || h === null) {
          problems.push(`hooks.${event} has a non-object hook entry`);
        } else if (h.type !== 'command') {
          problems.push(`hooks.${event} has a hook whose type is not "command"`);
        } else if (typeof h.command !== 'string' || h.command.trim() === '') {
          problems.push(`hooks.${event} has a hook with no command`);
        }
      }
    }
  }
  return problems;
}

/* ------------------------------- config.toml -------------------------------- */

/**
 * Render a managed TOML block with the ordering invariant that matters:
 * **every top-level key comes before the first `[table]` header.**
 *
 * TOML's footgun is that a bare key written after a table header belongs to that
 * table, silently. Our block is appended to a file we do not own, so a
 * `notify = …` emitted after `[sandbox_workspace_write]` would quietly become
 * `sandbox_workspace_write.notify`. Building the text through here makes that
 * impossible by construction rather than by review.
 */
export function managedToml(
  topLevel: ReadonlyArray<[string, string]>,
  tables: ReadonlyArray<{ name: string; comment?: string; keys: ReadonlyArray<[string, string]> }>,
): string {
  const out: string[] = [];
  for (const [k, v] of topLevel) out.push(`${k} = ${v}`);
  for (const t of tables) {
    if (out.length > 0) out.push('');
    if (t.comment) for (const line of t.comment.split('\n')) out.push(`# ${line}`);
    out.push(`[${t.name}]`);
    for (const [k, v] of t.keys) out.push(`${k} = ${v}`);
  }
  return out.join('\n');
}

/** The TOML value for a string array, escaping what TOML needs escaped. */
function tomlStrings(values: readonly string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}

/**
 * The two documented inline prerequisites, and nothing else.
 *
 * `network_access` is REQUIRED: under `workspace-write` each model-run command
 * gets a PRIVATE network namespace, so the agent's own `sparrow` commands cannot
 * reach the server — not even on localhost — and the failure looks like a dead
 * server rather than a sandbox. `writable_roots` is only needed when the state
 * dir sits outside the workspace ( `$HOME` is mounted READ-ONLY under
 * workspace-write), so a project-scope install whose `.sparrow` is inside the
 * project writes no roots at all.
 *
 * Deliberately NOT written: `sandbox_mode`, `approval_policy` (the human's call,
 * not an installer's) and `[shell_environment_policy]` (see the module note).
 */
export function codexConfigBlock(r: Resolved): string {
  const keys: Array<[string, string]> = [['network_access', 'true']];
  const inWorkspace = !path.relative(r.cwd, r.stateDir).startsWith('..');
  if (!(r.scope === 'project' && inWorkspace)) {
    keys.push(['writable_roots', tomlStrings([r.stateDir])]);
  }
  return managedToml([], [
    {
      name: 'sandbox_workspace_write',
      comment:
        "sparrow's inline prerequisites. Without network_access every model-run\ncommand sits in a private network namespace and cannot reach your Sparrow\nserver at all (localhost included).",
      keys,
    },
  ]);
}

/** The file's text with our managed block removed (and its blank line tidied). */
function withoutManaged(text: string, begin: string, end: string): string {
  const s = text.indexOf(begin);
  if (s < 0) return text;
  const e = text.indexOf(end, s);
  if (e < 0) return text;
  const before = text.slice(0, s).replace(/\n+$/, '\n');
  const after = text.slice(e + end.length).replace(/^\n+/, '');
  return after ? `${before}\n${after}` : before.replace(/\n+$/, '\n');
}

/** Insert/replace a delimited managed block at the END of `text`. */
function withManaged(text: string, begin: string, end: string, body: string): string {
  const base = withoutManaged(text, begin, end).replace(/\n*$/, '');
  const head = base === '' ? '' : `${base}\n\n`;
  return `${head}${begin}\n${body}\n${end}\n`;
}

/* -------------------------------- AGENTS.md --------------------------------- */

/**
 * The `AGENTS.md` fragment: a POINTER, kept to a few lines on purpose.
 *
 * Codex concatenates `AGENTS.md` from the repo root down to the cwd under a
 * 32KiB default budget, and truncation is SILENT at a file boundary — so a long
 * sparrow section does not just waste context, it can push somebody else's file
 * out of the brief entirely. The playbook itself lives in the skill.
 */
export function agentsFragment(r: Resolved): string {
  const skill = path.relative(r.cwd, path.join(skillDir(r), 'SKILL.md'));
  const rel = skill.startsWith('..') ? path.join(skillDir(r), 'SKILL.md') : skill;
  return [
    '## Sparrow',
    '',
    `This project is a Sparrow workspace. Your playbook is the \`sparrow\` skill at \`${rel}\` — pull it in with \`$sparrow\` before you touch the inbox.`,
    '',
    'Short version: you are turn-based, so you need a wake path. Run unbounded `sparrow await` as a background task as the last thing in every turn. Sparrow detects CODEX_THREAD_ID and queues the next Codex turn automatically; process exit alone does not start one. Drain with `sparrow pop` until it says `Inbox empty.`, reply in-room, and never pipe `sparrow` output through `jq`/`grep`. Step away on purpose with `sparrow skill pause`.',
  ].join('\n');
}

/* ------------------------------ firing stamps ------------------------------- */

function firedDir(r: Resolved): string {
  return path.join(r.stateDir, 'hooks-fired');
}

/**
 * What a firing stamp says: how old it is, and WHICH KIND of run wrote it.
 *
 * `manual` means the stamp came from the hook command being run BY HAND — the
 * script check `verify`'s own diagnostics print, which carries
 * `SPARROW_HOOK_SELFTEST=1`. That proves the script runs; it proves nothing at
 * all about Codex's trust gates, so it must never verify an event. An empty
 * stamp (written by any CLI before this) reads as `runtime`, exactly as before.
 */
export interface FiredStamp {
  ageSeconds: number;
  kind: 'runtime' | 'manual';
}

export function hookFiredStamp(r: Resolved, event: string, now = Date.now()): FiredStamp | undefined {
  const file = path.join(firedDir(r), event);
  let ageSeconds: number;
  try {
    const st = fs.statSync(file);
    ageSeconds = Math.max(0, Math.floor((now - st.mtimeMs) / 1000));
  } catch {
    return undefined;
  }
  let kind: FiredStamp['kind'] = 'runtime';
  try {
    if (fs.readFileSync(file, 'utf8').trim() === 'manual') kind = 'manual';
  } catch {
    /* unreadable stamp: judged by its mtime alone, as before */
  }
  return { ageSeconds, kind };
}

/**
 * Seconds since `event` was last OBSERVED FIRING — a manual script check is not
 * a firing, so it reads as `undefined` here exactly like no stamp at all.
 */
export function hookFiredAge(r: Resolved, event: string, now = Date.now()): number | undefined {
  const stamp = hookFiredStamp(r, event, now);
  return stamp && stamp.kind === 'runtime' ? stamp.ageSeconds : undefined;
}

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/**
 * `codex --version`, best-effort — so a bug report carries the runtime that
 * produced it. Never fails the command: no `codex` on PATH, a non-zero exit, a
 * hang, a machine without a shell — all read as "we don't know", which is what
 * the caller prints (nothing).
 */
export function codexVersion(env: Env): string | undefined {
  try {
    const out = execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: env as NodeJS.ProcessEnv,
    });
    const line = out.split('\n')[0]?.trim();
    return line ? line : undefined;
  } catch {
    return undefined;
  }
}

/** The exact command Codex was told to run for `event`, as registered on disk. */
function registeredCommand(raw: CodexHooksFile, event: string): string | undefined {
  for (const group of raw.hooks?.[event] ?? []) {
    for (const h of group.hooks ?? []) {
      if (isOurs(h.command)) return h.command;
    }
  }
  return undefined;
}

/* --------------------------------- adapter ---------------------------------- */

export const CODEX_ADAPTER: ProviderAdapter = {
  id: 'codex',
  label: 'Codex',
  scripts: SCRIPTS,
  skillDir,

  wire(r: Resolved): void {
    // hooks.json — merged, never clobbered.
    const hp = hooksJsonPath(r);
    fs.mkdirSync(path.dirname(hp), { recursive: true });
    const merged = mergeCodexHooks(readHooksFile(hp), r);
    fs.writeFileSync(hp, `${JSON.stringify(merged, null, 2)}\n`);
    r.log(`Hooks merged into ${hp} (${CODEX_EVENTS.join(' + ')}).`);

    // config.toml — a managed block, unless the user already owns the table.
    const cp = configTomlPath(r);
    let current = '';
    try {
      current = fs.readFileSync(cp, 'utf8');
    } catch {
      // absent — we create it
    }
    const foreign = withoutManaged(current, TOML_BEGIN, TOML_END);
    if (/^\s*\[sandbox_workspace_write[\].]/m.test(foreign)) {
      r.log(
        `NOTE: ${cp} already declares [sandbox_workspace_write] — left untouched (a second table ` +
          `would be invalid TOML). Make sure it has network_access = true, or sandboxed sparrow ` +
          `commands cannot reach your server.`,
      );
    } else {
      fs.writeFileSync(cp, withManaged(current, TOML_BEGIN, TOML_END, codexConfigBlock(r)));
      r.log(`Sandbox prerequisites written to ${cp} (network_access, writable_roots).`);
    }

    // AGENTS.md — a short delimited pointer at the skill.
    const ap = agentsMdPath(r);
    let agents = '';
    try {
      agents = fs.readFileSync(ap, 'utf8');
    } catch {
      // absent — we create it
    }
    fs.mkdirSync(path.dirname(ap), { recursive: true });
    fs.writeFileSync(ap, withManaged(agents, AGENTS_BEGIN, AGENTS_END, agentsFragment(r)));
    r.log(`Sparrow section written to ${ap} (delimited; an uninstall removes exactly it).`);

    r.log(
      r.profile
        ? `Hooks run as profile "${r.profile}" with SPARROW_STATE_DIR=${r.stateDir} (absolute — Codex hooks get no project-dir variable, so a moved checkout needs a re-install).`
        : `Hooks run with SPARROW_STATE_DIR=${r.stateDir} (absolute — Codex hooks get no project-dir variable, so a moved checkout needs a re-install; no profile known, they will use defaultProfile).`,
    );
  },

  unwire(r: Resolved): void {
    const hp = hooksJsonPath(r);
    if (fs.existsSync(hp)) {
      const file = readHooksFile(hp);
      const hadOurs = JSON.stringify(file).includes(WRAPPER);
      stripOurs(file);
      const onlyOurDescription =
        file.description === HOOKS_DESCRIPTION && Object.keys(file).length === 1;
      if (Object.keys(file).length === 0 || onlyOurDescription) fs.rmSync(hp, { force: true });
      else fs.writeFileSync(hp, `${JSON.stringify(file, null, 2)}\n`);
      if (hadOurs) r.log(`Hook entries stripped from ${hp} (yours preserved).`);
    }

    for (const [file, begin, end] of [
      [configTomlPath(r), TOML_BEGIN, TOML_END],
      [agentsMdPath(r), AGENTS_BEGIN, AGENTS_END],
    ] as const) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes(begin)) continue;
      const stripped = withoutManaged(text, begin, end);
      // A file that held nothing but our block was ours to create, so it is
      // ours to remove; one with other content keeps everything else.
      if (stripped.trim() === '') fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, stripped);
      r.log(`Sparrow block removed from ${file}.`);
    }
  },

  gitExcludes(): string[] {
    // `AGENTS.md` is deliberately absent: it is shared, it is small, and it is
    // marker-delimited, so it is meant to be committed like any other brief.
    return ['.agents/skills/sparrow/', '.codex/'];
  },

  statusLines(r: Resolved): CheckLine[] {
    const lines: CheckLine[] = [];
    const hp = hooksJsonPath(r);
    if (!fs.existsSync(hp)) {
      lines.push({ level: 'fail', text: `hooks.json: missing (${hp})` });
    } else {
      const problems = validateCodexHooks(readHooksFile(hp));
      lines.push(
        problems.length === 0
          ? { level: 'ok', text: `hooks.json: valid against the codex ${CODEX_MIN_VERSION} schema (${hp})` }
          : { level: 'fail', text: `hooks.json: INVALID — ${problems[0]}` },
      );
    }
    const fired = CODEX_EVENTS.filter((e) => hookFiredAge(r, e) !== undefined);
    lines.push(
      fired.length === CODEX_EVENTS.length
        ? { level: 'ok', text: 'trust:      OK — every wired hook has been observed firing' }
        : {
            level: 'warn',
            text:
              `trust:      UNVERIFIED — ${fired.length}/${CODEX_EVENTS.length} hooks observed firing. ` +
              `Codex silently ignores project .codex/ files in an untrusted project, and untrusted ` +
              `hooks never run. Run 'sparrow skill verify --codex'.`,
          },
    );
    return lines;
  },

  verifyLines(r: Resolved): CheckLine[] {
    const lines: CheckLine[] = [];
    const hp = hooksJsonPath(r);
    if (!fs.existsSync(hp)) {
      lines.push({ level: 'fail', text: `hooks.json: missing (${hp}) — run 'sparrow skill install --codex'` });
    } else {
      const raw = readHooksFile(hp);
      const problems = validateCodexHooks(raw);
      if (problems.length > 0) {
        for (const p of problems) lines.push({ level: 'fail', text: `hooks.json: ${p}` });
      } else {
        lines.push({ level: 'ok', text: `hooks.json: parses against the real codex schema (${hp})` });
        for (const event of CODEX_EVENTS) {
          const groups = raw.hooks?.[event] ?? [];
          const ours = groups.some((g) => (g.hooks ?? []).some((h) => isOurs(h.command)));
          lines.push(
            ours
              ? { level: 'ok', text: `hook ${event}: registered` }
              : { level: 'fail', text: `hook ${event}: NOT registered — re-run 'sparrow skill install --codex'` },
          );
        }
      }
    }
    lines.push(
      fs.existsSync(path.join(skillDir(r), 'SKILL.md'))
        ? { level: 'ok', text: `playbook:   ${path.join(skillDir(r), 'SKILL.md')} ($sparrow)` }
        : { level: 'fail', text: `playbook:   MISSING (${path.join(skillDir(r), 'SKILL.md')})` },
    );
    const ap = agentsMdPath(r);
    let agents = '';
    try {
      agents = fs.readFileSync(ap, 'utf8');
    } catch {
      // absent
    }
    lines.push(
      agents.includes(AGENTS_BEGIN)
        ? { level: 'ok', text: `AGENTS.md:  sparrow section present (${ap})` }
        : { level: 'fail', text: `AGENTS.md:  sparrow section MISSING (${ap})` },
    );

    // The runtime that produced this report — best-effort, never a failure.
    const version = codexVersion(r.env);
    if (version) lines.push({ level: 'ok', text: `codex CLI:  ${version}` });

    // The only check that proves anything about TRUST: did each hook run?
    //
    // A never-fired event is UNVERIFIED — never "failed", and never "overdue".
    // SessionStart says so out loud: it fires when a session STARTS, so a
    // session that was already open when the install landed was never going to
    // stamp it, and calling that a miss would be a false accusation.
    for (const event of CODEX_EVENTS) {
      const stamp = hookFiredStamp(r, event);
      const note = event === 'SessionStart' ? ' (fires on the next new session)' : '';
      if (stamp?.kind === 'runtime') {
        lines.push({ level: 'ok', text: `fired ${event}: yes, ${fmtAge(stamp.ageSeconds)}` });
      } else if (stamp?.kind === 'manual') {
        lines.push({
          level: 'warn',
          text:
            `fired ${event}: NOT by Codex — a manual script check stamped it ` +
            `${fmtAge(stamp.ageSeconds)} (UNVERIFIED: that run proves the script works, ` +
            `not that Codex invoked it)`,
        });
      } else {
        lines.push({ level: 'warn', text: `fired ${event}: NEVER — UNVERIFIED${note}` });
      }
    }
    return lines;
  },

  /**
   * The BLANKET never-fired report.
   *
   * Field case (2026-09-10): an agent installed the hooks, did both trust steps,
   * ran turns — and all four events still read never-fired. At that point
   * repeating the trust instructions is the one answer that cannot help. So this
   * replaces them with a diagnostic step to TRY (offered as a suggestion,
   * because whether Codex loads newly written hook files into a session that is
   * already open is undocumented — we do not claim a reload requirement), plus
   * the three ordinary explanations for nothing at all stamping: the stamps
   * landing in a different state dir, project trust, and a hook command that
   * errors before it can stamp.
   *
   * Empty in every other case: if ANY hook has fired, or the registration is not
   * valid and complete, the generic summary is the right one.
   */
  verifyNotes(r: Resolved): string[] {
    const hp = hooksJsonPath(r);
    if (!fs.existsSync(hp)) return [];
    const raw = readHooksFile(hp);
    if (validateCodexHooks(raw).length > 0) return [];
    const allRegistered = CODEX_EVENTS.every((e) => registeredCommand(raw, e) !== undefined);
    if (!allRegistered) return [];
    if (CODEX_EVENTS.some((e) => hookFiredAge(r, e) !== undefined)) return [];

    const sample = registeredCommand(raw, 'Stop') ?? registeredCommand(raw, 'PostToolUse') ?? '';
    return [
      '',
      'EVERY wired hook reads never-fired, and the registration itself is valid.',
      'That is UNVERIFIED, not failed: nothing here proves the hooks are broken, and',
      'nothing here proves they run.',
      '',
      'DIAGNOSTIC STEP (something to try — not a documented root cause, and not a claim',
      'that Codex requires a reload; whether a running session picks up newly written',
      'hook files is undocumented):',
      '  After installing and trusting hooks, restart Codex in this workspace, run a prompt that uses a tool and finishes, then run verify again.',
      '',
      'Three things explain a blanket never-fired. Check them in this order:',
      '  1. The stamps land somewhere else. This command reads exactly one directory:',
      `       ${firedDir(r)}`,
      '     A hook running with a different SPARROW_STATE_DIR stamps its own and reads',
      '     as never-fired here.',
      '  2. Project trust state. An untrusted project has its whole .codex/ layer ignored,',
      '     and hook trust is a second, separate gate. Neither one reports anything.',
      '  3. The hook command errors before it can stamp. Run it by hand and read the error —',
      '     script check (a manual run writes a stamp; verify will not treat that as runtime proof):',
      ...(sample ? [`       echo '{}' | SPARROW_HOOK_SELFTEST=1 ${sample}`] : []),
    ];
  },

  postInstallNotes(r: Resolved): string[] {
    const project = r.scope === 'user' ? r.home : r.cwd;
    return [
      '',
      'TWO MANUAL TRUST STEPS REMAIN — Codex will not do them for you, and until BOTH are done',
      'these hooks silently never run (no warning, no error, no log line):',
      `  1. Trust the project. Open 'codex' in ${project} and answer "trust this folder", or add to`,
      '     ~/.codex/config.toml:',
      `       [projects.${JSON.stringify(project)}]`,
      '       trust_level = "trusted"',
      '  2. Trust the hooks. Run /hooks in the Codex TUI and enable the sparrow hooks.',
      "     Headless: pass --dangerously-bypass-hook-trust to 'codex exec'.",
      '',
      "Then PROVE it: run one real Codex turn, then 'sparrow skill verify --codex'. It reports which",
      'hooks have actually FIRED — a file on disk is not evidence that anything runs.',
      `Tested against codex-cli ${CODEX_MIN_VERSION}.`,
    ];
  },

  installMarkers(dir: string): string[] {
    return [path.join(dir, '.agents', 'skills', 'sparrow')];
  },
};
