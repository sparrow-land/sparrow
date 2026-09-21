/**
 * Embed the startup-banner illustration into a TypeScript module.
 *
 * Why embed instead of reading the PNG at runtime? Because the image has to
 * survive packaging untouched. The Dockerfile copies `apps/api/dist` and
 * nothing else, and `package.json#files` ships `dist` alone — so a PNG under
 * `assets/` would simply not be there in the published image. Compiled into
 * `src/banner-image.ts`, it becomes part of `dist/banner-image.js` for free,
 * with no Dockerfile change and no runtime filesystem lookup at boot.
 *
 * The generated module is CHECKED IN (generated code in the tree beats a build
 * step everyone has to remember), and `src/banner-image.test.ts` compares the
 * decoded bytes against `assets/flying-sparrow-256.png`, so a stale embed is a
 * failing test rather than a wrong bird.
 *
 * Usage: `pnpm --filter @sparrow/api embed-banner-image`
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(PKG_ROOT, 'assets', 'flying-sparrow-256.png');
const TARGET = path.join(PKG_ROOT, 'src', 'banner-image.ts');

/** The 8-byte signature every PNG opens with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width/height straight out of the IHDR chunk, which a PNG is required to put
 * first: [8] signature, [4] length, [4] "IHDR", then width and height as
 * big-endian u32. No image library for four bytes each.
 *
 * @param {Buffer} png
 * @returns {{ width: number, height: number }}
 */
export function readPngSize(png) {
  if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG (bad signature)');
  if (png.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('not a PNG (no IHDR)');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * The generated module's source text.
 *
 * @param {{ base64: string, width: number, height: number, source: string }} info
 * @returns {string}
 */
export function renderModule({ base64, width, height, source }) {
  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:     ${source}
 * Regenerate: pnpm --filter @sparrow/api embed-banner-image
 *             (scripts/embed-banner-image.mjs)
 *
 * The startup banner's illustration, base64-encoded so it compiles into
 * \`dist/\` and ships with the image — see the script for why, and
 * \`banner-image.test.ts\` for the check that keeps this in step with the asset.
 */

/** The illustration as base64-encoded PNG bytes (no \`data:\` prefix). */
export const BANNER_IMAGE_PNG_BASE64 =
  '${base64}';

/** Pixel width of the encoded PNG. */
export const BANNER_IMAGE_WIDTH = ${width};

/** Pixel height of the encoded PNG. */
export const BANNER_IMAGE_HEIGHT = ${height};
`;
}

async function main() {
  const png = await readFile(SOURCE);
  const { width, height } = readPngSize(png);
  const base64 = png.toString('base64');
  await writeFile(
    TARGET,
    renderModule({
      base64,
      width,
      height,
      source: path.relative(PKG_ROOT, SOURCE),
    }),
    'utf8',
  );
  process.stdout.write(
    `embedded ${path.relative(PKG_ROOT, SOURCE)} (${png.length} bytes, ${width}x${height}) ` +
      `-> ${path.relative(PKG_ROOT, TARGET)} (${base64.length} base64 chars)\n`,
  );
}

// Run only as a script; the exports above stay importable for tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
