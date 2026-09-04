/**
 * Startup configuration resolution for the MCP server.
 *
 * Precedence (per SPEC.md MCP section): the `SPARROW_SERVER` / `SPARROW_TOKEN`
 * environment variables take precedence over the shared credential store;
 * otherwise the profile named by `SPARROW_PROFILE` (or the store's
 * `defaultProfile`) is used. `SPARROW_ROOM` selects the default room and
 * `SPARROW_ORG` the default org for room-/org-scoped tools.
 *
 * A `server` is required to start (tools like `enroll` still work without a
 * token). If nothing resolves a server, `resolveConfig` throws `ConfigError`
 * with an actionable message; `bin.ts` prints it to stderr and exits non-zero.
 */
import { resolveProfile, type ProfileKind } from './credentials.js';

export type Env = Record<string, string | undefined>;

export interface ResolvedConfig {
  server: string;
  /** A `ses_` session token or an `agk_` agent key; absent when unauthenticated. */
  token?: string;
  /** The credential kind, when known (from the `agk_`/`ses_` prefix or the profile). */
  kind?: ProfileKind;
  /** Default room id for room-scoped tools (`SPARROW_ROOM`). */
  roomId?: string;
  /** Default org id for org-scoped tools (`SPARROW_ORG`). */
  orgId?: string;
  /** Where the config came from, for diagnostics. */
  source: 'env' | 'profile' | 'mixed';
  profileName?: string;
}

/** Thrown when startup configuration cannot be resolved. */
export class ConfigError extends Error {}

function clean(v: string | undefined): string | undefined {
  return v && v.trim() !== '' ? v : undefined;
}

/** Infer a credential kind from the token prefix (`agk_` → agent, `ses_` → human). */
function kindFromToken(token: string | undefined): ProfileKind | undefined {
  if (!token) return undefined;
  if (token.startsWith('agk_')) return 'agent';
  if (token.startsWith('ses_')) return 'human';
  return undefined;
}

export function resolveConfig(env: Env): ResolvedConfig {
  const found = resolveProfile(env, clean(env.SPARROW_PROFILE));
  const profile = found?.profile;

  const envServer = clean(env.SPARROW_SERVER);
  const envToken = clean(env.SPARROW_TOKEN);

  const server = envServer ?? profile?.server;
  const token = envToken ?? profile?.token;

  if (!server) {
    throw new ConfigError(
      'sparrow MCP: no server configured. Set SPARROW_SERVER (+ SPARROW_TOKEN) in the ' +
        'MCP server env, or run `sparrow enroll <invite-url>` (or the `enroll` tool) ' +
        'to create a credential profile (~/.config/sparrow/credentials.json), or ' +
        'select one with SPARROW_PROFILE.',
    );
  }

  // Kind follows the live token: the env token's prefix wins, else the profile.
  const kind = token === undefined ? undefined : (kindFromToken(token) ?? profile?.kind);

  const roomId = clean(env.SPARROW_ROOM);
  const orgId = clean(env.SPARROW_ORG);

  // Report where each half came from (mostly for logs/tests).
  const serverFromEnv = envServer !== undefined && server === envServer;
  const tokenFromEnv = token !== undefined && token === envToken;
  let source: ResolvedConfig['source'];
  if (serverFromEnv && (token === undefined || tokenFromEnv)) source = 'env';
  else if (!serverFromEnv && !tokenFromEnv) source = 'profile';
  else source = 'mixed';

  return { server, token, kind, roomId, orgId, source, profileName: found?.name };
}
