import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { ErrorResponse } from '@sparrow/common-types';
import {
  PRESENCE_GRACE_SECONDS,
  EMAIL_INBOUND_RATE_PER_MIN,
  LLM_JUDGE_TIMEOUT_MS,
  parseClientIdent,
  clientVersionBelow,
} from '@sparrow/common-types';
import { openDb } from './db/index.js';
import { trackOpenStreams } from './open-streams.js';
import { EventBus } from './events.js';
import { EventJournal } from './event-journal.js';
import { RoomEventHub } from './event-hub.js';
import { StatusStore } from './status-store.js';
import { emitStatusExpiry } from './status-helpers.js';
import { ApiError } from './errors.js';
import type { AppContext, ServerConfig } from './context.js';
import { API_VERSION, BUILD_STAMP } from './version.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerEnrollmentRoutes } from './routes/enrollment.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerRoomRoutes } from './routes/rooms.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerPresenceRoutes } from './routes/presence.js';
import { registerDmRoutes } from './routes/dms.js';
import { registerAgentDmRoutes } from './routes/agent-dms.js';
import { registerMeRoomRoutes } from './routes/me-rooms.js';
import { registerEventRoutes } from './routes/events.js';
import { registerSidebarRoutes } from './routes/sidebar.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { registerHintPreferenceRoutes } from './routes/hint-preferences.js';
import { registerDocsRoutes, DOCS_BY_ROUTE } from './routes/docs.js';
import { apiDocMarkdownUrl, docsHome, installArtifactUrl, installHome } from './public-homes.js';
import { ElevenLabsVoiceProvider } from './voice/elevenlabs.js';
import { FakeVoiceProvider } from './voice/fake.js';
import type { VoiceRegistry } from './voice/types.js';
import { FakeEmailProvider, WebhookEmailProvider } from './email/providers.js';
import { AnthropicJudge, FakeJudge, OpenAiJudge } from './email/judge.js';
import type { EmailProvider, EmailRegistry, LlmJudge } from './email/types.js';
import { registerEmailRoutes } from './routes/email.js';
import { deliverInbound } from './email/inbound.js';
import { ConfigStore } from './config-store.js';
import { AuthService, type AuthCtx, type AuthProvider } from './auth.js';
import { passwordAuthProvider } from './auth-password.js';
import { googleAuthProvider, googleCredentialsPresent } from './auth-google.js';

/** ~30MB body limit so base64 attachment payloads fit (20MB raw ≈ 27MB b64). */
const BODY_LIMIT = 30 * 1024 * 1024;

function errorEnvelope(
  code: ErrorResponse['error']['code'],
  message: string,
  docs?: string,
): ErrorResponse {
  return { error: docs ? { code, message, docs } : { code, message } };
}

function sendError(reply: FastifyReply, status: number, body: ErrorResponse): void {
  void reply.code(status).type('application/json').send(body);
}

/* ------------------------------------------------------------------ *
 * Client routes (SPEC "Misc": static web UI + SPA fallback)
 * ------------------------------------------------------------------ */

/** Exact client routes the SPA shell answers for. */
const SPA_EXACT_ROUTES = new Set([
  '/',
  '/welcome',
  '/login',
  '/me',
  '/admin',
]);

/**
 * Client route PREFIXES (each takes at least one more path segment):
 * `/invite/:token`, the unscoped org tree `/org/:orgId/...` (plus `/orgs/...`),
 * the host-scoped org tree mounted at the root (`/rooms/...`, `/agents/...`),
 * and `/me/...`.
 *
 * `/docs*` is deliberately ABSENT: documentation has one canonical home and the
 * instance only `302`s there (SPEC "Canonical public homes"), so a docs path must
 * never fall through to the SPA shell — the explicit routes in `routes/docs.ts`
 * answer every one of them.
 */
const SPA_ROUTE_PREFIXES = [
  '/invite/',
  '/org/',
  '/orgs/',
  '/rooms/',
  '/agents/',
  '/me/',
];

