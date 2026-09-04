/**
 * Instance auth (v3): humans, sessions, and the AuthProvider surface.
 *
 * There are exactly two credentials in the system — a human's session token
 * (cookie OR `Authorization: Bearer ses_...`) and an agent's key (`agk_...`).
 * Providers mint sessions through `loginOrCreateUser`, which enforces the signup
 * policy (`auth.allowSignup`, `auth.allowedEmailPatterns`), creates the human if
 * new, bootstraps the first-ever human's org (unless `auth.bootstrapFirstOrg`
 * is disabled), inserts a 30-day session, and sets
 * the `sparrow_session` cookie. The session token is ALSO returned in the JSON body
 * so CLIs can persist it — the same secret the cookie carries.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  newSessionId,
  newSessionToken,
  newUserId,
  ThemePreferenceSchema,
  type ThemePreference,
  type User,
} from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { DB } from './db/index.js';
import { humans, userSessions } from './db/schema.js';
import type { HumanRow, UserSessionRow } from './db/schema.js';
import type { ConfigStore } from './config-store.js';
import { bootstrapOrgForHuman } from './org-helpers.js';
import { conflict, forbidden, unauthorized } from './errors.js';

/* ------------------------------------------------------------------ *
 * Provider surface (imported by sparrow-cloud)
 * ------------------------------------------------------------------ */

/** Context handed to an {@link AuthProvider} at registration time. */
export interface AuthCtx {
  /** Public origin used to build absolute URLs (`BASE_URL`). */
  baseUrl: string;
  db: DB;
  configStore: ConfigStore;
  auth: AuthService;
}

/**
 * An instance-auth provider. Core ships `password` (always) and `google` (when
 * its `GOOGLE_*` env credentials are set). The interface is the seam for future
 * providers (SAML, …) and cloud injection via `buildServer({ providers })`.
 * Provider credentials are operator env vars, never instance-configurable.
 */
export interface AuthProvider {
  id: string;
  label: string;
  kind: 'credentials' | 'oauth-redirect';
  /**
   * An instance may mark one oauth-redirect provider as primary; clients may
   * auto-initiate it for flows like invite acceptance rather than requiring an
   * explicit click. Omitted/false leaves the default (explicit) behavior.
   */
  primary?: boolean;
  /**
   * Build the provider's login-start URL for a given absolute `origin`. `GET
   * /auth/config` calls this per request with the *effective origin* (the
   * request's org-scoped host when one applies, else `BASE_URL`) — so a login
   * button rendered on `<slug><ORG_HOST_SUFFIX>` points back at that same host.
   * A provider whose server-side callback must stay on the static `BASE_URL`
   * (e.g. google's Google-registered `redirect_uri`) uses `AuthCtx.baseUrl` in
   * `register` for that, independent of this per-request origin.
   */
  loginUrl?(origin: string): string;
  register(app: FastifyInstance, ctx: AuthCtx): void;
}

export interface LoginOrCreateUserInput {
  email: string;
  displayName?: string;
  provider: string;
  /** Pre-computed password hash stored on a *newly created* human (password signup). */
  passwordHash?: string;
  /**
   * Additional verified email addresses for the SAME person, beyond the primary
   * `email`. An upstream identity provider may present several verified emails
   * for one person (e.g. a work address and a personal address); a person's
   * address stored on this instance might be any one of them. An existing human
   * is therefore matched by ANY of `[email, ...emails]` so the account is not
   * duplicated when the presented primary differs from the stored address.
   * Matching by a secondary email does NOT change the human's stored email, and
   * account creation always uses the primary `email`. Humans keep a single
   * stored email — this list is only used for resolution and signup policy.
   */
  emails?: string[];
  /**
   * A photo URL for this person from the upstream identity provider. When
   * present and the human has no UPLOADED avatar, it is stored as
   * `provider_avatar_url` (an uploaded avatar always wins; a changed provider
   * photo refreshes on the next sign-in). Ignored when absent.
   */
  avatarUrl?: string;
  /**
   * Name for the workspace this sign-in FOUNDS, when it turns out to be the
   * bootstrap one. Ignored in every other case — a later signup founds nothing,
   * so there is nothing to name. Blank falls back to `"{displayName}'s org"`.
   */
  orgName?: string;
}

/** Normalize (trim + lowercase) an email list, dropping blanks and duplicates. */
function normalizeEmailList(emails: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** The result of minting a session: the user resource + the plaintext token. */
export interface LoginResult {
  user: User;
  token: string;
}

/* ------------------------------------------------------------------ *
 * Glob matcher (auth.allowedEmailPatterns) — tiny, dependency-free
 * ------------------------------------------------------------------ */

/** Compile a glob (only `*` is special) to an anchored case-insensitive RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Empty pattern list = allow all; otherwise any pattern may match. */
export function emailMatchesPatterns(email: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => globToRegExp(p).test(email));
}

