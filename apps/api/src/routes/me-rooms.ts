/**
 * Principal room surfaces (SPEC "The invitee surface" + "Principal inbox"):
 * the caller's memberships (`GET /me/rooms`), leaving a room, the room-invitation
 * inbox (list/accept/decline), and the cross-membership principal inbox
 * (`GET /me/inbox`, `POST /me/inbox/pop`). Memberships span orgs; DM rows carry a
 * counterpart.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';
import {
  MeInboxQuerySchema,
  PopNextMessageRequestSchema,
  newMemberId,
  type MeRoomsResponse,
  type MeRoom,
  type ListMeRoomInvitationsResponse,
  type AcceptRoomInvitationResponse,
  type MeInboxResponse,
  type MeInboxPopResponse,
  type MeMessageResponse,
  type ChatInboxEntry,
  type ChatWorkItem,
  type EmailInboxEntry,
  type EmailWorkItem,
  type InboxEntry,
  type InboxRoomRef,
  type RoomKind,
  type RoomRole,
  type Message,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso, resolvePrincipal, principalIdent, type PrincipalIdent } from '../context.js';
import { emails, members, messageRecipients, messages, rooms, roomInvitations } from '../db/schema.js';
import type { EmailRow } from '../db/schema.js';
import { parse } from '../validate.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { resolveLimit } from '../pagination.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import {
  markEmailRead,
  oldestUnreadEmail,
  threadById,
  toEmail,
  toEmailPreview,
  toThreadRef,
} from '../email/store.js';
import {
  roomById,
  memberOf,
  dmCounterpart,
  roomOwnerCount,
  toMember,
  toMemberRef,
  toRoom,
} from '../room-helpers.js';
import {
  toMessage,
  toInboxItem,
  oldestUnreadAcrossMembers,
  recipientStatus,
  markReceived,
} from '../message-helpers.js';
import { emitMemberJoined, emitMemberRemoved, emitMessageRead } from '../room-events.js';
import { applyAck } from '../status-helpers.js';
import { computeHints, clientVersionOf } from '../hints.js';
import { inviteeInvitation } from './rooms.js';

/**
 * The total order of the ONE queue: `createdAt`, then medium in registry order
 * (chat `0` before email `1`), then id — so the order is total and stable, and a
 * cursor over it is comparable across mediums.
 */
function queueKey(createdAt: string, rank: 0 | 1, id: string): string {
  return `${createdAt}|${rank}|${id}`;
}

/** One over-fetched page of the caller's unread (or all) CHAT rows. */
function chatInboxRows(
  ctx: AppContext,
  principal: PrincipalIdent,
  query: { org?: string; all?: boolean },
  limit: number,
  after?: { createdAt: string },
): {
  msg: typeof messages.$inferSelect;
  readAt: string | null;
  receivedAt: string | null;
  recipientId: string;
  room: typeof rooms.$inferSelect;
}[] {
  const memberIds = principalMembers(ctx, principal, query.org).map((r) => r.member.id);
  if (memberIds.length === 0) return [];
  // Clawed messages (SPEC "Clawback") are dead — never previewed, never popped.
  const live = isNull(messages.clawedBackAt);
  const base = query.all
    ? and(inArray(messageRecipients.recipientId, memberIds), live)
    : and(inArray(messageRecipients.recipientId, memberIds), isNull(messageRecipients.readAt), live);
  // `>=` (not `>`): the exact cursor row is filtered out by the merged key, so a
  // tie at the same instant across mediums cannot skip an item.
  const where = after ? and(base, gte(messages.createdAt, after.createdAt)) : base;
  return ctx.db
    .select({
      msg: messages,
      readAt: messageRecipients.readAt,
      receivedAt: messageRecipients.receivedAt,
      recipientId: messageRecipients.recipientId,
      room: rooms,
    })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .innerJoin(rooms, eq(rooms.id, messages.roomId))
    .where(where)
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit + 1)
    .all();
}

/**
 * One over-fetched page of an agent's EMAIL inbox presence: inbound emails on
 * its threads with `disposition = 'delivered'` and (unless `?all=`) no
 * `read_at`. Quarantined, held, rejected and outbound rows never appear — they
 * are the owning human's approval queue, not the agent's work.
 */
