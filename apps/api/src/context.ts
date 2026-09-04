import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { DbHandle, DB } from './db/index.js';
import { agents } from './db/schema.js';
import type { AgentRow, HumanRow } from './db/schema.js';
import { EventBus } from './events.js';
import type { RoomEventHub } from './event-hub.js';
import type { EventJournal } from './event-journal.js';
import type { StatusStore } from './status-store.js';
import type { AuthProvider, AuthService } from './auth.js';
import type { ConfigStore } from './config-store.js';
import type { SttProvider, TtsProvider, VoiceRegistry } from './voice/types.js';
import type { EmailRegistry, LlmJudge } from './email/types.js';
import { unauthorized } from './errors.js';

export interface ServerConfig {
  dataDir: string;
  baseUrl: string;
  adminToken?: string;
  /**
   * The ONE home of the documentation (env `DOCS_URL`, default
   * `https://sparrow.land/docs`; trailing slash stripped). `/docs*` redirects
   * there and every `docs` URL the API emits is built from it. Undefined =
   * the default — see `public-homes.ts`.
   */
  docsUrl?: string;
  /**
   * The ONE home of `install.sh` and the CLI/MCP bundles (env `INSTALL_URL`,
   * default `https://sparrow.land`; trailing slash stripped). `/install.sh` and
   * `/install/*` redirect there. Undefined = the default.
   */
  installUrl?: string;
  /**
   * Env fallback for config key `orgs.openCreation` (`OPEN_ORG_CREATION`).
   * Undefined when the operator did not set the env var — the config store then
   * resolves db value → descriptor default (true).
   */
  openOrgCreation?: boolean;
  /**
   * Host suffix a fronting edge maps to org scope (env `ORG_HOST_SUFFIX`, e.g.
   * `.example.com` or `.localhost:8722`). A request whose Host equals
   * `<slug><suffix>` is host-scoped to that org. The API stays canonical
   * (org-id-in-URL); this value's server-side job is to be advertised to the SPA
   * via `GET /capabilities` so it can detect host scoping. Undefined = no host
   * scoping (path scoping, `/orgs/:slug/…`, is always available).
   */
  orgHostSuffix?: string;
  /**
   * Extra injected auth providers (interface seam for cloud/SAML). Core always
   * registers `password`, and `google` when its `GOOGLE_*` env credentials are
   * set; anything here is merged on top.
   */
  providers?: AuthProvider[];
  /**
   * Grace period (seconds) between a principal's last `/events` disconnect and
   * the `presence.changed offline` emit (env `PRESENCE_GRACE_SECONDS`, default
   * 30). Consumed by the Phase-3 rooms/presence layer.
   */
  presenceGraceSeconds?: number;
  /**
   * How long a sticky `working` status survives after its member goes (and stays)
   * offline, in seconds (default {@link STICKY_OFFLINE_HORIZON_SECONDS}). Injectable
   * so tests can exercise the horizon without a 30-minute wait.
   */
  stickyOfflineHorizonSeconds?: number;
  /**
   * Maximum lifetime (seconds) of a single SSE stream before the server
   * force-closes it (default {@link STREAM_MAX_LIFETIME_SECONDS}). Bounds a
   * stream's presence contribution so an intermediary that swallows a client
   * disconnect can't pin a principal online forever; well-behaved clients resume
   * via cursor replay. Injectable so tests exercise the cap without a 15-min wait.
   */
  streamMaxLifetimeSeconds?: number;
  /**
   * Env form of `VOICE_PROVIDER` (SPEC): `'fake'` registers the deterministic
   * offline voice provider. Ignored when an ElevenLabs key resolves (that wins).
   */
  voiceProvider?: string;
  /**
   * Injected voice providers (test seam). When set, each slot overrides whatever
   * the env/config-driven registration produced — supplying a spy or double.
   */
  voice?: { stt?: SttProvider | null; tts?: TtsProvider | null };
  /**
   * Streaming-transcription session caps (test seam; SPEC ships 20 MB / 600 s).
   * Mirrors `streamMaxLifetimeSeconds`: a cap the spec fixes, injectable so a
   * test can prove the boundary in milliseconds instead of megabytes.
   */
  voiceStreamMaxAudioBytes?: number;
  voiceStreamMaxSeconds?: number;
  /**
   * Global kill-switch for the hints engine (env `HINTS_ENABLED`, default ON).
   * `false` suppresses every response-body hint instance-wide; undefined/true
   * leaves hints on. Trumps the per-principal hint level and opt-out header.
   */
  hintsEnabled?: boolean;
  /**
   * Domain suffix agent addresses derive under (env `EMAIL_ORG_SUFFIX`, e.g.
   * `.example.com`): agent `fable` in org `acme` is `fable@acme.example.com`.
   * Unset = the email medium is OFF, whatever else is configured.
   */
  emailOrgSuffix?: string;
  /**
   * Env form of `EMAIL_PROVIDER`: `fake` (in-process loopback) or `webhook`
   * (outbound via `email.webhookUrl`). The second half of the medium's on/off
   * test — `webhook` without a resolved URL registers nothing.
   */
  emailProvider?: string;
  /**
   * Bearer the mail edge presents to `POST /email/inbound` (env
   * `EMAIL_INBOUND_TOKEN`). Unset = that ONE route 404s even with the medium on
   * (an inbound seam with no credential is not a seam); outbound still works.
   */
  emailInboundToken?: string;
  /** Per-org inbound cap before `429` (env `EMAIL_INBOUND_RATE_PER_MIN`). */
  emailInboundRatePerMin?: number;
  /** Env form of `EMAIL_WEBHOOK_URL` (the config-store fallback for `email.webhookUrl`). */
  emailWebhookUrl?: string;
  /** Env form of `EMAIL_WEBHOOK_TOKEN` (the config-store fallback for `email.webhookToken`). */
  emailWebhookToken?: string;
  /**
   * Env form of `LLM_PROVIDER`: `openai` | `anthropic` | `fake` — selects the
   * `LlmJudge`. The vendor variants also need their key (`llm.openAiApiKey` /
   * `llm.anthropicApiKey`); naming one without its key registers nothing.
   */
  llmProvider?: string;
  /** Optional endpoint override for the OpenAI judge (env `OPENAI_BASE_URL`). */
  openAiBaseUrl?: string;
  /** Optional endpoint override for the Anthropic judge (env `ANTHROPIC_BASE_URL`). */
  anthropicBaseUrl?: string;
  /** Per-judge-call deadline in ms (env `LLM_JUDGE_TIMEOUT_MS`, default 20000). */
  llmJudgeTimeoutMs?: number;
  /**
   * Injected `LlmJudge` (test seam). When set it overrides whatever the
   * env/config-driven registration produced — `null` forces "no judge".
   */
  judge?: LlmJudge | null;
  /**
   * Hard floor for the client-version gate (env `CLIENT_MIN_VERSION`). When set,
   * a request whose `X-Sparrow-Client` version parses BELOW this is rejected
   * `426 Upgrade Required` (except the escape-hatch routes: meta, docs, install).
   * Undefined = the gate is off. Compared on the `x.y.z` prefix; absent/unparseable
   * client headers are never gated (unknown clients pass).
   */
  clientMinVersion?: string;
  /**
   * Pino level for the request/server log (env `LOG_LEVEL`). Undefined/empty —
   * and the explicit `off`/`false`/`none`/`silent` — mean NO logger at all,
   * which is the default for an embedded/in-test `buildServer`. The real
   * entrypoint (`index.ts` via {@link envConfig}) defaults it to `info`, so a
   * self-hosted container logs out of the box. The `authorization` and `cookie`
   * request headers are redacted.
   */
  logLevel?: string;
  /**
   * Optional CORS allowlist for `/api/v1/*` (env `CORS_ALLOWED_ORIGINS`,
   * comma-separated). Undefined = reflect any origin (the shipped default).
   * Non-API routes never get CORS headers either way.
   */
  corsAllowedOrigins?: string[];
  /**
   * Soft floor for the client-version gate (env `CLIENT_RECOMMENDED_VERSION`).
   * When set, a request from a KNOWN client below it fires the `upgrade-your-cli`
   * hint (agents only, standard cooldown). Undefined = no upgrade hint. Purely
   * advisory — it never blocks a request.
   */
  clientRecommendedVersion?: string;
}

