/**
 * Sparrow inline-skill installer — the PURE, PROVIDER-NEUTRAL LIBRARY.
 *
 * Everything an inline install needs is the same whichever agent harness runs
 * it: the rendered playbook, the shared hook scripts, the credential ladder, the
 * per-project state dir and loop switch, the profile stamp, the git excludes.
 * The four things that differ — where the playbook goes, where hooks register,
 * in what shape, and what else must be true first — live behind a
 * {@link ProviderAdapter} (`provider-claude.ts`, `provider-codex.ts`). This
 * module owns the rest and never branches on the provider itself.
 *
 * ONE MACHINE, SEVERAL AGENTS. A project-scope install is deliberately PRIVATE
 * to this checkout and this agent:
 *   - Claude Code registers in `.claude/settings.local.json` (personal, not
 *     committed); `--shared` opts into the committed `.claude/settings.json`;
 *   - every hook command carries this project's `SPARROW_STATE_DIR` and
 *     `SPARROW_PROFILE`, so a hook acts as the agent that installed it, on this
 *     project's own loop switch and heartbeat;
 *   - the runtime state and the installed playbook are added to
 *     `.git/info/exclude` so none of it can be committed by accident.
 *
 * This module is SIDE-EFFECT-FREE: importing it never runs a command. The
 * `sparrow-skill` bin (`bin.ts`) and the `sparrow skill …` CLI subcommand both
 * drive it via {@link runSkill}, so there is one implementation and importing it
 * into the single-file API-served CLI bundle can never hijack `sparrow`.
 *
 * Runtime deps: node's own `fs`/`path`/`url` only.
 *
 * Subcommands: `install` (default) | `uninstall` | `pause` | `resume` |
 * `status` | `verify`.
 * Flags: `--user` (user scope instead of the project), `--shared` (Claude Code
 * project scope: write the committed `.claude/settings.json`), `--profile
 * <name>`, `--claude` / `--codex` (which harness; auto-detected otherwise).
 */
import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDED_ASSETS } from './assets-gen.js';
import { fileURLToPath } from 'node:url';
import { renderSkillMd, PROVIDER_LABEL, type Provider } from './skill-md.js';
import {
  adapterFor,
  detectProvider,
  type CheckLine,
  type Env,
  type Resolved,
  type Scope,
} from './providers.js';
import {
  resolveStateDir,
  homeStateDir,
  readLoopState,
  writeLoopState,
  heartbeatAgeSeconds,
  type LoopState,
} from './state.js';

export type { Scope, Resolved, Provider };

/** Options for a single `sparrow-skill` invocation (all resolvable from the process). */
export interface RunSkillOptions {
  /** Project root (for project-scope installs). Default `process.cwd()`. */
  cwd?: string;
  /** HOME (for user scope and `~/.sparrow` state). Default `$HOME`. */
  home?: string;
  /** Environment (for `$SPARROW_STATE_DIR` / server + token). Default `process.env`. */
  env?: Env;
  /** Sink for human-readable output. Default `process.stdout`. */
  log?: (msg: string) => void;
}

/** Absolute path to the shipped `assets/` dir (sibling of the compiled `dist/`). */
export function assetsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
}

/** Where this invocation's provider puts its playbook and hook scripts. */
export function skillDir(r: Resolved): string {
  return adapterFor(r.provider).skillDir(r);
}

export { settingsPath, BG_REAP_OPT_OUT_KEY } from './provider-claude.js';

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
  const dir =
    scoped || path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'sparrow');
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

/**
 * Write one shipped asset. The npx package ships real files under `assets/`
 * (primary path); the embedded copies are the fallback for a single-file bundle
 * with no assets directory next to the code.
 */
function writeAsset(rel: string, dest: string): void {
  const real = path.join(assetsDir(), ...rel.split('/'));
  if (fs.existsSync(real)) fs.copyFileSync(real, dest);
  else fs.writeFileSync(dest, EMBEDDED_ASSETS[rel]!);
}

