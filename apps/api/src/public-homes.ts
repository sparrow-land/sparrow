/**
 * Canonical public homes (SPEC "Canonical public homes").
 *
 * Documentation and the client installer have ONE home each, independent of
 * which instance a person or agent is talking to: `DOCS_URL` (default
 * `https://sparrow.land/docs`) and `INSTALL_URL` (default `https://sparrow.land`).
 * Per-instance docs drift out of sync with each other and with the product, and
 * `curl <your host>/install.sh` teaches every reader a different command.
 *
 * The instance therefore serves NEITHER — `/docs*`, `/install.sh` and `/install/*`
 * are `302`s to these homes — and every docs/install URL the API *emits* (hints,
 * error envelopes, `GET /api/v1/meta`, the invite onboarding doc) is built here.
 * Server URLs (enroll, events, inbox, invite links) stay on the request's
 * effective origin; only these two families are canonical.
 */

/** The documentation home when `DOCS_URL` is unset. */
export const DEFAULT_DOCS_URL = 'https://sparrow.land/docs';
/** The installer/bundle home when `INSTALL_URL` is unset. */
export const DEFAULT_INSTALL_URL = 'https://sparrow.land';

/** Strip trailing slashes so `${home}/path` never doubles up. */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The two canonical-home settings, as they live on {@link ServerConfig}. */
export interface PublicHomes {
  docsUrl?: string;
  installUrl?: string;
}

/** The docs home for this config (trailing slash stripped, default applied). */
export function docsHome(config: PublicHomes): string {
  return stripTrailingSlash(config.docsUrl?.trim() || DEFAULT_DOCS_URL);
}

/** The install home for this config (trailing slash stripped, default applied). */
export function installHome(config: PublicHomes): string {
  return stripTrailingSlash(config.installUrl?.trim() || DEFAULT_INSTALL_URL);
}

/** Normalize a `/docs/api/<segment>` path fragment (strip surrounding slashes). */
function normSegment(segment: string | undefined): string {
  return (segment ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * The MARKDOWN URL of one API docs page — what a machine caller gets:
 * `${DOCS_URL}/api/<segment>.md`, index at `${DOCS_URL}/api/index.md`.
 * This is the URL every emitted `docs` field uses (hints, error envelopes).
 */
export function apiDocMarkdownUrl(docsUrl: string, segment?: string): string {
  const seg = normSegment(segment);
  return `${stripTrailingSlash(docsUrl)}/api/${seg === '' ? 'index' : seg}.md`;
}

/**
 * The RENDERED (browser) URL of the API reference. There is exactly ONE human
 * page for the whole REST surface — `${DOCS_URL}/api/` — not a page per segment,
 * so every browser landing on any `/docs/api/...` path goes there. The
 * per-segment documents exist only as markdown ({@link apiDocMarkdownUrl}).
 */
export function apiDocPageUrl(docsUrl: string): string {
  return `${stripTrailingSlash(docsUrl)}/api/`;
}

/** A non-`api` docs page: `${DOCS_URL}/<page>/`; the getting-started index is `${DOCS_URL}/`. */
export function docsPageUrl(docsUrl: string, page?: string): string {
  const seg = normSegment(page);
  const base = stripTrailingSlash(docsUrl);
  return seg === '' ? `${base}/` : `${base}/${seg}/`;
}

/** An install artifact under the install home, e.g. `install.sh`, `install/sparrow.js`. */
export function installArtifactUrl(installUrl: string, file: string): string {
  return `${stripTrailingSlash(installUrl)}/${file.replace(/^\/+/, '')}`;
}
