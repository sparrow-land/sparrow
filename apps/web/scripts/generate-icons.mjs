#!/usr/bin/env node
// Maintainer tool — regenerates the native-app icon set in `public/icons/` from
// the canonical songbird mark. This is NOT part of the build or an app runtime
// dependency: it uses `sharp`, which is intentionally NOT a dependency of
// @sparrow/web. Run it from the workspace root, where sharp is installed:
//
//   pnpm add -Dw sharp        # one-time, at the workspace root
//   node apps/web/scripts/generate-icons.mjs
//
// The generated PNGs are committed, so day-to-day contributors never need sharp.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/web/scripts -> workspace root (sparrow-core) is three levels up.
const workspaceRoot = resolve(__dirname, '..', '..', '..');
// Resolve sharp from the workspace root's node_modules, never this package's.
const requireFromRoot = createRequire(join(workspaceRoot, 'package.json'));
let sharp;
try {
  sharp = requireFromRoot('sharp');
} catch {
  console.error(
    'sharp not found at the workspace root. Install it first:\n' +
      '  pnpm add -Dw sharp   (run from the workspace root)',
  );
  process.exit(1);
}

const outDir = resolve(__dirname, '..', 'public', 'icons');

// The canonical mark artwork: a standing songbird with an integrated beak
// (the leading point of the body), a folded-wing overlay, an eye, a notched
// tail, and two legs. Kept in one place so both variants stay in sync.
const artwork = `
  <path fill="url(#s)" d="M4 30 L14 27 C15 20 27 17 31 25 C39 23 46 27 46 34 L56 40 L48 41 L52 47 L44 42 C41 45 36 46 29 46 C21 46 15 42 13 37 C13 35 13 34 14 33 Z"/>
  <path fill="#12121a" opacity=".18" d="M24 29 C30 26 39 28 44 34 C41 39 33 41 27 38 C25 35 24 32 24 29 Z"/>
  <circle cx="21" cy="29" r="2.1" fill="#12121a"/>
  <line x1="24" y1="46" x2="22" y2="55" stroke="#e8703a" stroke-width="2.2" stroke-linecap="round"/>
  <line x1="31" y1="47" x2="31" y2="56" stroke="#e8703a" stroke-width="2.2" stroke-linecap="round"/>
`;

const gradient = `
  <defs>
    <linearGradient id="s" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f2c14e"/>
      <stop offset=".5" stop-color="#e8703a"/>
      <stop offset="1" stop-color="#c8456b"/>
    </linearGradient>
  </defs>
`;

// Standard mark: songbird on a dark rounded tile.
const masterSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
${gradient}
  <rect width="64" height="64" rx="15" fill="#16161f"/>
${artwork}
</svg>`;

// Maskable variant: full-bleed #16161f background (platform applies its own
// mask) with the mark scaled to ~70% inside the safe zone. Content bbox is
// roughly x[4..56] y[17..56], center (30, 36.5); scale about the tile center.
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
${gradient}
  <rect width="64" height="64" fill="#16161f"/>
  <g transform="translate(32 32) scale(0.7) translate(-30 -36.5)">
${artwork}
  </g>
</svg>`;

// name -> { size, svg }
const targets = {
  'icon-16.png': { size: 16, svg: masterSvg },
  'icon-32.png': { size: 32, svg: masterSvg },
  'icon-48.png': { size: 48, svg: masterSvg },
  'icon-128.png': { size: 128, svg: masterSvg },
  'icon-180.png': { size: 180, svg: masterSvg }, // apple-touch
  'icon-192.png': { size: 192, svg: masterSvg },
  'icon-256.png': { size: 256, svg: masterSvg },
  'icon-512.png': { size: 512, svg: masterSvg },
  'icon-1024.png': { size: 1024, svg: masterSvg },
  'icon-maskable-512.png': { size: 512, svg: maskableSvg },
};

await mkdir(outDir, { recursive: true });

for (const [name, { size, svg }] of Object.entries(targets)) {
  const out = join(outDir, name);
  await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: 'contain' })
    .png()
    .toFile(out);
  console.log(`wrote ${name} (${size}x${size})`);
}

console.log(`\nDone — ${Object.keys(targets).length} icons in ${outDir}`);
