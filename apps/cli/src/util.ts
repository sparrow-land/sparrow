/** Small formatting + resolution helpers for the CLI. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SparrowClient, ApiError, clientBuildVersion } from '@sparrow/client';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  type AttachmentInput,
  type Member,
  type MePrincipal,
  type VisibilityAgent,
} from '@sparrow/common-types';
import { resolveProfile, type Profile } from './credentials.js';
import { getProfileState } from './state.js';

export type Env = Record<string, string | undefined>;

/** Thrown for user-facing CLI errors (missing config, bad args). Exit code 1. */
export class CliError extends Error {}

/**
 * The CLI's `X-Sparrow-Client` self-identification, e.g.
 * `sparrow-cli/0.1.0+20260831.abc1234`. Passed as `clientIdent` on every client
 * the CLI builds so the server can advertise upgrades and enforce a minimum.
 */
export const CLI_CLIENT_IDENT = `sparrow-cli/${clientBuildVersion()}`;

const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.js': 'text/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

/** Minimal content-type inference from a filename extension. */
export function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

const MB = 1024 * 1024;

/**
 * Read `--attach` files into the attachment refs a send/reply carries. Enforces
 * the server's limits up front with friendly errors — ≤8 files, ≤5 MB each,
 * ≤20 MB combined — so an oversize attach fails clearly on the client instead of
 * bouncing off the server as a raw `payload_too_large`. Content type is inferred
 * from the extension (common image types included). Encoding runs through
 * {@link SparrowClient.uploadAttachment}, the same path any client uses.
 *
 * `roomId` names the room the caller intends to send into; it is `null` for
 * EMAIL, which binds attachments to an email rather than a room (see
 * {@link buildEmailAttachments}). The client's encoder does not read it either
 * way — attachments travel with the subsequent send, in both mediums.
 */
export async function buildAttachments(
  client: SparrowClient,
  roomId: string | null,
  files: string[],
): Promise<AttachmentInput[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_ATTACHMENTS) {
    throw new CliError(`You can attach up to ${MAX_ATTACHMENTS} files (got ${files.length}).`);
  }
  const refs: AttachmentInput[] = [];
  let total = 0;
  for (const f of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(f);
    } catch {
      throw new CliError(`Cannot read attachment "${f}".`);
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new CliError(
        `Attachment "${f}" is ${(bytes.length / MB).toFixed(1)} MB; ` +
          `the limit is ${Math.round(MAX_ATTACHMENT_BYTES / MB)} MB per file.`,
      );
    }
    total += bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new CliError(
        `Attachments total more than ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / MB)} MB combined.`,
      );
    }
    refs.push(
      await client.uploadAttachment(roomId ?? '', {
        filename: path.basename(f),
        contentType: inferContentType(f),
        bytes,
      }),
    );
  }
  return refs;
}

/**
 * `--attach` for the EMAIL medium. An email hangs off an agent's principal, not
 * a room, so there is no room to name — the limits, the content-type inference
 * and the encoding are otherwise identical to a chat send.
 */
export function buildEmailAttachments(
  client: SparrowClient,
  files: string[],
): Promise<AttachmentInput[]> {
  return buildAttachments(client, null, files);
}

export interface GlobalOpts {
  json?: boolean;
  profile?: string;
  server?: string;
  /** Room selector (id or name): `--room`. */
  room?: string;
  /** Org selector (id or slug): `--org`. */
  org?: string;
}

export interface ResolvedClient {
  client: SparrowClient;
  server: string;
  token?: string;
  profileName?: string;
  kind?: 'human' | 'agent';
}

/**
 * Build a client from `--server`/`--profile`, env overrides (`SPARROW_SERVER`,
 * `SPARROW_TOKEN`, `SPARROW_PROFILE`) and the credential store. `requireToken`
 * enforces that a credential is available (all but a bare `--server` call).
 */
export function buildClient(opts: GlobalOpts, env: Env, requireToken = true): ResolvedClient {
  const found = resolveProfile(env, opts.profile ?? env.SPARROW_PROFILE);
  const profile = found?.profile;
  const server = opts.server ?? env.SPARROW_SERVER ?? profile?.server;
  const token = env.SPARROW_TOKEN ?? profile?.token;

  if (!server) {
    throw new CliError(
      'No server configured. Run `sparrow login` / `sparrow login-agent` first, or pass ' +
        '--server (or set SPARROW_SERVER).',
    );
  }
  if (requireToken && !token) {
    throw new CliError(
      'Not authenticated. Run `sparrow login` / `sparrow login-agent` / `sparrow enroll` first, ' +
        'or set SPARROW_TOKEN.',
    );
  }
  const client = new SparrowClient({ server, token, clientIdent: CLI_CLIENT_IDENT });
  return { client, server, token, profileName: found?.name, kind: profile?.kind };
}

