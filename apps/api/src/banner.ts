import { DEFAULT_PORT } from '@sparrow-land/sdk/types';
import { BANNER_IMAGE_PNG_BASE64 } from './banner-image.js';
import {
  IMAGE_TERMINAL_ALLOWLIST,
  type ProbeOptions,
  type ProbeStdin,
  probeKittyGraphics,
} from './banner-probe.js';
import { stripTrailingSlash } from './public-homes.js';

/**
 * The startup banner — the first thing a human sees after
 * `docker run ... ghcr.io/sparrow-land/sparrow`.
 *
 * It exists to answer one question the log lines never did: *what do I open?*
 * Everything here is therefore derived, never re-decided: the URL comes from
 * the already-resolved `config.baseUrl` (so the `BASE_URL` rule lives in ONE
 * place, `config.ts`), the docs link from `config.docsUrl` (the same home the
 * `/docs` `302`s use), and the version/build from `version.ts` — the same pair
 * `GET /healthz` reports.
 *
 * There are two renderings, both pure so they can be asserted on without a
 * server: `renderBanner` (ASCII bird, the universal one) and
 * `renderImageBanner` (the real illustration, via the kitty graphics
 * protocol).
 *
 * Choosing between them happens in two steps. `imageBannerMode` is the
 * synchronous, env-only decision: an ALLOWLIST of terminals that identify
 * themselves in the environment. `resolveBannerMode` is the full one — it
 * reuses the allowlist and, only where the env is silent, ASKS the terminal
 * itself via `probeKittyGraphics` (see `banner-probe.ts`). The probe is what
 * makes `docker run -it` work: inside a container the host terminal's env is
 * invisible, but the terminal is still on the other end of the pty and will
 * still answer a feature query. `printBanner` is the only part that touches a
 * stream.
 */

/** Env var that silences the banner (tests, scenarios, log scrapers). */
export const BANNER_OPT_OUT_ENV = 'SPARROW_NO_BANNER';

/**
 * Env var that forces the illustration on (`1`/`true`/`on`) or off
 * (`0`/`false`/`off`), overriding {@link imageBannerMode}'s allowlist.
 */
export const BANNER_IMAGE_ENV = 'SPARROW_BANNER_IMAGE';

/**
 * Env var that forbids the runtime feature query alone (`0`/`false`/`off`):
 * never write a question to the terminal, but keep every env-based rule. For
 * the operator who does not want an unexpected escape sequence on their tty
 * (a serial console, a recording, a terminal with an exotic input handler)
 * yet still wants the illustration where the allowlist can see it.
 */
export const BANNER_PROBE_ENV = 'SPARROW_BANNER_PROBE';

/**
 * A sparrow, in flight. Plain ASCII on purpose: it has to survive `docker
 * logs`, a CI capture, an SSH session on a dumb terminal and a copy-paste into
 * an issue. Four rows — small enough that it never wraps, and short enough
 * that it never pushes the URL off a cramped screen.
 */
export const SPARROW_ART: readonly string[] = [
  '        ___',
  '  \\\\\\__(o  )>',
  '      \\____/',
  '    ~~~^~~^~~~',
];

/** Two spaces of air on the left so the art never hugs the terminal edge. */
const PAD = '  ';
/** Separator between version and build, as the CLI prints it. */
const DOT = '·';

/**
 * The whole palette, and deliberately a small one: standard SGR attributes and
 * the 16-colour set only. 256-colour (`38;5;n`) and truecolor render as noise
 * on a `TERM=vt100` SSH session or a CI capture, and the banner is exactly the
 * thing an operator sees over a bad connection.
 */
const RESET = '[0m';
const DIM = '[2m';
/** Sparrow-brown for the art; basic ANSI only — 256-color is not universal. */
const FEATHER = '[33m';
/** The water under the bird — cool, so the warm bird sits on top of it. */
const WATER = '[36m';
/** The wordmark: the product's name carries the weight, nothing else. */
const WORDMARK = '[1m';
/** The version: the one fact an operator is usually squinting for. */
const VERSION = '[32m';
/** The one thing to act on, in the second accent: bold + underlined cyan. */
const LINK = '[1;4;36m';
/** Field labels ("Open", "Docs") and the docs URL: present, never competing. */
const LABEL = '[2m';

