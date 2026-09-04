/**
 * Vite config for the docs prerender's SSR bundle.
 *
 * Deliberately `configFile: false`: the app's own vite.config.ts carries the
 * dev proxy, the Tailwind plugin and the vitest block, none of which a Node
 * render needs. Driven by scripts/prerender-docs.mjs — don't run it by hand.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const webDir = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: webDir,
  configFile: false,
  plugins: [react()],
  resolve: {
    alias: [
      // See origin-stub.ts: off-browser the real module answers
      // `http://localhost:8722`, which would end up in every docs snippet.
      { find: /^.*\/lib\/origin\.js$/, replacement: scriptsDir + 'origin-stub.ts' },
    ],
  },
  build: {
    ssr: scriptsDir + 'prerender-entry.tsx',
    outDir: process.env.PRERENDER_SSR_OUT || webDir + 'node_modules/.cache/prerender-docs',
    emptyOutDir: true,
    minify: false,
    target: 'node20',
  },
});
