/**
 * The mechanical half of agent enrollment, shared by `sparrow enroll` and
 * `sparrow harness --url`.
 *
 * Both commands follow the SAME invite (poll until the approver decides, then
 * write the minted key into a credential profile) and differ only in what they
 * PRINT and what they do next — enroll reports and stops, the harness reports
 * and starts running. So the polling, the "the key is shown exactly once"
 * guards, and the profile write live here, and each command owns its own voice.
 *
 * Nothing here prints. Nothing here reads `process.env`.
 */
import { ApiError, SparrowClient } from '@sparrow/client';
import type { Agent, OrgMini, PollEnrollmentResponse } from '@sparrow/common-types';
import {
  clearPending,
  loadCredentials,
  saveProfile,
  type PendingEnrollment,
  type Profile,
  type SaveProfileResult,
} from '../credentials.js';
import { getProfileState, updateProfileState } from '../state.js';
import { CliError, type Env } from '../util.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The three ids a pending enrollment is polled with. */
export interface EnrollmentRef {
  inviteToken: string;
  enrollmentId: string;
  enrollmentToken: string;
}

/**
 * The wait ran out. `unreachable` distinguishes the two ways that happens: a
 * live server that kept saying "pending" (the plain timeout — the approver just
 * hasn't decided) versus a server we never got an answer from at all. Only the
 * caller prints; this is the fact it prints FROM.
 */
export interface EnrollmentTimeout {
  status: 'timeout';
  /** The deadline passed while the server was unreachable, not while it answered. */
  unreachable?: true;
  /** The last transport failure's text, so the caller can name what went wrong. */
  lastError?: string;
}

/** HTTP statuses that mean "try again", not "this request is wrong". */
const TRANSIENT_STATUSES = new Set([0, 408, 429, 502, 503, 504]);

/**
 * Is this failure worth retrying? A poll can fail two ways. The server ANSWERED
 * with a real refusal (401/403/404/410 — the token died, the enrollment is
 * gone): retrying that forever is worse than failing, so it propagates. Or we
 * never reached it — `TypeError: fetch failed`, ECONNREFUSED/ECONNRESET, a
 * socket hang up, a 502 from something in front — which is exactly what a
 * server RESTART looks like, and restarts are routine in dev and self-host.
 */
function isTransient(e: unknown): boolean {
  if (e instanceof ApiError) return TRANSIENT_STATUSES.has(e.status);
  return true;
}

/** Best one-line text for a transport failure — `fetch failed` alone says nothing. */
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  const detail = cause instanceof Error ? cause.message : undefined;
  return detail && detail !== e.message ? `${e.message}: ${detail}` : e.message;
}

/** The retry ladder for an unreachable server: 1s, 2s, 4s, 8s, then 15s forever. */
const RETRY_BACKOFF_START_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 15_000;

/**
 * Poll a pending enrollment until the approver decides or `timeoutMs` elapses.
 * The server's `retryAfterSeconds` sets the cadence; `SPARROW_POLL_INTERVAL_MS`
 * overrides it (what keeps the integration suites fast, and — since a test's
 * whole point is speed — doubles as the retry delay).
 *
 * A wait that was working must survive the server going away underneath it, so
 * transient failures back off and retry rather than escaping; see
 * {@link isTransient}. If the deadline passes while still unreachable we return
 * {@link EnrollmentTimeout} with `unreachable` rather than throwing, so the
 * caller prints an honest line that still names `sparrow enroll --resume`.
 */
export async function pollEnrollmentUntilResolved(
  client: SparrowClient,
  ref: EnrollmentRef,
  timeoutMs: number,
  env: Env,
): Promise<PollEnrollmentResponse | EnrollmentTimeout> {
  const overrideMs = env.SPARROW_POLL_INTERVAL_MS
    ? Number.parseInt(env.SPARROW_POLL_INTERVAL_MS, 10)
    : undefined;
  const deadline = Date.now() + timeoutMs;
  let backoffMs = RETRY_BACKOFF_START_MS;
  for (;;) {
    let poll: PollEnrollmentResponse;
    try {
      poll = await client.pollEnrollment(ref.inviteToken, ref.enrollmentId, {
        enrollmentToken: ref.enrollmentToken,
      });
    } catch (e) {
      if (!isTransient(e)) throw e;
      const lastError = errorText(e);
      if (Date.now() >= deadline) return { status: 'timeout', unreachable: true, lastError };
      await sleep(Math.max(overrideMs ?? backoffMs, 10));
      backoffMs = Math.min(backoffMs * 2, RETRY_BACKOFF_MAX_MS);
      continue;
    }
    backoffMs = RETRY_BACKOFF_START_MS; // the server is answering again
    if (poll.status !== 'pending') return poll;
    if (Date.now() >= deadline) return { status: 'timeout' };
    const waitMs = overrideMs ?? poll.retryAfterSeconds * 1000;
    await sleep(Math.max(waitMs, 10));
  }
}

