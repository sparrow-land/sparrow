/**
 * Per-profile CLI state: `state.json` beside the credential store, so it lands
 * wherever `configDir` resolves (`$SPARROW_CONFIG_DIR` > `$XDG_CONFIG_HOME/sparrow`
 * > `~/.config/sparrow`). Unlike `credentials.json` this holds no
 * secrets — only convenience state keyed by profile name: the last INBOUND
 * message (so `sparrow reply` needs no id) and sticky `defaultRoom`/`defaultOrg`
 * (so `--room`/`--org` can be omitted). Best-effort: a missing or corrupt file
 * reads as empty and never fails a command.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configDir } from './credentials.js';

type Env = Record<string, string | undefined>;

/** The last message the profile received — the target `sparrow reply --last` acts on. */
export interface LastInbound {
  /** The message id, set as `inReplyTo` on the reply. */
  messageId: string;
  /** The room the message arrived in — where the reply is sent. */
  roomId: string;
  /** The sender's member id — the reply's recipient (`to`). */
  senderMemberId: string;
}

/**
 * The last EMAIL the profile received — the thread `sparrow email reply` answers.
 * Kept SEPARATE from {@link LastInbound} on purpose (SPEC → CLI): `reply` always
 * answers chat and `email reply` always answers email, so popping an email never
 * re-targets `sparrow reply` and no command crosses a reply between mediums.
 */
export interface LastEmail {
  /** The email id (`eml_…`) the reply quotes. */
  emailId: string;
  /** Its thread (`eth_…`) — the reply keeps the thread's subject and recipients. */
  threadId: string;
}

/** Convenience state for one credential profile. */
export interface ProfileState {
  lastInbound?: LastInbound;
  /** The last inbound email (set by `pop`; the target of `sparrow email reply`). */
  lastEmail?: LastEmail;
  /** Sticky default room (a `room_…` id) — lowest-precedence room source. */
  defaultRoom?: string;
  /** Sticky default org (an `org_…` id) — lowest-precedence org source. */
  defaultOrg?: string;
  /**
   * The DISPLAY NAME of the org this profile belongs to, learned at enrollment.
   *
   * An agent key cannot read it back: `GET /orgs/:orgId` and `GET /me/orgs` are
   * session-only, and `GET /me` carries an agent's `orgId` and nothing else. The
   * name reaches the CLI exactly once — in the enrollment response — so a
   * long-running agent process that wants to say where it is (the `sparrow
   * harness` banner and the prompt it hands a runner) must have kept it. Absent
   * for profiles enrolled before this existed; callers fall back to the id.
   */
  orgName?: string;
  /**
   * The last `/me/events` journal cursor this profile surfaced (watch/loop).
   * Persisted so a RESTARTED process resumes exactly where the last one left
   * off — replaying what was missed while down, never re-flooding history.
   */
  lastEventId?: string;
  /**
   * Which credential IDENTITY earned {@link lastEventId} — see
   * {@link eventCursorIdentity}. Cursors are per-principal journal positions, so a
   * cursor is only meaningful to the (server, credential) that produced it. A
   * profile NAME is reused across identities — `sparrow enroll` and
   * `sparrow login-agent` overwrite a profile in place — and a prod outage
   * (2026-09-01) came from exactly that: a re-enrolled agent inherited the
   * previous agent's cursor and filtered every live event as already-seen.
   * Absent (a cursor written by an older CLI) → grandfathered in and stamped on
   * the next write; present and different → the cursor is dropped, not resumed.
   */
  eventCursorIdentity?: string;
}

export interface StateFile {
  /** Keyed by credential profile name. */
  profiles: Record<string, ProfileState>;
}

export function statePath(env: Env): string {
  return path.join(configDir(env), 'state.json');
}

export function loadState(env: Env): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(env), 'utf8')) as Partial<StateFile>;
    return { profiles: parsed.profiles ?? {} };
  } catch {
    return { profiles: {} };
  }
}

export function saveState(env: Env, data: StateFile): void {
  fs.mkdirSync(configDir(env), { recursive: true });
  fs.writeFileSync(statePath(env), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** The stored state for `profileName` (empty object when absent). */
export function getProfileState(env: Env, profileName: string): ProfileState {
  return loadState(env).profiles[profileName] ?? {};
}

/**
 * A stable, NON-REVERSIBLE fingerprint of the credential a `/me/events` cursor
 * was earned under: the server it points at plus a truncated SHA-256 of the
 * token. It identifies the principal without storing anything secret (the digest
 * cannot be turned back into the key, and the key itself lives in
 * `credentials.json`), which keeps `state.json`'s "no secrets" rule intact.
 */
export function eventCursorIdentity(server: string, token: string | undefined): string {
  const digest = createHash('sha256')
    .update(token ?? '')
    .digest('hex')
    .slice(0, 16);
  return `${server}#${digest}`;
}

/**
 * The profile's `/me/events` cursor, but ONLY if it belongs to `identity`. A
 * cursor stamped with a DIFFERENT identity (re-enrollment, a new agent key, a
 * re-pointed server) names a position in someone else's journal: it is dropped
 * here — and erased from disk — so watch/loop start clean instead of filtering
 * every live event against a stranger's high-water mark. An UNSTAMPED cursor
 * (written by a CLI that predates this) is grandfathered in, so upgrading does
 * not cost every agent its resume point.
 */
export function readEventCursor(
  env: Env,
  profileName: string,
  identity: string,
): string | undefined {
  const state = getProfileState(env, profileName);
  if (state.lastEventId === undefined) return undefined;
  if (state.eventCursorIdentity === undefined) return state.lastEventId; // grandfathered
  if (state.eventCursorIdentity === identity) return state.lastEventId;
  writeEventCursor(env, profileName, identity, undefined); // another identity's cursor
  return undefined;
}

/** Persist (or, with `undefined`, erase) the profile's cursor, stamped with `identity`. */
export function writeEventCursor(
  env: Env,
  profileName: string,
  identity: string,
  cursor: string | undefined,
): void {
  updateProfileState(env, profileName, {
    lastEventId: cursor ?? null,
    eventCursorIdentity: identity,
  });
}

/**
 * Merge `patch` into `profileName`'s state and persist. A `null` value in the
 * patch deletes that key (so callers can clear a default).
 */
export function updateProfileState(
  env: Env,
  profileName: string,
  patch: Partial<Record<keyof ProfileState, ProfileState[keyof ProfileState] | null>>,
): ProfileState {
  const state = loadState(env);
  const current = state.profiles[profileName] ?? {};
  const next: ProfileState = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key as keyof ProfileState];
    else (next as Record<string, unknown>)[key] = value;
  }
  state.profiles[profileName] = next;
  saveState(env, state);
  return next;
}
