/**
 * Google SSO `AuthProvider` (open core): the standard OAuth 2.0
 * authorization-code flow against Google, minting instance sessions via
 * `ctx.auth.loginOrCreateUser` (which enforces the signup policy).
 *
 * v5: this lives in open core. It self-registers when BOTH `GOOGLE_CLIENT_ID`
 * and `GOOGLE_CLIENT_SECRET` env vars are set (see `buildServer`). Credentials
 * are operator env vars only — never instance config, never visible in
 * `/config`.
 *
 * Routes registered:
 * - `GET /api/v1/auth/google` — 302 to Google's consent screen; a random
 *   state token rides in the URL *and* a short-lived httpOnly cookie.
 * - `GET /api/v1/auth/google/callback` — verifies state vs cookie (401 on
 *   mismatch), exchanges the code (form-encoded POST), decodes the id_token
 *   payload (it arrives over TLS directly from the token endpoint, so no
 *   signature check is needed), requires `email_verified`, then logs in.
 *
 * Endpoints are constructor-injectable so tests can point them at a fake.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { AuthCtx, AuthProvider } from './auth.js';
import { parseCookies } from './auth.js';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Short-lived (10 min) httpOnly cookie holding the OAuth state token. */
export const STATE_COOKIE = 'sparrow_google_state';
const STATE_TTL_SECONDS = 10 * 60;

