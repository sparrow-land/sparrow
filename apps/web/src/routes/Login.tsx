import { useEffect, useRef } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';
import { useAutoSso } from '../lib/auto-sso.js';
import { AuthForm } from '../components/AuthForm.js';
import { Logo } from '../components/Logo.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { MAIN_CONTENT_ID } from '../components/SkipLink.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/**
 * The API's validation text, in a human's words. Lives with the form it belongs
 * to ({@link AuthForm}); re-exported here because this page is where it was
 * born and where its tests still address it.
 */
export { humanizeAuthError } from '../components/AuthForm.js';

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

  const next = searchParams.get('next') || '/';
  // An invitee sent here from the invite landing page (`/invite/:token`) gets a
  // hint tying the sign-in back to the invitation they were following.
  const invited = next.startsWith('/invite/');

  /** Flip the view by rewriting the URL — every other param (`next`) rides along. */
  function showView(nextView: 'login' | 'signup') {
    const params = new URLSearchParams(searchParams);
    if (nextView === 'signup') params.set('view', 'signup');
    else params.delete('view');
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
      </div>
    );
  }

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
              <AuthForm
                view={view}
                founding={founding}
                onDone={() => navigate(next, { replace: true })}
              />
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
    </div>
  );
}
