/**
 * Credential store: `~/.config/sparrow/credentials.json` — or wherever
 * {@link configDir} resolves (`$SPARROW_CONFIG_DIR` > `$XDG_CONFIG_HOME/sparrow`
 * > `~/.config/sparrow`), the isolation hook for sandboxes and tests. A map of
 * named profiles plus `defaultProfile`.
 *
 * This is intentionally the SAME on-disk format as the `sparrow` CLI
 * (`apps/cli/src/credentials.ts`) so the MCP server and CLI share credentials:
 * v3 profiles are `{ server, token, kind: 'human' | 'agent' }`. Kept as a local
 * copy rather than a cross-package import to avoid depending on an app package.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A profile's credential kind: a human session (`ses_`) or an agent key (`agk_`). */
export type ProfileKind = 'human' | 'agent';

export interface Profile {
  server: string;
  /** A `ses_` session token (`kind: 'human'`) or an `agk_` key (`kind: 'agent'`). */
  token: string;
  kind: ProfileKind;
}

export interface CredentialsFile {
  profiles: Record<string, Profile>;
  defaultProfile?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Directory holding `credentials.json`. Mirrors the CLI's `configDir` exactly —
 * the two share one on-disk store, so they must agree on WHERE it is:
 * `$SPARROW_CONFIG_DIR` (verbatim) > `$XDG_CONFIG_HOME/sparrow` >
 * `~/.config/sparrow`. A blank value at either step reads as unset.
 */
export function configDir(env: Env): string {
  const scoped = env.SPARROW_CONFIG_DIR?.trim();
  if (scoped) return scoped;
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ''
      ? env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
  return path.join(base, 'sparrow');
}

export function credentialsPath(env: Env): string {
  return path.join(configDir(env), 'credentials.json');
}

export function loadCredentials(env: Env): CredentialsFile {
  const file = credentialsPath(env);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, Profile>;
      defaultProfile?: string;
    };
    return { profiles: parsed.profiles ?? {}, defaultProfile: parsed.defaultProfile };
  } catch {
    return { profiles: {} };
  }
}

export function saveCredentials(env: Env, data: CredentialsFile): void {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = credentialsPath(env);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** Pick a profile name not already used, appending `-2`, `-3`, … as needed. */
export function dedupeProfileName(desired: string, existing: Record<string, Profile>): string {
  const base = desired.trim() || 'agent';
  if (!(base in existing)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!(candidate in existing)) return candidate;
  }
}

/** What an {@link upsertDefaultProfile} did to `defaultProfile` — callers report it. */
export interface SaveProfileResult {
  /** The profile just written (post-dedupe). */
  name: string;
  /** `defaultProfile` BEFORE the save (`undefined` = the store had none). */
  previousDefault?: string;
  /** `defaultProfile` AFTER the save. */
  defaultProfile: string;
  /** Did this save MOVE the default? */
  changed: boolean;
}

/**
 * Write a profile (deduping the name against existing profiles) and set
 * `defaultProfile` only when that is unambiguously right.
 *
 * ONE MACHINE, SEVERAL AGENTS. Several agents routinely share a unix user, a
 * HOME and therefore this one credentials.json. Making every new profile the
 * default meant the third agent's `enroll` silently re-pointed the other two
 * agents' bare commands at ITS workspace — they kept working, as somebody else.
 *
 * So the default moves only when:
 *   - there is no default yet (the first enrollment/login on the machine), or
 *   - the caller asked for it (`set_default`), or
 *   - we are (re)writing the profile that IS the default, or
 *   - the stored default is dangling (its profile no longer exists).
 * Otherwise it is left exactly where it was, and the caller tells the agent how
 * to address the new profile (`--profile` / `SPARROW_PROFILE`) — see
 * {@link defaultProfileNote}. Mirrors the CLI's `saveProfile` rule exactly.
 */
export function upsertDefaultProfile(
  env: Env,
  desiredName: string,
  profile: Profile,
  opts: { setDefault?: boolean } = {},
): SaveProfileResult {
  const creds = loadCredentials(env);
  const name = dedupeProfileName(desiredName, creds.profiles);
  const previousDefault = creds.defaultProfile;
  const takeDefault =
    opts.setDefault === true ||
    previousDefault === undefined ||
    previousDefault === name ||
    !(previousDefault in creds.profiles);
  creds.profiles[name] = profile;
  if (takeDefault) creds.defaultProfile = name;
  saveCredentials(env, creds);
  return {
    name,
    previousDefault,
    defaultProfile: creds.defaultProfile!,
    changed: creds.defaultProfile !== previousDefault,
  };
}

/**
 * The one line every credential-writing tool returns about `defaultProfile` —
 * the same words the CLI prints, with `set_default` for the MCP argument name.
 *
 * "Which profile do bare commands use?" is load-bearing shared state that nobody
 * may change by accident. When the save left the default alone, this says so AND
 * says how to address the profile just written — otherwise the agent would go on
 * running as its neighbour without noticing.
 */
export function defaultProfileNote(r: SaveProfileResult): string {
  if (r.defaultProfile === r.name) {
    return r.changed && r.previousDefault
      ? `defaultProfile: "${r.previousDefault}" \u2192 "${r.defaultProfile}"`
      : `defaultProfile: "${r.defaultProfile}"`;
  }
  return (
    `defaultProfile stays "${r.defaultProfile}" \u2014 pass --profile ${r.name} ` +
    `(or SPARROW_PROFILE=${r.name}) on commands for this workspace, or re-run with set_default.`
  );
}

/** Resolve the active profile given an explicit selector or the default. */
export function resolveProfile(
  env: Env,
  selector?: string,
): { name: string; profile: Profile } | null {
  const creds = loadCredentials(env);
  const name = selector ?? creds.defaultProfile;
  if (!name) return null;
  const profile = creds.profiles[name];
  if (!profile) return null;
  return { name, profile };
}