/** Install: render the playbook, copy scripts, wire hooks, seed loop-state. */
export function install(r: Resolved): number {
  const adapter = adapterFor(r.provider);
  const dir = adapter.skillDir(r);
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // The playbook is RENDERED per provider from one template plus that
  // provider's fragments — never a forked document.
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMd(r.provider));

  for (const file of adapter.scripts) {
    const dest = path.join(hooksDir, file);
    writeAsset(`hooks/${file}`, dest);
    fs.chmodSync(dest, 0o755);
  }

  r.log(`Sparrow skill installed for ${adapter.label} (${r.scope} scope): ${dir}`);
  adapter.wire(r);

  // The state dir exists from here on (project scope: `<project>/.sparrow`), and
  // the loop switch is seeded on first install — never clobbering an existing one.
  fs.mkdirSync(r.stateDir, { recursive: true });
  if (readLoopState(r.stateDir) === undefined) writeLoopState(r.stateDir, 'engaged');

  if (r.scope === 'project') {
    // Local state must never land in a commit: exclude it from THIS clone only.
    const gitDir = findGitDir(r.cwd);
    const entries = ['.sparrow/', ...adapter.gitExcludes(r)];
    if (gitDir && addGitExcludes(gitDir, entries)) {
      r.log(`added ${entries.join(' and ')} to .git/info/exclude`);
    }
  }
  r.log(`Loop switch: ${readLoopState(r.stateDir)} (${path.join(r.stateDir, 'loop-state')}).`);
  r.log(
    `Pause anytime with 'sparrow skill pause' (or 'sparrow-skill pause' / 'npx sparrow-skill pause').`,
  );
  for (const note of adapter.postInstallNotes(r)) r.log(note);
  return 0;
}

/** Uninstall: remove hook registrations (preserving foreign ones) and the skill dir. */
export function uninstall(r: Resolved): number {
  const adapter = adapterFor(r.provider);
  r.log(`Sparrow skill removed for ${adapter.label} (${r.scope} scope).`);
  adapter.unwire(r);
  fs.rmSync(adapter.skillDir(r), { recursive: true, force: true });
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
  r.log(
    `Sparrow loop engaged (${r.stateDir}). Re-start your loop ('sparrow watch' / 'sparrow loop') to come online.`,
  );
  return 0;
}

/** Print the current loop switch, heartbeat freshness, and install state. */
export function status(r: Resolved): number {
  const adapter = adapterFor(r.provider);
  const state = readLoopState(r.stateDir) ?? '(unset)';
  const age = heartbeatAgeSeconds(r.stateDir);
  const hb = age === undefined ? 'no heartbeat' : `heartbeat ${age}s ago`;
  const dir = adapter.skillDir(r);
  const installed = fs.existsSync(path.join(dir, 'SKILL.md'));
  r.log(`provider:   ${adapter.label}`);
  r.log(`loop-state: ${state}`);
  r.log(`heartbeat:  ${hb}`);
  r.log(`state dir:  ${r.stateDir}`);
  r.log(`skill:      ${installed ? 'installed' : 'not installed'} (${r.scope} scope, ${dir})`);
  for (const line of adapter.statusLines(r)) r.log(line.text);
  return 0;
}

/**
 * `verify` — the honest half of `status`.
 *
 * `status` can only report what is on disk, and on Codex what is on disk proves
 * nothing: two silent trust gates stand between a hooks.json and any hook
 * running. So `verify` parse-validates our registration against the harness's
 * REAL schema and then reports which hooks have actually been OBSERVED firing.
 * A check we cannot prove is reported as UNVERIFIED, never as a tick — and an
 * unverified check makes the whole command exit non-zero, so a script cannot
 * mistake "we don't know" for "fine".
 */
