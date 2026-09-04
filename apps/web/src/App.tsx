import { Routes, Route, Outlet, useParams, Navigate, useLocation, matchPath } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { OrgRole, OrgSummary } from '@sparrow/common-types';
import { AppShell } from './components/AppShell.js';
import { BareShell } from './components/BareShell.js';
import { Home } from './routes/Home.js';
import { Welcome } from './routes/Welcome.js';
import { OrgHome } from './routes/OrgHome.js';
import { Room } from './routes/Room.js';
import { RoomSettings } from './routes/RoomSettings.js';
import { AgentProfile } from './routes/AgentProfile.js';
import { OrgSettings } from './routes/OrgSettings.js';
import { MyApprovals } from './routes/MyApprovals.js';
import { MySettings } from './routes/MySettings.js';
import { Login } from './routes/Login.js';
import { Invite } from './routes/Invite.js';
import { NotFound } from './routes/NotFound.js';
import { NotMember } from './routes/NotMember.js';
import { DocsRedirect } from './routes/docs/DocsRedirect.js';
import { DOCS_ROOT } from './routes/docs/paths.js';
import { AuthProvider, useAuth } from './lib/auth.js';
import { ThemeProvider } from './lib/theme-provider.js';
import { CapabilitiesProvider } from './lib/capabilities.js';
import type { CapabilitiesResponse } from '@sparrow/common-types';
import { OrgProvider } from './lib/org.js';
import { WorkspaceProvider } from './lib/workspace.js';
import { getLastOrg, setLastOrg } from './lib/prefs.js';
import { wire, setScopedMode, activeRoomIdFromPath } from './lib/ids.js';
import { type Scope, activeOrgForScope } from './lib/scope.js';
import { api } from './lib/client.js';

/** Remount the room view whenever the roomId changes so state never bleeds. */
function KeyedRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  return <Room key={roomId ?? ''} />;
}

/**
 * The docs have ONE home — sparrow.land/docs — and this instance is not it
 * (SPEC: *Canonical public homes*). The route stays mounted in every auth state
 * and in both trees, but only to forward: `/docs` and everything under it hand
 * off to {@link DocsRedirect}, the SPA-side twin of the server's `302`. The
 * page sources still live in routes/docs/ — the marketing site pre-renders
 * them — they are simply not rendered here.
 */
const docsRoutes = <Route path={`${DOCS_ROOT}/*`} element={<DocsRedirect />} />;

/**
 * The workspace layout for one org (`/org/:orgId/...`, BARE ids): guards
 * membership, mounts the org + workspace providers around the app shell. The
 * URL carries bare ids; we restore the `org_`/`room_` prefixes here so the rest
 * of the app works in wire ids. The active room id (from the URL) is handed to
 * the workspace so its live streams prioritize it.
 */
function OrgLayout() {
  const { orgId: bareOrgId = '' } = useParams<{ orgId: string }>();
  const orgId = wire('org', bareOrgId);
  const auth = useAuth();
  const location = useLocation();
  const bareActiveRoom =
    matchPath('/org/:orgId/rooms/:roomId', location.pathname)?.params.roomId ??
    matchPath('/org/:orgId/rooms/:roomId/settings', location.pathname)?.params.roomId ??
    null;
  const activeRoomId = bareActiveRoom ? wire('room', bareActiveRoom) : null;

  useEffect(() => {
    if (auth.signedIn && orgId) setLastOrg(orgId);
  }, [auth.signedIn, orgId]);

  if (!auth.signedIn) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  // Not a member (or unknown org) → send home, which picks a valid org.
  if (!auth.orgs.some((o) => o.org.id === orgId)) return <Navigate to="/" replace />;

  return (
    <OrgProvider orgId={orgId}>
      <WorkspaceProvider activeRoomId={activeRoomId}>
        <AppShell />
      </WorkspaceProvider>
    </OrgProvider>
  );
}

/**
 * The workspace layout when the app is SCOPED to one org by slug (host
 * `<slug><suffix>` or a `/orgs/<slug>` path prefix). Behaviourally equivalent to
 * {@link OrgLayout}, but the org identity comes from `GET /orgs/resolve/:slug`
 * (not the URL): a signed-out visitor gets the normal login flow (and lands back
 * in the scope), a signed-in NON-member sees a clear "not a member" screen (no
 * redirect loop), and a member gets the full shell. Routes mount WITHOUT the
 * `/org/:orgId` prefix — react-router's basename already carries the scope.
 */
