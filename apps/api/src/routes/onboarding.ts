import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ErrorResponse } from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { AppContext } from '../context.js';
import { effectiveOrigin } from '../effective-origin.js';
import { API_VERSION, BUILD_STAMP } from '../version.js';
import { humans, invites, orgs } from '../db/schema.js';
import { parseOrgSettings } from '../org-helpers.js';
import { deadInvite, deadInviteError } from '../invite-helpers.js';
import { renderInstallScript, renderInviteDoc } from './onboarding.templates.js';

export interface OnboardingOptions {
  /** Directory holding the bundled install artifacts (sparrow.js, sparrow-mcp.js). */
  installAssetsDir: string;
  /** Static web root (contains index.html) when the SPA is bundled; else undefined. */
  staticRoot?: string;
}

const BUNDLES: Record<string, string> = {
  'sparrow.js': 'sparrow.js',
  'sparrow-mcp.js': 'sparrow-mcp.js',
};

/**
 * Substrings (matched case-insensitively) that mark a User-Agent as a bot/agent
 * rather than an interactive browser.
 */
export const AGENT_UA_MARKERS = [
  'bot',
  'curl',
  'wget',
  'python',
  'node',
  'go-http',
  'java',
  'ruby',
  'libwww',
  'httpx',
  'aiohttp',
  'claude',
  'gpt',
  'openai',
  'anthropic',
  'headless',
] as const;

/**
 * Decide whether `GET /invite/:token` should serve the markdown onboarding doc
 * based purely on the User-Agent. Real browsers send `Mozilla/…` with none of the
 * agent markers and keep the SPA; everything else gets markdown.
 */
export function userAgentPrefersMarkdown(ua: string | undefined): boolean {
  if (!ua) return true;
  const s = ua.toLowerCase();
  if (!s.startsWith('mozilla/')) return true;
  return AGENT_UA_MARKERS.some((marker) => s.includes(marker));
}

function notFoundEnvelope(): ErrorResponse {
  return { error: { code: 'not_found', message: 'Not found' } };
}

function serveSpaOr404(reply: FastifyReply, staticRoot: string | undefined): FastifyReply {
  if (staticRoot) {
    const indexPath = path.join(staticRoot, 'index.html');
    if (existsSync(indexPath)) {
      return reply.type('text/html').send(readFileSync(indexPath));
    }
  }
  return reply.code(404).type('application/json').send(notFoundEnvelope());
}

/**
 * Machine-readable discovery doc for `GET /api/v1/meta`. Every URL is anchored to
 * the request's effective origin, so a probe on any sparrow host is self-hosting-
 * aware. Kept small, stable, and additive — a fixed shape agents can rely on.
 */
export interface MetaDoc {
  name: 'sparrow';
  version: string;
  /**
   * This image's build stamp (`<yyyymmdd>.<sha>`), or `null` when the build was
   * never stamped with a `BUILD_SHA`. Together with `version` it pins the exact
   * commit an instance is running — the same pair `GET /healthz` reports.
   */
  build: string | null;
  install: { script: string; cli: string; mcp: string };
  docs: { index: string; convention: string };
  api: { base: string };
  /** The server's own version + build — the same strings `GET /healthz` reports. */
  server: { version: string; build: string | null };
  /**
   * The instance's client-version policy (both `null` when the gate is off): the
   * hard `minimum` a client must meet (below it → `426`) and the soft
   * `recommended` version below which a client is nudged to upgrade. Advertised so
   * a client can self-check without waiting to be rejected.
   */
  client: { minimum: string | null; recommended: string | null };
}

/** The client-version policy advertised in `GET /api/v1/meta`. */
export interface ClientVersionPolicy {
  minimum?: string;
  recommended?: string;
}

/** Build the discovery doc from a request's effective origin + the client policy. */
export function renderMeta(origin: string, policy: ClientVersionPolicy = {}): MetaDoc {
  return {
    name: 'sparrow',
    version: API_VERSION,
    build: BUILD_STAMP,
    install: {
      script: `${origin}/install.sh`,
      cli: `${origin}/install/sparrow.js`,
      mcp: `${origin}/install/sparrow-mcp.js`,
    },
    docs: {
      index: `${origin}/docs/api`,
      convention: `${origin}/docs/api/<endpoint-path>`,
    },
    api: { base: `${origin}/api/v1` },
    server: { version: API_VERSION, build: BUILD_STAMP },
    client: {
      minimum: policy.minimum ?? null,
      recommended: policy.recommended ?? null,
    },
  };
}

/**
 * Agent onboarding routes:
 *   GET /api/v1/meta         unauthenticated discovery doc (install + docs + api)
 *   GET /install.sh          POSIX installer templated with BASE_URL
 *   GET /install/:name       serve a bundled client (sparrow.js | sparrow-mcp.js)
 *   GET /invite/:token       content-negotiated: markdown doc for non-browsers,
 *                            SPA for browsers (Accept contains text/html)
 */