export function verify(r: Resolved): number {
  const adapter = adapterFor(r.provider);
  const lines: CheckLine[] = adapter.verifyLines(r);
  const mark = { ok: '  ok  ', warn: ' ???  ', fail: ' FAIL ' } as const;
  r.log(`Verifying the Sparrow skill for ${adapter.label} (${r.scope} scope):`);
  for (const l of lines) r.log(`[${mark[l.level]}] ${l.text}`);
  const failed = lines.filter((l) => l.level === 'fail').length;
  const unverified = lines.filter((l) => l.level === 'warn').length;
  if (failed === 0 && unverified === 0) {
    r.log('All checks passed.');
    return 0;
  }
  if (failed > 0) r.log(`${failed} check(s) FAILED — re-run 'sparrow skill install'.`);
  if (unverified > 0) {
    r.log(
      `${unverified} check(s) UNVERIFIED. A hook that has never fired is not proof of anything: ` +
        `finish the trust steps above, run ONE real turn, then re-run this command.`,
    );
  }
  return 1;
}

/* ---------------------------------- dispatch --------------------------------- */

/** Parsed `sparrow-skill` argv: the subcommand plus its flags. */
interface ParsedArgv {
  sub: string;
  user: boolean;
  shared: boolean;
  profile?: string;
  provider?: Provider;
}

function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  let user = false;
  let shared = false;
  let profile: string | undefined;
  let provider: Provider | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--user') user = true;
    else if (a === '--shared') shared = true;
    else if (a === '--codex') provider = 'codex';
    else if (a === '--claude') provider = 'claude';
    else if (a === '--profile') profile = argv[++i];
    else if (a.startsWith('--profile=')) profile = a.slice('--profile='.length);
    else positional.push(a);
  }
  return { sub: (positional[0] ?? 'install').toLowerCase(), user, shared, profile, provider };
}

/**
 * Which state dir this invocation acts on.
 *
 * `--user` is pinned to `~/.sparrow` — that is what a user-scope install's
 * unstamped hooks read. A project-scope INSTALL always uses `<cwd>/.sparrow`,
 * because that is exactly what it stamps into the hook commands. Every other
 * project-scope subcommand (pause/resume/status/verify) DISCOVERS the project by
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

function resolve(opts: RunSkillOptions, p: ParsedArgv, provider: Provider): Resolved {
  const env = opts.env ?? (process.env as Env);
  const home = opts.home ?? env.HOME ?? process.env.HOME ?? '';
  const cwd = opts.cwd ?? process.cwd();
  const scope: Scope = p.user ? 'user' : 'project';
  return {
    provider,
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

const USAGE =
  'Use: install | uninstall | pause | resume | status | verify ' +
  '[--user] [--shared] [--profile <name>] [--claude|--codex].';

/**
 * Parse `argv` (subcommand + flags) and run it. Shared by the `sparrow-skill`
 * bin and the `sparrow skill …` CLI subcommand. Returns a process exit code.
 */
export async function runSkill(argv: string[], opts: RunSkillOptions = {}): Promise<number> {
  const parsed = parseArgv(argv);
  const log = opts.log ?? ((m: string) => process.stdout.write(`${m}\n`));

  let provider = parsed.provider;
  if (!provider) {
    const searchFrom = parsed.user
      ? (opts.home ?? opts.env?.HOME ?? process.env.HOME ?? '')
      : (opts.cwd ?? process.cwd());
    const detected = detectProvider(searchFrom);
    if (!detected.provider) {
      log(`Cannot tell which agent harness to install for: ${detected.reason}`);
      return 1;
    }
    provider = detected.provider;
    // Only worth a line when the answer was not the historical default.
    if (provider !== 'claude') {
      log(`Detected harness: ${PROVIDER_LABEL[provider]} (${detected.reason}).`);
    }
  }

  const r = resolve(opts, parsed, provider);
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
    case 'verify':
      return verify(r);
    default:
      r.log(`Unknown command '${parsed.sub}'. ${USAGE}`);
      return 1;
  }
}

export type { LoopState };
