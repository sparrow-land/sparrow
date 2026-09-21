/**
 * Onboarding mode (SPEC "Onboarding mode"): the server half of the web UI's
 * first-run wizard. Two public routes — "should the wizard run here?" and the
 * Cancel button that answers "no, forever" — and nothing else. In particular
 * nothing here grants a signup: the wizard drives `POST /auth/signup` like any
 * other sign-up form, so `auth.allowSignup` still decides.
 *
 * NOT `routes/onboarding.ts`, which serves the agent invite doc and `/meta`.
 * Same word, different feature: that one onboards an AGENT into a room, this
 * one onboards an OPERATOR into a brand-new instance.
 *
 * The dismissal is instance-level state, so it lives in the `config` table (the
 * instance settings store, SPEC "Config (instance)") under a key that is
 * deliberately NOT a `ConfigDescriptor`: it is a latch the product sets, not a
 * setting an operator tunes, so it stays out of `GET /config`'s entries.
 */
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { DB } from '../db/index.js';
import { config as configTable, humans } from '../db/schema.js';

/** The `config` row the Cancel button latches. */
export const ONBOARDING_DISMISSED_KEY = 'onboarding.dismissed';

/**
 * Why the wizard is (not) running. `empty` is the ONLY active state; the rest
 * are the four ways an instance can be past it, in the order they are tested.
 */
export type OnboardingReason = 'empty' | 'populated' | 'dismissed' | 'disabled' | 'hosted';

/**
 * Wire shape of `GET /onboarding`. Declared here rather than imported from
 * `@sparrow-land/sdk/types` because the SDK has no onboarding-mode shape yet;
 * it moves there at the next SDK release (precedent: `WireMessageIdResponse`).
 */
export interface OnboardingStatusResponse {
  active: boolean;
  reason: OnboardingReason;
}

/** Has anyone pressed Cancel on this instance? */
export function onboardingDismissed(db: DB): boolean {
  const row = db
    .select()
    .from(configTable)
    .where(eq(configTable.key, ONBOARDING_DISMISSED_KEY))
    .get();
  if (!row) return false;
  try {
    return JSON.parse(row.value) === true;
  } catch {
    // A corrupt row is not a dismissal.
    return false;
  }
}

/** Latch the dismissal. Idempotent — the second press only moves `updated_at`. */
export function dismissOnboarding(db: DB): void {
  const now = new Date().toISOString();
  const value = JSON.stringify(true);
  db.insert(configTable)
    .values({ key: ONBOARDING_DISMISSED_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: configTable.key, set: { value, updatedAt: now } })
    .run();
}

/**
 * Resolve the wizard's state. Order is the contract: `hosted` → `disabled` →
 * `dismissed` → `populated` → `empty`. The human count is the LAST test, so the
 * one query this route can cost is only paid when it is the question that
 * remains — and the sign-in page asks on every load.
 */
export function onboardingStatus(ctx: AppContext): OnboardingStatusResponse {
  // Host-scoped = platform-provisioned: `ORG_HOST_SUFFIX` is what a tenant
  // container is handed (and what `GET /capabilities` advertises), so it is the
  // instance's own "somebody else provisioned me" signal. Onboarding mode is
  // OSS-only by construction.
  if (ctx.config.orgHostSuffix) return { active: false, reason: 'hosted' };
  if (ctx.config.skipOnboarding) return { active: false, reason: 'disabled' };
  if (onboardingDismissed(ctx.db)) return { active: false, reason: 'dismissed' };
  const humanCount = ctx.db.select({ n: count() }).from(humans).get()?.n ?? 0;
  if (humanCount > 0) return { active: false, reason: 'populated' };
  return { active: true, reason: 'empty' };
}

export function registerOnboardingModeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /onboarding — public, and never cached: the sign-in page asks on every
  // load, and an answer cached past the first signup would offer the wizard to
  // a stranger on an instance that already has an owner.
  app.get('/api/v1/onboarding', (_request, reply) => {
    const response: OnboardingStatusResponse = onboardingStatus(ctx);
    return reply.header('cache-control', 'no-store').send(response);
  });

  // POST /onboarding/dismiss — the wizard's Cancel. Public (the caller by
  // definition has no account yet), bodyless, idempotent, `204`. It records the
  // latch whatever the current reason is: on an instance that was never active
  // that is harmless, and it keeps the answer stable if the instance later
  // stops being hosted or un-sets the env switch.
  app.post('/api/v1/onboarding/dismiss', (_request, reply) => {
    dismissOnboarding(ctx.db);
    return reply.header('cache-control', 'no-store').code(204).send();
  });
}