/** What the banner says about this server. */
export interface BannerInfo {
  /** Product version, as `GET /healthz` reports it. */
  version: string;
  /** Build stamp `<yyyymmdd>.<sha>`, or `null` for an unstamped build. */
  build: string | null;
  /** The URL a human should open — already passed through {@link bannerUrl}. */
  url: string;
  /** The canonical documentation home (`config.docsUrl`). */
  docsUrl: string;
  /** Emit ANSI colour. Decide with {@link useColor}; never guess at call sites. */
  color: boolean;
}

/** Wrap `text` in `code` when colouring, else return it untouched. */
function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

/**
 * A row of art is "water" when it is made of nothing but ripples. Deciding it
 * from the glyphs rather than from a row index means the bird can be redrawn
 * without a second edit here to keep the colours in step.
 */
function isWaterRow(row: string): boolean {
  return /^[~^ ]+$/.test(row) && row.includes('~');
}

/** The ASCII bird, painted: warm feathers above, a cool ripple below. */
function artLines(color: boolean): string[] {
  return SPARROW_ART.map((row) => paint(PAD + row, isWaterRow(row) ? WATER : FEATHER, color));
}

/**
 * The words: wordmark + version, then the two links. Shared verbatim between
 * the ASCII banner and the image one, so the illustration never drifts into
 * having its own, subtly different, typography.
 */
function textLines(info: BannerInfo): string[] {
  const { version, build, url, docsUrl, color } = info;
  // The version carries its own colour; the build stamp stays dim behind it.
  const stamp =
    paint(`v${version}`, VERSION, color) +
    (build ? paint(` ${DOT} build ${build}`, DIM, color) : '');
  return [
    '',
    `${PAD}${paint('Sparrow', WORDMARK, color)}   ${stamp}`,
    '',
    `${PAD}${paint('Open', LABEL, color)}   ${paint(url, LINK, color)}`,
    `${PAD}${paint('Docs', LABEL, color)}   ${paint(docsUrl, DIM, color)}`,
    '',
  ];
}

/**
 * The banner as a string, without a trailing newline.
 *
 * Colour is strictly decorative: `renderBanner({...})` with `color: true` and
 * `color: false` differ by escape sequences and nothing else, and every line
 * that opens a sequence closes it, so a truncated log can never leave a
 * terminal painted.
 */
export function renderBanner(info: BannerInfo): string {
  return ['', ...artLines(info.color), ...textLines(info)].join('\n');
}

/** Payload bytes per kitty transmission chunk — the protocol's own ceiling. */
export const KITTY_CHUNK_LIMIT = 4096;
/**
 * The placement box, in terminal cells. A cell is about twice as tall as it is
 * wide, so a square illustration needs twice as many columns as rows to come
 * out square: ten rows of bird, twenty columns.
 */
export const IMAGE_CELL_ROWS = 10;
export const IMAGE_CELL_COLS = IMAGE_CELL_ROWS * 2;

/** APC opener/closer that wraps every kitty graphics command. */
const APC = '\x1b_G';
const ST = '\x1b\\';

/**
 * One kitty-graphics "direct transmission" of a PNG, as a string.
 *
 * `f=100` says the payload is a PNG file (not raw pixels), `a=T` transmits and
 * displays it in one go, `c`/`r` scale the placement to that many cells, and
 * `C=1` tells the terminal NOT to move the cursor — we step past the image
 * ourselves with plain newlines, which is the one cursor behaviour every
 * terminal agrees on. The base64 payload is split into `KITTY_CHUNK_LIMIT`
 * pieces carrying `m=1` ("more coming") until the last, which carries `m=0`;
 * control keys ride the first chunk only, as the protocol requires, and `q=2`
 * rides every one of them.
 *
 * `q=2` is "say nothing back, not even on failure". We never read a reply to a
 * transmission, so any reply is by definition noise — and on a terminal that
 * accepted the feature query but cannot finish the transfer it is worse than
 * noise: iTerm2 3.5 printed `ENOENT:Image not found after transmission` across
 * the operator's screen (2026-09-21). Quiet is the only setting that cannot
 * leave garbage under the banner.
 */
export function renderKittyImage(
  base64: string,
  opts: { cols?: number; rows?: number } = {},
): string {
  const cols = opts.cols ?? IMAGE_CELL_COLS;
  const rows = opts.rows ?? IMAGE_CELL_ROWS;
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += KITTY_CHUNK_LIMIT) {
    chunks.push(base64.slice(i, i + KITTY_CHUNK_LIMIT));
  }
  return chunks
    .map((payload, i) => {
      const more = i === chunks.length - 1 ? 0 : 1;
      const keys =
        i === 0 ? `f=100,a=T,C=1,c=${cols},r=${rows},q=2,m=${more}` : `q=2,m=${more}`;
      return `${APC}${keys};${payload}${ST}`;
    })
    .join('');
}