/** What an approval yielded, once the key is safely on disk. */
export interface ApprovedEnrollment {
  agent: Agent;
  org: OrgMini;
  dmRoomId: string;
  saved: SaveProfileResult;
}

/**
 * Turn an APPROVED poll into a stored credential profile. Throws
 * {@link CliError} for the two ways an approval can still leave you with
 * nothing: a human enrollment (no agent minted) and a key that was already
 * delivered — it is shown exactly once, so a second poll cannot recover it.
 */
export function saveApprovedProfile(
  env: Env,
  pending: PendingEnrollment,
  poll: PollEnrollmentResponse,
): ApprovedEnrollment {
  if (poll.status !== 'approved' || !('agent' in poll)) {
    throw new CliError('Enrollment approved but did not mint an agent.');
  }
  if (!poll.key) {
    throw new CliError(
      'Enrollment approved but the agent key was already delivered (it is shown exactly ' +
        'once). Rotate the key or use a fresh invite.',
    );
  }
  const saved = saveProfile(
    env,
    pending.profileName,
    { server: pending.server, token: poll.key, kind: 'agent' },
    { setDefault: pending.setDefault === true },
  );
  clearPending(env);
  // The one moment the org's DISPLAY NAME is on the wire: an agent key can never
  // ask for it again (see ProfileState.orgName). Keep it now or say `org_…`
  // forever.
  rememberOrgName(env, pending.profileName, poll.org.name);
  return { agent: poll.agent, org: poll.org, dmRoomId: poll.dmRoomId, saved };
}

/**
 * Remember a profile's org display name (best-effort; an empty name is ignored).
 * Convenience state, never a correctness input — a failed write costs a banner
 * that reads `org_…`.
 */
export function rememberOrgName(env: Env, profileName: string, orgName: string): void {
  if (!orgName.trim()) return;
  try {
    updateProfileState(env, profileName, { orgName });
  } catch {
    /* the id is a survivable fallback */
  }
}

/** The stored org display name for `profileName`, if one was ever learned. */
export function readOrgName(env: Env, profileName: string): string | undefined {
  const name = getProfileState(env, profileName).orgName;
  return name && name.trim() !== '' ? name : undefined;
}

/**
 * An AGENT profile already pointed at `server`, if one exists — what makes
 * `sparrow harness --url <same url>` idempotent. Re-running the command with
 * the invite still in the scrollback must not mint a second agent; it must
 * notice the first one and just run.
 *
 * An explicit `--profile`/`SPARROW_PROFILE` is authoritative: it is only a
 * match if THAT profile points at the same server (otherwise the caller named a
 * profile for somewhere else and we must enroll fresh under it). Without one,
 * the default profile wins if it matches, then any other agent profile on the
 * same server, so the common single-agent machine reuses the obvious thing.
 */
export function findAgentProfileForServer(
  env: Env,
  server: string,
  explicitProfile?: string,
): { name: string; profile: Profile } | undefined {
  const creds = loadCredentials(env);
  const matches = (p: Profile | undefined): boolean =>
    p !== undefined && p.kind === 'agent' && sameServer(p.server, server);
  if (explicitProfile) {
    const profile = creds.profiles[explicitProfile];
    return matches(profile) ? { name: explicitProfile, profile: profile! } : undefined;
  }
  const preferred = creds.defaultProfile;
  if (preferred && matches(creds.profiles[preferred])) {
    return { name: preferred, profile: creds.profiles[preferred]! };
  }
  for (const [name, profile] of Object.entries(creds.profiles)) {
    if (matches(profile)) return { name, profile };
  }
  return undefined;
}

/** Compare server URLs ignoring a trailing slash and case in the origin. */
function sameServer(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
