/**
 * Test harness: a REAL in-process sparrow API (`buildServer()` from `@sparrow/api`)
 * listening on an ephemeral port, backed by a fresh temp-dir SQLite database.
 * Client tests drive it over real HTTP via {@link SparrowClient} — so they double
 * as a contract check against the live server and the `common-types` wire shapes.
 * Node-only; never imported by the browser entry.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildServer } from '@sparrow/api';

export const TEST_ADMIN_TOKEN = 'test-admin-token';

/** The bearer an email-enabled harness accepts at `POST /email/inbound`. */
export const TEST_INBOUND_TOKEN = 'test-inbound-token';

/** The `EMAIL_ORG_SUFFIX` every email harness derives addresses from. */
export const TEST_EMAIL_SUFFIX = '.example.com';

/** The Fastify instance type, sourced from `buildServer` (avoids a direct `fastify` dep). */
type Server = ReturnType<typeof buildServer>;

export interface Harness {
  app: Server;
  /** Base origin, e.g. `http://127.0.0.1:PORT` (no path). */
  url: string;
  adminToken: string;
  close(): Promise<void>;
}

/** Build, start (port 0), and return a live server + its base origin. */
export async function startServer(
  overrides: {
    openOrgCreation?: boolean;
    presenceGraceSeconds?: number;
    voiceProvider?: string;
    /** `EMAIL_ORG_SUFFIX` — half of the email medium's on/off switch. */
    emailOrgSuffix?: string;
    /** `EMAIL_PROVIDER` — `fake` registers the in-process loopback provider. */
    emailProvider?: string;
    /** `EMAIL_INBOUND_TOKEN` — the bearer `POST /email/inbound` demands. */
    emailInboundToken?: string;
  } = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-client-'));
  const app = buildServer({
    dataDir,
    baseUrl: 'http://localhost:8722',
    adminToken: TEST_ADMIN_TOKEN,
    ...overrides,
  });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${addr.port}`,
    adminToken: TEST_ADMIN_TOKEN,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * A harness with the EMAIL MEDIUM ON: `EMAIL_ORG_SUFFIX` plus the in-process
 * `fake` provider (outbound captured on `app.emailFake.sent`, inbound injectable
 * through `app.emailFake.deliver()`), and the inbound seam's bearer. The medium
 * is on iff BOTH the suffix and a provider are configured — see SPEC v4 "The
 * email medium".
 */
export function startEmailServer(
  overrides: Parameters<typeof startServer>[0] = {},
): Promise<Harness> {
  return startServer({
    emailOrgSuffix: TEST_EMAIL_SUFFIX,
    emailProvider: 'fake',
    emailInboundToken: TEST_INBOUND_TOKEN,
    ...overrides,
  });
}

/** A normalized inbound payload with the edge's verdicts already filled in. */
export function inboundPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rfcMessageId: `<${Math.random().toString(36).slice(2)}@mail.example.net>`,
    from: { email: 'dana@partner.example.com', name: 'Dana Lee' },
    to: [{ email: 'fable@acme.example.com', name: 'fable' }],
    subject: 'Q3 rollout',
    text: 'the body',
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'partner.example.com' },
    ...overrides,
  };
}

/**
 * Drive one inbound email through the REAL `/email/inbound` pipeline in-process
 * (no HTTP, no token) via the fake provider's `deliver()`.
 */
export async function deliverEmail(
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  const fake = h.app.emailFake;
  if (!fake) throw new Error('this harness has no fake email provider (start with startEmailServer)');
  return fake.deliver(inboundPayload(overrides));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
