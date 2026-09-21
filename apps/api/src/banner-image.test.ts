import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BANNER_IMAGE_HEIGHT,
  BANNER_IMAGE_PNG_BASE64,
  BANNER_IMAGE_WIDTH,
} from './banner-image.js';

/**
 * The embed is a GENERATED module (`scripts/embed-banner-image.mjs`), checked
 * in so that packaging needs no Dockerfile change: the image ships as source,
 * compiles into `dist/`, and the runtime never reads a file.
 *
 * That convenience has one failure mode — a stale embed after the artwork
 * changes — so this test compares the decoded bytes against the asset itself.
 * If they ever diverge, re-run the script.
 */
const ASSET = new URL('../assets/flying-sparrow-256.png', import.meta.url);

/** The 8-byte PNG signature every PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('banner-image (generated embed)', () => {
  const asset = readFileSync(ASSET);
  const embedded = Buffer.from(BANNER_IMAGE_PNG_BASE64, 'base64');

  it('decodes to a PNG', () => {
    expect(embedded.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it('matches the asset header byte for byte (a stale embed fails here)', () => {
    // IHDR is the first chunk: 8 signature + 4 length + 4 type + 13 data.
    expect(embedded.subarray(0, 29)).toEqual(asset.subarray(0, 29));
  });

  it('matches the asset in full', () => {
    expect(embedded.length).toBe(asset.length);
    expect(embedded.equals(asset)).toBe(true);
  });

  it('reports the dimensions the PNG itself carries', () => {
    expect(BANNER_IMAGE_WIDTH).toBe(asset.readUInt32BE(16));
    expect(BANNER_IMAGE_HEIGHT).toBe(asset.readUInt32BE(20));
    expect(BANNER_IMAGE_WIDTH).toBe(256);
    expect(BANNER_IMAGE_HEIGHT).toBe(256);
  });

  it('is base64 and nothing else (no data: prefix, no newlines)', () => {
    expect(BANNER_IMAGE_PNG_BASE64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('says it is generated, and how to regenerate it', () => {
    const src = readFileSync(new URL('./banner-image.ts', import.meta.url), 'utf8');
    expect(src).toContain('GENERATED');
    expect(src).toContain('embed-banner-image');
  });
});
