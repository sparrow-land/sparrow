/**
 * Canonical public homes — the documentation and the client installer each have
 * ONE home, whatever instance the reader is talking to (SPEC: *Canonical public
 * homes*). Per-instance docs drift out of sync with each other and with the
 * product, and `curl <your host>/install.sh` teaches every reader a different
 * command; so an instance serves NEITHER — its `/docs*` and `/install.sh`
 * answer `302` to the URLs below, and every dialog, doc and README prints them.
 *
 * Instance-relative URLs are still exactly right for everything an instance
 * really owns: `${serverOrigin()}/api/v1/…`, `${serverOrigin()}/invite/…`.
 */

/** Where the documentation lives. No trailing slash — {@link docsUrl} adds it. */
export const DOCS_URL = 'https://sparrow.land/docs';

/** Where the client installer lives (`INSTALL_URL/install.sh`). */
export const INSTALL_URL = 'https://sparrow.land';

/** The one install one-liner. Printed verbatim by every surface that shows it. */
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL}/install.sh | sh`;

/**
 * An absolute docs URL. `docsUrl()` is the docs root; `docsUrl('cli')` is the
 * CLI page. Always trailing-slashed, which is how the published site addresses
 * its pages, so no link pays for a redirect on arrival.
 */
export function docsUrl(path = ''): string {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return clean ? `${DOCS_URL}/${clean}/` : `${DOCS_URL}/`;
}
