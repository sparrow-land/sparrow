/**
 * Request-host-aware absolute origin ("effective origin").
 *
 * Every user-facing absolute URL the server builds (invite URLs, onboarding
 * surfaces, provider login buttons) is anchored to an origin. By default that
 * origin is the operator's static `BASE_URL`. But when a fronting edge maps an
 * org subdomain (`<slug><ORG_HOST_SUFFIX>`, e.g. `acme.example.com`) onto this
 * instance, links built from `BASE_URL` would send the user back to the apex
 * host and drop the org scope. The effective origin fixes that: for a request
 * whose Host is a valid, non-reserved org-slug subdomain of `ORG_HOST_SUFFIX`,
 * the origin becomes `<BASE_URL scheme>://<request Host>` — so the links keep
 * the org's host. This mirrors the SPA-side host-scope detection in
 * `apps/web/src/lib/scope.ts` (same suffix match, same slug validation, port
 * included).
 *
 * The API itself stays canonical (org-id-in-URL) and never routes by Host; this
 * only affects the absolute URLs rendered back to users.
 */
import { OrgSlugSchema, isReservedSlug } from '@sparrow/common-types';
import type { ServerConfig } from './context.js';

/** Strip trailing slashes so `${origin}/path` never doubles up. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The URL scheme (`http`/`https`) of `url`, defaulting to `http`. */
function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  return m ? m[1]!.toLowerCase() : 'http';
}

/**
 * A slug usable as a host scope: shape-valid (`OrgSlugSchema`) and not a
 * reserved label (`RESERVED_SLUGS`). Same rule the SPA applies in scope.ts.
 */
function isValidScopeSlug(slug: string): boolean {
  return OrgSlugSchema.safeParse(slug).success && !isReservedSlug(slug);
}

/**
 * The absolute origin to anchor user-facing links to for this request.
 *
 * When `config.orgHostSuffix` is set AND the request Host equals
 * `<slug><suffix>` for a valid, non-reserved org slug (suffix match includes the
 * port, matching scope.ts), returns `<config.baseUrl scheme>://<request Host>`.
 * Otherwise returns `config.baseUrl` with any trailing slash stripped.
 */
export function effectiveOrigin(
  request: { headers: { host?: string } },
  config: Pick<ServerConfig, 'baseUrl' | 'orgHostSuffix'>,
): string {
  const base = stripTrailingSlash(config.baseUrl);
  const suffix = config.orgHostSuffix;
  const host = request.headers.host;
  if (suffix && host && host.endsWith(suffix)) {
    const slug = host.slice(0, host.length - suffix.length);
    if (isValidScopeSlug(slug)) {
      return `${schemeOf(config.baseUrl)}://${host}`;
    }
  }
  return base;
}
