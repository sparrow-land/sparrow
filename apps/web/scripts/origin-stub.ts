/**
 * Build-time replacement for `src/lib/origin.ts` during the docs prerender.
 *
 * The real one reads `window.location.origin` and falls back to the dev URL
 * `http://localhost:8722` when there is no browser — which is exactly the
 * situation a prerender is in, so every `sparrow join <url>` snippet in the
 * docs would ship pointing at localhost. The prerender aliases the module to
 * this file and passes the real origin through the environment instead.
 *
 * This is the ONLY module shim the docs import graph needs.
 */
export function serverOrigin(): string {
  const origin = process.env.PRERENDER_ORIGIN;
  if (!origin) throw new Error('PRERENDER_ORIGIN is not set — refusing to bake in a wrong origin');
  return origin;
}
