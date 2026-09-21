import { DEFAULT_PORT } from '@sparrow-land/sdk/types';
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
 * Rendering is pure (`renderBanner`) so it can be asserted on without a server;
 * `printBanner` is the only part that touches a stream.
 */

/** Env var that silences the banner (tests, scenarios, log scrapers). */
export const BANNER_OPT_OUT_ENV = 'SPARROW_NO_BANNER';

/**
 * A sparrow, perched. Plain ASCII on purpose: it has to survive `docker logs`,
 * a CI capture, an SSH session on a dumb terminal and a copy-paste into an
 * issue. Nine rows, thirty columns — small enough that it never wraps.
 */
export const SPARROW_ART: readonly string[] = [
  "         .-''-.",
  "       .'      `.",
  ' __   /    o     \\',
  '<__\\ |             `--.._',
  '      \\                  `--._',
  "       `.        __..--''''",
  "         `-.__.-'",
  '          |  |',
  '    ~~~~~~^~~^~~~~~~~~~~',
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
/** The wordmark: the product's name carries the weight, nothing else. */
const WORDMARK = '[1m';
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
 * The banner as a string, without a trailing newline.
 *
 * Colour is strictly decorative: `renderBanner({...})` with `color: true` and
 * `color: false` differ by escape sequences and nothing else, and every line
 * that opens a sequence closes it, so a truncated log can never leave a
 * terminal painted.
 */
export function renderBanner(info: BannerInfo): string {
  const { version, build, url, docsUrl, color } = info;
  const stamp = build ? `v${version} ${DOT} build ${build}` : `v${version}`;
  const lines = [
    '',
    ...SPARROW_ART.map((row) => paint(PAD + row, FEATHER, color)),
    '',
    `${PAD}${paint('Sparrow', WORDMARK, color)}   ${paint(stamp, DIM, color)}`,
    '',
    `${PAD}${paint('Open', LABEL, color)}   ${paint(url, LINK, color)}`,
    `${PAD}${paint('Docs', LABEL, color)}   ${paint(docsUrl, DIM, color)}`,
    '',
  ];
  return lines.join('\n');
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

/** A stdout-shaped sink: all `printBanner` needs, and all a test has to fake. */
export interface BannerStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface PrintBannerOptions extends Omit<BannerInfo, 'color'> {
  env?: NodeJS.ProcessEnv;
  stream?: BannerStream;
  /** `false` when the server's logger is off — see {@link bannerEnabled}. */
  logging: boolean;
}

/**
 * Write the banner to `stream` (default stdout) exactly once, or write nothing
 * at all. Called from the entrypoint the moment `listen()` resolves, so it
 * lands above the ordinary log lines rather than buried in them.
 */
export function printBanner(opts: PrintBannerOptions): void {
  const env = opts.env ?? process.env;
  const stream = opts.stream ?? process.stdout;
  if (!bannerEnabled(env, { logging: opts.logging })) return;
  const color = useColor(env, stream);
  stream.write(`${renderBanner({ ...opts, color })}\n`);
}
