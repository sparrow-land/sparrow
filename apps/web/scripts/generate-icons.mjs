#!/usr/bin/env node
// Maintainer tool: regenerate committed browser/app icon derivatives from the
// canonical SVGs in public/brand. Sharp is intentionally a workspace-local
// maintainer dependency rather than an @sparrow/web runtime dependency.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '..', '..', '..');
const publicDir = resolve(scriptDir, '..', 'public');
const brandDir = join(publicDir, 'brand');
const outDir = join(publicDir, 'icons');
const requireFromRoot = createRequire(join(workspaceRoot, 'package.json'));

let sharp;
try {
  sharp = process.env.SPARROW_SHARP_PATH
    ? requireFromRoot(process.env.SPARROW_SHARP_PATH)
    : requireFromRoot('sharp');
} catch {
  console.error(
    'sharp not found at the workspace root. Install it temporarily with:\n' +
      '  pnpm add -Dw sharp\n' +
      'Then run this script and remove the dependency if it is not otherwise needed.',
  );
  process.exit(1);
}

const [iconSvg, faviconSvg, markSvg] = await Promise.all([
  readFile(join(brandDir, 'sparrow-icon.svg')),
  readFile(join(brandDir, 'favicon.svg')),
  readFile(join(brandDir, 'sparrow-mark.svg')),
]);

const targets = new Map([
  [16, faviconSvg],
  [32, faviconSvg],
  [48, faviconSvg],
  [128, iconSvg],
  [180, iconSvg],
  [192, iconSvg],
  [256, iconSvg],
  [512, iconSvg],
  [1024, iconSvg],
]);

await mkdir(outDir, { recursive: true });
for (const [size, source] of targets) {
  const name = `icon-${size}.png`;
  await sharp(source, { density: 384 }).resize(size, size).png().toFile(join(outDir, name));
  console.log(`wrote ${name} (${size}x${size})`);
}

// Maskable icons need a full-bleed field. The mark occupies 70% of the canvas,
// keeping all important artwork inside the platform's central safe circle.
const maskableSize = 512;
const markSize = Math.round(maskableSize * 0.7);
const inset = Math.round((maskableSize - markSize) / 2);
await sharp({
  create: {
    width: maskableSize,
    height: maskableSize,
    channels: 4,
    background: '#edf3e7',
  },
})
  .composite([
    {
      input: await sharp(markSvg, { density: 384 }).resize(markSize, markSize).png().toBuffer(),
      left: inset,
      top: inset,
    },
  ])
  .png()
  .toFile(join(outDir, 'icon-maskable-512.png'));
console.log('wrote icon-maskable-512.png (512x512)');

// Keep the conventional root SVG fallback byte-identical to the canonical one.
await writeFile(join(publicDir, 'favicon.svg'), faviconSvg);

// ICO supports PNG-compressed entries. Include the common legacy sizes without
// introducing another image-processing dependency.
const icoSizes = [16, 32, 48];
const icoImages = await Promise.all(
  icoSizes.map((size) => readFile(join(outDir, `icon-${size}.png`))),
);
const icoHeader = Buffer.alloc(6 + 16 * icoImages.length);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoImages.length, 4);
let imageOffset = icoHeader.length;
icoImages.forEach((image, index) => {
  const entryOffset = 6 + 16 * index;
  const size = icoSizes[index];
  icoHeader[entryOffset] = size;
  icoHeader[entryOffset + 1] = size;
  icoHeader.writeUInt16LE(1, entryOffset + 4);
  icoHeader.writeUInt16LE(32, entryOffset + 6);
  icoHeader.writeUInt32LE(image.length, entryOffset + 8);
  icoHeader.writeUInt32LE(imageOffset, entryOffset + 12);
  imageOffset += image.length;
});
await writeFile(join(publicDir, 'favicon.ico'), Buffer.concat([icoHeader, ...icoImages]));
console.log('wrote favicon.svg and favicon.ico');