/* ------------------------------------------------------------------ *
 * Cookies (manual parse/serialize — no dependencies)
 * ------------------------------------------------------------------ */

export const SESSION_COOKIE = 'sparrow_session';
/** Session lifetime: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Parse a `Cookie:` header into a name -> value map (trivial split). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/** `Set-Cookie` value for a fresh session token. */
export function serializeSessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

/** `Set-Cookie` value that expires the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** Extract the session token from a request: `Authorization: Bearer ses_...` wins over the cookie. */
export function requestSessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header) {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value?.startsWith('ses_')) return value.trim();
  }
  return parseCookies(request.headers.cookie)[SESSION_COOKIE];
}

/**
 * True when the request carries no credential at all — no `Authorization`
 * header and no (non-empty) session cookie.
 *
 * `GET /auth/me` uses this to separate two facts a bare `401` conflated: "you
 * never said who you are" (the normal state of every anonymous page load →
 * `200 { user: null }`) from "the credential you presented no longer works"
 * (still a `401`, so the client knows to clear its stale state). An
 * `Authorization` header of the WRONG kind — an `agk_` agent key on this
 * human-only route — counts as a credential, not as anonymity.
 */
export function isAnonymousRequest(request: FastifyRequest): boolean {
  return !request.headers.authorization && !requestSessionToken(request);
}

/* ------------------------------------------------------------------ *
 * Password hashing (scrypt via node:crypto)
 * ------------------------------------------------------------------ */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** Hash a password as `scrypt$N$r$p$salt$hash` (hex salt + hash). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('hex');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

/** Timing-safe verification against a stored `scrypt$...` value. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, salt, hashHex] = parts as [
    string, string, string, string, string, string,
  ];
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 1 || r < 1 || p < 1) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
    if (expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * AuthService — sessions + loginOrCreateUser
 * ------------------------------------------------------------------ */

/**
 * Resolve a human's stored theme column to a wire `ThemePreference`. Null (never
 * set) or any unexpected stored value falls back to `auto`, so the web UI follows
 * the OS `prefers-color-scheme`.
 */
export function resolveTheme(stored: string | null): ThemePreference {
  const parsed = ThemePreferenceSchema.safeParse(stored);
  return parsed.success ? parsed.data : 'auto';
}

export function toUser(row: HumanRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    provider: row.provider,
    theme: resolveTheme(row.theme),
  };
}

export class AuthService {
  constructor(
    private db: DB,
    private configStore: ConfigStore,
  ) {}

  /** Look up the human by email (lowercased). */
  humanByEmail(email: string): HumanRow | undefined {
    return this.db
      .select()
      .from(humans)
      .where(eq(humans.email, email.trim().toLowerCase()))
      .get();
  }

  /**
   * Would the NEXT signup found this instance's first workspace?
   *
   * True only when all three hold: signup is open, `auth.bootstrapFirstOrg` is
   * on, and no human exists yet. Advertised on the unauthenticated
   * `GET /auth/config` so the sign-up form can ask for a workspace name up front
   * instead of leaving the founder with `alice@example.com's org`.
   *
   * The conjunction is the privacy argument, not an optimization: an instance
   * that will not let you sign up, or that would not found an org if it did,
   * answers `false` and tells a stranger nothing. Where it answers `true`, the
   * only fact disclosed — "nobody has signed up yet" — is one that same stranger
   * could establish in a single signup, on a route `allowSignup` already
   * advertises as open.
   */
  bootstrapOrgPending(): boolean {
    if (!this.configStore.getBoolean('auth.allowSignup')) return false;
    if (!this.configStore.getBoolean('auth.bootstrapFirstOrg')) return false;
    return (this.db.select({ n: count() }).from(humans).get()?.n ?? 0) === 0;
  }

