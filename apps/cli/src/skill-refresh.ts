/**
 * Keeping the installed SKILL in step with the installed CLI.
 *
 * `sparrow upgrade` re-pulls the CLI + MCP bundles, but the Sparrow skill —
 * the rendered `SKILL.md`, the hook scripts, the harness registrations — is
 * written to disk by `sparrow skill install` and never moves on its own. The
 * two therefore DRIFT: a Codex agent upgraded 0.1.17 → 0.1.18 and kept running
 * the 0.1.17 playbook (with 0.1.17's hooks) until they thought to re-run
 * `sparrow skill install --codex` by hand.
 *
 * Nothing on disk recorded HOW that skill had been installed — which provider,
 * which scope, `--shared` or not, acting as which profile — so an upgrade had
 * nothing to replay. This module adds the missing record and reads it back:
 *
 *   - `sparrow skill install` stamps `<state dir>/skill-install.json` next to
 *     the loop switch it already seeds (see {@link recordSkillInstall}). The
 *     state dir is the right home for it: it is already per-project (or
 *     per-user), already excluded from git, and already the thing every other
 *     part of the skill resolves.
 *   - `sparrow upgrade` looks in the two state dirs that can hold one — this
 *     project's and `~/.sparrow` — and re-runs each recorded install
 *     (see {@link discoverSkillInstalls}, {@link refreshSkillInstalls}).
 *
 * BACKWARD COMPATIBLE: an install written by an older CLI leaves no marker, and
 * "no marker" means "refresh nothing" plus a one-line nudge — never a guess at
 * a provider, which would happily install a Claude Code skill over a Codex one.
 *
 * WHY THE REFRESH EXECS THE NEW BUNDLE: the process running `upgrade` is the
 * OLD bundle, carrying the OLD embedded assets. Re-installing in-process would
 * rewrite exactly the stale files we are trying to replace, so the refresh
 * shells out to the freshly downloaded binary instead ({@link refreshSkillInstalls}
 * takes the exec as a parameter; the CLI binds it to the new `sparrow.mjs`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectProvider,
  homeStateDir,
  resolveStateDir,
  PROVIDERS,
  type Provider,
  type Scope,
} from '@sparrow/skill';

type Env = Record<string, string | undefined>;

/** File name of the install marker, inside the state dir. */
export const SKILL_INSTALL_MARKER = 'skill-install.json';

/**
 * What a `sparrow skill install` recorded about itself — everything needed to
 * REPLAY it verbatim on a later upgrade.
 */
export interface SkillInstallMarker {
  /** The harness this install targeted. */
  provider: Provider;
  /** `project` (this checkout) or `user` (this HOME). */
  scope: Scope;
  /** ISO timestamp of the install that wrote this marker. */
  installedAt: string;
  /** CLI version that wrote it — what a stale install is stale RELATIVE TO. */
  version: string;
  /** Project root for `project` scope, HOME for `user` scope: the replay cwd. */
  dir: string;
  /** Claude Code project scope: hooks went in the COMMITTED settings file. */
  shared?: boolean;
  /** The `--profile` the hooks were stamped with, when one was given. */
  profile?: string;
}

/** Where the marker lives for a given state dir. */
export function skillInstallMarkerPath(stateDir: string): string {
  return path.join(stateDir, SKILL_INSTALL_MARKER);
}

/**
 * Read a state dir's marker. Anything unreadable, unparseable, or not shaped
 * like a marker reads as ABSENT — a refresh must never act on a guess.
 */