export function registerOnboardingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  opts: OnboardingOptions,
): void {
  // Unauthenticated discovery: an agent that lands on any sparrow host can probe
  // this to find the installer, the CLI/MCP bundles, the docs, and the API base —
  // all anchored to this request's origin. Stable and additive by contract.
  app.get('/api/v1/meta', (request, reply) => {
    return reply
      .type('application/json')
      .send(
        renderMeta(effectiveOrigin(request, ctx.config), {
          minimum: ctx.config.clientMinVersion,
          recommended: ctx.config.clientRecommendedVersion,
        }),
      );
  });

  // The install artifacts change on EVERY deploy but sit on cache-friendly
  // paths (a CDN default-caches `.js` by extension — Cloudflare's 4h edge TTL
  // kept serving a pre-deploy bundle on 2026-09-01, so `sparrow upgrade`
  // "succeeded" into the old build). They are fetched rarely, so forbid
  // caching outright rather than tune a TTL.
  app.get('/install.sh', (request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .type('text/x-shellscript; charset=utf-8')
      .send(renderInstallScript(effectiveOrigin(request, ctx.config)));
  });

  app.get<{ Params: { name: string } }>('/install/:name', (request, reply) => {
    reply.header('cache-control', 'no-store');
    const file = BUNDLES[request.params.name];
    if (!file) {
      return reply.code(404).type('application/json').send(notFoundEnvelope());
    }
    const full = path.join(opts.installAssetsDir, file);
    if (!existsSync(full)) {
      return reply.code(404).type('application/json').send(notFoundEnvelope());
    }
    return reply.type('text/javascript; charset=utf-8').send(readFileSync(full));
  });

  app.get<{ Params: { token: string }; Querystring: { format?: string } }>(
    '/invite/:token',
    (request, reply) => {
      const accept = request.headers.accept ?? '';
      const format =
        typeof request.query.format === 'string' ? request.query.format.toLowerCase() : undefined;
      const forceMarkdown = format === 'md' || format === 'markdown';
      const uaMarkdown = userAgentPrefersMarkdown(request.headers['user-agent']);
      // Precedence: `?format=md` > UA heuristic > Accept. Browsers keep the SPA.
      const wantsSpa = !forceMarkdown && !uaMarkdown && accept.includes('text/html');

      // Resolve the token first — the status code depends on it. GET is
      // side-effect-free (it never enrolls the fetcher).
      const token = request.params.token;
      const invite = ctx.db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, sha256Hex(token)))
        .get();

      // A DEAD invite must read dead. Serving the full onboarding doc at 200 for a
      // bogus/revoked/expired token walks an agent several steps down a path that
      // cannot work, with the dead token baked into every copy-paste enroll line —
      // and a revoked link is exactly the one the operator killed on purpose.
      // Unknown token → 404 (no existence oracle beyond that); revoked/expired →
      // 410, which says "this WAS a door" without naming the org or the inviter.
      // The classification lives in invite-helpers so `…/info` and `…/enroll`
      // answer with the same three sentences.
      const dead = deadInvite(invite);

      if (wantsSpa) {
        // Browsers keep an HTML page either way — the SPA renders its own "this
        // link is dead" screen — but the status line stays truthful, so `curl -I`,
        // a proxy, and a crawler all see the failure.
        if (dead) reply.code(dead.status);
        return serveSpaOr404(reply, opts.staticRoot);
      }
      if (dead) throw deadInviteError(dead);

      // Everyone else (curl's */*, text/markdown, …) gets the onboarding doc, which
      // names the org + inviter + agent policy.
      const usable = invite;
      let orgName: string | undefined;
      let inviterName: string | undefined;
      let agentsPolicy: 'approval' | 'open' | undefined;
      if (usable) {
        const org = ctx.db.select().from(orgs).where(eq(orgs.id, usable.orgId)).get();
        orgName = org?.name;
        agentsPolicy = org ? parseOrgSettings(org.settings).enroll.agents : undefined;
        // An admin owner invite carries no inviter (NULL) — the doc names no one.
        const inviter = usable.inviterHumanId
          ? ctx.db.select().from(humans).where(eq(humans.id, usable.inviterHumanId)).get()
          : undefined;
        inviterName = inviter?.displayName;
      }
      return reply
        .type('text/markdown; charset=utf-8')
        .send(
          renderInviteDoc(effectiveOrigin(request, ctx.config), token, {
            orgName,
            inviterName,
            agentsPolicy,
          }),
        );
    },
  );
}

export { renderInstallScript, renderInviteDoc } from './onboarding.templates.js';
