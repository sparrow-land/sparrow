import { createContext, useContext, type ReactNode } from 'react';
import type { OrgRole } from '@sparrow/common-types';
import { useAuth, roleInOrg } from './auth.js';

/**
 * Org context for the workspace subtree (`/org/:orgId/...`). Every workspace
 * surface resolves the active org from the URL; `useOrg()` exposes its id, the
 * caller's role, and governance capability. Single-org sugar (no switcher, no
 * org chrome) is a rendering concern of the shell — this context is identical
 * whether the caller has one org or many.
 */
export interface OrgContextValue {
  orgId: string;
  role: OrgRole;
  /** Org owners/admins: org settings, approvals, governance. */
  isAdmin: boolean;
  /** The org's display name/slug from `GET /me/orgs` (best-effort). */
  name: string;
  slug: string;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within <OrgProvider>');
  return ctx;
}

/** Same as {@link useOrg} but returns null outside an org subtree. */
export function useOrgOrNull(): OrgContextValue | null {
  return useContext(OrgContext);
}

export function OrgProvider({
  orgId,
  fallback,
  children,
}: {
  orgId: string;
  /**
   * Identity to fall back on when `auth.orgs` hasn't listed this org yet — used
   * by scoped mode, whose org comes from `GET /orgs/resolve/:slug` and may
   * precede the `/me/orgs` list. Unscoped callers omit it (behaviour unchanged).
   */
  fallback?: { name: string; slug: string; role: OrgRole };
  children: ReactNode;
}) {
  const auth = useAuth();
  const entry = auth.orgs.find((o) => o.org.id === orgId);
  const role = roleInOrg(auth.orgs, orgId) ?? fallback?.role ?? 'member';
  const value: OrgContextValue = {
    orgId,
    role,
    isAdmin: role === 'owner' || role === 'admin',
    name: entry?.org.name ?? fallback?.name ?? '',
    slug: entry?.org.slug ?? fallback?.slug ?? '',
  };
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}
