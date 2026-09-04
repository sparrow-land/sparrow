import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@sparrow/client';
import { useAuth } from '../lib/auth.js';
import { useAutoSso } from '../lib/auto-sso.js';
import { api } from '../lib/client.js';
import { Logo } from '../components/Logo.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { MAIN_CONTENT_ID } from '../components/SkipLink.js';
import { SiteFooter } from '../components/SiteFooter.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/* ------------------------------------------------------------------ *
 * Validation copy
 * ------------------------------------------------------------------ */

/** Field names the API validates, in the words a person would use. */
const FIELD_LABEL: Record<string, string> = {
  password: 'Password',
  email: 'Email',
  displayName: 'Display name',
};

/** `displayName` → "Display name"; an unknown field → "Nickname". */
function fieldLabel(field: string): string {
  const known = FIELD_LABEL[field];
  if (known) return known;
  const spaced = field.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Turn the API's verbatim validation text into something a human wrote.
 *
 * `apps/api/src/validate.ts` renders a failed zod parse as `"<path>: <zod
 * message>"`, so a short password arrives at the browser as
 * `password: String must contain at least 8 character(s)` — machine grammar,
 * parenthesised plural and all, on the most-hit error path in the product.
 * We rewrite only shapes we RECOGNISE; anything else (a `forbidden`, a bad
 * password, a server's own sentence) is passed through untouched, because a
 * message we don't understand is exactly the one a person must still see.
 */
export function humanizeAuthError(raw: string): string {
  const message = raw.trim();

  const length = /^(\w+): String must contain at (least|most) (\d+) character\(s\)$/.exec(message);
  if (length) {
    const field = length[1] ?? '';
    const bound = length[2] ?? 'least';
    const n = Number(length[3] ?? 0);
    return `${fieldLabel(field)} must be at ${bound} ${n} ${n === 1 ? 'character' : 'characters'}.`;
  }

  if (/^email: Invalid email$/.test(message)) return 'Enter a valid email address.';

  return raw;
}

/**
 * The Login page (`/login`). v3: a normal route, NOT an app-wide wall — the
 * site chrome renders around it. Signing in (or up) here redirects to `?next=`
 * (default `/`), so an invitee sent to `/login?next=/invite/:token` lands back
 * on the invite landing page.
 *
 * Renders a credentials form when a `credentials` provider is active (plus a
 * sign-up variant when the instance allows signup), and one
 * "Continue with {label}" button per `oauth-redirect` provider (navigating to
 * its loginUrl with `?next=` preserved). `api.login`/`api.signup` each return
 * `{ user, token }`; we hand the user to `auth.completeSignIn`.
 *
 * Sign-in vs sign-up is a URL state (`?view=signup`), so the create-account form
 * is linkable — the invite page sends first-time invitees straight to it.
 */
export function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const credentials = auth.providers.find((p) => p.kind === 'credentials');
  const oauth = auth.providers.filter((p) => p.kind === 'oauth-redirect');
  const canSignup = Boolean(credentials) && auth.allowSignup;
  // This account would FOUND the instance's workspace, so the form asks what to
  // call it. Only here: on every other instance the workspace already exists, and
  // an "orgName" typed into a later signup would be silently dropped.
  const founding = auth.bootstrapOrg;

  // The view lives in the URL (`?view=signup`), not in component state: an
  // invite CTA — or anyone's shared link — can point a first-time visitor
  // straight at "Create your account" instead of dropping them on a sign-in
  // form with a small "New here?" toggle underneath.
  const view: 'login' | 'signup' = searchParams.get('view') === 'signup' ? 'signup' : 'login';
  useDocumentTitle(pageTitle(view === 'signup' ? 'Create your account' : 'Sign in'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = searchParams.get('next') || '/';
  // An invitee sent here from the invite landing page (`/invite/:token`) gets a
  // hint tying the sign-in back to the invitation they were following.
  const invited = next.startsWith('/invite/');

  /** Flip the view by rewriting the URL — every other param (`next`) rides along. */
  function showView(nextView: 'login' | 'signup') {
    const params = new URLSearchParams(searchParams);
    if (nextView === 'signup') params.set('view', 'signup');
    else params.delete('view');
    setError(null);
    setSearchParams(params, { replace: true });
  }

  // Toggling the view swaps the whole form with no route change and no live
  // region, so a screen reader is told nothing. Move focus to the heading (which
  // names the new view) — but only on a real flip: stealing focus on mount would
  // pull it off the email field the form auto-focuses.
  // Comparing the view we last rendered (rather than a "have I mounted" flag)
  // also keeps StrictMode's double-invoked mount effect from grabbing focus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownView = useRef<'login' | 'signup' | null>(null);
  useEffect(() => {
    if (shownView.current !== null && shownView.current !== view) headingRef.current?.focus();
    shownView.current = view;
  }, [view]);

  // Managed tenants mark one oauth-redirect provider as `primary`: an
  // unauthenticated visitor bounces silently through it (carrying `next`) and
  // returns signed in — zero clicks when an IdP session exists. If they come
  // back still unauthenticated the loop-guard is set, so the full provider
  // buttons render as a fallback. Guard key is distinct from the invite flow.
  const autoRedirecting = useAutoSso({ guardKey: 'sparrow.login.sso', next });

  function oauthUrl(loginUrl: string): string {
    const sep = loginUrl.includes('?') ? '&' : '?';
    return `${loginUrl}${sep}next=${encodeURIComponent(next)}`;
  }

  // Already signed in (or just landed back here) → straight to the target.
  if (auth.signedIn) return <Navigate to={next} replace />;

  // Bouncing through the primary IdP now — a quiet interstitial, no form flash.
  if (autoRedirecting) {
    return (
      <div className="flex min-h-full flex-col">
        <SiteHeader />
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="flex flex-1 items-start justify-center px-4 py-16 sm:py-24 outline-none"
        >
          <div className="w-full max-w-sm text-center">
            <div className="flex justify-center">
              <Logo size={28} />
            </div>
            <p className="mt-5 text-sm text-[var(--sparrow-muted)]">Taking you to sign in…</p>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        view === 'signup'
          ? await api.signup({
              email: email.trim(),
              password,
              displayName: displayName.trim() || undefined,
              // Blank (or an instance that is not bootstrapping) sends nothing, and
              // the server falls back to "{displayName}'s org" exactly as before.
              orgName: (founding && orgName.trim()) || undefined,
            })
          : await api.login({ email: email.trim(), password });
      await auth.completeSignIn(res.user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? humanizeAuthError(err.message)
          : view === 'signup'
            ? 'Could not create the account'
            : 'Could not sign in',
      );
      setBusy(false);
    }
  }

  const inputClass =
    'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="flex flex-1 items-start justify-center px-4 py-16 sm:py-24 outline-none"
        >
        <div className="w-full max-w-sm">
          <div className="flex justify-center">
            <Logo size={28} />
          </div>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mt-5 text-center text-xl font-semibold tracking-tight outline-none"
          >
            {view === 'signup' ? 'Create your account' : 'Sign in'}
          </h1>
          <p className="mt-1.5 text-center text-sm text-[var(--sparrow-muted)]">
            {view === 'signup'
              ? invited
                ? 'You were invited — create your account to continue.'
                : 'Create an account to sync your rooms across browsers.'
              : invited
                ? 'You were invited — sign in to continue.'
                : 'Sign in to sync your rooms across browsers.'}
          </p>

          <div className="mt-6 rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
            {credentials && (
              <form onSubmit={onSubmit} className="flex flex-col gap-3">
                {view === 'signup' && (
                  <div>
                    <label
                      htmlFor="login-name"
                      className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
                    >
                      Display name
                    </label>
                    <input
                      id="login-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="e.g. Jake"
                      autoComplete="name"
                      className={inputClass}
                    />
                  </div>
                )}
                {view === 'signup' && founding && (
                  <div>
                    <label
                      htmlFor="login-org-name"
                      className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
                    >
                      Workspace name
                    </label>
                    <input
                      id="login-org-name"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      placeholder="e.g. Acme Robotics"
                      autoComplete="organization"
                      aria-describedby="login-org-name-hint"
                      className={inputClass}
                    />
                    <p id="login-org-name-hint" className="mt-1 text-xs text-[var(--sparrow-faint)]">
                      You are the first person here, so this account founds the workspace. Optional
                      — leave it blank and we will name it after you; you can rename it later.
                    </p>
                  </div>
                )}
                <div>
                  <label
                    htmlFor="login-email"
                    className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
                  >
                    Email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus
                    className={`mono ${inputClass}`}
                  />
                </div>
                <div>
                  <label
                    htmlFor="login-password"
                    className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
                  >
                    Password
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={view === 'signup' ? 'At least 8 characters' : '••••••••'}
                    autoComplete={view === 'signup' ? 'new-password' : 'current-password'}
                    className={`mono ${inputClass}`}
                  />
                </div>
                {error && <p className="text-sm text-[var(--sparrow-danger)]">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !email.trim() || !password}
                  className="mt-1 rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy
                    ? view === 'signup'
                      ? 'Creating account…'
                      : 'Signing in…'
                    : view === 'signup'
                      ? 'Create account'
                      : 'Sign in'}
                </button>
              </form>
            )}

            {credentials && oauth.length > 0 && (
              <div className="my-4 flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-[var(--sparrow-border)]" />
                <span className="text-xs uppercase tracking-wider text-[var(--sparrow-faint)]">or</span>
                <span className="h-px flex-1 bg-[var(--sparrow-border)]" />
              </div>
            )}

            {oauth.length > 0 && (
              <div className={`flex flex-col gap-2 ${credentials ? '' : 'mt-0'}`}>
                {oauth.map((p) => (
                  <a
                    key={p.id}
                    href={p.loginUrl ? oauthUrl(p.loginUrl) : '#'}
                    className="block rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] px-4 py-2.5 text-center text-sm font-medium text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-accent)]"
                  >
                    Continue with {p.label}
                  </a>
                ))}
              </div>
            )}

            {!credentials && oauth.length === 0 && (
              <p className="text-sm text-[var(--sparrow-muted)]">
                No sign-in method is configured on this instance. Contact your operator.
              </p>
            )}
          </div>

          {canSignup && (
            <p className="mt-4 text-center text-sm text-[var(--sparrow-muted)]">
              {view === 'signup' ? (
                <>
                  Already have an account?{' '}
                  <button
                    onClick={() => showView('login')}
                    className="text-[var(--sparrow-accent)] hover:underline"
                  >
                    Sign in
                  </button>
                </>
              ) : (
                <>
                  New here?{' '}
                  <button
                    onClick={() => showView('signup')}
                    className="text-[var(--sparrow-accent)] hover:underline"
                  >
                    Create an account
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
