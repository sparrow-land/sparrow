import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// apps/web/src -> package root is one level up.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(pkgRoot, 'public');

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

describe('web app manifest + icons', () => {
  const manifestPath = resolve(publicDir, 'manifest.webmanifest');

  it('manifest.webmanifest is valid JSON with the expected brand fields', () => {
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as Manifest;
    expect(manifest.name).toBe('sparrow');
    // Dark-palette surface color (matches --sparrow-bg and the pre-paint meta default).
    expect(manifest.theme_color).toBe('#0a0c0f');
    expect(manifest.background_color).toBe('#0a0c0f');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('every icon the manifest references exists under public/', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    for (const icon of manifest.icons) {
      // manifest srcs are absolute web paths ("/icons/..."); map to public/.
      const filePath = resolve(publicDir, icon.src.replace(/^\//, ''));
      expect(existsSync(filePath), `missing icon file: ${icon.src}`).toBe(true);
    }
  });

  it('manifest declares a maskable icon', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const maskable = manifest.icons.filter((i) => i.purpose?.includes('maskable'));
    expect(maskable.length).toBeGreaterThan(0);
  });

  it('favicon.svg exists in public/', () => {
    expect(existsSync(resolve(publicDir, 'favicon.svg'))).toBe(true);
  });

  it('index.html links the manifest and an apple-touch-icon', () => {
    const html = readFileSync(resolve(pkgRoot, 'index.html'), 'utf8');
    expect(html).toMatch(/rel="manifest"\s+href="\/manifest\.webmanifest"/);
    expect(html).toMatch(/rel="apple-touch-icon"/);
  });

  // Browsers probe /favicon.ico by convention even when <link rel="icon"> tags
  // are present; without the file every anonymous page load logged a 404.
  it('favicon.ico exists in public/ and is a real ICO container', () => {
    const icoPath = resolve(publicDir, 'favicon.ico');
    expect(existsSync(icoPath)).toBe(true);
    const buf = readFileSync(icoPath);
    // ICONDIR: reserved=0, type=1 (icon), count>0 — all little-endian uint16.
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    expect(buf.readUInt16LE(4)).toBeGreaterThan(0);
  });

  it('index.html links favicon.ico as the legacy fallback', () => {
    const html = readFileSync(resolve(pkgRoot, 'index.html'), 'utf8');
    expect(html).toMatch(/href="\/favicon\.ico"/);
  });
});
