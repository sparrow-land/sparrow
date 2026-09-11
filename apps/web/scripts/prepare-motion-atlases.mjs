import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SPARROW_SHARP_PATH || 'sharp');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public/avatars');
const output = resolve(root, 'sparrow-v2/motion');
await mkdir(output, { recursive: true });
const sources = ['hover-base-1.png', 'hover-base-2.png', 'hover-sprites-v1.png'];
const patches = [[185, 130, 90, 85], [235, 135, 85, 90], [180, 132, 100, 85]];
const report = [];

for (let base = 0; base < sources.length; base++) {
  const { data, info } = await sharp(resolve(root, 'motion-study', sources[base])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== info.height || info.width % 3) throw new Error('Expected square 3x3 atlas');
  const cell = info.width / 3;
  const [px, py, pw, ph] = patches[base];
  const frames = [];
  const offsets = [];
  for (let frame = 0; frame < 9; frame++) {
    const left = (frame % 3) * cell;
    const top = Math.floor(frame / 3) * cell;
    // Register a face patch, not the changing wing silhouette or whole-bird box.
    let best = { error: Infinity, dx: 0, dy: 0 };
    for (let dy = -40; dy <= 40; dy++) for (let dx = -20; dx <= 20; dx++) {
      let error = 0;
      for (let y = py; y < py + ph; y += 4) for (let x = px; x < px + pw; x += 4) {
        const ref = (y * info.width + x) * 4;
        const at = ((top + y + dy) * info.width + left + x + dx) * 4;
        for (let c = 0; c < 3; c++) error += (data[ref + c] - data[at + c]) ** 2;
      }
      if (error < best.error) best = { error, dx, dy };
    }
    const pixels = Buffer.alloc(cell * cell * 4);
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const src = ((top + y) * info.width + left + x) * 4;
      const dest = (y * cell + x) * 4;
      const [r, g, b] = data.subarray(src, src + 3);
      // These generated sources use a green key absent from the warm feathers.
      const excess = Math.min(g - r, g - b);
      const opacity = Math.max(0, Math.min(1, 1 - (excess - 2) / 8));
      pixels[dest] = r;
      pixels[dest + 1] = opacity < 1 ? Math.min(g, Math.max(r, b) + 1) : g;
      pixels[dest + 2] = b;
      pixels[dest + 3] = Math.round(data[src + 3] * opacity);
    }
    const size = 218;
    const image = await sharp(pixels, { raw: { width: cell, height: cell, channels: 4 } }).resize(size, size).png().toBuffer();
    const x = 19 - Math.round(best.dx * size / cell);
    const y = 19 - Math.round(best.dy * size / cell);
    if (x < 0 || y < 0 || x + size > 256 || y + size > 256) throw new Error(`Registration exceeds padding: ${JSON.stringify(best)}`);
    frames.push({ input: image, left: (frame % 3) * 256 + x, top: Math.floor(frame / 3) * 256 + y });
    offsets.push({ frame, dx: best.dx, dy: best.dy, error: best.error });
  }
  await sharp({ create: { width: 768, height: 768, channels: 4, background: '#00000000' } })
    .composite(frames).webp({ lossless: true }).toFile(resolve(output, `base-${base + 1}.webp`));
  report.push({ base: base + 1, source: sources[base], offsets });
}
await writeFile(resolve(output, 'registration.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