export interface GoogleAuthProviderOptions {
  /**
   * OAuth client ID. Falls back to env `GOOGLE_CLIENT_ID`. This is an
   * operator credential — it is NEVER instance-configurable via `/config`.
   */
  clientId?: string;
  /**
   * OAuth client secret. Falls back to env `GOOGLE_CLIENT_SECRET`. This is an
   * operator credential — it is NEVER instance-configurable via `/config`.
   */
  clientSecret?: string;
  /** Consent-screen URL (tests point this at a fake). */
  authorizationEndpoint?: string;
  /** Code-exchange URL (tests point this at a fake). */
  tokenEndpoint?: string;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

interface StatePayload {
  /** Random token; must equal the state cookie's value. */
  t: string;
  /** Post-login redirect target (always a same-origin path). */
  next: string;
}

const encodeState = (p: StatePayload): string =>
  Buffer.from(JSON.stringify(p)).toString('base64url');

function decodeState(raw: string | undefined): StatePayload | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as StatePayload).t === 'string' &&
      typeof (parsed as StatePayload).next === 'string'
    ) {
      return parsed as StatePayload;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Only same-origin paths survive; anything else falls back to `/`. */
const safeNext = (next: unknown): string =>
  typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
    ? next
    : '/';

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/** Decode a JWT's payload segment without verifying the signature. */
function decodeJwtPayload(idToken: string): Record<string, unknown> | undefined {
  const segment = idToken.split('.')[1];
  if (!segment) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal browser-facing error page (the callback is a navigation). */
function sendErrorPage(reply: FastifyReply, status: number, message: string): FastifyReply {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>Sign-in failed</title>` +
        `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1 style="font-size:1.25rem">Sign-in failed</h1>` +
        `<p>${escaped}</p><p><a href="/">Back to sparrow</a></p></body>`,
    );
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

/**
 * True iff both Google operator credentials are present (options first, else
 * env). Drives self-registration in `buildServer`.
 */
export function googleCredentialsPresent(
  options: GoogleAuthProviderOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = (options.clientId ?? env.GOOGLE_CLIENT_ID ?? '').trim();
  const secret = (options.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? '').trim();
  return id.length > 0 && secret.length > 0;
}

export function googleAuthProvider(
  options: GoogleAuthProviderOptions = {},
): AuthProvider {
  const authorizationEndpoint = options.authorizationEndpoint ?? GOOGLE_AUTH_ENDPOINT;
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;

  return {
    id: 'google',
    label: 'Google',
    kind: 'oauth-redirect',

    // The login-start URL IS host-aware: it rides the effective origin so a
    // "Sign in with Google" button on an org subdomain begins the flow on that
    // host. (The redirect_uri below is deliberately NOT host-aware — see there.)
    loginUrl: (origin) => `${stripTrailingSlash(origin)}/api/v1/auth/google`,

    register(app, ctx: AuthCtx): void {
      // redirect_uri stays anchored to the static BASE_URL, NOT the request host:
      // a self-hoster registers exactly ONE callback with Google, and Google
      // forbids wildcard redirect URIs, so every org subdomain must complete the
      // code exchange on the same registered apex callback. (Cross-host session
      // relay for SSO on subdomains is a separate, later concern.)
      const redirectUri = `${stripTrailingSlash(ctx.baseUrl)}/api/v1/auth/google/callback`;
      // Operator credentials only: constructor options, else env vars. These
      // are never sourced from the instance config store (not admin-editable).
      const credentials = (): { clientId: string; clientSecret: string } => ({
        clientId: options.clientId ?? process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: options.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? '',
      });

      app.get<{ Querystring: { next?: string } }>(
        '/api/v1/auth/google',
        (request, reply) => {
          const { clientId } = credentials();
          if (!clientId) {
            return sendErrorPage(
              reply,
              500,
              'Google sign-in is not configured on this instance (missing client ID).',
            );
          }
          const token = randomBytes(16).toString('hex');
          const state = encodeState({ t: token, next: safeNext(request.query.next) });
          const url = new URL(authorizationEndpoint);
          url.searchParams.set('client_id', clientId);
          url.searchParams.set('redirect_uri', redirectUri);
          url.searchParams.set('response_type', 'code');
          url.searchParams.set('scope', 'openid email profile');
          url.searchParams.set('state', state);
          void reply.header(
            'set-cookie',
            `${STATE_COOKIE}=${token}; Path=/; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; SameSite=Lax`,
          );
          return reply.redirect(url.toString(), 302);
        },
      );

      app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
        '/api/v1/auth/google/callback',
        async (request, reply) => {
          // The state cookie is single-use: clear it whatever happens next.
          void reply.header(
            'set-cookie',
            `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
          );

          const state = decodeState(request.query.state);
          const cookieToken = parseCookies(request.headers.cookie)[STATE_COOKIE];
          if (!state || !cookieToken || state.t !== cookieToken) {
            return sendErrorPage(
              reply,
              401,
              'Sign-in state did not match — please try signing in again.',
            );
          }
          if (request.query.error) {
            return sendErrorPage(reply, 401, `Google returned: ${request.query.error}`);
          }
          if (!request.query.code) {
            return sendErrorPage(reply, 400, 'Missing authorization code.');
          }

          const { clientId, clientSecret } = credentials();
          let idToken: string | undefined;
          try {
            const res = await fetch(tokenEndpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                code: request.query.code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
              }).toString(),
            });
            if (res.ok) {
              const body = (await res.json()) as { id_token?: string };
              idToken = body.id_token;
            }
          } catch {
            /* network failure -> handled below */
          }
          const claims = (idToken ? decodeJwtPayload(idToken) : undefined) ?? {};
          const email = typeof claims.email === 'string' ? claims.email : undefined;
          if (!email) {
            return sendErrorPage(
              reply,
              502,
              'Could not complete the Google sign-in (code exchange failed).',
            );
          }
          if (claims.email_verified !== true && claims.email_verified !== 'true') {
            return sendErrorPage(
              reply,
              403,
              'Your Google account email address is not verified.',
            );
          }

          try {
            ctx.auth.loginOrCreateUser(
              {
                email,
                displayName: typeof claims.name === 'string' ? claims.name : undefined,
                provider: 'google',
                // The OpenID `picture` claim (profile scope) is the person's
                // provider avatar; stored unless they have an uploaded one.
                avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
              },
              reply,
            );
          } catch (err) {
            // Signup policy rejection (allowSignup / allowedEmailPatterns).
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 403) {
              return sendErrorPage(reply, 403, (err as Error).message);
            }
            throw err;
          }
          return reply.redirect(state.next, 302);
        },
      );
    },
  };
}
