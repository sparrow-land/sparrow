import { describe, expect, it } from 'vitest';
import {
  BANNER_OPT_OUT_ENV,
  SPARROW_ART,
  bannerEnabled,
  bannerUrl,
  printBanner,
  renderBanner,
  useColor,
} from './banner.js';
import { envConfig } from './config.js';
import { DEFAULT_DOCS_URL } from './public-homes.js';

const ESC = '';
/** Strip every ANSI SGR sequence so a rendered line can be measured/compared. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const INFO = {
  version: '0.1.43',
  build: '20260921.0675365',
  url: 'http://localhost:8722',
  docsUrl: DEFAULT_DOCS_URL,
};

describe('renderBanner', () => {
  it('carries the version and the build stamp', () => {
    const out = renderBanner({ ...INFO, color: false });
    expect(out).toContain('v0.1.43');
    expect(out).toContain('20260921.0675365');
  });

  it('carries the URL a human is meant to open, and the docs home', () => {
    const out = renderBanner({ ...INFO, color: false });
    expect(out).toContain('http://localhost:8722');
    expect(out).toContain(DEFAULT_DOCS_URL);
    // Never the bind address: the container binds 0.0.0.0, the human opens localhost.
    expect(out).not.toContain('0.0.0.0');
  });

  it('names the product', () => {
    expect(strip(renderBanner({ ...INFO, color: false }))).toContain('sparrow');
  });

  it('omits the build fragment when the build is unstamped', () => {
    const out = renderBanner({ ...INFO, build: null, color: false });
    expect(out).toContain('v0.1.43');
    expect(out).not.toContain('build');
  });

  it('emits NO escape codes when color is off (docker logs, piped stdout)', () => {
    expect(renderBanner({ ...INFO, color: false })).not.toContain(ESC);
  });

  it('emits escape codes when color is on, and resets every one it opens', () => {
    const out = renderBanner({ ...INFO, color: true });
    expect(out).toContain(`${ESC}[`);
    // Same visible text either way: color is decoration, never content.
    expect(strip(out)).toBe(renderBanner({ ...INFO, color: false }));
    // Every line that opens a sequence closes it, so a truncated read of
    // `docker logs` cannot leave a terminal painted.
    for (const line of out.split('\n')) {
      if (line.includes(`${ESC}[`)) expect(line.endsWith(`${ESC}[0m`)).toBe(true);
    }
  });

  it('fits a plain 80-column terminal in both color modes', () => {
    for (const color of [false, true]) {
      for (const line of renderBanner({ ...INFO, color }).split('\n')) {
        expect(strip(line).length).toBeLessThanOrEqual(80);
      }
    }
  });

  it('keeps the art itself under 40 columns', () => {
    for (const line of SPARROW_ART) expect(line.length).toBeLessThanOrEqual(40);
    expect(SPARROW_ART.length).toBeGreaterThanOrEqual(6);
    expect(SPARROW_ART.length).toBeLessThanOrEqual(9);
  });

  it('is pure ASCII except for the one separator dot', () => {
    const out = renderBanner({ ...INFO, color: false }).replace(/·/g, '');
    expect(out).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

describe('bannerUrl', () => {
  it('uses BASE_URL when the operator set one', () => {
    const config = envConfig({ BASE_URL: 'https://chat.acme.com' } as NodeJS.ProcessEnv);
    expect(bannerUrl(config.baseUrl)).toBe('https://chat.acme.com');
  });

  it('falls back to localhost on the configured port', () => {
    expect(bannerUrl(envConfig({ PORT: '8724' } as NodeJS.ProcessEnv).baseUrl)).toBe(
      'http://localhost:8724',
    );
    expect(bannerUrl(envConfig({} as NodeJS.ProcessEnv).baseUrl)).toBe('http://localhost:8722');
  });

  it('never prints a bind address a browser cannot open', () => {
    expect(bannerUrl('http://0.0.0.0:8722')).toBe('http://localhost:8722');
    expect(bannerUrl('http://[::]:8722')).toBe('http://localhost:8722');
  });

  it('strips a trailing slash', () => {
    expect(bannerUrl('https://chat.acme.com/')).toBe('https://chat.acme.com');
  });
});

describe('bannerEnabled', () => {
  it('is on by default', () => {
    expect(bannerEnabled({}, { logging: true })).toBe(true);
  });

  it('is off when the opt-out env is set', () => {
    expect(BANNER_OPT_OUT_ENV).toBe('SPARROW_NO_BANNER');
    expect(bannerEnabled({ SPARROW_NO_BANNER: '1' }, { logging: true })).toBe(false);
    expect(bannerEnabled({ SPARROW_NO_BANNER: 'true' }, { logging: true })).toBe(false);
  });

  it('treats an empty/0/false value as "not set" (compose always defines the var)', () => {
    for (const v of ['', '  ', '0', 'false']) {
      expect(bannerEnabled({ SPARROW_NO_BANNER: v }, { logging: true })).toBe(true);
    }
  });

  it('is off when the logger is off — LOG_LEVEL=off really is silent (SPEC)', () => {
    expect(bannerEnabled({}, { logging: false })).toBe(false);
  });
});

describe('useColor', () => {
  it('colors only a TTY', () => {
    expect(useColor({}, { isTTY: true })).toBe(true);
    expect(useColor({}, { isTTY: false })).toBe(false);
    expect(useColor({}, {})).toBe(false);
  });

  it('honours NO_COLOR over the TTY', () => {
    expect(useColor({ NO_COLOR: '1' }, { isTTY: true })).toBe(false);
    expect(useColor({ NO_COLOR: '' }, { isTTY: true })).toBe(true);
  });

  it('lets FORCE_COLOR opt a pipe in, but NO_COLOR still wins', () => {
    expect(useColor({ FORCE_COLOR: '1' }, { isTTY: false })).toBe(true);
    expect(useColor({ FORCE_COLOR: '0' }, { isTTY: false })).toBe(false);
    expect(useColor({ FORCE_COLOR: '1', NO_COLOR: '1' }, { isTTY: false })).toBe(false);
  });
});

describe('printBanner', () => {
  const sink = (): { out: string; isTTY: boolean; write: (s: string) => void } => {
    const s = {
      out: '',
      isTTY: false,
      write: (chunk: string) => {
        s.out += chunk;
      },
    };
    return s;
  };

  it('writes the banner exactly once, plain, to the given stream', () => {
    const s = sink();
    printBanner({ ...INFO, env: {}, stream: s, logging: true });
    expect(s.out).toContain('http://localhost:8722');
    expect(s.out).not.toContain(ESC);
    expect(s.out.match(/v0\.1\.43/g)).toHaveLength(1);
    expect(s.out.endsWith('\n')).toBe(true);
  });

  it('writes nothing at all when opted out', () => {
    const s = sink();
    printBanner({ ...INFO, env: { SPARROW_NO_BANNER: '1' }, stream: s, logging: true });
    expect(s.out).toBe('');
  });

  it('writes nothing when the logger is off', () => {
    const s = sink();
    printBanner({ ...INFO, env: {}, stream: s, logging: false });
    expect(s.out).toBe('');
  });
});
