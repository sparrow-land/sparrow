import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '@sparrow/client';
import type { AuthProviderInfo, MeOrg, OrgRole, User } from '@sparrow/common-types';
import { api } from './client.js';

/**
 * Instance auth (v3). Accounts are always on and session-only — there are NO
 * guests. At boot the app fetches `GET /auth/config` (providers + allowSignup),
 * then `GET /auth/me`, which answers an anonymous visitor `200 { user: null }`
 * — signed-out is the ANSWER, so the expected outcome of every public page load
 * costs neither a console line nor a red entry in the browser's network log. An
 * older server answers the same question with `401`; that is still swallowed
 * silently, and a `401` from a CURRENT server means a dead credential, which
 * boots signed-out just the same. A signed-in human's orgs come from
 * `GET /me/orgs` — they drive the org switcher and `/` → org redirect.
 *
 * The only auth axis is `signedIn = user !== null`. Every workspace surface
 * requires sign-in; a signed-out visitor is sent to `/login`.
 */
export interface AuthState {
  /** True until the boot sequence (config → me → orgs) resolves. */
  booting: boolean;
  /** Convenience: `user !== null`. */
  signedIn: boolean;
  /** Login providers from `GET /auth/config`. */
  providers: AuthProviderInfo[];
  allowSignup: boolean;
  /**
   * The next signup would FOUND this instance's first workspace (`GET /auth/config`
   * → `bootstrapOrg`). The sign-up form offers a "Workspace name" field on exactly
   * these instances; everywhere else the founding has already happened and there
   * is nothing to name. Absent on an older server → `false`.
   */
  bootstrapOrg: boolean;
  /** The signed-in user, or null. */
  user: User | null;
  /** The caller's orgs with per-org roles (`GET /me/orgs`); [] when signed out. */
  orgs: MeOrg[];
  /** Complete a sign-in: fetch the org list, then expose the user. */
  completeSignIn(user: User): Promise<void>;
  /** Replace the signed-in user (e.g. optimistic display-name update). */
  updateUser(user: User): void;
  /** Drop the local session view (e.g. after a 401 mid-flight). */
  sessionExpired(): void;
  /** `POST /auth/logout`, then drop local state. */
  signOut(): Promise<void>;
  /** Re-derive the org list from the server (e.g. after joining one). */
  refreshOrgs(): Promise<MeOrg[]>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** The caller's role in one org, or null when not a member. */
export function roleInOrg(orgs: MeOrg[], orgId: string): OrgRole | null {
  return orgs.find((o) => o.org.id === orgId)?.role ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [booted, setBooted] = useState(false);
  const [providers, setProviders] = useState<AuthProviderInfo[]>([]);
  const [allowSignup, setAllowSignup] = useState(false);
  const [bootstrapOrg, setBootstrapOrg] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<MeOrg[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let bootProviders: AuthProviderInfo[] = [];
      let bootAllowSignup = false;
      let bootBootstrapOrg = false;
      let bootUser: User | null = null;
      let bootOrgs: MeOrg[] = [];
      try {
        const config = await api.authConfig();
        bootProviders = config.providers;
        bootAllowSignup = config.allowSignup;
        bootBootstrapOrg = config.bootstrapOrg === true;
      } catch {
        // No /auth/config (unreachable) — carry on signed-out.
      }
      try {
        // `null` = nobody is signed in. Skip `/me/orgs` in that case: there is
        // no list to fetch, and asking would only earn a second pointless 401.
        bootUser = await api.authMe();
        if (bootUser) bootOrgs = await api.meOrgs().catch(() => []);
      } catch (err) {
        // A `401` here is still a legitimate answer — an older server says
        // "signed out" that way, and a current one says "the credential you
        // sent is dead". Either way the app boots signed-out, quietly.
        // A server that answered with something else (5xx, a broken proxy) IS a
        // fault worth a console line. A transport error is not: an unreachable
        // server is already handled by booting signed-out, exactly as the
        // `/auth/config` fetch above does.
        bootUser = null;
        if (err instanceof ApiError && err.status !== 401) {
          console.error('sparrow: could not resolve the signed-in user', err);
        }
      }
      if (cancelled) return;
      setProviders(bootProviders);
      setAllowSignup(bootAllowSignup);
      setBootstrapOrg(bootBootstrapOrg);
      setUser(bootUser);
      setOrgs(bootOrgs);
      setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshOrgs = useCallback(async (): Promise<MeOrg[]> => {
    try {
      const next = await api.meOrgs();
      setOrgs(next);
      return next;
    } catch {
      return [];
    }
  }, []);

  const completeSignIn = useCallback(async (nextUser: User) => {
    const nextOrgs = await api.meOrgs().catch(() => [] as MeOrg[]);
    setOrgs(nextOrgs);
    setUser(nextUser);
  }, []);

  const updateUser = useCallback((nextUser: User) => setUser(nextUser), []);

  const sessionExpired = useCallback(() => {
    api.setToken(undefined);
    setUser(null);
    setOrgs([]);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Session already dead server-side — dropping it locally is enough.
    }
    setUser(null);
    setOrgs([]);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      booting: !booted,
      signedIn: user !== null,
      providers,
      allowSignup,
      bootstrapOrg,
      user,
      orgs,
      completeSignIn,
      updateUser,
      sessionExpired,
      signOut,
      refreshOrgs,
    }),
    [booted, providers, allowSignup, bootstrapOrg, user, orgs, completeSignIn, updateUser, sessionExpired, signOut, refreshOrgs],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