export function readSkillInstallMarker(stateDir: string): SkillInstallMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(skillInstallMarkerPath(stateDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SkillInstallMarker>;
    const provider = parsed.provider;
    const scope = parsed.scope;
    const dir = parsed.dir;
    if (typeof provider !== 'string' || !PROVIDERS.includes(provider as Provider)) return undefined;
    if (scope !== 'project' && scope !== 'user') return undefined;
    if (typeof dir !== 'string' || dir === '') return undefined;
    return {
      provider: provider as Provider,
      scope,
      dir,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
      ...(parsed.shared === true ? { shared: true } : {}),
      ...(typeof parsed.profile === 'string' && parsed.profile !== ''
        ? { profile: parsed.profile }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Write a state dir's marker (creating the dir). Best-effort by the caller. */
export function writeSkillInstallMarker(stateDir: string, marker: SkillInstallMarker): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(skillInstallMarkerPath(stateDir), `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * The state dir an INSTALL acts on — deliberately the same answer
 * `@sparrow/skill` computes for its own `install` subcommand:
 * `$SPARROW_STATE_DIR` first, else `~/.sparrow` for `--user`, else
 * `<cwd>/.sparrow` (an install stamps the cwd's project, it does not go
 * hunting up the tree the way pause/status do).
 */
function installStateDir(env: Env, cwd: string, home: string, scope: Scope): string {
  const override = env.SPARROW_STATE_DIR?.trim();
  if (override) return override;
  if (scope === 'user') return homeStateDir({ ...env, HOME: home });
  return path.join(cwd, '.sparrow');
}

/** What `sparrow skill install` knew about the install it just ran. */
export interface RecordSkillInstallOptions {
  env: Env;
  cwd: string;
  /** CLI version doing the installing. */
  version: string;
  /** `--user`. */
  user?: boolean;
  /** `--shared`. */
  shared?: boolean;
  /** Explicit `--profile <name>`, if one was typed. */
  profile?: string;
  /** Explicit `--claude` / `--codex`; auto-detected (as the installer does) otherwise. */
  provider?: Provider;
}

/**
 * Stamp the marker after a successful install. Best-effort in the strictest
 * sense: a failure here must never fail an install that actually worked, so
 * everything is swallowed and `undefined` returned.
 */
export function recordSkillInstall(o: RecordSkillInstallOptions): SkillInstallMarker | undefined {
  try {
    const home = o.env.HOME?.trim() || os.homedir();
    const scope: Scope = o.user ? 'user' : 'project';
    // Same resolution the installer used: the explicit flag, else detection
    // from the same directory it searched. Detection runs AFTER the install, so
    // the freshly written skill dir is itself the strongest signal.
    const provider = o.provider ?? detectProvider(scope === 'user' ? home : o.cwd).provider;
    if (!provider) return undefined;
    const marker: SkillInstallMarker = {
      provider,
      scope,
      installedAt: new Date().toISOString(),
      version: o.version,
      dir: scope === 'user' ? home : o.cwd,
      ...(o.shared ? { shared: true } : {}),
      ...(o.profile ? { profile: o.profile } : {}),
    };
    writeSkillInstallMarker(installStateDir(o.env, o.cwd, home, scope), marker);
    return marker;
  } catch {
    return undefined;
  }
}

/**
 * Drop the marker after an UNINSTALL. Without this, a removed skill would be
 * resurrected by the next `sparrow upgrade` — the marker outliving the thing it
 * describes is the one way this feature could act against the user.
 *
 * It clears both state dirs an uninstall could have acted on (the resolved one
 * — `uninstall` walks up from the cwd the way `pause`/`status` do — and, for
 * `--user`, `~/.sparrow`), but only where the marker's own scope matches, so a
 * user-scope uninstall never forgets a project install or vice versa.
 */
export function forgetSkillInstall(env: Env, cwd: string, opts: { user?: boolean } = {}): void {
  try {
    const home = env.HOME?.trim() || os.homedir();
    const scope: Scope = opts.user ? 'user' : 'project';
    const override = env.SPARROW_STATE_DIR?.trim();
    const stateDir = override
      ? override
      : scope === 'user'
        ? homeStateDir({ ...env, HOME: home })
        : resolveStateDir(env, cwd);
    const marker = readSkillInstallMarker(stateDir);
    if (!marker || marker.scope !== scope) return;
    fs.rmSync(skillInstallMarkerPath(stateDir), { force: true });
  } catch {
    // best-effort: an uninstall that worked must not fail over its bookkeeping
  }
}

/** A discovered install: its marker and the state dir the marker was found in. */
export interface DiscoveredSkillInstall {
  stateDir: string;
  marker: SkillInstallMarker;
}

/**
 * Every skill install this machine can show us from HERE: the state dir this
 * project resolves to (`$SPARROW_STATE_DIR`, else `<project>/.sparrow`, else
 * `~/.sparrow`) and the user-scope one, de-duplicated — those are exactly the
 * two an install can have written. Project first: it is the one the caller is
 * standing in.
 */
export function discoverSkillInstalls(env: Env, cwd: string): DiscoveredSkillInstall[] {
  const dirs: string[] = [];
  for (const candidate of [resolveStateDir(env, cwd), homeStateDir(env)]) {
    const resolved = path.resolve(candidate);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  }
  const found: DiscoveredSkillInstall[] = [];
  for (const stateDir of dirs) {
    const marker = readSkillInstallMarker(stateDir);
    if (marker) found.push({ stateDir, marker });
  }
  return found;
}

/** The argv a refresh replays — `sparrow skill install` plus the recorded flags. */
export function refreshArgv(marker: SkillInstallMarker): string[] {
  return [
    'skill',
    'install',
    `--${marker.provider}`,
    ...(marker.scope === 'user' ? ['--user'] : []),
    ...(marker.shared ? ['--shared'] : []),
    ...(marker.profile ? ['--profile', marker.profile] : []),
  ];
}

/** One refreshed (or attempted) install. `error` is set exactly when `ok` is false. */
export interface SkillRefreshResult {
  provider: Provider;
  scope: Scope;
  dir: string;
  ok: boolean;
  error?: string;
}

/** Run `sparrow skill install …` — bound by the caller to the NEW bundle. */
export type SkillInstallExec = (argv: string[], ctx: { cwd: string; env: Env }) => void;

/** The stderr of a failed child, else its error message. */
function execErrorMessage(e: unknown): string {
  const err = e as { stderr?: unknown; message?: string };
  const stderr =
    typeof err.stderr === 'string'
      ? err.stderr
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString('utf8')
        : '';
  const trimmed = stderr.trim();
  if (trimmed !== '') return trimmed.split('\n').slice(-3).join(' ');
  return err.message ?? String(e);
}

/**
 * Re-run every discovered install. Each one is replayed with its own recorded
 * flags, in its own directory, with `SPARROW_STATE_DIR` pinned to the state dir
 * the marker came from — so a Codex install (whose hooks bake an ABSOLUTE state
 * dir) refreshes onto the same one it already used.
 *
 * A failure is captured, never thrown: the upgrade itself succeeded, and one
 * broken harness must not make the command look like it did not.
 */
export function refreshSkillInstalls(o: {
  env: Env;
  cwd: string;
  exec: SkillInstallExec;
}): SkillRefreshResult[] {
  return discoverSkillInstalls(o.env, o.cwd).map(({ stateDir, marker }) => {
    const base = { provider: marker.provider, scope: marker.scope, dir: marker.dir };
    let cwd = marker.dir;
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = o.cwd;
    } catch {
      cwd = o.cwd;
    }
    try {
      o.exec(refreshArgv(marker), { cwd, env: { ...o.env, SPARROW_STATE_DIR: stateDir } });
      return { ...base, ok: true };
    } catch (e) {
      return { ...base, ok: false, error: execErrorMessage(e) };
    }
  });
}

/** The nudge printed when an upgrade finds nothing to refresh. */
export const NO_SKILL_INSTALL_NOTE =
  "skill: no recorded install here — run 'sparrow skill install' once and future upgrades will keep it in step.";