/**
 * Is `pathname` one of the client routes the SPA is KNOWN to own?
 *
 * These are the only paths that answer `200` with the shell. Everything else
 * either 404s as JSON (machine callers) or gets the shell WITH a `404` status
 * so the SPA can render its own not-found page (browsers) — see
 * {@link wantsSpaShell}. Existing static files never reach here;
 * `@fastify/static` serves them from its own routes.
 */
export function isSpaRoute(pathname: string): boolean {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (SPA_EXACT_ROUTES.has(p)) return true;
  return SPA_ROUTE_PREFIXES.some((prefix) => p.startsWith(prefix) && p.length > prefix.length);
}

/** File extensions that mark a path as a build artifact, never an SPA route. */
const STATIC_ASSET_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'css',
  'map',
  'json',
  'txt',
  'xml',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'ico',
  'webp',
  'avif',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'webmanifest',
  'wasm',
  'mp3',
  'mp4',
  'webm',
]);

/**
 * Does `pathname` look like a bundle artifact rather than a client route?
 * A missing chunk must 404 as JSON — never as HTML that a `<script>` tag would
 * try to parse (and that a stale service worker could cache as "the app").
 */
export function looksLikeStaticAsset(pathname: string): boolean {
  if (pathname === '/assets' || pathname.startsWith('/assets/')) return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return false;
  return STATIC_ASSET_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/**
 * Should this unmatched request be answered with the SPA shell?
 *
 * Two audiences, one catch-all. A BROWSER (its `Accept` asks for `text/html`)
 * navigating to any non-asset, non-`/api` path gets the shell so the app's own
 * `Route path="*"` NotFound page renders instead of a raw JSON envelope — with
 * HTTP `404` on the response when the path is not a known client route (a
 * `404` carrying an HTML body renders normally in every browser, and keeps the
 * status honest for caches, crawlers and link checkers; only the enumerated
 * routes of {@link isSpaRoute} answer `200`).
 *
 * A MACHINE (curl's wildcard Accept, `application/json`, or none at all) gets
 * the JSON `404` envelope, so `/healthzz`, `/health`, `/metrics` and
 * `/totally/bogus` still cannot be mistaken for live endpoints by a prober.
 * Asset-looking paths and anything under `/api/` are JSON `404` for everyone.
 */
export function wantsSpaShell(pathname: string, accept: string | undefined): boolean {
  if (pathname.startsWith('/api/')) return false;
  if (isSpaRoute(pathname)) return true;
  if (looksLikeStaticAsset(pathname)) return false;
  return (accept ?? '').toLowerCase().includes('text/html');
}

/** Pino levels Fastify accepts; anything else would throw at boot. */
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

/** Values that mean "no logger", including the empty compose `${LOG_LEVEL:-}`. */
const LOG_OFF = new Set(['', 'off', 'false', 'none', 'silent', '0']);

/**
 * Translate `LOG_LEVEL` into Fastify's `logger` option. Unset/empty (and the
 * explicit off-switches) → `false`, the historical silence and the right
 * default for an embedded/in-test server; a level → pino at that level with the
 * `authorization` and `cookie` request headers (and `set-cookie` on the way
 * out) redacted. An unrecognized level degrades to `info` rather than crashing
 * the boot on a typo.
 */
export function loggerOptions(
  level: string | undefined,
): false | { level: string; redact: { paths: string[]; censor: string } } {
  const wanted = (level ?? '').trim().toLowerCase();
  if (LOG_OFF.has(wanted)) return false;
  return {
    level: LOG_LEVELS.has(wanted) ? wanted : 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
  };
}

/**
 * Build a fully configured Fastify instance. Importable/startable in-process
 * (client/CLI tests inject or listen against it). `close()` also closes the DB.
 */
export function buildServer(config: ServerConfig): FastifyInstance {
  const handle = openDb(config.dataDir);

  // Config store env fallbacks: the raw process env for env-declared config keys
  // (e.g. OPEN_ORG_CREATION), plus the explicit ServerConfig value when set.
  const envValues: Record<string, string | undefined> = { ...process.env };
  if (config.openOrgCreation !== undefined) {
    envValues.OPEN_ORG_CREATION = String(config.openOrgCreation);
  }
  if (config.emailWebhookUrl !== undefined) envValues.EMAIL_WEBHOOK_URL = config.emailWebhookUrl;
  if (config.emailWebhookToken !== undefined) {
    envValues.EMAIL_WEBHOOK_TOKEN = config.emailWebhookToken;
  }
  const configStore = new ConfigStore(handle.db, envValues);
  const auth = new AuthService(handle.db, configStore);

  // Providers: `password` always; `google` when its GOOGLE_* env credentials are
  // set; anything injected via config.providers is merged on top (injected wins).
  const providers: AuthProvider[] = [passwordAuthProvider, ...(config.providers ?? [])];
  if (googleCredentialsPresent() && !providers.some((p) => p.id === 'google')) {
    providers.push(googleAuthProvider());
  }

  // Voice providers (SPEC "Voice"): `elevenlabs` when a key resolves (db → env →
  // default) — it wins and backs both STT and TTS; else `fake` when
  // VOICE_PROVIDER=fake. Injected `config.voice` slots override per-slot (tests).
  const voice: VoiceRegistry = { stt: null, tts: null };
  const elevenLabsKey = String(configStore.get('voice.elevenLabsApiKey') ?? '').trim();
  if (elevenLabsKey) {
    const provider = new ElevenLabsVoiceProvider({
      apiKey: elevenLabsKey,
      voiceId: String(configStore.get('voice.ttsVoiceId') ?? ''),
      ttsModelId: String(configStore.get('voice.ttsModelId') ?? ''),
      sttModelId: String(configStore.get('voice.sttModelId') ?? ''),
    });
    voice.stt = provider;
    voice.tts = provider;
  } else if (config.voiceProvider === 'fake') {
    const fake = new FakeVoiceProvider();
    voice.stt = fake;
    voice.tts = fake;
  }
  if (config.voice?.stt !== undefined) voice.stt = config.voice.stt;
  if (config.voice?.tts !== undefined) voice.tts = config.voice.tts;

  // The email medium (SPEC "The email medium → Providers"): ON iff
  // EMAIL_ORG_SUFFIX is set AND a provider registers — `fake`, or `webhook` WITH
  // `email.webhookUrl` resolved (naming `webhook` without a URL registers
  // nothing, so the medium stays off).
  let emailProvider: EmailProvider | null = null;
  let emailFake: FakeEmailProvider | null = null;
  if (config.emailProvider === 'fake') {
    emailFake = new FakeEmailProvider();
    emailProvider = emailFake;
  } else if (config.emailProvider === 'webhook') {
    const url = String(configStore.get('email.webhookUrl') ?? '').trim();
    if (url) {
      emailProvider = new WebhookEmailProvider(() => ({
        webhookUrl: String(configStore.get('email.webhookUrl') ?? ''),
        webhookToken: String(configStore.get('email.webhookToken') ?? ''),
      }));
    }
  }
  // The judge is gated on an explicit provider choice AND its key; naming a
  // vendor without its key registers nothing (a `judge` policy then degrades to
  // approve, never to allow).
  let judge: LlmJudge | null = null;
  if (config.llmProvider === 'fake') {
    judge = new FakeJudge();
  } else if (config.llmProvider === 'openai') {
    const key = String(configStore.get('llm.openAiApiKey') ?? '').trim();
    if (key) judge = new OpenAiJudge({ apiKey: key, baseUrl: config.openAiBaseUrl });
  } else if (config.llmProvider === 'anthropic') {
    const key = String(configStore.get('llm.anthropicApiKey') ?? '').trim();
    if (key) judge = new AnthropicJudge({ apiKey: key, baseUrl: config.anthropicBaseUrl });
  }
  if (config.judge !== undefined) judge = config.judge;
  const email: EmailRegistry = {
    provider: emailProvider,
    fake: emailFake,
    judge,
    inboundToken: config.emailInboundToken,
    inboundRatePerMin: config.emailInboundRatePerMin ?? EMAIL_INBOUND_RATE_PER_MIN,
    judgeTimeoutMs: config.llmJudgeTimeoutMs ?? LLM_JUDGE_TIMEOUT_MS,
  };

  const rooms = new RoomEventHub(config.presenceGraceSeconds ?? PRESENCE_GRACE_SECONDS);
  // Per-principal `/me/events` journal (SSE resume). The bus journals its own
  // principal-level publishes; the hub journals room fan-in via ctx.journal.
  const journal = new EventJournal(handle.sqlite);
  const bus = new EventBus();
  bus.bindJournal(journal);
  // The status store's expiry callback needs ctx; late-bind via a mutable ref.
  let ctxRef: AppContext;
  const statuses = new StatusStore(
    (record) => emitStatusExpiry(ctxRef, record),
    config.stickyOfflineHorizonSeconds !== undefined
      ? config.stickyOfflineHorizonSeconds * 1000
      : undefined,
  );

  const ctx: AppContext = {
    config,
    handle,
    db: handle.db,
    bus,
    rooms,
    journal,
    statuses,
    configStore,
    auth,
    providers,
    voice,
    email,
  };
  ctxRef = ctx;
  rooms.bind(ctx);
  // The `fake` provider's in-process `deliver()` runs the EXACT `/email/inbound`
  // pipeline with no HTTP and no token — bound late, since it needs the context.
  emailFake?.bindDeliver((payload) => deliverInbound(ctx, payload));

  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: loggerOptions(config.logLevel) });

  // Long-lived SSE responses are requests that never finish, and `close()` waits
  // for in-flight requests: one open stream used to pin the shutdown past
  // docker's 10 s grace, so the database was SIGKILLed instead of checkpointed
  // (issue #55). Track responses here and end the streaming ones in `preClose`.
  // Registered first so the `onRequest` hook sees every route.
  trackOpenStreams(app);

  app.addHook('onClose', (_instance, done) => {
    // Cancel pending presence/status timers BEFORE closing the DB so no late
    // timer touches a closed connection.
    try {
      rooms.dispose();
    } catch {
      // ignore
    }
    try {
      statuses.dispose();
    } catch {
      // ignore
    }
    try {
      handle.close();
    } catch {
      // ignore
    }
    done();
  });

  // CORS is scoped to `/api/v1/*` (SPEC "Misc"): the browser API surface. The
  // SPA shell, /docs, /install.sh and /healthz are same-origin resources and get
  // no CORS headers at all. Within the API, the default reflects any origin with
  // credentials enabled (session cookies work cross-origin; bearer forms exist
  // for every cookie-authed route); `CORS_ALLOWED_ORIGINS` narrows that to an
  // explicit allowlist for a self-hoster who wants one.
  //
  // `methods` must be stated: @fastify/cors defaults it to GET,HEAD,POST, so a
  // preflight for any of the documented PATCH/PUT/DELETE routes came back
  // advertising three verbs and the browser refused to send the real request.
  const corsAllowlist = config.corsAllowedOrigins?.length ? config.corsAllowedOrigins : undefined;
  const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'];
  app.register(cors, () => (request: { url: string }, done: (err: Error | null, options: Record<string, unknown>) => void) => {
    const url = request.url.split('?')[0]!;
    if (!url.startsWith('/api/v1/')) {
      done(null, { origin: false });
      return;
    }
    done(null, { origin: corsAllowlist ?? true, credentials: true, methods: CORS_METHODS });
  });

  // Conservative security headers. `nosniff` on everything; the framing and
  // referrer policies matter for the HTML shell (an authenticated SPA that must
  // not be framed). No CSP: the Vite build inlines a module preload script, so a
  // strict policy would need a nonce pipeline we can't verify here.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.includes('text/html')) {
      reply.header('x-frame-options', 'DENY');
      reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    }
    return payload;
  });

  // Hard tier of the client-version gate: reject a KNOWN client below the
  // configured minimum with `426 Upgrade Required`. Off entirely unless
  // CLIENT_MIN_VERSION is set. Escape hatches (meta, docs, install) always pass so
  // an old client can still discover the policy and pull a fresh bundle. Absent or
  // unparseable `X-Sparrow-Client` headers are ungated — the gate targets
  // known-old clients, never unknown/third-party ones (web sends nothing).
  app.addHook('onRequest', async (request, reply) => {
    const min = config.clientMinVersion;
    if (!min) return;
    const url = request.url.split('?')[0]!;
    if (
      url === '/api/v1/meta' ||
      url === '/docs' ||
      url.startsWith('/docs/') ||
      url.startsWith('/install')
    ) {
      return;
    }
    const raw = request.headers['x-sparrow-client'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const ident = parseClientIdent(header);
    if (!ident) return; // unknown/absent client → ungated
    if (!clientVersionBelow(ident.version, min)) return; // at/above the floor → ok
    await reply.code(426).type('application/json').send(
      errorEnvelope(
        'client_upgrade_required',
        `Your Sparrow client (${ident.version}) is below the minimum this server requires (${min}). ` +
          `Upgrade with \`sparrow upgrade\`, or re-run ` +
          `${installArtifactUrl(installHome(config), 'install.sh')}.`,
        apiDocMarkdownUrl(docsHome(config), 'versioning'),
      ),
    );
  });

  // Docs URL for a failed request on a DOCUMENTED route, so 4xx envelopes teach
  // where to read. Built from the canonical docs home (never the request origin):
  // the markdown page is the same document for every instance. Undefined for
  // undocumented routes.
  const docsForRequest = (request: { routeOptions?: { url?: string } }): string | undefined => {
    const segment = request.routeOptions?.url ? DOCS_BY_ROUTE[request.routeOptions.url] : undefined;
    if (!segment) return undefined;
    return apiDocMarkdownUrl(docsHome(config), segment);
  };

  // Uniform error envelope for every non-2xx.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      const docs = error.statusCode >= 400 && error.statusCode < 500 ? docsForRequest(request) : undefined;
      sendError(reply, error.statusCode, errorEnvelope(error.code, error.message, docs));
      return;
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) {
      sendError(reply, 413, errorEnvelope('payload_too_large', 'Payload too large'));
      return;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = (error as Error).message || 'Bad request';
      sendError(reply, status, errorEnvelope('bad_request', message, docsForRequest(request)));
      return;
    }
    app.log.error(error);
    sendError(reply, 500, errorEnvelope('internal', 'Internal server error'));
  });

  // Static web UI (optional): serve apps/api/public with SPA fallback.
  const publicDir = path.resolve(config.dataDir, '..', 'public');
  const bundledPublic = new URL('../public', import.meta.url).pathname;
  const staticRoot = existsSync(bundledPublic)
    ? bundledPublic
    : existsSync(publicDir)
      ? publicDir
      : undefined;
  if (staticRoot) {
    app.register(fastifyStatic, { root: staticRoot, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/');
    if (isApi || request.method !== 'GET') {
      // Unknown `/api/*` (and any non-GET) gets a real JSON 404 — never the SPA —
      // with a docs pointer so a probing agent is handed where to read. API 404s
      // also name the discovery endpoint so a wrong guess self-corrects.
      const message = isApi
        ? 'No such API route. Probe GET /api/v1/meta for install + docs + the API base.'
        : 'Not found';
      const docs = apiDocMarkdownUrl(docsHome(config));
      sendError(reply, 404, errorEnvelope('not_found', message, docs));
      return;
    }
    // SPA fallback — audience-aware (see wantsSpaShell). A browser navigation
    // always gets the shell so the app renders its OWN 404 page; the status is
    // 200 for the enumerated client routes and 404 for anything else, which
    // browsers render exactly the same while keeping the status honest. A
    // machine caller (wildcard/JSON/absent Accept) and every asset-looking path
    // get the JSON envelope, so a prober still can't mistake `/healthzz` for a
    // live endpoint and a missing chunk never comes back as HTML.
    const pathname = request.url.split('?')[0]!;
    if (staticRoot && wantsSpaShell(pathname, request.headers.accept)) {
      const indexPath = path.join(staticRoot, 'index.html');
      if (existsSync(indexPath)) {
        return reply
          .code(isSpaRoute(pathname) ? 200 : 404)
          .type('text/html')
          .send(readFileSync(indexPath));
      }
    }
    sendError(reply, 404, errorEnvelope('not_found', 'Not found'));
  });

  // Health check (no auth): the PRODUCT version (root package.json) plus this
  // image's build stamp — `null` when the build was never stamped with a
  // BUILD_SHA, so "which commit is this?" has an honest answer either way.
  app.get('/healthz', (_request, reply) => {
    return reply.send({ ok: true, version: API_VERSION, build: BUILD_STAMP });
  });

  // Agent onboarding: the install redirects and /invite/:token content
  // negotiation. Registered before the SPA notFound fallback so an explicit
  // GET /invite/:token handles Accept negotiation.
  registerOnboardingRoutes(app, ctx, { staticRoot });
  // The docs door: every /docs path 302s to the canonical documentation home.
  registerDocsRoutes(app, ctx);

  registerAuthRoutes(app, ctx);
  registerOrgRoutes(app, ctx);
  registerInviteRoutes(app, ctx);
  registerEnrollmentRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerRoomRoutes(app, ctx);
  registerMessageRoutes(app, ctx);
  registerDraftRoutes(app, ctx);
  registerStatusRoutes(app, ctx);
  registerPresenceRoutes(app, ctx);
  registerDmRoutes(app, ctx);
  registerAgentDmRoutes(app, ctx);
  registerMeRoomRoutes(app, ctx);
  registerHintPreferenceRoutes(app, ctx);
  registerSidebarRoutes(app, ctx);
  registerActivityRoutes(app, ctx);
  registerAvatarRoutes(app, ctx);
  registerVoiceRoutes(app, ctx);
  registerEmailRoutes(app, ctx);
  registerEventRoutes(app, ctx);

  // The in-process fake handle (SPEC "Providers → EMAIL_PROVIDER=fake"): the
  // captured outbox plus `deliver()`. Present only under `fake`.
  app.decorate('emailFake', emailFake ?? undefined);

  // Provider routes (password signup/login; google oauth redirect/callback).
  const authCtx: AuthCtx = {
    baseUrl: config.baseUrl,
    db: handle.db,
    configStore,
    auth,
  };
  for (const p of providers) p.register(app, authCtx);

  return app;
}

export type { ServerConfig, AppContext } from './context.js';
export type {
  AuthCtx,
  AuthProvider,
  LoginOrCreateUserInput,
  LoginResult,
} from './auth.js';
export {
  AuthService,
  SESSION_COOKIE,
  parseCookies,
  serializeSessionCookie,
  clearSessionCookie,
  emailMatchesPatterns,
  globToRegExp,
  hashPassword,
  verifyPassword,
  toUser,
} from './auth.js';
export { passwordAuthProvider } from './auth-password.js';
export {
  googleAuthProvider,
  googleCredentialsPresent,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  STATE_COOKIE as GOOGLE_STATE_COOKIE,
  type GoogleAuthProviderOptions,
} from './auth-google.js';
export { ConfigStore, CORE_DESCRIPTORS, SECRET_MASK } from './config-store.js';
export { envConfig } from './config.js';
