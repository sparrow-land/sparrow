/**
 * Org scoping detection (the managed-hosting seam's SPA half). A workspace can be
 * reached two equivalent ways, both naming an org by SLUG rather than by
 * `/org/:orgId`:
 *
 * - **Path scope** (always available): a URL path beginning `/orgs/<slug>` — the
 *   API already serves the SPA for these paths. basename is `/orgs/<slug>`, so
 *   org routes mount at the root within it. Detectable synchronously.
 * - **Host scope**: the whole host is the org — `window.location.host` equals
 *   `<slug><suffix>` for the advertised `ORG_HOST_SUFFIX` (from `GET
 *   /capabilities`). basename is `/`. Needs the suffix, so it resolves once
 *   capabilities load.
 *
 * In both cases the SPA resolves `slug → org` via `GET /orgs/resolve/:slug` and
 * mounts the org UI WITHOUT the `/org/:orgId` prefix. When neither matches the
 * app is UNSCOPED — the classic `/org/:orgId/…` multi-org experience, unchanged.
 */
import { ORG_SLUG_MAX, isReservedSlug, type MeOrg } from '@sparrow/common-types';

const SLUG_RE = /^[a-z0-9-]+$/;

/** A slug usable as an org scope: shape-valid and not a reserved label. */
function validScopeSlug(slug: string): boolean {
  return (
    slug.length >= 1 &&
    slug.length <= ORG_SLUG_MAX &&
    SLUG_RE.test(slug) &&
    !isReservedSlug(slug)
  );
}

export interface Scope {
  slug: string;
  mode: 'path' | 'host';
  /** The react-router basename this scope mounts under. */
  basename: string;
}

/**
 * Path scope from a pathname: `/orgs/<slug>` or `/orgs/<slug>/…`. basename is
 * `/orgs/<slug>`. Returns null when the path is not a `/orgs/<valid-slug>` path
 * (including a bare `/orgs`, or a reserved/invalid slug).
 */
export function detectPathScope(pathname: string): Scope | null {
  const m = /^\/orgs\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  if (!validScopeSlug(slug)) return null;
  return { slug, mode: 'path', basename: `/orgs/${slug}` };
}

/**
 * Host scope from the current host + the advertised suffix. Matches the FULL
 * host including port (dev uses `.localhost:8722`; browsers resolve `*.localhost`
 * to loopback). basename is `/`. Returns null when the suffix is unconfigured or
 * the host is not `<valid-slug><suffix>`.
 */
export function detectHostScope(
  host: string,
  orgHostSuffix: string | null | undefined,
): Scope | null {
  if (!orgHostSuffix) return null;
  if (!host.endsWith(orgHostSuffix)) return null;
  const slug = host.slice(0, host.length - orgHostSuffix.length);
  if (!validScopeSlug(slug)) return null;
  return { slug, mode: 'host', basename: '/' };
}

/**
 * The effective scope for a page. Path scope wins (synchronous); otherwise host
 * scope from the advertised suffix. Null = unscoped.
 */
export function detectScope(
  location: { pathname: string; host: string },
  orgHostSuffix: string | null | undefined,
): Scope | null {
  return (
    detectPathScope(location.pathname) ?? detectHostScope(location.host, orgHostSuffix)
  );
}

/**
 * The active org for a cross-org shell (`/me/*`, `/`) that must follow the host.
 *
 * On an org-scoped page (`scope` non-null — a `<slug><suffix>` host or a
 * `/orgs/<slug>` path), the active org MUST be the membership whose slug matches
 * the scope — never the first/last-active membership. This is the fix for the
 * multi-org host bug where, on `sightsinging.<suffix>`, the shell showed the
 * caller's first org ("Meteor") instead of the org named by the host.
 *
 * Off a scoped page (apex/dev — `scope` null), OR when the scoped slug names no
 * membership (a non-member on a foreign host: no crash, just a sensible default),
 * fall back to the existing selection: the last-active org, else the first.
 * Returns `null` only when the caller belongs to no org at all.
 */
export function activeOrgForScope(
  orgs: MeOrg[],
  scope: Scope | null,
  lastOrgId: string | null,
): MeOrg | null {
  if (scope) {
    const bySlug = orgs.find((o) => o.org.slug === scope.slug);
    if (bySlug) return bySlug;
  }
  const byLast = lastOrgId ? orgs.find((o) => o.org.id === lastOrgId) : undefined;
  return byLast ?? orgs[0] ?? null;
}
