import { hostname } from 'node:os';

/** DKIM signing material — all three vars or none (see {@link loadConfig}). */
export interface DkimConfig {
  domain: string;
  selector: string;
  privateKey: string;
}

/** Upstream relay. Unset = deliver direct to each recipient's MX. */
export interface SmarthostConfig {
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
}

/**
 * The gateway's whole configuration. It is stateless: no database, no queue, no
 * credentials beyond these (SPEC.md, `apps/mail-gateway`).
 */
export interface GatewayConfig {
  /** `MAIL_SMTP_PORT` — inbound SMTP listener. */
  smtpPort: number;
  /** `MAIL_SMTP_MAX_BYTES` — advertised SMTP `SIZE`; over → `552`. */
  smtpMaxBytes: number;
  /** `MAIL_INBOUND_URL` — the core's `POST /email/inbound`. */
  inboundUrl: string;
  /** `EMAIL_INBOUND_TOKEN` — bearer presented to the core. */
  inboundToken: string;
  /** `EMAIL_ORG_SUFFIX` — the accepted RCPT suffix, e.g. `.example.com`. */
  orgSuffix: string;
  /** `MAIL_OUTBOUND_PORT` — outbound webhook listener. */
  outboundPort: number;
  /** `EMAIL_WEBHOOK_TOKEN` — bearer the core presents; `null` = no auth. */
  webhookToken: string | null;
  /** `MAIL_DKIM_*` — `null` = unsigned mail. */
  dkim: DkimConfig | null;
  /** `MAIL_SMARTHOST_*` — `null` = direct to MX. */
  smarthost: SmarthostConfig | null;
  /** `MAIL_HELO_NAME` — EHLO name; must match the sending IP's PTR. */
  heloName: string;
}

/** Defaults straight from the spec's env table. */
const DEFAULT_SMTP_PORT = 2525;
const DEFAULT_SMTP_MAX_BYTES = 26_214_400;
const DEFAULT_OUTBOUND_PORT = 2526;
const DEFAULT_SMARTHOST_PORT = 25;

/** A configuration the operator has to fix before the gateway can run. */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`mail-gateway configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/**
 * Build the gateway config from the environment, or throw a `ConfigError`
 * naming EVERY problem at once (an operator should not have to restart three
 * times to learn three missing variables).
 */
export function loadConfig(env: Env = process.env): GatewayConfig {
  const problems: string[] = [];

  const inboundUrl = trimmed(env.MAIL_INBOUND_URL);
  if (!inboundUrl) problems.push('MAIL_INBOUND_URL is required');
  const inboundToken = trimmed(env.EMAIL_INBOUND_TOKEN);
  if (!inboundToken) problems.push('EMAIL_INBOUND_TOKEN is required');

  const rawSuffix = trimmed(env.EMAIL_ORG_SUFFIX);
  let orgSuffix = '';
  if (!rawSuffix) {
    problems.push('EMAIL_ORG_SUFFIX is required');
  } else if (!rawSuffix.startsWith('.') && !rawSuffix.startsWith('@')) {
    problems.push(
      `EMAIL_ORG_SUFFIX must start with "." or "@" (got "${rawSuffix}") — an agent address is <name>@<org-slug><suffix>`,
    );
  } else {
    orgSuffix = rawSuffix.toLowerCase();
  }

  const smtpPort = port(env.MAIL_SMTP_PORT, DEFAULT_SMTP_PORT, 'MAIL_SMTP_PORT', problems);
  const outboundPort = port(
    env.MAIL_OUTBOUND_PORT,
    DEFAULT_OUTBOUND_PORT,
    'MAIL_OUTBOUND_PORT',
    problems,
  );
  const smtpMaxBytes = positive(
    env.MAIL_SMTP_MAX_BYTES,
    DEFAULT_SMTP_MAX_BYTES,
    'MAIL_SMTP_MAX_BYTES',
    problems,
  );

  const dkim = dkimConfig(env, problems);
  const smarthost = smarthostConfig(env, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    smtpPort,
    smtpMaxBytes,
    inboundUrl,
    inboundToken,
    orgSuffix,
    outboundPort,
    webhookToken: trimmed(env.EMAIL_WEBHOOK_TOKEN) || null,
    dkim,
    smarthost,
    heloName: trimmed(env.MAIL_HELO_NAME) || hostname(),
  };
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

function port(value: string | undefined, fallback: number, name: string, problems: string[]): number {
  const raw = trimmed(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    problems.push(`${name} must be a port number 0-65535 (got "${raw}")`);
    return fallback;
  }
  return parsed;
}

function positive(
  value: string | undefined,
  fallback: number,
  name: string,
  problems: string[],
): number {
  const raw = trimmed(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive integer (got "${raw}")`);
    return fallback;
  }
  return parsed;
}

/**
 * All three DKIM vars or none. A half-configured key is a misconfiguration, not
 * a licence to quietly send unsigned mail nobody's DMARC will accept.
 */
function dkimConfig(env: Env, problems: string[]): DkimConfig | null {
  const domain = trimmed(env.MAIL_DKIM_DOMAIN);
  const selector = trimmed(env.MAIL_DKIM_SELECTOR);
  const privateKey = env.MAIL_DKIM_PRIVATE_KEY?.trim() ?? '';
  if (!domain && !selector && !privateKey) return null;
  const missing = [
    domain ? null : 'MAIL_DKIM_DOMAIN',
    selector ? null : 'MAIL_DKIM_SELECTOR',
    privateKey ? null : 'MAIL_DKIM_PRIVATE_KEY',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    problems.push(`DKIM signing needs all of MAIL_DKIM_DOMAIN / MAIL_DKIM_SELECTOR / MAIL_DKIM_PRIVATE_KEY (missing ${missing.join(', ')})`);
    return null;
  }
  return { domain: domain.toLowerCase(), selector, privateKey };
}

function smarthostConfig(env: Env, problems: string[]): SmarthostConfig | null {
  const host = trimmed(env.MAIL_SMARTHOST_HOST);
  const user = trimmed(env.MAIL_SMARTHOST_USER);
  const pass = env.MAIL_SMARTHOST_PASS ?? '';
  if (!host) {
    if (user || pass || trimmed(env.MAIL_SMARTHOST_PORT)) {
      problems.push('MAIL_SMARTHOST_PORT/_USER/_PASS need MAIL_SMARTHOST_HOST');
    }
    return null;
  }
  return {
    host,
    port: port(env.MAIL_SMARTHOST_PORT, DEFAULT_SMARTHOST_PORT, 'MAIL_SMARTHOST_PORT', problems),
    user: user || null,
    pass: pass || null,
  };
}
