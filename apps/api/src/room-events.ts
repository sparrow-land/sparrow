/**
 * Typed emit helpers for room SSE events (SPEC "Events"). Each wraps
 * `ctx.rooms.emitRoom`, building the exact wire payloads from `common-types`.
 * Audience follows the spec: `message.new` → recipients, `message.received`/
 * `message.read` → the sender, `message.clawback` → all members,
 * member/room/presence events → all members, `status.changed` → scoped.
 */
import { and, eq } from 'drizzle-orm';
import type {
  MemberRef,
  Member,
  MessageKind,
  PresenceState,
  PrincipalKind,
  StatusState,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import type { Audience } from './event-hub.js';
import type { RoomRow } from './db/schema.js';
import { members } from './db/schema.js';
import { toMember } from './room-helpers.js';
import { parseRoomSettings } from './room-settings.js';

/** `member.joined` — to all members. */
export function emitMemberJoined(ctx: AppContext, roomId: string, member: Member): void {
  ctx.rooms.emitRoom(roomId, 'member.joined', { member }, 'all');
}

/** `member.updated` — to all members (role change, principal rename). */
export function emitMemberUpdated(ctx: AppContext, roomId: string, member: Member): void {
  ctx.rooms.emitRoom(roomId, 'member.updated', { member }, 'all');
}

/**
 * A principal's display name changed (human `displayName` / agent `name`) — emit
 * `member.updated` in EVERY room the principal is a member of, so every connected
 * member list refreshes live. Names are rendered live from the principal row, so
 * this is the only wire signal callers need after a rename.
 */
export function emitPrincipalRenamed(
  ctx: AppContext,
  principalType: PrincipalKind,
  principalId: string,
): void {
  const rows = ctx.db
    .select()
    .from(members)
    .where(and(eq(members.principalType, principalType), eq(members.principalId, principalId)))
    .all();
  for (const m of rows) emitMemberUpdated(ctx, m.roomId, toMember(ctx, m));
}

/** `member.removed` — to the remaining members (`{ id, displayName }` only). */
export function emitMemberRemoved(
  ctx: AppContext,
  roomId: string,
  member: { id: string; displayName: string },
): void {
  ctx.rooms.emitRoom(roomId, 'member.removed', { member }, 'all');
}

/** `room.updated` — to all members. */
export function emitRoomUpdated(ctx: AppContext, room: RoomRow): void {
  ctx.rooms.emitRoom(
    room.id,
    'room.updated',
    {
      room: { id: room.id, name: room.name, archivedAt: room.archivedAt ?? null },
      settings: parseRoomSettings(room.settings),
    },
    'all',
  );
}

/** `message.new` — to the message's recipients. */
export function emitMessageNew(
  ctx: AppContext,
  roomId: string,
  recipientMemberIds: string[],
  payload: { messageId: string; from: MemberRef; preview: string; kind: MessageKind },
): void {
  if (recipientMemberIds.length === 0) return;
  ctx.rooms.emitRoom(roomId, 'message.new', { ...payload }, recipientMemberIds);
}

/** `message.received` — to the sender; emitted once per recipient on delivery. */
export function emitMessageReceived(
  ctx: AppContext,
  roomId: string,
  senderMemberId: string,
  payload: { messageId: string; by: MemberRef; receivedAt: string },
): void {
  ctx.rooms.emitRoom(roomId, 'message.received', { ...payload }, [senderMemberId]);
}

/** `message.read` — to the sender. */
export function emitMessageRead(
  ctx: AppContext,
  roomId: string,
  senderMemberId: string,
  payload: { messageId: string; by: MemberRef; readAt: string },
): void {
  ctx.rooms.emitRoom(roomId, 'message.read', { ...payload }, [senderMemberId]);
}

/**
 * `message.clawback` — to ALL room members (SPEC "Clawback"): the sender pulled
 * an unread message back; every client drops it from every view and queue.
 * Journaled per member like any room event, so reconnecting watchers replay it.
 */
export function emitMessageClawback(
  ctx: AppContext,
  roomId: string,
  payload: { messageId: string; by: MemberRef; clawedBackAt: string },
): void {
  ctx.rooms.emitRoom(roomId, 'message.clawback', { ...payload }, 'all');
}

/** `status.changed` — scoped to (recipient + setter) when `to` is set, else all. */
export function emitStatusChanged(
  ctx: AppContext,
  roomId: string,
  audience: Audience,
  payload: {
    member: MemberRef;
    state: StatusState;
    note: string | null;
    to: MemberRef | null;
    sinceAt: string | null;
    sticky: boolean;
    expiresAt: string | null;
  },
): void {
  ctx.rooms.emitRoom(roomId, 'status.changed', { ...payload }, audience);
}

/** `presence.changed` — emitted by the hub itself; re-exported type for clarity. */
export type { PresenceState };