/**
 * The banner with the real illustration instead of the ASCII bird.
 *
 * Only ever reached through {@link imageBannerMode}, i.e. on a terminal we
 * KNOW speaks this protocol without prompting. The text block is printed
 * below the image rather than beside it: putting it to the right would mean
 * cursor-positioning escapes whose interaction with wrapping and scrollback
 * differs per terminal, and a banner is not the place to be clever.
 */
export function renderImageBanner(info: BannerInfo): string {
  const image = `${PAD}${renderKittyImage(BANNER_IMAGE_PNG_BASE64)}`;
  // C=1 left the cursor where it started, so walk it past the image's rows.
  const clear = '\n'.repeat(IMAGE_CELL_ROWS);
  return `\n${image}${clear}${textLines(info).join('\n')}`;
}

/**
 * Bind addresses a browser cannot open. The container listens on `0.0.0.0` so
 * that published ports work at all, but telling a human to visit `0.0.0.0:8722`
 * is telling them to visit nothing.
 */
const UNROUTABLE_HOSTS = new Set(['0.0.0.0', '::', '[::]', '[::0]', '0']);

/**
 * The URL to print, from the server's already-resolved public origin.
 *
 * `config.baseUrl` is `BASE_URL` when the operator set one and
 * `http://localhost:<PORT>` otherwise — that rule is `config.ts`'s, not this
 * module's. All this adds is the bind-address guard and a trailing-slash trim.
 */
export function bannerUrl(baseUrl: string): string {
  const raw = stripTrailingSlash((baseUrl ?? '').trim());
  if (!raw) return `http://localhost:${DEFAULT_PORT}`;
  try {
    const parsed = new URL(raw);
    if (!UNROUTABLE_HOSTS.has(parsed.hostname)) return raw;
    parsed.hostname = 'localhost';
    return stripTrailingSlash(parsed.toString());
  } catch {
    return raw;
  }
}

/** An env var is "set" only when it holds something meaningful. */
function envFlag(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/**
 * Whether to print the banner at all.
 *
 * Two ways to silence it: {@link BANNER_OPT_OUT_ENV}, and a logger that is off.
 * The second matters because SPEC promises `LOG_LEVEL=off` is really silent —
 * a banner that ignored it would be the same lie a stray `console.log` once was.
 * An empty value reads as unset: compose's `${SPARROW_NO_BANNER:-}` always
 * defines the variable.
 */
export function bannerEnabled(
  env: NodeJS.ProcessEnv,
  opts: { logging: boolean },
): boolean {
  if (!opts.logging) return false;
  return !envFlag(env[BANNER_OPT_OUT_ENV]);
}

/**
 * Whether to colour: a TTY, with `NO_COLOR` unset. `FORCE_COLOR` opts a pipe
 * in (CI capturing a pretty log on purpose); `NO_COLOR` always wins.
 * `docker logs` and `docker run` without `-t` get plain text.
 */
export function useColor(env: NodeJS.ProcessEnv, stream: { isTTY?: boolean }): boolean {
  if (envFlag(env.NO_COLOR)) return false;
  if (env.FORCE_COLOR !== undefined) return envFlag(env.FORCE_COLOR);
  return stream.isTTY === true;
}

/** Which rendering to use: the illustration, or the ASCII bird. */
export type BannerImageMode = 'image' | 'text';

/** An env var that is present at all (empty reads as absent, as in compose). */
function envPresent(value: string | undefined): boolean {
  return (value ?? '').trim() !== '';
}

/** `1|true|on` → true, `0|false|off` → false, anything else → undefined. */
function envTristate(value: string | undefined): boolean | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return undefined;
}

/** `TERM`, normalised: lower-cased and trimmed. */
function termName(env: NodeJS.ProcessEnv): string {
  return (env.TERM ?? '').trim().toLowerCase();
}

/** `TERM_PROGRAM`, normalised. */
function termProgram(env: NodeJS.ProcessEnv): string {
  return (env.TERM_PROGRAM ?? '').trim().toLowerCase();
}

/**
 * Inside tmux or screen. Both need `allow-passthrough` configured to carry a
 * graphics escape at all, and both mangle the image on redraw when it is not —
 * and a feature query sent into an unconfigured multiplexer may never be
 * answered, which is why this also means "do not probe".
 */