export interface AppContext {
  config: ServerConfig;
  handle: DbHandle;
  db: DB;
  /**
   * In-process pub/sub for principal-level events (enrollment/share/room
   * invitations, `activity.appended`, and the email medium's `email.*`), keyed by
   * **(principalType, principalId)** so agents are journalable recipients too.
   * Room events fan in on top via {@link RoomEventHub}.
   */
  bus: EventBus;
  /**
   * Room-event fan-out + presence registry (Phase 3). Delivers room SSE events
   * to `/rooms/:id/events` and `/me/events`, and tracks per-(room, principal)
   * and principal-wide online state.
   */
  rooms: RoomEventHub;
  /**
   * Per-principal `/me/events` journal (SSE resume). Every event delivered on a
   * `/me/events` stream is persisted here with a monotonic cursor so a
   * reconnecting client can replay what it missed via `?since=`/`Last-Event-ID`.
   */
  journal: EventJournal;
  /** Ephemeral, TTL'd working-status store (Phase 3). */
  statuses: StatusStore;
  /** Live runtime config (db → env → default). */
  configStore: ConfigStore;
  /** Session/human operations. */
  auth: AuthService;
  /** Registered auth providers (always includes `password`). */
  providers: AuthProvider[];
  /** Registered voice providers (`elevenlabs`, `fake`, or none). */
  voice: VoiceRegistry;
  /**
   * The email medium's registry: the outbound provider (null = medium off), the
   * in-process `fake` handle, the `LlmJudge`, and the inbound seam's settings.
   */
  email: EmailRegistry;
}