function emailInboxRows(
  ctx: AppContext,
  agentId: string,
  query: { org?: string; all?: boolean },
  limit: number,
  after?: { createdAt: string },
): EmailRow[] {
  const base = and(
    eq(emails.agentId, agentId),
    eq(emails.direction, 'in'),
    eq(emails.disposition, 'delivered'),
    ...(query.all ? [] : [isNull(emails.readAt)]),
    ...(query.org ? [eq(emails.orgId, query.org)] : []),
  );
  const where = after ? and(base, gte(emails.createdAt, after.createdAt)) : base;
  return ctx.db
    .select()
    .from(emails)
    .where(where)
    .orderBy(asc(emails.createdAt), asc(emails.id))
    .limit(limit + 1)
    .all();
}

/** The email variant of an inbox entry: THE preview shape plus its thread. */
function toEmailInboxEntry(ctx: AppContext, row: EmailRow): EmailInboxEntry {
  const thread = threadById(ctx, row.threadId);
  return {
    ...toEmailPreview(ctx, row),
    type: 'email',
    thread: {
      id: row.threadId,
      subject: thread?.subject ?? row.subject,
      lastEmailAt: thread?.lastEmailAt ?? null,
    },
  };
}

/** Every member row of a principal (optionally filtered to one org). */
function principalMembers(
  ctx: AppContext,
  principal: PrincipalIdent,
  orgId?: string,
): { member: typeof members.$inferSelect; room: typeof rooms.$inferSelect }[] {
  return ctx.db
    .select({ member: members, room: rooms })
    .from(members)
    .innerJoin(rooms, eq(rooms.id, members.roomId))
    .where(and(eq(members.principalType, principal.type), eq(members.principalId, principal.id)))
    .all()
    .filter((r) => (orgId ? r.room.orgId === orgId : true));
}

/** The principal-inbox room context for a room (counterpart on DM rooms). */
function inboxRoomRef(
  ctx: AppContext,
  room: typeof rooms.$inferSelect,
  selfPrincipalId: string,
): InboxRoomRef {
  const ref: InboxRoomRef = {
    id: room.id,
    name: room.name,
    orgId: room.orgId,
    kind: room.kind as RoomKind,
  };
  const counterpart = dmCounterpart(ctx, room, selfPrincipalId);
  if (counterpart) ref.counterpart = counterpart;
  return ref;
}

/**
 * Resolve a message for a principal by id, across ALL their memberships: the
 * message row, its room, and the caller's own recipient row (undefined when the
 * caller is only the sender). Returns undefined when the message does not exist
 * or the caller can neither read (recipient) nor has sent it — the seam the
 * single-message `/me/messages/:id` routes gate on (a foreign message is
 * indistinguishable from an unknown one: both 404).
 */
function principalMessage(
  ctx: AppContext,
  principal: PrincipalIdent,
  messageId: string,
): {
  msg: typeof messages.$inferSelect;
  room: typeof rooms.$inferSelect;
  recipientRow?: typeof messageRecipients.$inferSelect;
} | undefined {
  const msg = ctx.db.select().from(messages).where(eq(messages.id, messageId)).get();
  // A clawed-back message (SPEC "Clawback") is indistinguishable from an
  // unknown one: by-id read AND read/ack both 404.
  if (!msg || msg.clawedBackAt) return undefined;
  const memberIds = new Set(principalMembers(ctx, principal).map((r) => r.member.id));
  const recipientRow = ctx.db
    .select()
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, msg.id))
    .all()
    .find((r) => memberIds.has(r.recipientId));
  if (!recipientRow && !memberIds.has(msg.senderId)) return undefined;
  const room = roomById(ctx, msg.roomId);
  if (!room) return undefined;
  return { msg, room, recipientRow };
}