function inMultiplexer(env: NodeJS.ProcessEnv): boolean {
  const term = termName(env);
  return envPresent(env.TMUX) || term.startsWith('screen') || term.startsWith('tmux');
}

/**
 * iTerm2, which can render kitty graphics in recent versions but may show a
 * permission prompt for inline images. A startup banner that asks the operator
 * a question is worse than a startup banner made of ASCII, so: never.
 */
function isIterm2(env: NodeJS.ProcessEnv): boolean {
  return (
    termProgram(env) === 'iterm.app' || (env.LC_TERMINAL ?? '').trim().toLowerCase() === 'iterm2'
  );
}

/**
 * A terminal that names itself in the environment as one we trust.
 *
 * The roster is {@link IMAGE_TERMINAL_ALLOWLIST}, shared with the probe: the
 * env half of the decision recognises these three by their own variables, the
 * runtime half recognises the same three by their XTVERSION name, and neither
 * list can drift without the other.
 */
function onImageAllowlist(env: NodeJS.ProcessEnv): boolean {
  const term = termName(env);
  const program = termProgram(env);
  const byEnv: Record<(typeof IMAGE_TERMINAL_ALLOWLIST)[number], boolean> = {
    kitty: term === 'xterm-kitty' || envPresent(env.KITTY_WINDOW_ID),
    ghostty:
      program === 'ghostty' || term === 'xterm-ghostty' || envPresent(env.GHOSTTY_RESOURCES_DIR),
    wezterm: program === 'wezterm',
  };
  return IMAGE_TERMINAL_ALLOWLIST.some((name) => byEnv[name]);
}

/**
 * Whether to draw the real illustration, and the rule is deliberately timid:
 * show it only where we KNOW the kitty graphics protocol works AND know it
 * will not interrogate the user. Everything else gets the ASCII bird, which
 * is never wrong anywhere.
 *
 * This is the ENV-ONLY half of the decision, and it is an ALLOWLIST of
 * terminals identified by their own env vars — never a heuristic. It stays
 * synchronous and side-effect free, which is what lets it be the fast path
 * inside {@link resolveBannerMode}; the runtime feature query that covers the
 * terminals the env cannot name lives there, not here.
 *
 * The rules, in order:
 *  - `SPARROW_BANNER_IMAGE=0|false|off` forces text, always.
 *  - stdout must be a real TTY (the same check colour makes — though unlike
 *    colour, `FORCE_COLOR` does NOT opt a pipe in: bytes in a log file are not
 *    a picture). `NO_COLOR` is about colour and says nothing about images.
 *  - `SPARROW_BANNER_IMAGE=1|true|on` forces the image on that TTY. This is
 *    for `docker run -it`: inside the container the host terminal's `TERM`/
 *    `TERM_PROGRAM` are invisible, so the allowlist cannot fire and the
 *    operator has to say so themselves.
 *  - tmux and screen are out. Both need passthrough to be configured
 *    (`allow-passthrough`) and both mangle the image on redraw when it is not.
 *  - iTerm2 is EXPLICITLY out, even though recent versions can render kitty
 *    graphics: it may show a permission/confirmation prompt for inline images,
 *    and a startup banner that asks the operator a question is worse than a
 *    startup banner made of ASCII.
 */
export function imageBannerMode(
  env: NodeJS.ProcessEnv,
  stream: { isTTY?: boolean },
): BannerImageMode {
  const forced = envTristate(env[BANNER_IMAGE_ENV]);
  if (forced === false) return 'text';
  if (stream.isTTY !== true) return 'text';
  if (forced === true) return 'image';

  if (inMultiplexer(env)) return 'text';
  if (isIterm2(env)) return 'text';
  return onImageAllowlist(env) ? 'image' : 'text';
}

/** A stdout-shaped sink: all `printBanner` needs, and all a test has to fake. */
export interface BannerStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** The probe, as an injectable dependency — so tests need no real TTY. */
export type KittyProbe = (opts: ProbeOptions) => Promise<boolean>;

export interface ResolveBannerModeOptions {
  /** Where the answer comes back. Defaults to `process.stdin`. */
  stdin?: ProbeStdin;
  /** Where the banner (and the query) goes. Defaults to `process.stdout`. */
  stdout?: BannerStream;
  /** Injectable for tests; defaults to the real {@link probeKittyGraphics}. */
  probe?: KittyProbe;
  /** Passed through to the probe; defaults to its own 500 ms. */
  probeTimeoutMs?: number;
}