/** The active credential profile name (explicit `--profile`/`SPARROW_PROFILE`, else the default). */
export function activeProfileName(opts: GlobalOpts, env: Env): string | undefined {
  return resolveProfile(env, opts.profile ?? env.SPARROW_PROFILE)?.name;
}

/**
 * Effective room selector, in precedence order: `--room` flag > `SPARROW_ROOM` env >
 * the active profile's sticky `defaultRoom` (`sparrow use`). `undefined` when none
 * of the three is set (callers then aggregate over `/me/*`).
 */
export function roomSelector(opts: GlobalOpts, env: Env): string | undefined {
  if (opts.room) return opts.room;
  if (env.SPARROW_ROOM) return env.SPARROW_ROOM;
  const name = activeProfileName(opts, env);
  return name ? getProfileState(env, name).defaultRoom : undefined;
}

/**
 * Effective org selector, in precedence order: `--org` flag > `SPARROW_ORG` env >
 * the active profile's sticky `defaultOrg` (`sparrow use`). `undefined` when none set.
 */
export function orgSelector(opts: GlobalOpts, env: Env): string | undefined {
  if (opts.org) return opts.org;
  if (env.SPARROW_ORG) return env.SPARROW_ORG;
  const name = activeProfileName(opts, env);
  return name ? getProfileState(env, name).defaultOrg : undefined;
}

/**
 * Resolve a `--room` / `SPARROW_ROOM` / profile-default selector (a room id or a room
 * name) to a room id. Ids (`room_…`) pass through; names resolve via
 * `GET /me/rooms`, and an ambiguous name errors listing the matching ids.
 */
export async function resolveRoom(client: SparrowClient, opts: GlobalOpts, env: Env): Promise<string> {
  const selector = roomSelector(opts, env);
  if (!selector) {
    throw new CliError(
      'This command acts in a room. Pass --room <roomId|name> (or set SPARROW_ROOM); ' +
        'run `sparrow rooms` to list them.',
    );
  }
  if (/^room_/.test(selector)) return selector;
  const rooms = await client.meRooms();
  const byId = rooms.find((r) => r.room.id === selector);
  if (byId) return byId.room.id;
  const byName = rooms.filter((r) => r.room.name === selector);
  if (byName.length === 1) return byName[0]!.room.id;
  if (byName.length > 1) {
    const ids = byName.map((r) => r.room.id).join(', ');
    throw new CliError(
      `Ambiguous room name "${selector}"; matches ${byName.length} rooms: ${ids}. ` +
        'Pass the room id instead.',
    );
  }
  throw new CliError(
    `No room "${selector}" among your memberships. Run \`sparrow rooms\` to list them.`,
  );
}

