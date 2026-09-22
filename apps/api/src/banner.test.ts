import { describe, expect, it } from 'vitest';
import {
  BANNER_IMAGE_ENV,
  BANNER_OPT_OUT_ENV,
  BANNER_PROBE_ENV,
  IMAGE_CELL_COLS,
  IMAGE_CELL_ROWS,
  KITTY_CHUNK_LIMIT,
  SPARROW_ART,
  bannerEnabled,
  bannerUrl,
  imageBannerMode,
  printBanner,
  renderBanner,
  resolveBannerMode,
  renderImageBanner,
  renderKittyImage,
  useColor,
} from './banner.js';
import { BANNER_IMAGE_PNG_BASE64 } from './banner-image.js';
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

  it('names the product, capitalized — it is a proper noun in prose', () => {
    const out = strip(renderBanner({ ...INFO, color: false }));
    expect(out).toContain('Sparrow');
    // The wordmark line itself never spells it lowercase (the docs URL still may).
    const wordmark = out.split('\n').find((l) => l.includes('Sparrow'))!;
    expect(wordmark).not.toMatch(/\bsparrow\b/);
  });

  it('omits the build fragment when the build is unstamped', () => {
    const out = renderBanner({ ...INFO, build: null, color: false });
    expect(out).toContain('v0.1.43');
    expect(out).not.toContain('build');
  });

  it('emits NO escape codes when color is off (docker logs, piped stdout)', () => {
    expect(renderBanner({ ...INFO, color: false })).not.toContain(ESC);
  });

  it('paints each part deliberately: wordmark bold, version dim, URL an underlined accent', () => {
    const out = renderBanner({ ...INFO, color: true });
    const line = (needle: string): string =>
      out.split('\n').find((l) => strip(l).includes(needle))!;
    // The bird gets its own accent colour, and only that.
    expect(line(SPARROW_ART[2]!)).toMatch(new RegExp(`${ESC}\\[3[0-7]m`));
    // Wordmark bold, version dim, on one line.
    const mark = line('Sparrow');
    expect(mark).toContain(`${ESC}[1m`);
    expect(mark).toContain(`${ESC}[2m`);
    // The URL is the thing to click: bold + underlined, in a second colour.
    const open = line('Open');
    expect(open).toMatch(new RegExp(`${ESC}\\[[0-9;]*4[;m]`));
    expect(open).toMatch(new RegExp(`${ESC}\\[[0-9;]*1[;m]`));
    // Labels are quiet.
    expect(open.indexOf(`${ESC}[2m`)).toBeLessThan(open.indexOf('Open'));
    expect(line('Docs')).toContain(`${ESC}[2m`);
    // Only standard 16-colour/attribute SGR — nothing 256-colour (38;5;n) or truecolor.
    for (const seq of out.match(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')) ?? []) {
      expect(seq).not.toContain('38;5;');
      expect(seq).not.toContain('48;5;');
      expect(seq).not.toContain('38;2;');
    }
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

  it('keeps the art itself under 40 columns and 6 rows', () => {
    for (const line of SPARROW_ART) expect(line.length).toBeLessThanOrEqual(40);
    expect(SPARROW_ART.length).toBeGreaterThanOrEqual(3);
    expect(SPARROW_ART.length).toBeLessThanOrEqual(6);
  });

  it('is the compact bird, exactly', () => {
    expect(SPARROW_ART.join('\n')).toBe(
      ['        ___', '  \\\\\\__(o  )>', '      \\____/', '    ~~~^~~^~~~'].join('\n'),
    );
  });

  it('gives the version its own colour and the water line a cool one', () => {
    const out = renderBanner({ ...INFO, color: true });
    const line = (needle: string): string =>
      out.split('\n').find((l) => strip(l).includes(needle))!;
    // Version green, the build stamp behind it merely dim.
    const mark = line('v0.1.43');
    expect(mark).toContain(`${ESC}[32m`);
    expect(mark.indexOf(`${ESC}[32m`)).toBeLessThan(mark.indexOf('v0.1.43'));
    expect(mark).toContain(`${ESC}[2m`);
    // Water is blue or cyan, never the feather yellow.
    const water = line('~~~^~~^~~~');
    expect(water).toMatch(new RegExp(`${ESC}\\[3[46]m`));
    // The bird's body stays yellow.
    expect(line('(o  )>')).toContain(`${ESC}[33m`);
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

  it('writes the banner exactly once, plain, to the given stream', async () => {
    const s = sink();
    await printBanner({ ...INFO, env: {}, stream: s, logging: true });
    expect(s.out).toContain('http://localhost:8722');
    expect(s.out).not.toContain(ESC);
    expect(s.out.match(/v0\.1\.43/g)).toHaveLength(1);
    expect(s.out.endsWith('\n')).toBe(true);
  });

  it('writes nothing at all when opted out', async () => {
    const s = sink();
    await printBanner({ ...INFO, env: { SPARROW_NO_BANNER: '1' }, stream: s, logging: true });
    expect(s.out).toBe('');
  });

  it('writes nothing when the logger is off', async () => {
    const s = sink();
    await printBanner({ ...INFO, env: {}, stream: s, logging: false });
    expect(s.out).toBe('');
  });
});

/**
 * Parse a rendered kitty-graphics stream into its APC chunks. Deliberately
 * strict: anything that is not `ESC _ G <keys> ; <payload> ESC \` fails to
 * parse, so a malformed frame shows up as a missing chunk rather than as a
 * loose assertion that happened to pass.
 */
const parseKitty = (s: string): Array<{ keys: string; payload: string }> => {
  const out: Array<{ keys: string; payload: string }> = [];
  const re = new RegExp(`${ESC}_G([^;${ESC}]*);([^${ESC}]*)${ESC}\\\\`, 'g');
  for (const m of s.matchAll(re)) out.push({ keys: m[1]!, payload: m[2]! });
  return out;
};

/** The control keys of one chunk, as a map. */
const keyMap = (keys: string): Record<string, string> =>
  Object.fromEntries(
    keys
      .split(',')
      .filter(Boolean)
      .map((kv) => kv.split('=') as [string, string]),
  );

describe('renderKittyImage', () => {
  const out = renderKittyImage(BANNER_IMAGE_PNG_BASE64);
  const chunks = parseKitty(out);

  it('emits every byte inside an APC frame and nothing outside one', () => {
    expect(chunks.length).toBeGreaterThan(1);
    expect(out.startsWith(`${ESC}_G`)).toBe(true);
    expect(out.endsWith(`${ESC}\\`)).toBe(true);
    // Rebuilding the frames byte-for-byte reproduces the whole string: there is
    // no stray text between chunks that a non-kitty terminal could print.
    const rebuilt = chunks.map((c) => `${ESC}_G${c.keys};${c.payload}${ESC}\\`).join('');
    expect(rebuilt).toBe(out);
  });

  it('declares PNG direct transmission and a cell-sized placement, once', () => {
    const first = keyMap(chunks[0]!.keys);
    expect(first.f).toBe('100'); // f=100: the payload is a PNG, not raw RGBA
    expect(first.a).toBe('T'); // a=T: transmit AND display
    expect(first.c).toBe(String(IMAGE_CELL_COLS));
    expect(first.r).toBe(String(IMAGE_CELL_ROWS));
    expect(first.C).toBe('1'); // do not move the cursor; we place the text ourselves
    // Control keys ride the FIRST chunk only; the rest carry continuation and
    // the quiet flag alone.
    for (const chunk of chunks.slice(1)) {
      expect(Object.keys(keyMap(chunk.keys)).sort()).toEqual(['m', 'q']);
    }
  });

  it('is quiet: every transmission chunk carries q=2, so a failure prints nothing', () => {
    // iTerm2 answered our feature query with OK and then failed the
    // transmission, printing `ENOENT:Image not found after transmission` on
    // the user's screen. q=2 suppresses both the OK and the error for these
    // commands — we never read them, and nobody should ever see them.
    for (const chunk of chunks) expect(keyMap(chunk.keys).q).toBe('2');
  });

  it('chunks the payload with m=1 and closes with m=0', () => {
    for (const chunk of chunks.slice(0, -1)) expect(keyMap(chunk.keys).m).toBe('1');
    expect(keyMap(chunks.at(-1)!.keys).m).toBe('0');
  });

  it('never exceeds 4096 payload bytes in a chunk', () => {
    expect(KITTY_CHUNK_LIMIT).toBe(4096);
    for (const chunk of chunks) {
      expect(chunk.payload.length).toBeLessThanOrEqual(KITTY_CHUNK_LIMIT);
      expect(Buffer.byteLength(chunk.payload, 'utf8')).toBeLessThanOrEqual(KITTY_CHUNK_LIMIT);
    }
    // ...and fills them: only the last chunk may be short.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.payload.length).toBe(KITTY_CHUNK_LIMIT);
    }
  });

  it('round-trips: the concatenated payload is the PNG', () => {
    const joined = chunks.map((c) => c.payload).join('');
    expect(joined).toBe(BANNER_IMAGE_PNG_BASE64);
    const bytes = Buffer.from(joined, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('keeps the bird square: ~2:1 cells mean twice as many columns as rows', () => {
    expect(IMAGE_CELL_ROWS).toBe(10);
    expect(IMAGE_CELL_COLS).toBe(IMAGE_CELL_ROWS * 2);
  });
});

describe('renderImageBanner', () => {
  it('puts the text block BELOW the image, clear of its rows', () => {
    const out = renderImageBanner({ ...INFO, color: false });
    const end = out.lastIndexOf(`${ESC}\\`) + 2;
    const below = out.slice(end);
    // Exactly as many newlines as the image is tall, before anything is drawn.
    expect(below.startsWith('\n'.repeat(IMAGE_CELL_ROWS))).toBe(true);
    expect(below).toContain('Sparrow');
    expect(below).toContain('v0.1.43');
    expect(below).toContain('http://localhost:8722');
    expect(below).toContain(DEFAULT_DOCS_URL);
  });

  it('drops the ASCII bird — the image IS the bird', () => {
    const out = renderImageBanner({ ...INFO, color: false });
    for (const row of SPARROW_ART) expect(out).not.toContain(row.trim());
  });

  it('carries the same PNG the text-free path does', () => {
    const chunks = parseKitty(renderImageBanner({ ...INFO, color: true }));
    expect(chunks.map((c) => c.payload).join('')).toBe(BANNER_IMAGE_PNG_BASE64);
  });

  it('colours the text block exactly as the text banner does, or not at all', () => {
    const plain = renderImageBanner({ ...INFO, color: false });
    const below = (s: string): string => s.slice(s.lastIndexOf(`${ESC}\\`) + 2);
    // Colour off: no SGR anywhere below the image.
    expect(below(plain)).not.toMatch(new RegExp(`${ESC}\\[[0-9;]*m`));
    const painted = below(renderImageBanner({ ...INFO, color: true }));
    expect(strip(painted)).toBe(below(plain));
    expect(painted).toContain(`${ESC}[32m`); // version green
    expect(painted).toContain(`${ESC}[1m`); // wordmark bold
  });
});

describe('imageBannerMode', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  it('needs a TTY, whatever the terminal says it is', () => {
    expect(imageBannerMode({ TERM: 'xterm-kitty' }, tty)).toBe('image');
    expect(imageBannerMode({ TERM: 'xterm-kitty' }, pipe)).toBe('text');
    expect(imageBannerMode({ TERM: 'xterm-kitty' }, {})).toBe('text');
    // FORCE_COLOR opts a PIPE into colour; it never opts one into graphics.
    expect(imageBannerMode({ TERM: 'xterm-kitty', FORCE_COLOR: '1' }, pipe)).toBe('text');
  });

  it('allows kitty, Ghostty and WezTerm — and only by env, never a heuristic', () => {
    expect(imageBannerMode({ TERM: 'xterm-kitty' }, tty)).toBe('image');
    expect(imageBannerMode({ KITTY_WINDOW_ID: '1' }, tty)).toBe('image');
    expect(imageBannerMode({ TERM_PROGRAM: 'ghostty' }, tty)).toBe('image');
    expect(imageBannerMode({ TERM_PROGRAM: 'Ghostty' }, tty)).toBe('image');
    expect(imageBannerMode({ TERM: 'xterm-ghostty' }, tty)).toBe('image');
    expect(imageBannerMode({ GHOSTTY_RESOURCES_DIR: '/x' }, tty)).toBe('image');
    expect(imageBannerMode({ TERM_PROGRAM: 'WezTerm' }, tty)).toBe('image');
    expect(imageBannerMode({ TERM_PROGRAM: 'wezterm' }, tty)).toBe('image');
  });

  it('falls back to text for everything else', () => {
    for (const env of [
      {},
      { TERM: 'xterm-256color' },
      { TERM: 'vt100' },
      { TERM: 'dumb' },
      { TERM_PROGRAM: 'Apple_Terminal' },
      { TERM_PROGRAM: 'vscode' },
      { TERM: 'xterm-kitty-ish' },
    ]) {
      expect(imageBannerMode(env, tty)).toBe('text');
    }
  });

  it('is text in iTerm2 even though it can render: it may PROMPT the user', () => {
    expect(imageBannerMode({ TERM_PROGRAM: 'iTerm.app' }, tty)).toBe('text');
    expect(imageBannerMode({ LC_TERMINAL: 'iTerm2' }, tty)).toBe('text');
    // Even when another allowlist key is also present (iTerm2 wins, downward).
    expect(imageBannerMode({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-kitty' }, tty)).toBe('text');
  });

  it('is text inside tmux or screen: passthrough is unreliable', () => {
    expect(imageBannerMode({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux-1000/default,1,0' }, tty)).toBe(
      'text',
    );
    expect(imageBannerMode({ TERM: 'screen.xterm-kitty', KITTY_WINDOW_ID: '1' }, tty)).toBe('text');
    expect(imageBannerMode({ TERM: 'tmux-256color', KITTY_WINDOW_ID: '1' }, tty)).toBe('text');
    // An empty TMUX (compose-style `${TMUX:-}`) is not "inside tmux".
    expect(imageBannerMode({ TERM: 'xterm-kitty', TMUX: '' }, tty)).toBe('image');
  });

  it('honours the opt-out over every allowlist entry', () => {
    expect(BANNER_IMAGE_ENV).toBe('SPARROW_BANNER_IMAGE');
    for (const v of ['0', 'false', 'off', 'OFF', 'False']) {
      expect(imageBannerMode({ TERM: 'xterm-kitty', SPARROW_BANNER_IMAGE: v }, tty)).toBe('text');
    }
  });

  it('honours the opt-in on a TTY the allowlist cannot see (docker -t)', () => {
    for (const v of ['1', 'true', 'on', 'ON', 'True']) {
      expect(imageBannerMode({ SPARROW_BANNER_IMAGE: v }, tty)).toBe('image');
      // ...but a pipe is still a pipe, and tmux is still tmux.
      expect(imageBannerMode({ SPARROW_BANNER_IMAGE: v }, pipe)).toBe('text');
    }
    // Forced ON deliberately overrides the tmux and iTerm2 guards too: the
    // operator has said, explicitly, that this terminal can take it.
    expect(imageBannerMode({ SPARROW_BANNER_IMAGE: '1', TMUX: 'x' }, tty)).toBe('image');
  });

  it('treats an empty or unknown value as unset (compose always defines the var)', () => {
    for (const v of ['', '  ', 'maybe']) {
      expect(imageBannerMode({ TERM: 'xterm-kitty', SPARROW_BANNER_IMAGE: v }, tty)).toBe('image');
      expect(imageBannerMode({ TERM: 'xterm', SPARROW_BANNER_IMAGE: v }, tty)).toBe('text');
    }
  });
});

describe('printBanner (image mode)', () => {
  const sink = (isTTY: boolean): { out: string; isTTY: boolean; write: (s: string) => void } => {
    const s = {
      out: '',
      isTTY,
      write: (chunk: string) => {
        s.out += chunk;
      },
    };
    return s;
  };

  it('writes the image banner ONCE on an allowlisted TTY', async () => {
    const s = sink(true);
    await printBanner({ ...INFO, env: { TERM: 'xterm-kitty' }, stream: s, logging: true });
    expect(parseKitty(s.out).length).toBeGreaterThan(1);
    expect(s.out.match(/v0\.1\.43/g)).toHaveLength(1);
    expect(s.out).toContain('http://localhost:8722');
    expect(s.out.endsWith('\n')).toBe(true);
    // A TTY is coloured, so the text block below the image is painted.
    expect(s.out).toContain(`${ESC}[1m`);
  });

  it('writes the ASCII banner on a TTY that is not allowlisted', async () => {
    const s = sink(true);
    await printBanner({
      ...INFO,
      env: { TERM: 'xterm-256color' },
      stream: s,
      logging: true,
      probe: async () => false,
    });
    expect(parseKitty(s.out)).toHaveLength(0);
    expect(s.out).toContain('(o  )>');
  });

  it('never writes an image when the banner is suppressed', async () => {
    for (const env of [{ TERM: 'xterm-kitty', SPARROW_NO_BANNER: '1' }]) {
      const s = sink(true);
      await printBanner({ ...INFO, env, stream: s, logging: true });
      expect(s.out).toBe('');
    }
    const off = sink(true);
    await printBanner({ ...INFO, env: { TERM: 'xterm-kitty' }, stream: off, logging: false });
    expect(off.out).toBe('');
  });

  it('is plain text when stdout is a file, on any terminal', async () => {
    const s = sink(false);
    await printBanner({ ...INFO, env: { TERM: 'xterm-kitty' }, stream: s, logging: true });
    expect(s.out).not.toContain(ESC);
  });
});

describe('resolveBannerMode', () => {
  const tty = { isTTY: true, write: () => true };
  const pipe = { isTTY: false, write: () => true };
  /** A probe stub that records whether it ran, so "no probe" is assertable. */
  const stub = (answer: boolean): (() => Promise<boolean>) & { calls: number } => {
    const fn = Object.assign(
      async () => {
        fn.calls += 1;
        return answer;
      },
      { calls: 0 },
    );
    return fn;
  };
  const resolve = async (
    env: NodeJS.ProcessEnv,
    stdout: typeof tty,
    probe: ReturnType<typeof stub>,
  ): Promise<string> => resolveBannerMode(env, { stdout, stdin: undefined, probe });

  it('honours the force-off first, without ever writing to the terminal', async () => {
    const probe = stub(true);
    expect(await resolve({ SPARROW_BANNER_IMAGE: '0', TERM: 'xterm-kitty' }, tty, probe)).toBe(
      'text',
    );
    expect(probe.calls).toBe(0);
  });

  it('never probes a pipe: no TTY, no question', async () => {
    const probe = stub(true);
    expect(await resolve({ TERM: 'xterm' }, pipe, probe)).toBe('text');
    expect(await resolve({ SPARROW_BANNER_IMAGE: '1' }, pipe, probe)).toBe('text');
    expect(probe.calls).toBe(0);
  });

  it('honours the force-on without probing (docker run -it, operator said so)', async () => {
    const probe = stub(false);
    expect(await resolve({ SPARROW_BANNER_IMAGE: '1', TERM: 'xterm' }, tty, probe)).toBe('image');
    expect(probe.calls).toBe(0);
  });

  it('never probes inside tmux or screen: the query may never be answered', async () => {
    const probe = stub(true);
    expect(await resolve({ TMUX: '/tmp/x,1,0', TERM: 'xterm' }, tty, probe)).toBe('text');
    expect(await resolve({ TERM: 'screen.xterm-kitty' }, tty, probe)).toBe('text');
    expect(await resolve({ TERM: 'tmux-256color' }, tty, probe)).toBe('text');
    expect(probe.calls).toBe(0);
  });

  it('never probes iTerm2: it can render, but it may prompt', async () => {
    const probe = stub(true);
    expect(await resolve({ TERM_PROGRAM: 'iTerm.app' }, tty, probe)).toBe('text');
    expect(await resolve({ LC_TERMINAL: 'iTerm2' }, tty, probe)).toBe('text');
    expect(probe.calls).toBe(0);
  });

  it('takes the env allowlist as an answer and skips the probe', async () => {
    const probe = stub(false);
    for (const env of [
      { TERM: 'xterm-kitty' },
      { KITTY_WINDOW_ID: '1' },
      { TERM_PROGRAM: 'ghostty' },
      { TERM_PROGRAM: 'WezTerm' },
    ]) {
      expect(await resolve(env, tty, probe)).toBe('image');
    }
    expect(probe.calls).toBe(0);
  });

  it('asks the TERMINAL when the env says nothing — this is the docker -it case', async () => {
    // Inside `docker run -it` from Ghostty, TERM is a plain `xterm`.
    const yes = stub(true);
    expect(await resolve({ TERM: 'xterm' }, tty, yes)).toBe('image');
    expect(yes.calls).toBe(1);
    const no = stub(false);
    expect(await resolve({ TERM: 'xterm' }, tty, no)).toBe('text');
    expect(no.calls).toBe(1);
    const bare = stub(false);
    expect(await resolve({}, tty, bare)).toBe('text');
    expect(bare.calls).toBe(1);
  });

  it('lets an operator forbid the query itself, without forbidding the image', async () => {
    expect(BANNER_PROBE_ENV).toBe('SPARROW_BANNER_PROBE');
    const probe = stub(true);
    for (const v of ['0', 'false', 'off']) {
      expect(await resolve({ TERM: 'xterm', SPARROW_BANNER_PROBE: v }, tty, probe)).toBe('text');
    }
    expect(probe.calls).toBe(0);
    // ...and the allowlist still fires with the probe switched off.
    expect(
      await resolve({ TERM: 'xterm-kitty', SPARROW_BANNER_PROBE: '0' }, tty, probe),
    ).toBe('image');
    expect(probe.calls).toBe(0);
    // Empty/unknown reads as unset (compose always defines the var).
    for (const v of ['', '  ', 'maybe', '1']) {
      expect(await resolve({ TERM: 'xterm', SPARROW_BANNER_PROBE: v }, tty, probe)).toBe('image');
    }
  });

  it('hands the probe the very streams it was given', async () => {
    const seen: Array<{ stdin: unknown; stdout: unknown }> = [];
    const stdin = { isTTY: true } as unknown as NodeJS.ReadStream;
    const out = { isTTY: true, write: () => true };
    const mode = await resolveBannerMode(
      { TERM: 'xterm' },
      {
        stdin,
        stdout: out,
        probe: async (o) => {
          seen.push({ stdin: o.stdin, stdout: o.stdout });
          return true;
        },
      },
    );
    expect(mode).toBe('image');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.stdin).toBe(stdin);
    expect(seen[0]!.stdout).toBe(out);
  });

  it('agrees with the sync env-only decision wherever that one is sure', async () => {
    const probe = stub(false);
    for (const env of [
      { TERM: 'xterm-kitty' },
      { TERM: 'xterm-ghostty' },
      { GHOSTTY_RESOURCES_DIR: '/x' },
      { TERM: 'xterm-kitty', SPARROW_BANNER_IMAGE: '0' },
      { TERM_PROGRAM: 'iTerm.app' },
      { TMUX: 'x' },
    ]) {
      expect(await resolve(env, tty, probe)).toBe(imageBannerMode(env, tty));
    }
  });
});

describe('printBanner (probe path)', () => {
  const sink = (isTTY: boolean): { out: string; isTTY: boolean; write: (s: string) => void } => {
    const s = {
      out: '',
      isTTY,
      write: (chunk: string) => {
        s.out += chunk;
      },
    };
    return s;
  };

  it('draws the illustration on a terminal only the probe could vouch for', async () => {
    const s = sink(true);
    await printBanner({
      ...INFO,
      env: { TERM: 'xterm' },
      stream: s,
      logging: true,
      probe: async () => true,
    });
    expect(parseKitty(s.out).length).toBeGreaterThan(1);
    expect(s.out).toContain('http://localhost:8722');
  });

  it('draws the ASCII bird when the probe comes back empty-handed', async () => {
    const s = sink(true);
    await printBanner({
      ...INFO,
      env: { TERM: 'xterm' },
      stream: s,
      logging: true,
      probe: async () => false,
    });
    expect(parseKitty(s.out)).toHaveLength(0);
    expect(s.out).toContain('(o  )>');
  });

  it('never probes when the banner is silenced at all', async () => {
    let calls = 0;
    const s = sink(true);
    await printBanner({
      ...INFO,
      env: { TERM: 'xterm', SPARROW_NO_BANNER: '1' },
      stream: s,
      logging: true,
      probe: async () => {
        calls += 1;
        return true;
      },
    });
    expect(s.out).toBe('');
    expect(calls).toBe(0);
  });
});