export function ScopedOrgLayout({ slug }: { slug: string }) {
  const auth = useAuth();
  const location = useLocation();
  const [resolved, setResolved] = useState<
    | { state: 'loading' }
    | { state: 'member'; org: OrgSummary; role: OrgRole }
    | { state: 'not-member' }
  >({ state: 'loading' });

  useEffect(() => {
    if (!auth.signedIn) return;
    let cancelled = false;
    setResolved({ state: 'loading' });
    api
      .resolveOrg(slug)
      .then((res) => {
        if (!cancelled) setResolved({ state: 'member', org: res.org, role: res.role });
      })
      .catch(() => {
        if (!cancelled) setResolved({ state: 'not-member' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, auth.signedIn]);

  // Don't decide sign-in state until the auth boot settles (it would flash a
  // login redirect for a signed-in user). AppRoutes already gates on this, but
  // guard here too so the layout is correct on its own.
  if (auth.booting) return null;
  if (!auth.signedIn) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (resolved.state === 'loading') return null;
  if (resolved.state === 'not-member') return <NotMember />;

  const activeRoomId = activeRoomIdFromPath(location.pathname);
  return (
    <OrgProvider
      orgId={resolved.org.id}
      fallback={{ name: resolved.org.name, slug: resolved.org.slug, role: resolved.role }}
    >
      <WorkspaceProvider activeRoomId={activeRoomId}>
        <AppShell />
      </WorkspaceProvider>
    </OrgProvider>
  );
}

/**
 * Chrome for the personal `/me/...` pages (approvals, settings). These surfaces are
 * cross-org, so they carry no `:orgId`; to wear the SAME app shell as the rest of
 * the signed-in app, we mount it against a default org (the last-active one, else
 * the first). A signed-out visitor — or a signed-in human who belongs to NO org
 * yet — has no org to hang the shell on. A signed-in human with no org still
 * gets the signed-in {@link BareShell} frame (identity + Sign out) around the
 * page; a signed-out visitor renders fully bare (each page shows its own sign-in
 * state through the {@link Outlet}).
 */
function MeLayout({ scope = null }: { scope?: Scope | null }) {
  const auth = useAuth();

  // The `/me/*` shell is cross-org, so it must pick a default org to hang on. On
  // an org-scoped host that default MUST follow the host (else the top nav shows
  // the wrong workspace); off a scoped host it keeps the last-active/first org.
  const defaultOrgId = activeOrgForScope(auth.orgs, scope, getLastOrg())?.org.id ?? null;

  if (!auth.signedIn) return <Outlet />;
  if (!defaultOrgId)
    return (
      <BareShell>
        <Outlet />
      </BareShell>
    );

  return (
    <OrgProvider orgId={defaultOrgId}>
      <WorkspaceProvider activeRoomId={null}>
        <AppShell />
      </WorkspaceProvider>
    </OrgProvider>
  );
}

/**
 * The org-scoped route tree: org surfaces mount at the ROOT of the scope (no
 * `/org/:orgId`), with `/login`, `/invite/:token`, and `/docs` still reachable
 * inside it. `ScopedOrgLayout` resolves the slug and guards membership.
 */
function ScopedRoutes({ scope }: { scope: Scope }) {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/invite/:token" element={<Invite />} />
      {docsRoutes}
      <Route element={<ScopedOrgLayout slug={scope.slug} />}>
        <Route index element={<OrgHome />} />
        <Route path="rooms/:roomId" element={<KeyedRoom />} />
        <Route path="rooms/:roomId/settings" element={<RoomSettings />} />
        <Route path="agents/:agentId" element={<AgentProfile />} />
        <Route path="admin" element={<OrgSettings />} />
      </Route>
      {/* Personal surfaces exist on scoped hosts too — in-app affordances
          (the pending pill) link to /me/*. The scope is threaded
          so the shell's default org follows the host, not the first membership. */}
      <Route path="/me" element={<MeLayout scope={scope} />}>
        <Route path="approvals" element={<MyApprovals />} />
        {/* v3's URL — every old link and bookmark lands on the unified page. */}
        <Route path="invites" element={<Navigate to="/me/approvals" replace />} />
        <Route path="settings" element={<MySettings />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function AppRoutes({ scope }: { scope: Scope | null }) {
  const auth = useAuth();

  // Scope is fixed for the page's lifetime (resolved by the boot bootstrap before
  // the app mounts); tell the path builders once, before any link renders, so
  // scoped links drop the `/org/:orgId` segment.
  setScopedMode(scope !== null);

  // While the boot sequence resolves (config → me → orgs), only the
  // auth-independent docs render; everything else stays blank for a beat.
  if (auth.booting) {
    return (
      <Routes>
        {docsRoutes}
        <Route path="*" element={null} />
      </Routes>
    );
  }

  // Scoped: the org UI mounts at the ROOT of the scope (a separate <Routes>).
  if (scope) return <ScopedRoutes scope={scope} />;

  // Unscoped (the classic multi-org tree). A bare <Routes> — SAME element type as
  // the booting branch above — so the boot transition reconciles rather than
  // remounting the shared docs/route subtree.
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/org/:orgId" element={<OrgLayout />}>
        <Route index element={<OrgHome />} />
        <Route path="rooms/:roomId" element={<KeyedRoom />} />
        <Route path="rooms/:roomId/settings" element={<RoomSettings />} />
        <Route path="agents/:agentId" element={<AgentProfile />} />
        <Route path="admin" element={<OrgSettings />} />
      </Route>
      <Route path="/me" element={<MeLayout />}>
        <Route path="approvals" element={<MyApprovals />} />
        {/* v3's URL — every old link and bookmark lands on the unified page. */}
        <Route path="invites" element={<Navigate to="/me/approvals" replace />} />
        <Route path="settings" element={<MySettings />} />
      </Route>
      <Route path="/login" element={<Login />} />
      <Route path="/invite/:token" element={<Invite />} />
      {docsRoutes}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * The app root. `scope` (org-scoped by host/path, or null = unscoped) and any
 * pre-fetched `capabilities` are resolved by the boot bootstrap (main.tsx) and
 * passed in; tests render `<App />` bare, which is the classic unscoped app.
 */
export function App({
  scope = null,
  capabilities,
}: {
  scope?: Scope | null;
  capabilities?: CapabilitiesResponse;
}) {
  return (
    <div className="min-h-full">
      <AuthProvider>
        <ThemeProvider>
          <CapabilitiesProvider initial={capabilities}>
            <AppRoutes scope={scope} />
          </CapabilitiesProvider>
        </ThemeProvider>
      </AuthProvider>
    </div>
  );
}