  /**
   * Log an existing human in, or create the account when signup policy allows
   * (`403` otherwise). The FIRST human ever created auto-gets an org (owner)
   * unless `auth.bootstrapFirstOrg` is disabled (managed instances provision
   * orgs centrally). Inserts a 30-day session (token stored sha256-hashed), sets the cookie, and
   * returns the user + plaintext token.
   */
  loginOrCreateUser(input: LoginOrCreateUserInput, reply: FastifyReply): LoginResult {
    const email = input.email.trim().toLowerCase();
    // Candidate identities: the primary email plus any secondary verified
    // emails, normalized and deduped with the primary kept first.
    const candidates = normalizeEmailList([email, ...(input.emails ?? [])]);
    // Resolve by any candidate, primary first; matching a secondary leaves the
    // matched human's stored email untouched.
    let human: HumanRow | undefined;
    for (const candidate of candidates) {
      human = this.humanByEmail(candidate);
      if (human) break;
    }
    if (!human) {
      if (!this.configStore.getBoolean('auth.allowSignup')) {
        throw forbidden('Signup is disabled on this instance');
      }
      const patterns = this.configStore.getStringArray('auth.allowedEmailPatterns');
      // Signup is allowed if ANY candidate matches; the account is still created
      // under the primary email below.
      if (!candidates.some((c) => emailMatchesPatterns(c, patterns))) {
        throw forbidden('This email address is not allowed to sign up');
      }
      const isFirst = (this.db.select({ n: count() }).from(humans).get()?.n ?? 0) === 0;
      const nowTs = new Date().toISOString();
      human = {
        id: newUserId(),
        email,
        displayName: input.displayName?.trim() || email,
        passwordHash: input.passwordHash ?? null,
        provider: input.provider,
        avatarAttachment: null,
        // A brand-new account has no uploaded avatar, so a provider photo (if any)
        // is stored immediately.
        providerAvatarUrl: input.avatarUrl?.trim() || null,
        // Theme preference is unset at signup → null (resolves to `auto`).
        theme: null,
        createdAt: nowTs,
      };
      this.db.insert(humans).values(human).run();
      // The first-ever human founds a workspace (self-hosted single-org default).
      // Managed multi-org instances disable this (`auth.bootstrapFirstOrg`) so a
      // first sign-in redeems a centrally-provisioned invite instead of founding
      // an accidental personal org.
      if (isFirst && this.configStore.getBoolean('auth.bootstrapFirstOrg')) {
        bootstrapOrgForHuman(this.db, human, input.orgName);
      }
    }

    // Provider photo intake: refresh `provider_avatar_url` when the provider
    // supplied a photo and the human has no UPLOADED avatar (an uploaded avatar
    // always wins). A newly created human already stored it above; this covers a
    // returning human and a changed provider photo.
    const providerPhoto = input.avatarUrl?.trim();
    if (providerPhoto && !human.avatarAttachment && human.providerAvatarUrl !== providerPhoto) {
      this.db
        .update(humans)
        .set({ providerAvatarUrl: providerPhoto })
        .where(eq(humans.id, human.id))
        .run();
      human.providerAvatarUrl = providerPhoto;
    }

    const token = newSessionToken();
    const now = new Date();
    this.db
      .insert(userSessions)
      .values({
        id: newSessionId(),
        tokenHash: sha256Hex(token),
        humanId: human.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      })
      .run();
    void reply.header('set-cookie', serializeSessionCookie(token));
    return { user: toUser(human), token };
  }

  /** Resolve the request's session (cookie or bearer ses_) to its unexpired row. */
  sessionOf(request: FastifyRequest): UserSessionRow | undefined {
    const token = requestSessionToken(request);
    if (!token) return undefined;
    const session = this.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, sha256Hex(token)))
      .get();
    if (!session) return undefined;
    if (session.expiresAt <= new Date().toISOString()) {
      this.db.delete(userSessions).where(eq(userSessions.id, session.id)).run();
      return undefined;
    }
    return session;
  }

  /** The signed-in human for this request, or null (missing/expired/unknown). */
  sessionHuman(request: FastifyRequest): HumanRow | null {
    const session = this.sessionOf(request);
    if (!session) return null;
    return this.db.select().from(humans).where(eq(humans.id, session.humanId)).get() ?? null;
  }

  /** Like {@link sessionHuman} but throws `401` when absent. */
  requireSession(request: FastifyRequest): HumanRow {
    const human = this.sessionHuman(request);
    if (!human) throw unauthorized('Sign-in required');
    return human;
  }

  /** Delete the request's session (if any) and clear the cookie. */
  logout(request: FastifyRequest, reply: FastifyReply): boolean {
    const session = this.sessionOf(request);
    if (session) {
      this.db.delete(userSessions).where(eq(userSessions.id, session.id)).run();
    }
    void reply.header('set-cookie', clearSessionCookie());
    return session !== undefined;
  }

  /** Signup guard used by the password provider: duplicate email → 409. */
  assertEmailAvailable(email: string): void {
    if (this.humanByEmail(email)) {
      throw conflict('An account with this email already exists');
    }
  }
}