export function registerMeRoomRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- GET /me/rooms --------------------- */
  app.get('/api/v1/me/rooms', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const org = (request.query as { org?: string } | undefined)?.org;
    const rows = principalMembers(ctx, principal, org).sort((a, b) =>
      a.member.createdAt.localeCompare(b.member.createdAt),
    );
    const items: MeRoom[] = rows.map(({ member, room }) => {
      const entry: MeRoom = {
        room: {
          id: room.id,
          name: room.name,
          orgId: room.orgId,
          kind: room.kind as RoomKind,
          archivedAt: room.archivedAt ?? null,
        },
        memberId: member.id,
        roomRole: member.roomRole as RoomRole,
      };
      const counterpart = dmCounterpart(ctx, room, principal.id);
      if (counterpart) entry.room.counterpart = counterpart;
      return entry;
    });
    const response: MeRoomsResponse = { items };
    return reply.send(response);
  });

  /* ------------------------------- DELETE /me/rooms/:roomId (leave) --- */
  app.delete<{ Params: { roomId: string } }>('/api/v1/me/rooms/:roomId', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const room = roomById(ctx, request.params.roomId);
    if (!room) throw notFound('No such room');
    const member = memberOf(ctx, room.id, principal.type, principal.id);
    if (!member) throw forbidden('You are not a member of this room');
    // Sole owner of a project room cannot leave (transfer or archive first). DM
    // rooms have no roles — leaving is always allowed (ensure re-joins).
    if (
      room.kind !== 'dm' &&
      member.roomRole === 'owner' &&
      roomOwnerCount(ctx, room.id) === 1
    ) {
      throw conflict('The sole owner cannot leave — transfer ownership or archive the room first');
    }
    const displayName = toMember(ctx, member).displayName;
    ctx.db.delete(members).where(eq(members.id, member.id)).run();
    emitMemberRemoved(ctx, room.id, { id: member.id, displayName });
    ctx.rooms.onMembershipChanged(principal.type, principal.id);
    return reply.send({ ok: true });
  });

  /* ------------------------- GET /me/room-invitations ---------------- */
  app.get('/api/v1/me/room-invitations', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const rows = ctx.db
      .select()
      .from(roomInvitations)
      .where(and(eq(roomInvitations.humanId, human.id), eq(roomInvitations.status, 'pending')))
      .orderBy(asc(roomInvitations.createdAt), asc(roomInvitations.id))
      .all();
    const response: ListMeRoomInvitationsResponse = {
      items: rows.map((r) => inviteeInvitation(ctx, r)),
    };
    return reply.send(response);
  });

  /* ------------------- POST /me/room-invitations/:id/accept ---------- */
  app.post<{ Params: { id: string } }>(
    '/api/v1/me/room-invitations/:id/accept',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const inv = ctx.db
        .select()
        .from(roomInvitations)
        .where(and(eq(roomInvitations.id, request.params.id), eq(roomInvitations.humanId, human.id)))
        .get();
      if (!inv || inv.status !== 'pending') throw notFound('No such invitation');
      const room = roomById(ctx, inv.roomId);
      if (!room) throw notFound('No such invitation');
      const ts = nowIso();
      let member = memberOf(ctx, room.id, 'human', human.id);
      if (!member) {
        const id = newMemberId();
        ctx.db
          .insert(members)
          .values({
            id,
            roomId: room.id,
            principalType: 'human',
            principalId: human.id,
            roomRole: 'member',
            lastSeenAt: ts,
            createdAt: ts,
          })
          .run();
        member = ctx.db.select().from(members).where(eq(members.id, id)).get()!;
      }
      ctx.db
        .update(roomInvitations)
        .set({ status: 'accepted', resolvedAt: ts })
        .where(eq(roomInvitations.id, inv.id))
        .run();
      const wire = toMember(ctx, member);
      emitMemberJoined(ctx, room.id, wire);
      ctx.rooms.onMembershipChanged('human', human.id);
      const response: AcceptRoomInvitationResponse = { room: toRoom(room), member: wire };
      return reply.send(response);
    },
  );

  /* ------------------ POST /me/room-invitations/:id/decline ---------- */
  app.post<{ Params: { id: string } }>(
    '/api/v1/me/room-invitations/:id/decline',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const inv = ctx.db
        .select()
        .from(roomInvitations)
        .where(and(eq(roomInvitations.id, request.params.id), eq(roomInvitations.humanId, human.id)))
        .get();
      if (!inv || inv.status !== 'pending') throw notFound('No such invitation');
      ctx.db
        .update(roomInvitations)
        .set({ status: 'declined', resolvedAt: nowIso() })
        .where(eq(roomInvitations.id, inv.id))
        .run();
      return reply.send({ ok: true });
    },
  );

  /* ------------------------------- GET /me/inbox --------------------- */
  // Previews across MEDIUMS, ascending, paged: items are a `type`-discriminated
  // union (SPEC "Unified attention → The medium-spanning work queue"). v4 ships
  // the chat variant; `?medium=email` is a valid narrowing that is simply empty
  // while the email medium is off (a client must never learn a medium's on/off
  // from a 404 — that is `GET /capabilities`).
  app.get('/api/v1/me/inbox', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const query = parse(MeInboxQuerySchema, request.query ?? {});
    const limit = resolveLimit(query.limit);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    // One queue, two mediums: each side is over-fetched from its own index and
    // then merge-sorted on the total order (createdAt, medium rank, id) — the
    // same order `/me/inbox/pop` drains in.
    const chatRows =
      query.medium === 'email'
        ? []
        : chatInboxRows(ctx, principal, query, limit, after);
    const emailRows =
      query.medium === 'chat' || principal.type !== 'agent'
        ? []
        : emailInboxRows(ctx, principal.id, query, limit, after);

    type Merged =
      | { rank: 0; createdAt: string; id: string; chat: (typeof chatRows)[number] }
      | { rank: 1; createdAt: string; id: string; email: (typeof emailRows)[number] };
    const merged: Merged[] = [
      ...chatRows.map(
        (r) => ({ rank: 0, createdAt: r.msg.createdAt, id: r.msg.id, chat: r }) as Merged,
      ),
      ...emailRows.map((r) => ({ rank: 1, createdAt: r.createdAt, id: r.id, email: r }) as Merged),
    ]
      .filter((m) => !after || queueKey(m.createdAt, m.rank, m.id) > after.id)
      .sort((a, b) => queueKey(a.createdAt, a.rank, a.id).localeCompare(queueKey(b.createdAt, b.rank, b.id)));

    const hasMore = merged.length > limit;
    const page = hasMore ? merged.slice(0, limit) : merged;
    // Listing marks each RETURNED chat row `received` (once) — server-observed
    // delivery. It marks NOTHING on an email item: SMTP delivery is not
    // sparrow's to witness.
    const markTs = nowIso();
    const effReceived = new Map<string, string | null>();
    for (const m of page) {
      if (m.rank !== 0) continue;
      const r = m.chat;
      effReceived.set(
        r.msg.id,
        r.receivedAt ??
          markReceived(ctx, r.msg.roomId, r.msg.senderId, r.msg.id, r.recipientId, markTs),
      );
    }
    const items = page.map((m): InboxEntry => {
      if (m.rank === 0) {
        const r = m.chat;
        const entry: ChatInboxEntry = {
          type: 'chat.message',
          ...toInboxItem(
            ctx,
            r.msg,
            recipientStatus(r.readAt, effReceived.get(r.msg.id) ?? r.receivedAt),
          ),
          room: inboxRoomRef(ctx, r.room, principal.id),
        };
        return entry;
      }
      return toEmailInboxEntry(ctx, m.email);
    });
    const last = page[page.length - 1];
    const response: MeInboxResponse = {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: last.createdAt,
              id: queueKey(last.createdAt, last.rank, last.id),
            })
          : null,
    };
    return reply.send(response);
  });

  /* ------------------------------- POST /me/inbox/pop ---------------- */
  // ONE drain loop across every membership AND every medium: the response is a
  // typed `WorkItem` (`{ item: WorkItem | null }`), never v3's `{ message, room }`.
  // Ordering is one queue by `createdAt` ascending, ties broken by medium in
  // registry order (chat before email) — with the email medium off the chat queue
  // IS the queue. The `{ ack?, note?, ttlSeconds? }` body survives unchanged,
  // including the rejection of `note`/`ttlSeconds` without `ack: true`.
  app.post('/api/v1/me/inbox/pop', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const body = parse(PopNextMessageRequestSchema, request.body ?? {});
    const memberIds = principalMembers(ctx, principal).map((r) => r.member.id);
    const hit = oldestUnreadAcrossMembers(ctx, memberIds);
    // The other medium's head of queue: a delivered inbound email with no
    // `read_at`. Ties break by medium in registry order — chat before email.
    const emailHit =
      principal.type === 'agent' ? oldestUnreadEmail(ctx, principal.id) : undefined;
    const emailWins =
      emailHit !== undefined &&
      (!hit || emailHit.createdAt < hit.row.createdAt);
    const chatRoom = hit && !emailWins ? roomById(ctx, hit.row.roomId) : undefined;
    if (emailWins && emailHit) {
      // Popping IS reading: `read_at` is set atomically with the return.
      markEmailRead(ctx, emailHit);
      const thread = threadById(ctx, emailHit.threadId);
      const item: EmailWorkItem = {
        type: 'email',
        email: toEmail(ctx, emailHit),
        thread: toThreadRef(thread!),
      };
      // An `ack` on an email item sets nothing — working status is a
      // room-scoped, member-scoped concept and an email has no room.
      // No `hints`: a response carrying WORK is never hinted (see below).
      const response: MeInboxPopResponse = { item };
      return reply.send(response);
    }
    if (!hit) {
      // An empty queue is `item: null` (never 404), and an `ack` on it sets nothing.
      //
      // THE PAUSE — the ONE hinted response surface on this server. The right
      // time to teach an agent is BETWEEN tasks, and an empty pop is precisely
      // that: the queue came back empty, so nothing the agent is carrying
      // competes with the lesson. The `computeHints` call lives inside this
      // branch, not above the fork, so it is not even EVALUATED when work is
      // returned — no wasted queries, and no delivery recorded (which would
      // silently burn a cooldown) for a hint nobody was ever shown.
      const empty: MeInboxPopResponse = { item: null };
      const hints = computeHints(
        ctx,
        principal,
        { clientVersion: clientVersionOf(request) },
        request,
      );
      if (hints) empty.hints = hints;
      return reply.send(empty);
    }
    const room = chatRoom!;
    const recipientMember = ctx.db.select().from(members).where(eq(members.id, hit.recipientId)).get()!;
    const ts = nowIso();
    ctx.db
      .update(messageRecipients)
      .set({ readAt: ts })
      .where(
        and(
          eq(messageRecipients.messageId, hit.row.id),
          eq(messageRecipients.recipientId, hit.recipientId),
        ),
      )
      .run();
    const message: Message = toMessage(ctx, hit.row);
    emitMessageRead(ctx, room.id, hit.row.senderId, {
      messageId: hit.row.id,
      by: toMemberRef(ctx, recipientMember),
      readAt: ts,
    });
    if (body.ack) applyAck(ctx, room.id, hit.recipientId, message, body);
    const item: ChatWorkItem = {
      type: 'chat.message',
      message,
      room: inboxRoomRef(ctx, room, principal.id),
    };
    // No `hints`: this response hands back WORK, and teaching must not compete
    // with the job. The lesson waits for the pause.
    const response: MeInboxPopResponse = { item };
    return reply.send(response);
  });

  /* --------------------------- GET /me/messages/:messageId ----------- */
  // Non-consuming fetch of ONE message by id, across the caller's memberships —
  // the peek half of ack-by-id: an agent that saw a message id (from a watcher
  // or `/me/inbox`) reads its full body WITHOUT consuming anything. Never writes
  // read state (contrast the room-scoped read, which marks read unless `?peek`).
  // Unknown or foreign (not sender/recipient) → 404.
  app.get<{ Params: { messageId: string } }>('/api/v1/me/messages/:messageId', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const hit = principalMessage(ctx, principal, request.params.messageId);
    if (!hit) throw notFound('No such message');
    const response: MeMessageResponse = {
      message: toMessage(ctx, hit.msg),
      room: inboxRoomRef(ctx, hit.room, principal.id),
    };
    return reply.send(response);
  });

  /* --------------------------- POST /me/messages/:messageId/read ----- */
  // Ack-by-id: mark THIS specific message read for the caller, across their
  // memberships. Unlike `/me/inbox/pop` (which consumes the OLDEST unread and can
  // race a watcher-shown message), this targets exactly the id the caller names —
  // the preferred read path for watcher-driven agents. Same receipt semantics as
  // pop: emits `message.read` to the sender when it transitions unread→read.
  // Idempotent (already-read → 200, no re-emit); unknown/foreign → 404.
  app.post<{ Params: { messageId: string } }>(
    '/api/v1/me/messages/:messageId/read',
    (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      const hit = principalMessage(ctx, principal, request.params.messageId);
      // A sender-only caller has no recipient row — there is nothing to read, so
      // it is 404 (indistinguishable from foreign/unknown), never a self-read.
      if (!hit || !hit.recipientRow) throw notFound('No such message');
      const { msg, room, recipientRow } = hit;
      if (!recipientRow.readAt) {
        const ts = nowIso();
        ctx.db
          .update(messageRecipients)
          .set({ readAt: ts })
          .where(
            and(
              eq(messageRecipients.messageId, msg.id),
              eq(messageRecipients.recipientId, recipientRow.recipientId),
            ),
          )
          .run();
        const recipientMember = ctx.db
          .select()
          .from(members)
          .where(eq(members.id, recipientRow.recipientId))
          .get()!;
        emitMessageRead(ctx, room.id, msg.senderId, {
          messageId: msg.id,
          by: toMemberRef(ctx, recipientMember),
          readAt: ts,
        });
      }
      const response: MeMessageResponse = {
        message: toMessage(ctx, msg),
        room: inboxRoomRef(ctx, room, principal.id),
      };
      return reply.send(response);
    },
  );
}
