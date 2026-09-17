/**
 * The org's shareable invite — REUSED, not re-minted.
 *
 * An invite is a live door into the org for seven days. The invite dialog used
 * to mint one on every open, so a person opening it three times to re-read the
 * harness command left three live doors behind and an Invites page full of
 * identical rows (issue #5). So: on open, reuse the caller's most recent invite
 * that is still blank (no note), still live (unrevoked, unexpired) and still
 * untouched (`useCount === 0`), and mint only when there is no such invite.
 *
 * The token is shown exactly ONCE, inside the created invite's `url` (SPEC
 * *Invites & enrollment*) — the server keeps only its hash and can never hand it
 * back. So reuse has two halves: this module remembers the URLs this browser
 * minted, and the server's list says which of them are still worth reusing. The
 * remembered URL is never trusted on its own; an entry the list no longer calls
 * reusable is dropped on sight, so a revoked or spent invite can never be
 * resurrected from storage. Fewer live doors is the whole point of the exercise.
 */
import type { Invite } from '@sparrow/common-types';
import { api } from './client.js';

/** What this browser has to remember to be able to re-offer an invite: its link. */
export interface RememberedInvite {
  id: string;
  url: string;
}

const KEY_PREFIX = 'sparrow:invite:';
/** Enough to survive a couple of invites being spent; not a growing pile. */
const MAX_REMEMBERED = 5;

function key(orgId: string): string {
  return `${KEY_PREFIX}${orgId}`;
}

/** The invites this browser minted for `orgId`, newest first. */
export function rememberedInvites(orgId: string): RememberedInvite[] {
  try {
    const raw = localStorage.getItem(key(orgId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RememberedInvite =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as RememberedInvite).id === 'string' &&
        typeof (e as RememberedInvite).url === 'string',
    );
  } catch {
    return [];
  }
}

function write(orgId: string, entries: RememberedInvite[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(key(orgId));
    else localStorage.setItem(key(orgId), JSON.stringify(entries.slice(0, MAX_REMEMBERED)));
  } catch {
    /* storage unavailable — every open just mints, as it always did */
  }
}

/**
 * Is this invite the generic, still-unused link a surface may hand out again?
 * A note means the creator meant it for a particular audience; a revoked or
 * expired one is a dead link; a non-zero `useCount` means somebody has already
 * come through, and re-sharing a door in use is a different decision.
 */
export function isReusableInvite(inv: Invite, now = Date.now()): boolean {
  return (
    !inv.note && inv.revokedAt === null && Date.parse(inv.expiresAt) > now && inv.useCount === 0
  );
}

/**
 * The URL of an invite the caller can share for `orgId`: the most recent
 * remembered one the server still calls reusable, or a freshly minted one.
 *
 * Mint failures propagate (the dialog tells the difference between a policy
 * `403` and a plain failure); a failing LIST never does — it just means this
 * open mints, which is the old behavior.
 */
export async function ensureOrgInvite(orgId: string): Promise<string> {
  const reused = await reusableFor(orgId);
  if (reused) return reused;
  const res = await api.createInvite(orgId, {});
  write(orgId, [{ id: res.invite.id, url: res.url }, ...rememberedInvites(orgId)]);
  return res.url;
}

/** The remembered URL the server still vouches for, pruning the ones it doesn't. */
async function reusableFor(orgId: string): Promise<string | null> {
  const remembered = rememberedInvites(orgId);
  if (remembered.length === 0) return null;
  let items: Invite[];
  try {
    items = await api.listInvites(orgId);
  } catch {
    return null;
  }
  const live = new Map(items.filter((i) => isReusableInvite(i)).map((i) => [i.id, i]));
  const kept = remembered.filter((r) => live.has(r.id));
  write(orgId, kept);
  // Newest by the server's own createdAt — never by the order this browser
  // happens to have stored them in.
  const best = kept
    .map((r) => ({ r, inv: live.get(r.id)! }))
    .sort((a, b) => b.inv.createdAt.localeCompare(a.inv.createdAt))[0];
  return best ? best.r.url : null;
}
