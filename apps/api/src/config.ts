import { DEFAULT_PORT, EMAIL_INBOUND_RATE_PER_MIN, LLM_JUDGE_TIMEOUT_MS } from '@sparrow/common-types';
import type { ServerConfig } from './context.js';

/**
 * Build the server config from environment variables.
 *
 * `OPEN_ORG_CREATION` is the env *fallback* for config key `orgs.openCreation`
 * (db value wins, default true): it is surfaced only when actually set, so the
 * config store can report an honest `source`. Accounts are always on; the
 * available login providers are decided at build time (password always; google
 * when its `GOOGLE_*` credentials are set).
 */
export function envConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = env.DATA_DIR ?? './data';
  const baseUrl = env.BASE_URL ?? `http://localhost:${env.PORT ?? DEFAULT_PORT}`;
  const adminToken = env.ADMIN_TOKEN?.trim() || undefined;
  const rawOpen = env.OPEN_ORG_CREATION;
  const openOrgCreation = rawOpen === undefined ? undefined : rawOpen !== 'false';
  const rawGrace = env.PRESENCE_GRACE_SECONDS;
  const parsedGrace = rawGrace === undefined ? Number.NaN : Number(rawGrace);
  const presenceGraceSeconds = Number.isFinite(parsedGrace) ? parsedGrace : undefined;
  const voiceProvider = env.VOICE_PROVIDER?.trim() || undefined;
  const orgHostSuffix = env.ORG_HOST_SUFFIX?.trim() || undefined;
  // Hints default ON; only an explicit HINTS_ENABLED=false disables them. Left
  // undefined otherwise so the engine treats the absent env var as "on".
  const hintsEnabled = env.HINTS_ENABLED === 'false' ? false : undefined;
  // The email medium (SPEC "Server configuration (env)"). ON iff a suffix is set
  // AND a provider registers; the inbound seam additionally needs its token.
  const emailOrgSuffix = env.EMAIL_ORG_SUFFIX?.trim() || undefined;
  const emailProvider = env.EMAIL_PROVIDER?.trim() || undefined;
  const emailInboundToken = env.EMAIL_INBOUND_TOKEN?.trim() || undefined;
  const emailInboundRatePerMin = positiveInt(env.EMAIL_INBOUND_RATE_PER_MIN, EMAIL_INBOUND_RATE_PER_MIN);
  const llmProvider = env.LLM_PROVIDER?.trim() || undefined;
  const openAiBaseUrl = env.OPENAI_BASE_URL?.trim() || undefined;
  const anthropicBaseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const llmJudgeTimeoutMs = positiveInt(env.LLM_JUDGE_TIMEOUT_MS, LLM_JUDGE_TIMEOUT_MS);
  // Client-version gate (both default unset = feature off): a hard minimum below
  // which known-old clients get `426`, and a soft recommended below which they
  // get the `upgrade-your-cli` hint.
  const clientMinVersion = env.CLIENT_MIN_VERSION?.trim() || undefined;
  const clientRecommendedVersion = env.CLIENT_RECOMMENDED_VERSION?.trim() || undefined;
  // Server logging. The library default (`buildServer` with no logLevel) is
  // silence so embedding/tests stay quiet; the real entrypoint asks for `info`,
  // so a self-hosted container logs requests without any configuration. An
  // empty value — compose's `${LOG_LEVEL:-}` always defines one — is "unset".
  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  // Optional CORS allowlist for /api/v1/*; unset keeps the reflect-any default.
  const allowed = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const corsAllowedOrigins = allowed.length > 0 ? allowed : undefined;
  return {
    dataDir,
    baseUrl,
    adminToken,
    openOrgCreation,
    presenceGraceSeconds,
    voiceProvider,
    orgHostSuffix,
    hintsEnabled,
    emailOrgSuffix,
    emailProvider,
    emailInboundToken,
    emailInboundRatePerMin,
    llmProvider,
    openAiBaseUrl,
    anthropicBaseUrl,
    llmJudgeTimeoutMs,
    clientMinVersion,
    clientRecommendedVersion,
    logLevel,
    corsAllowedOrigins,
  };
}

/** Parse a positive-integer env var, falling back to `fallback` when unusable. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