/** True for the auth refusals a session-only surface gives an agent key. */
function isAuthRefusal(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

/**
 * Resolve a `--org` / `SPARROW_ORG` selector (an org id or slug) to an org id. Ids
 * (`org_…`) pass through; a slug resolves via `GET /me/orgs`. When no selector is
 * given and the caller has exactly one org, that org is used automatically.
 *
 * `GET /me/orgs` is a SESSION-only surface — org membership is a human concept —
 * so an agent key is refused there. An agent belongs to exactly one org and
 * `GET /me` carries it, so we fall back to that rather than surfacing a bare
 * `401 Sign-in required` from a call the user never made.
 */
export async function resolveOrg(client: SparrowClient, opts: GlobalOpts, env: Env): Promise<string> {
  const selector = orgSelector(opts, env);
  if (selector && /^org_/.test(selector)) return selector;
  let orgs;
  try {
    orgs = await client.meOrgs();
  } catch (e) {
    if (!isAuthRefusal(e)) throw e;
    // Ask who we are. A dead credential rethrows its own honest error here; a
    // live agent key answers with its single org.
    const me = await client.me();
    if (me.type !== 'agent') throw e;
    if (selector && selector !== me.orgId) {
      throw new CliError(`No org "${selector}" among your orgs. You belong to ${me.orgId}.`);
    }
    return me.orgId;
  }
  if (selector) {
    const match = orgs.find((o) => o.org.id === selector || o.org.slug === selector);
    if (match) return match.org.id;
    const avail = orgs.map((o) => `${o.org.slug} (${o.org.id})`).join(', ') || '(none)';
    throw new CliError(`No org "${selector}" among your orgs. Available: ${avail}.`);
  }
  if (orgs.length === 1) return orgs[0]!.org.id;
  if (orgs.length === 0) throw new CliError('You are not a member of any org.');
  const list = orgs.map((o) => `${o.org.slug} (${o.org.id})`).join(', ');
  throw new CliError(`You belong to multiple orgs; pass --org <id|slug>: ${list}.`);
}

/**
 * {@link resolveOrg} for the commands where `--org` NARROWS rather than names:
 * `rooms`, `agents`, `inbox`, `dm`, … Those aggregate over every org when no
 * selector is set, so "no selector" must stay `undefined` (don't narrow) rather
 * than becoming "your single org".
 *
 * The reason it exists at all: the server matches org IDs, so passing the raw
 * selector meant a SLUG filtered everything out — empty output, exit 0, no
 * error. Going through `resolveOrg` turns a slug into the id and a typo into
 * the loud "No org …" the user can act on.
 */
export async function resolveOrgOptional(
  client: SparrowClient,
  opts: GlobalOpts,
  env: Env,
): Promise<string | undefined> {
  if (!orgSelector(opts, env)) return undefined;
  return resolveOrg(client, opts, env);
}

/**
 * Resolve an agent selector (an `agt_…` id or an agent name) to a visibility
 * entry from `GET /me/agents`. Names match case-insensitively across the caller's
 * visible agents (optionally narrowed to `org`); ambiguity errors listing ids.
 */
export async function resolveAgent(
  client: SparrowClient,
  selector: string,
  org?: string,
): Promise<VisibilityAgent> {
  const agents = await client.listAgents(org ? { org } : undefined);
  if (/^agt_/.test(selector)) {
    const byId = agents.find((a) => a.agent.id === selector);
    if (byId) return byId;
    throw new CliError(`No agent ${selector} is visible to you.`);
  }
  const matches = agents.filter((a) => a.agent.name.toLowerCase() === selector.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const ids = matches.map((a) => a.agent.id).join(', ');
    throw new CliError(
      `Ambiguous agent name "${selector}"; matches ${matches.length}: ${ids}. ` +
        'Pass the agent id instead.',
    );
  }
  throw new CliError(`No agent "${selector}" is visible to you. Run \`sparrow agents\` to list them.`);
}

/**
 * A principal a CLI selector resolved to — enough for every caller: the id to act
 * on, the name to echo, and the org the resolution happened in.
 */
export interface ResolvedPrincipal {
  /** `agt_…` / `usr_…`. */
  id: string;
  kind: 'human' | 'agent';
  /** Best known display name; the selector itself when only an id was given. */
  name: string;
  orgId: string;
}

/** Pages `GET /rooms/:id/members` (bounded), so a big room can't hide a match. */
async function allMembers(client: SparrowClient, roomId: string): Promise<Member[]> {
  const out: Member[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await client.listMembers(roomId, { limit: 100, cursor });
    out.push(...res.items);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

/**
 * Name → principal for an AGENT caller.
 *
 * An agent has no visibility list (`GET /me/agents` is session-only, and being
 * refused there masked the command's real semantics behind a `401`). It resolves
 * names from the two surfaces it legitimately has:
 *
 *  1. its OWNER, carried on `GET /me` — the dominant case (`sparrow dm <owner>`),
 *     and the one where no shared room exists yet. The owner's name wins outright;
 *  2. its rooms' member lists (`GET /me/rooms` → `GET /rooms/:id/members`),
 *     matched case-insensitively on `displayName` and deduped by principal id
 *     across rooms. Its own membership row is skipped — never a useful target.
 *
 * Ambiguity errors listing the ids, the same convention {@link resolveRoom} uses.
 * A `agt_`/`usr_` id passes straight through: the ROUTE is the authority on
 * whether the caller may act on it, and it gives an honest answer.
 */
async function resolveAsAgent(
  client: SparrowClient,
  me: Extract<MePrincipal, { type: 'agent' }>,
  selector: string,
  org?: string,
): Promise<ResolvedPrincipal> {
  if (/^(agt_|usr_)/.test(selector)) {
    return {
      id: selector,
      kind: selector.startsWith('usr_') ? 'human' : 'agent',
      name: selector,
      orgId: me.orgId,
    };
  }
  if (me.owner.displayName.toLowerCase() === selector.toLowerCase()) {
    return { id: me.owner.id, kind: 'human', name: me.owner.displayName, orgId: me.orgId };
  }
  const rooms = await client.meRooms(org ? { org } : undefined);
  const hits = new Map<string, ResolvedPrincipal>();
  for (const r of rooms) {
    let members: Member[];
    try {
      members = await allMembers(client, r.room.id);
    } catch {
      continue; // a room that won't list members simply contributes nothing
    }
    for (const m of members) {
      if (m.principalId === me.id) continue;
      if (m.displayName.toLowerCase() !== selector.toLowerCase()) continue;
      if (!hits.has(m.principalId)) {
        hits.set(m.principalId, {
          id: m.principalId,
          kind: m.kind,
          name: m.displayName,
          orgId: r.room.orgId,
        });
      }
    }
  }
  const matches = [...hits.values()];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).join(', ');
    throw new CliError(
      `Ambiguous name "${selector}"; matches ${matches.length} principals: ${ids}. ` +
        'Pass the principal id instead.',
    );
  }
  throw new CliError(
    `No principal named "${selector}" in your rooms. Agents resolve names from their rooms' ` +
      "members (and their owner); use the agt_/usr_ id directly for principals you don't " +
      'share a room with.',
  );
}

/**
 * Resolve a principal selector (an `agt_…`/`usr_…` id or a name) for whoever is
 * calling — the one door every name-accepting command goes through.
 *
 * A HUMAN resolves through its visibility list exactly as before
 * ({@link resolveAgent}); an AGENT resolves through {@link resolveAsAgent}. The
 * caller kind comes from `GET /me`, which every principal may read.
 */
export async function resolvePrincipal(
  client: SparrowClient,
  selector: string,
  org?: string,
): Promise<ResolvedPrincipal> {
  const me = await client.me();
  if (me.type === 'agent') return resolveAsAgent(client, me, selector, org);
  const found = await resolveAgent(client, selector, org);
  return {
    id: found.agent.id,
    kind: 'agent',
    name: found.agent.name,
    orgId: found.agent.orgId,
  };
}

/**
 * Resolve a human selector (a `usr_…` id or an email) to a `usr_…` id, using the
 * org directory when an email is given.
 */
export async function resolveHumanId(
  client: SparrowClient,
  orgId: string,
  selector: string,
): Promise<string> {
  if (/^usr_/.test(selector)) return selector;
  const hits = await client.directory(orgId, selector);
  const exact = hits.filter((h) => h.email.toLowerCase() === selector.toLowerCase());
  const pool = exact.length > 0 ? exact : hits;
  if (pool.length === 1) return pool[0]!.id;
  if (pool.length === 0) throw new CliError(`No human matching "${selector}" in this org.`);
  const ids = pool.map((h) => `${h.email} (${h.id})`).join(', ');
  throw new CliError(`Ambiguous human "${selector}"; matches: ${ids}. Pass the usr_ id.`);
}

/**
 * Parse an invite URL (`{BASE_URL}/invite/{token}`) into its server origin and
 * invite token. A bare token is accepted with a `--server` fallback.
 */
export function parseInviteUrl(
  arg: string,
  serverOverride: string | undefined,
): { token: string; server: string } {
  if (/^https?:\/\//i.test(arg)) {
    const url = new URL(arg);
    const m = url.pathname.match(/\/invite\/([^/]+)\/?$/);
    if (!m) throw new CliError(`Not an invite URL (expected …/invite/<token>): ${arg}`);
    return { token: decodeURIComponent(m[1]!), server: serverOverride ?? url.origin };
  }
  if (!serverOverride) {
    throw new CliError('A bare invite token requires --server <url> (or SPARROW_SERVER).');
  }
  return { token: arg, server: serverOverride };
}

/** Right-pad a string to a fixed width for simple table output. */
export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Render an array of rows as a fixed-width text table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd();
  const out = [line(headers)];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

/** Reference to a Profile type re-export so index.ts can share it. */
export type { Profile };