/** Current time as an ISO-8601 UTC string (matches the wire datetime shape). */
export const nowIso = (): string => new Date().toISOString();

/** Extract a bearer token from the Authorization header, if present. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return undefined;
  return value.trim();
}

/**
 * Resolve an `agk_` agent key to its agent row, bumping `last_seen_at`. Returns
 * undefined when no agent key is present (so callers can fall back to a session);
 * throws `401` when an `agk_` token is present but does not resolve.
 * `tokenOverride` supplies the `?token=` value for SSE (EventSource can't set
 * headers).
 */
export function resolveAgentKey(
  ctx: AppContext,
  request: FastifyRequest,
  tokenOverride?: string,
): AgentRow | undefined {
  const bearer = tokenOverride ?? bearerToken(request);
  if (!bearer || !bearer.startsWith('agk_')) return undefined;
  const agent = ctx.db.select().from(agents).where(eq(agents.keyHash, sha256Hex(bearer))).get();
  if (!agent) throw unauthorized('Invalid agent key');
  const seen = nowIso();
  ctx.db.update(agents).set({ lastSeenAt: seen }).where(eq(agents.id, agent.id)).run();
  agent.lastSeenAt = seen;
  return agent;
}

/** A resolved principal: a human account or an agent. */
export type Principal =
  | { type: 'human'; human: HumanRow }
  | { type: 'agent'; agent: AgentRow };

/** A principal's kind + id (the shape room/member queries key on). */
export interface PrincipalIdent {
  type: 'human' | 'agent';
  id: string;
}

/** Normalize a resolved {@link Principal} to its `{ type, id }` identity. */
export function principalIdent(p: Principal): PrincipalIdent {
  return p.type === 'human' ? { type: 'human', id: p.human.id } : { type: 'agent', id: p.agent.id };
}

/**
 * Resolve the caller of a `/me/*` or `GET /me` route as a principal: an `agk_`
 * agent key, else a human session (cookie or `Bearer ses_...`). `401` when
 * neither credential is present/valid. `tokenOverride` is the SSE `?token=`.
 */
export function resolvePrincipal(
  ctx: AppContext,
  request: FastifyRequest,
  tokenOverride?: string,
): Principal {
  const agent = resolveAgentKey(ctx, request, tokenOverride);
  if (agent) return { type: 'agent', agent };
  const human = ctx.auth.requireSession(request);
  return { type: 'human', human };
}
