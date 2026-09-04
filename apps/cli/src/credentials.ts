/**
 * Credential store: `~/.config/sparrow/credentials.json` — or wherever
 * {@link configDir} resolves (`$SPARROW_CONFIG_DIR` > `$XDG_CONFIG_HOME/sparrow`
 * > `~/.config/sparrow`), the isolation hook for sandboxes, tests and
 * scenarios — mode 0600. A map of named profiles plus `defaultProfile`, and a
 * single in-flight pending agent enrollment (so `sparrow enroll` is Ctrl-C-safe).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A stored credential profile. Both kinds span rooms and orgs; the credential
 * is a human session token (`ses_…`, `kind: 'human'`) or an agent key (`agk_…`,
 * `kind: 'agent'`) sent as `Authorization: Bearer`.
 */
export interface Profile {
  server: string;
  token: string;
  kind: 'human' | 'agent';
}

/**
 * A pending agent enrollment (a followed invite awaiting approval). Persisted so
 * `sparrow enroll` survives Ctrl-C: interrupt the wait and `sparrow enroll --resume`
 * continues polling from here. The `enr_` token authorizes the poll; the profile
 * name + server are what the approved profile is written under.
 */
export interface PendingEnrollment {
  server: string;
  /** The invite token (`ivk_…`) the enrollment was created under. */
  inviteToken: string;
  /** The enrollment id (`enl_…`). */
  enrollmentId: string;
  /** The one-time `enr_…` poll token. */
  enrollmentToken: string;
  /** The proposed agent name (for the approval blurb). */
  name: string;
  /** Profile name to write on approval. */
  profileName: string;
  /**
   * Whether `--set-default` was passed. Persisted with the rest of the pending
   * record so a Ctrl-C'd enroll resumed with `--resume` still lands the default
   * where the original invocation asked (and, absent the flag, still leaves
   * another agent's default alone).
   */
  setDefault?: boolean;
}

export interface CredentialsFile {
  profiles: Record<string, Profile>;
  defaultProfile?: string;
  /** A single in-flight agent enrollment awaiting approval. */
  pending?: PendingEnrollment;
}

type Env = Record<string, string | undefined>;

/**
 * Directory holding `credentials.json` (and the sibling `state.json`).
 *
 * Resolution order, for READS and WRITES alike:
 *   1. `$SPARROW_CONFIG_DIR` — the directory itself, used verbatim (no `sparrow`
 *      segment is appended). This is the credential-store twin of
 *      `$SPARROW_STATE_DIR`: it isolates ONE agent's identity without
 *      commandeering `$XDG_CONFIG_HOME`, which would move every other program's
 *      config too. A sandbox or a second agent on the same unix user sets this
 *      and stops writing through to the operator's shared store.
 *   2. `$XDG_CONFIG_HOME/sparrow` — the standard base-directory override.
 *   3. `~/.config/sparrow` — the default.
 *
 * A blank (empty or whitespace-only) value at either step reads as UNSET and
 * falls through, so an exported-but-empty variable never silently relocates the
 * store to the process's working directory.
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
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
    return {
      profiles: parsed.profiles ?? {},
      defaultProfile: parsed.defaultProfile,
      pending: parsed.pending,
    };
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
  const base = desired.trim() || 'default';
  if (!(base in existing)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!(candidate in existing)) return candidate;
  }
}

/** What a {@link saveProfile} did to `defaultProfile` — the caller reports it. */
export interface SaveProfileResult {
  /** The profile just written. */
  name: string;
  /** `defaultProfile` BEFORE the save (`undefined` = the store had none). */
  previousDefault?: string;
  /** `defaultProfile` AFTER the save. */
  defaultProfile: string;
  /** Did this save MOVE the default? */
  changed: boolean;
}

/**
 * Write a profile under `name` (verbatim — overwrites an existing one of the
 * same name), and set `defaultProfile` only when that is unambiguously right.
 *
 * ONE MACHINE, SEVERAL AGENTS. Three Claude Code agents routinely share a unix
 * user, a HOME and therefore this one credentials.json, in three checkouts and
 * often three workspaces. Making every new profile the default meant the third
 * agent's `sparrow enroll` silently re-pointed the other two agents' bare
 * `sparrow` commands at ITS workspace — they kept working, as somebody else.
 *
 * So the default moves only when:
 *   - there is no default yet (the first enrollment/login on the machine), or
 *   - the caller asked for it (`--set-default`), or
 *   - we are (re)writing the profile that IS the default, or
 *   - the stored default is dangling (its profile no longer exists).
 * Otherwise it is left exactly where it was, and the caller tells the user how
 * to address the new profile (`--profile` / `SPARROW_PROFILE`).
 */
export function saveProfile(
  env: Env,
  name: string,
  profile: Profile,
  opts: { setDefault?: boolean } = {},
): SaveProfileResult {
  const creds = loadCredentials(env);
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

/** Persist the single in-flight pending enrollment (Ctrl-C safety for enroll). */
export function savePending(env: Env, pending: PendingEnrollment): void {
  const creds = loadCredentials(env);
  creds.pending = pending;
  saveCredentials(env, creds);
}

/** Read the stored pending enrollment, if any (`sparrow enroll --resume`). */
export function loadPending(env: Env): PendingEnrollment | undefined {
  return loadCredentials(env).pending;
}

/** Clear the stored pending enrollment (on approval, denial, or a fresh enroll). */
export function clearPending(env: Env): void {
  const creds = loadCredentials(env);
  if (creds.pending === undefined) return;
  delete creds.pending;
  saveCredentials(env, creds);
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
