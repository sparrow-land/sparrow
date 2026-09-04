import { CLIENT_VERSION } from '@sparrow/common-types';

/**
 * The build version stamped into the CLI/MCP bundles at bundle time via esbuild's
 * `define` (see apps/api/scripts/bundle-clients.mjs) — a string of the form
 * `<pkg-version>+<yyyymmdd>.<git-short-sha>`. It exists ONLY in the bundled
 * artifacts; a non-bundled (workspace / test / `tsx`) run has no such global, so
 * {@link clientBuildVersion} falls back to `<pkg-version>+dev`.
 *
 * `typeof` on an undeclared identifier is safe (no ReferenceError), and esbuild's
 * `define` textually replaces `__SPARROW_BUILD__` with the string literal, so the
 * bundled branch resolves to the stamped value.
 */
declare const __SPARROW_BUILD__: string | undefined;

/**
 * The single source of truth for the client's self-reported version, shared by
 * the CLI (`--version`) and the MCP server (`serverInfo`) so they always agree.
 * Bundled builds report the stamped `<pkg>+<date>.<sha>`; everything else reports
 * `<pkg>+dev`.
 */
export function clientBuildVersion(): string {
  if (typeof __SPARROW_BUILD__ === 'string' && __SPARROW_BUILD__.length > 0) {
    return __SPARROW_BUILD__;
  }
  return `${CLIENT_VERSION}+dev`;
}