/**
 * The full decision: illustration or ASCII bird, asking the terminal when —
 * and only when — the environment has nothing to say.
 *
 * In order, and the order is the point:
 *  1. `SPARROW_BANNER_IMAGE=0|false|off` — text, always. An operator's "no" is
 *     never worth a question to the terminal.
 *  2. stdout is not a TTY — text. Bytes in a log file are not a picture, and
 *     there is nobody there to answer a query.
 *  3. `SPARROW_BANNER_IMAGE=1|true|on` — image, and no probe: the operator has
 *     already said this terminal can take it.
 *  4. tmux/screen — text, and NO probe: passthrough is unreliable, and a query
 *     sent into an unconfigured multiplexer may never come back at all.
 *  5. iTerm2 — text, and no probe: it can render, but it may prompt.
 *  6. The env allowlist (kitty, Ghostty, WezTerm) — image, no probe needed.
 *  7. Otherwise, ask: {@link probeKittyGraphics} decides.
 *
 * Why step 7 is safe without an allowlist entry. The probe asks TWO questions:
 * the `a=q` feature query, which a terminal that implements the protocol
 * answers `OK` to while drawing nothing, and XTVERSION, which makes it say what
 * it is called. It reports yes only when the `OK` comes from one of the same
 * three terminals the env allowlist names. `OK` alone would not do: iTerm2 3.5
 * answers the query `OK`, then fails the actual transmission
 * (`ENOENT:Image not found after transmission`) and leaves a blank hole —
 * inside a container `TERM_PROGRAM` is invisible, so step 5 cannot catch it and
 * the name is the only thing that can. So a positive probe still satisfies the
 * original rule — renders it, and will not prompt — for terminals the
 * environment cannot name. That is precisely the `docker run -it` case: a
 * Ghostty user whose container sees `TERM=xterm` now gets the illustration.
 *
 * `SPARROW_BANNER_PROBE=0` opts out of step 7 alone, leaving 1-6 intact.
 */
export async function resolveBannerMode(
  env: NodeJS.ProcessEnv,
  opts: ResolveBannerModeOptions = {},
): Promise<BannerImageMode> {
  const stdout = opts.stdout ?? process.stdout;
  const forced = envTristate(env[BANNER_IMAGE_ENV]);
  if (forced === false) return 'text';
  if (stdout.isTTY !== true) return 'text';
  if (forced === true) return 'image';

  if (inMultiplexer(env)) return 'text';
  if (isIterm2(env)) return 'text';
  // The env-only decision is the fast path, and stays the single home of the
  // allowlist: reuse it rather than restating which terminals are on it.
  if (imageBannerMode(env, stdout) === 'image') return 'image';

  if (envTristate(env[BANNER_PROBE_ENV]) === false) return 'text';
  const probe = opts.probe ?? probeKittyGraphics;
  return (await probe({
    stdin: opts.stdin ?? process.stdin,
    stdout,
    timeoutMs: opts.probeTimeoutMs,
  }))
    ? 'image'
    : 'text';
}

export interface PrintBannerOptions extends Omit<BannerInfo, 'color'> {
  env?: NodeJS.ProcessEnv;
  stream?: BannerStream;
  /** Where a feature query is answered. Defaults to `process.stdin`. */
  stdin?: ProbeStdin;
  /** Injectable probe, for tests. */
  probe?: KittyProbe;
  /** `false` when the server's logger is off — see {@link bannerEnabled}. */
  logging: boolean;
}

/**
 * Write the banner to `stream` (default stdout) exactly once, or write nothing
 * at all. Called from the entrypoint the moment `listen()` resolves, so it
 * lands above the ordinary log lines rather than buried in them.
 *
 * Async only because of the feature query in {@link resolveBannerMode}: on
 * every path that does not probe it still resolves within a microtask, and
 * when it does probe it costs at most the probe's 500 ms. The suppression
 * check comes FIRST, so a silenced banner never writes a query either.
 */
export async function printBanner(opts: PrintBannerOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const stream = opts.stream ?? process.stdout;
  if (!bannerEnabled(env, { logging: opts.logging })) return;
  const color = useColor(env, stream);
  const mode = await resolveBannerMode(env, {
    stdin: opts.stdin,
    stdout: stream,
    probe: opts.probe,
  });
  const render = mode === 'image' ? renderImageBanner : renderBanner;
  stream.write(`${render({ ...opts, color })}\n`);
}
