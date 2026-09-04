/**
 * Avatar resolution (SPEC "Avatars"). Every wire payload that carries a human
 * projects an effective `avatarUrl` computed here. The chain, highest priority
 * first:
 *
 *   1. an uploaded avatar  → the serve endpoint `GET /api/v1/avatars/:humanId`
 *   2. `provider_avatar_url` → a photo URL from an upstream identity provider
 *   3. gravatar            → only when the instance opts in (`avatars.gravatar`);
 *                            a sha256 of the lowercased email, `?d=404`
 *   4. otherwise `null`    → the client renders a generated avatar
 *
 * Agents never have an avatar — their refs always resolve to `null`.
 */
import { eq } from 'drizzle-orm';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { HumanContact, PrincipalKind } from '@sparrow/common-types';
import type { AppContext } from './context.js';
import { humans } from './db/schema.js';
import type { HumanRow } from './db/schema.js';

/** Config key gating the gravatar fallback. */
export const GRAVATAR_CONFIG_KEY = 'avatars.gravatar';

/** The relative serve path for a human's uploaded avatar. */
export function avatarServePath(humanId: string): string {
  return `/api/v1/avatars/${humanId}`;
}

/** The gravatar URL for an email (sha256 of the lowercased, trimmed address). */
export function gravatarUrl(email: string): string {
  const hash = sha256Hex(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?d=404`;
}

/** Resolve the effective avatar URL for a human row (the full chain). */
export function avatarUrlForHuman(ctx: AppContext, human: HumanRow): string | null {
  if (human.avatarAttachment) return avatarServePath(human.id);
  if (human.providerAvatarUrl) return human.providerAvatarUrl;
  if (ctx.configStore.getBoolean(GRAVATAR_CONFIG_KEY)) return gravatarUrl(human.email);
  return null;
}

/** Project a human row to the roster/directory `HumanContact` shape with its avatar. */
export function toHumanContact(ctx: AppContext, human: HumanRow): HumanContact {
  return {
    id: human.id,
    displayName: human.displayName,
    email: human.email,
    avatarUrl: avatarUrlForHuman(ctx, human),
  };
}

/**
 * Resolve the effective avatar URL for a principal. Agents always resolve to
 * `null`; an unknown human id also resolves to `null`.
 */
export function avatarUrlForPrincipal(
  ctx: AppContext,
  type: PrincipalKind,
  id: string,
): string | null {
  if (type !== 'human') return null;
  const human = ctx.db.select().from(humans).where(eq(humans.id, id)).get();
  return human ? avatarUrlForHuman(ctx, human) : null;
}
