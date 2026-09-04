/**
 * The origin this SPA is served from. Every install/join command that embeds a
 * server URL is computed from this so self-hosted instances show their own URL.
 * Guarded for non-browser (SSR/test) contexts.
 */
export function serverOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost:8722';
}
