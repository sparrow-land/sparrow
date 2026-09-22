import { useEffect, useState } from 'react';

/**
 * First-run onboarding — the browser half of `GET /api/v1/onboarding`.
 *
 * A fresh self-hosted instance answers `active: true` and the app shows the
 * guided setup (`/onboarding`) instead of a bare sign-in form. Everything else —
 * an instance that already has an account, one whose owner cancelled the wizard,
 * a hosted tenant — answers `active: false`, and nothing about the wizard is
 * mounted.
 *
 * ONE FETCH PER PAGE LOAD. The answer is a property of the instance, not of the
 * moment, and the wizard itself invalidates it (after step 2 the server would
 * say `populated`), so the wizard keeps its own in-session progress and this
 * module keeps the server's first answer for the life of the page. No polling,
 * no revalidation: a reload is what re-asks.
 *
 * The route is PUBLIC and `no-store`, so this is a plain same-origin fetch (the
 * SDK client carries no onboarding method — the route is instance-local).
 * Anything unexpected — an old server with no route, a network error, a body
 * that does not parse — reads as INACTIVE, so a broken probe can never trap a
 * working instance behind a setup wizard it cannot leave.
 */

export type OnboardingReason = 'empty' | 'populated' | 'dismissed' | 'disabled' | 'hosted';

export interface OnboardingStatus {
  active: boolean;
  reason: OnboardingReason;
}

const REASONS: OnboardingReason[] = ['empty', 'populated', 'dismissed', 'disabled', 'hosted'];

/** The safe answer: no wizard. Used for every failure mode. */
const INACTIVE: OnboardingStatus = { active: false, reason: 'disabled' };

/** The in-flight (or settled) probe for THIS page load. */
let pending: Promise<OnboardingStatus> | null = null;
/** The settled answer, readable synchronously once it has arrived. */
let settled: OnboardingStatus | null = null;

/** The answer if it is already known, else null (tests and first paint). */
export function peekOnboarding(): OnboardingStatus | null {
  return settled;
}

/** Drop the cached answer. Tests only — a real page load starts empty. */
export function resetOnboardingCache(): void {
  pending = null;
  settled = null;
}

function parse(body: unknown): OnboardingStatus {
  if (typeof body !== 'object' || body === null) return INACTIVE;
  const raw = body as { active?: unknown; reason?: unknown };
  if (typeof raw.active !== 'boolean') return INACTIVE;
  const reason = REASONS.find((r) => r === raw.reason) ?? (raw.active ? 'empty' : 'disabled');
  return { active: raw.active, reason };
}

/** `GET /api/v1/onboarding`, once per page load. Never rejects. */
export function onboardingStatus(): Promise<OnboardingStatus> {
  pending ??= (async () => {
    try {
      const res = await fetch('/api/v1/onboarding', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) return INACTIVE;
      const text = await res.text();
      return parse(text ? JSON.parse(text) : null);
    } catch {
      return INACTIVE;
    }
  })().then((status) => {
    settled = status;
    return status;
  });
  return pending;
}

/**
 * The wizard was FINISHED (not dismissed) — the visitor is on their way into the
 * workspace. Nothing is sent: the founding account exists, so the server already
 * answers `populated` and a dismissal would be a lie about how this ended. What
 * this fixes is the stale local answer: it was fetched while the instance was
 * still empty, and without this the route gate would meet the finisher at `/`
 * and send them straight back into the wizard they just completed.
 */
export function markOnboardingComplete(): void {
  settled = { active: false, reason: 'populated' };
  pending = Promise.resolve(settled);
}

/**
 * `POST /api/v1/onboarding/dismiss` — permanent, and public (the visitor who
 * cancels may not have an account yet). The local answer flips FIRST so the
 * navigation that follows the cancel cannot bounce back into the wizard, even
 * if the request is still in flight or fails outright.
 */
export async function dismissOnboarding(): Promise<void> {
  settled = { active: false, reason: 'dismissed' };
  pending = Promise.resolve(settled);
  try {
    await fetch('/api/v1/onboarding/dismiss', { method: 'POST' });
  } catch {
    /* dismissal is best-effort; the local answer already stands */
  }
}

/**
 * The instance's onboarding answer, or `null` while the one probe is in flight.
 * Callers render nothing for that beat rather than flashing a page the answer
 * is about to replace.
 */
export function useOnboardingStatus(): OnboardingStatus | null {
  const [status, setStatus] = useState<OnboardingStatus | null>(peekOnboarding);
  useEffect(() => {
    if (status !== null) return;
    let cancelled = false;
    void onboardingStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [status]);
  return status;
}
