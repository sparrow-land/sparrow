/**
 * Client-version utilities shared by the server (the upgrade gate + the
 * `upgrade-your-cli` hint) and the clients (CLI `--version`, MCP `serverInfo`,
 * the `whoami` skew note). Deliberately tiny and dependency-free so both the
 * browser client bundle and the Node server can import it.
 *
 * A client identifies itself with an `X-Sparrow-Client: <product>/<version>`
 * header, e.g. `sparrow-cli/0.1.0+20260831.abc1234`. The version is "semver-ish":
 * only the leading `x.y.z` numeric prefix is significant — any `+build` metadata
 * (and any `-pre` tag) is ignored for comparison. Anything that does not parse to
 * at least a numeric major is treated as UNKNOWN, and unknown clients are never
 * gated or hinted (the policy targets known-old clients, not unrecognized ones).
 */

/**
 * The canonical package version stamped into `<version>+dev` for non-bundled runs
 * (bundled builds stamp the ROOT package.json version + build metadata). Keep it
 * in step with the root `package.json`.
 *
 * **Bump the PATCH whenever a client-behavior fix must be adopted by deployed
 * clients.** Build metadata is invisible to the gate — every `0.1.0+<date>.<sha>`
 * compares EQUAL — so `CLIENT_MIN_VERSION` can only push agents off a broken
 * build if the fixed build carries a higher `x.y.z`. 0.1.1 is the events-cursor
 * gap-heal fix (a stale cursor could silently swallow every live event).
 */
export const CLIENT_VERSION = '0.1.1';

/** A parsed `x.y.z` version prefix. */
export interface SemVerParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse the leading `x.y.z` numeric prefix of a version string, ignoring any
 * `+build` / `-pre` suffix. Returns `null` when there is no numeric major (an
 * unrecognized/garbage version — treated as UNKNOWN by callers). Missing minor
 * or patch default to `0` (`"2"` → `2.0.0`, `"2.3"` → `2.3.0`).
 */
export function parseClientVersion(raw: string | undefined): SemVerParts | null {
  if (!raw) return null;
  // Strip build (`+…`) and pre-release (`-…`) metadata, then keep the core.
  const core = raw.trim().split('+')[0]!.split('-')[0]!.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(core);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  };
}

/** Compare two parsed versions: `-1` if a<b, `0` if equal, `1` if a>b. */
export function compareParts(a: SemVerParts, b: SemVerParts): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Compare two version STRINGS on their `x.y.z` prefix (build metadata ignored).
 * Returns `-1|0|1`, or `undefined` when either side is unparseable — the signal
 * callers use to leave unknown clients ungated.
 */
export function compareClientVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const pa = parseClientVersion(a);
  const pb = parseClientVersion(b);
  if (!pa || !pb) return undefined;
  return compareParts(pa, pb);
}

/**
 * Whether `current` is strictly BELOW `floor` (both compared on their `x.y.z`
 * prefix). An unparseable `current` (unknown client) or `floor` returns `false`
 * — unknown clients pass, and a mis-set floor never gates anyone.
 */
export function clientVersionBelow(current: string, floor: string): boolean {
  return compareClientVersions(current, floor) === -1;
}

/** A parsed `X-Sparrow-Client` header value: the product name and its version. */
export interface ClientIdent {
  /** e.g. `sparrow-cli` or `sparrow-mcp`. */
  product: string;
  /** The raw version token after the slash, e.g. `0.1.0+20260831.abc1234`. */
  version: string;
}

/**
 * Parse an `X-Sparrow-Client` header (`<product>/<version>`). Returns `undefined`
 * for an absent or malformed value (no slash, empty half) — an unknown client the
 * gate/hint must leave alone.
 */
export function parseClientIdent(header: string | undefined): ClientIdent | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  const product = raw.slice(0, slash).trim();
  const version = raw.slice(slash + 1).trim();
  if (!product || !version) return undefined;
  return { product, version };
}

/**
 * The number of MINOR versions (within the same major) that `newer` is ahead of
 * `older`, or `0` when it is not ahead at the minor+ granularity. A jump in MAJOR
 * counts as "ahead" and returns a large positive number (Infinity-ish is avoided;
 * a major bump returns `newer.major - older.major` scaled so it always reads as a
 * gap ≥ 1). Used by the CLI `whoami` skew note ("server is older than this
 * client"). Returns `0` when either side is unparseable.
 */
export function minorVersionsAhead(newer: string, older: string): number {
  const a = parseClientVersion(newer);
  const b = parseClientVersion(older);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? (a.major - b.major) * 1000 : 0;
  return a.minor > b.minor ? a.minor - b.minor : 0;
}
