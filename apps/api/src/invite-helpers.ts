/**
 * Invite-creation machinery shared by the two invite paths:
 *
 *  - the bare invite-link flow (`POST /orgs/:orgId/invites`), and
 *  - the low-friction "invite by email" add (`POST /orgs/:orgId/members`),
 *    which pre-provisions the membership AND mints a standard invite so the
 *    recipient gets a one-click door.
 *
 * Keeping token minting in one place means both paths produce identical,
 * revocable, expiring `ivk_` invites that the normal enrollment/redemption
 * machinery already understands.
 */
import { eq } from 'drizzle-orm';
import {
  newInviteId,
  newInviteToken,
  INVITE_EXPIRY_DAYS_DEFAULT,
} from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { invites } from './db/schema.js';
import type { InviteRow } from './db/schema.js';
import { ApiError, gone, notFound } from './errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Dead-invite semantics (shared by every invite surface)
 * ------------------------------------------------------------------ */

/**
 * An unknown token is a `404` and says nothing else — the only existence oracle
 * we are willing to be. A token that IS real but no longer usable is a `410`
 * naming WHICH way it died, because "not found" sends a person hunting for a
 * typo in a link that was fine and an agent retrying a door the operator closed
 * on purpose. Neither message names the org or the inviter.
 */
export const INVITE_UNKNOWN_MESSAGE =
  'This invite link is not valid. Check the link you were given, or ask whoever invited you for a new one.';
export const INVITE_REVOKED_MESSAGE =
  'This invite has been revoked. Ask whoever invited you for a new link.';
export const INVITE_EXPIRED_MESSAGE =
  'This invite has expired. Ask whoever invited you for a new link.';

/** Why an invite cannot be used, and the status that says so. */
export interface DeadInvite {
  status: 404 | 410;
  reason: 'unknown' | 'revoked' | 'expired';
  message: string;
}

/**
 * Classify an invite row (or its absence) as dead, or `undefined` when it is
 * live. One function so `/invite/:token`, `…/info` and `…/enroll` can never
 * drift into telling the same person three different stories.
 */
export function deadInvite(row: InviteRow | undefined, now = Date.now()): DeadInvite | undefined {
  if (!row) return { status: 404, reason: 'unknown', message: INVITE_UNKNOWN_MESSAGE };
  if (row.revokedAt) return { status: 410, reason: 'revoked', message: INVITE_REVOKED_MESSAGE };
  if (Date.parse(row.expiresAt) <= now) {
    return { status: 410, reason: 'expired', message: INVITE_EXPIRED_MESSAGE };
  }
  return undefined;
}

/** The {@link ApiError} for a {@link DeadInvite} (`not_found` / `gone`). */
export function deadInviteError(dead: DeadInvite): ApiError {
  return dead.status === 404 ? notFound(dead.message) : gone(dead.message);
}

/**
 * Throw the right error for a dead invite, or return the live row. The single
 * call site shape for the JSON routes.
 */
export function requireLiveInvite(row: InviteRow | undefined): InviteRow {
  const dead = deadInvite(row);
  if (dead) throw deadInviteError(dead);
  return row as InviteRow;
}

/**
 * Mint + persist an invite for `orgId` on behalf of `inviterHumanId`. Returns
 * the stored row plus the plaintext `ivk_` token (which is shown to the caller
 * exactly once — the DB keeps only its sha256 hash).
 */
export function createInvite(
  ctx: AppContext,
  input: {
    orgId: string;
    inviterHumanId: string | null;
    note?: string | null;
    expiresInDays?: number;
  },
): { row: InviteRow; token: string } {
  const token = newInviteToken();
  const createdAt = nowIso();
  const days = input.expiresInDays ?? INVITE_EXPIRY_DAYS_DEFAULT;
  const expiresAt = new Date(Date.parse(createdAt) + days * DAY_MS).toISOString();
  const row: InviteRow = {
    id: newInviteId(),
    orgId: input.orgId,
    inviterHumanId: input.inviterHumanId,
    tokenHash: sha256Hex(token),
    note: input.note ?? null,
    expiresAt,
    revokedAt: null,
    createdAt,
  };
  ctx.db.insert(invites).values(row).run();
  return { row, token };
}

/** Look up an invite row by id (helper for callers that need the fresh row). */
export function inviteById(ctx: AppContext, id: string): InviteRow | undefined {
  return ctx.db.select().from(invites).where(eq(invites.id, id)).get();
}

/** Rendered invitation email (subject + both body variants). */
export interface RenderedInviteEmail {
  subject: string;
  text: string;
  html: string;
}

/** Minimal HTML escape for interpolating names/URLs into the html body. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the invitation email for the low-friction invite. Both the plain-text
 * and HTML bodies carry who invited the recipient, the org name, the invite
 * link, and one sentence explaining that clicking it signs them in / lets them
 * create their account.
 */
export function renderInviteEmail(input: {
  inviterName: string;
  orgName: string;
  inviteUrl: string;
}): RenderedInviteEmail {
  const { inviterName, orgName, inviteUrl } = input;
  const subject = `${inviterName} invited you to ${orgName}`;
  const action =
    'Click the link to sign in and join — if you don’t have an account yet, you’ll create one along the way.';
  const text = [
    `${inviterName} invited you to join ${orgName}.`,
    '',
    action,
    '',
    inviteUrl,
  ].join('\n');
  const html = [
    `<p><strong>${esc(inviterName)}</strong> invited you to join <strong>${esc(orgName)}</strong>.</p>`,
    `<p>${esc(action)}</p>`,
    `<p><a href="${esc(inviteUrl)}">${esc(inviteUrl)}</a></p>`,
  ].join('\n');
  return { subject, text, html };
}
