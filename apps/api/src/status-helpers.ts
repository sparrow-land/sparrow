/**
 * Projection + expiry emission for working statuses. Bridges the in-memory
 * {@link StatusStore} (ids only) to the wire `MemberStatus` (live display names)
 * and emits a scoped `status.changed idle` when a status TTL elapses.
 */
import {
  STATUS_ACK_DEFAULT_NOTE,
  STATUS_TTL_DEFAULT,
  type MemberRef,
  type MemberStatus,
  type Message,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import type { StatusRecord } from './status-store.js';
import { memberById, toMemberRef } from './room-helpers.js';
import { emitStatusChanged } from './room-events.js';

/** Resolve a status record's scoped-recipient MemberRef (null when room-wide). */
export function statusToRef(ctx: AppContext, toMemberId: string | null): MemberRef | null {
  if (!toMemberId) return null;
  const row = memberById(ctx, toMemberId);
  return row ? toMemberRef(ctx, row) : null;
}

/** Project a live status record to the wire `MemberStatus` (display name live). */
export function toMemberStatus(ctx: AppContext, record: StatusRecord): MemberStatus {
  const setter = memberById(ctx, record.memberId);
  return {
    memberId: record.memberId,
    displayName: setter ? toMemberRef(ctx, setter).displayName : '',
    state: 'working',
    note: record.note,
    to: statusToRef(ctx, record.toMemberId),
    sinceAt: record.sinceAt,
    sticky: record.sticky,
    expiresAt: record.expiresAt,
  };
}

/** The SSE audience for a status change: (setter + recipient) when scoped, else all. */
export function statusAudience(record: StatusRecord): 'all' | string[] {
  return record.toMemberId ? [record.memberId, record.toMemberId] : 'all';
}

/**
 * Apply the `pop --ack` sugar: on a returned message, set the popper's status to
 * `working` scoped to the message's sender ("reading your message" by default)
 * and emit `status.changed`. A no-op when there is no message.
 */
export function applyAck(
  ctx: AppContext,
  roomId: string,
  popperMemberId: string,
  message: Message,
  opts: { note?: string; ttlSeconds?: number },
): void {
  const senderMemberId = message.from.id;
  const record = ctx.statuses.upsert({
    roomId,
    memberId: popperMemberId,
    note: opts.note ?? STATUS_ACK_DEFAULT_NOTE,
    toMemberId: senderMemberId,
    sticky: false,
    ttlSeconds: opts.ttlSeconds ?? STATUS_TTL_DEFAULT,
  });
  const setter = memberById(ctx, popperMemberId);
  if (!setter) return;
  emitStatusChanged(ctx, roomId, statusAudience(record), {
    member: toMemberRef(ctx, setter),
    state: 'working',
    note: record.note,
    to: statusToRef(ctx, record.toMemberId),
    sinceAt: record.sinceAt,
    sticky: record.sticky,
    expiresAt: record.expiresAt,
  });
}

/** Emit `status.changed idle` when a status expires (TTL elapsed). */
export function emitStatusExpiry(ctx: AppContext, record: StatusRecord): void {
  const setter = memberById(ctx, record.memberId);
  if (!setter) return; // member gone — nothing to notify about
  emitStatusChanged(ctx, record.roomId, statusAudience(record), {
    member: toMemberRef(ctx, setter),
    state: 'idle',
    note: null,
    to: statusToRef(ctx, record.toMemberId),
    sinceAt: null,
    sticky: false,
    expiresAt: null,
  });
}
