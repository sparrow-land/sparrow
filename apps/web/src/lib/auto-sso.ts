import { useEffect } from 'react';
import type { AuthProviderInfo } from '@sparrow/common-types';
import { useAuth } from './auth.js';

/**
 * Shared auto-SSO behavior for the invite and login landing pages.
 *
 * A managed tenant marks one oauth-redirect provider as `primary`. An
 * unauthenticated visitor almost always already has a session with that upstream
 * identity provider, so we bounce them through it silently instead of making them
 * click "sign in" — they return authenticated, ready to continue.
 *
 * A per-scope sessionStorage marker guards against a redirect loop: if the SSO
 * round-trip returns still-unauthenticated (cancelled/failed), the marker is
 * already set, so the page falls back to the normal sign-in surface instead of
 * bouncing again. Each caller passes a distinct `guardKey` (e.g. the invite
 * token vs. the login page) so the two flows never share a marker.
 */

/** The primary oauth-redirect provider (with a loginUrl), if the instance has one. */
export function primaryOauthProvider(
  providers: AuthProviderInfo[],
): AuthProviderInfo | undefined {
  return providers.find((p) => p.kind === 'oauth-redirect' && p.primary && Boolean(p.loginUrl));
}

/**
 * When the viewer is unauthenticated, a primary oauth-redirect provider exists,
 * and this scope's loop-guard is unset, navigate to the provider's loginUrl
 * carrying `next`. Returns whether an auto-redirect is (about to be) performed so
 * the caller can render a quiet "taking you to sign in" state instead of its
 * normal content.
 */
export function useAutoSso(opts: { guardKey: string; next: string }): boolean {
  const { guardKey, next } = opts;
  const auth = useAuth();
  const primary = primaryOauthProvider(auth.providers);
  const alreadyTried =
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem(guardKey) !== null;
  const willAutoRedirect =
    !auth.booting && !auth.signedIn && Boolean(primary?.loginUrl) && !alreadyTried;

  useEffect(() => {
    if (!willAutoRedirect) return;
    const loginUrl = primary?.loginUrl;
    if (!loginUrl) return;
    try {
      sessionStorage.setItem(guardKey, '1');
    } catch {
      /* storage unavailable (private mode) — still redirect, just no loop guard */
    }
    const sep = loginUrl.includes('?') ? '&' : '?';
    window.location.assign(`${loginUrl}${sep}next=${encodeURIComponent(next)}`);
  }, [willAutoRedirect, primary, guardKey, next]);

  return willAutoRedirect;
}
