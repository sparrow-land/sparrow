import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The iOS auto-zoom trap, and why it is a LAYOUT bug rather than a typography
 * one (Jake's iPhone session, 2026-09-04).
 *
 * Mobile Safari zooms the whole page in when a focused `input`/`textarea`/
 * `select` computes to a font-size under 16px — and it does NOT zoom back out
 * when the field blurs. One tap on the 14px composer therefore left the entire
 * app scaled up for the rest of the session: the header's Sign out and the
 * composer's own Send button were sheared off the right edge at 390px, and so
 * was the welcome page, which has no input on it at all. That last detail is
 * what proves the diagnosis — the clipping outlives the screen that caused it.
 *
 * The fix belongs on the FIELD, not the viewport: `maximum-scale=1` /
 * `user-scalable=no` would also stop the zoom, by taking pinch-zoom away from
 * everyone who needs it. So: every text field renders at ≥16px below the `md`
 * breakpoint, and desktop keeps its 14px scale.
 *
 * This test reads the stylesheet as text because there is no layout engine in
 * jsdom to compute the rule against — the assertion is that the rule SHIPS.
 */
// Resolved from the vitest root (apps/web); `import.meta.url` is an http URL
// under the jsdom environment, not a file one.
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');
const css = read('src/index.css');

/** The rule's block, from its `@media` line to the closing brace. */
function mobileFieldBlock(): string {
  const at = css.indexOf('@media (max-width: 767px)');
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('\n}', at) + 2);
}

describe('mobile text fields never trigger iOS auto-zoom', () => {
  it('ships a max-width:767px rule setting text fields to 16px', () => {
    const block = mobileFieldBlock();
    expect(block).toMatch(/font-size:\s*16px/);
  });

  it('covers input, textarea and select — the whole sweep, not just the composer', () => {
    const block = mobileFieldBlock();
    expect(block).toMatch(/\binput\b/);
    expect(block).toMatch(/\btextarea\b/);
    expect(block).toMatch(/\bselect\b/);
  });

  it('exempts the non-text inputs, which have no zoom behaviour to fix', () => {
    // A checkbox or a range slider has no text to measure; forcing 16px on them
    // only changes their box size.
    const block = mobileFieldBlock();
    expect(block).toMatch(/checkbox/);
    expect(block).toMatch(/radio/);
  });

  it('leaves the desktop scale alone — the rule is inside the media query', () => {
    // The 14px body scale is the design; only phones get the bump.
    expect(css).toMatch(/font-size:\s*14px/);
    const block = mobileFieldBlock();
    expect(block.startsWith('@media (max-width: 767px)')).toBe(true);
  });

  it('does NOT lock the viewport scale — pinch-zoom stays available', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/maximum-scale/);
    expect(html).not.toMatch(/user-scalable/);
  });
});
