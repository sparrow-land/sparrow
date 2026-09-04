/**
 * Messages (SPEC "Messages"): send (DM to a member/principal or broadcast to
 * `all`), inbox previews (unread by default), atomic pop, read (with force-peek
 * on archived rooms), outbox, per-recipient status, attachment download, and
 * whoami. Attachments are stored on disk under `$DATA_DIR/attachments/{id}`;
 * download is restricted to the message's sender or recipients.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  SendMessageRequestSchema,
  ListInboxQuerySchema,
  PopNextMessageRequestSchema,
  ReadMessageQuerySchema,
  ListOutboxQuerySchema,
  ListRoomMessagesQuerySchema,
  MAX_BODY_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MESSAGES_LIST_DEFAULT_LIMIT,
  CLAWBACK_WINDOW,
  newMessageId,
  newAttachmentId,
  type SendMessageResponse,
  type ClawbackMessageResponse,
  type ListInboxResponse,
  type PopNextMessageResponse,
  type ReadMessageResponse,
  type ListOutboxResponse,
  type ListRoomMessagesResponse,
  type GetMessageStatusResponse,
  type WhoamiResponse,
  type MessageKind,
  type Message,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso, resolvePrincipal, principalIdent } from '../context.js';
import { activityEntries, attachments, members, messageRecipients, messages } from '../db/schema.js';
import { parse } from '../validate.js';
import { badRequest, conflict, forbidden, notFound, payloadTooLarge } from '../errors.js';
import { resolveLimit, cursorCondition, withCursor, pageResult } from '../pagination.js';
import {
  requireRoomMember,
  assertNotArchived,
  memberById,
  toMember,
  toMemberRef,
  dmCounterpart,
  agentById,
} from '../room-helpers.js';
import { AGENT_DM_NO_COMMON_VIEWER_MESSAGE } from '@sparrow/common-types';
import { canAccessAgent, someHumanCanSeeBoth } from '../agent-helpers.js';
import { appendChatMessageActivity } from '../activity.js';
import {
  memberIdentity,
  toMessage,
  toInboxItem,
  bodyPreview,
  messageInRoom,
  memberCanReadMessage,
  broadcastRecipientIds,
  unreadCountForMember,
  oldestUnreadAcrossMembers,
  recipientStatus,
  markReceived,
} from '../message-helpers.js';
import { emitMessageClawback, emitMessageNew, emitMessageRead } from '../room-events.js';
import { applyAck } from '../status-helpers.js';

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- SendMessage ----------------------- */
  app.post<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/messages', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    assertNotArchived(caller.room);

    // Agent-sharing gate on human→agent DM sends. A DM room is a private channel
    // that only exists because access was granted at ensure-time; if the human
    // has since lost access to the counterpart agent (sharing downgraded to
    // `selected`, or the last shared room removed under `room-members`), they
    // must not keep sending into it — otherwise a revoked human retains a working
    // private line. Reads stay membership-based (history remains visible); only
    // NEW human→agent sends are refused here. The agent→human direction is never
    // gated (an agent may always reply to a human), and the owner always passes
    // via their mint-time `agent_visibility` row (see canAccessAgent).
    if (caller.room.kind === 'dm' && caller.member.principalType === 'human') {
      const counterpart = dmCounterpart(ctx, caller.room, caller.member.principalId);
      if (counterpart?.type === 'agent') {
        const agent = agentById(ctx, counterpart.id);
        if (agent && !canAccessAgent(ctx, agent, caller.member.principalId)) {
          throw forbidden('You no longer have access to this agent');
        }
      }
    }

    // Agent↔agent DM revocation gate, symmetric with the human→agent one above:
    // the pair may keep sending only while some human can still oversee both. If
    // the last common viewer went away (a share revoked, the shared room left or
    // archived), new sends are refused — history stays readable, the line goes
    // quiet. Applies to a send from either agent into the DM.
    if (caller.room.kind === 'dm' && caller.member.principalType === 'agent') {
      const counterpart = dmCounterpart(ctx, caller.room, caller.member.principalId);
      if (counterpart?.type === 'agent') {
        const self = agentById(ctx, caller.member.principalId);
        const other = agentById(ctx, counterpart.id);
        if (self && other && !someHumanCanSeeBoth(ctx, self, other)) {
          throw forbidden(AGENT_DM_NO_COMMON_VIEWER_MESSAGE);
        }
      }
    }

    const body = parse(SendMessageRequestSchema, request.body);

    if (Buffer.byteLength(body.body, 'utf8') > MAX_BODY_BYTES) {
      throw payloadTooLarge('Message body is too large');
    }

    // Recipients + kind. Every message reaches the whole room: recipient rows go
    // to all current members except the sender (delivery-state fan-out), and `to`
    // is accepted-and-ignored (old clients may still pass a member id or `'all'`).
    // A `dm` room fans out to its one counterpart and keeps kind `dm`; a project
    // room is a flat `broadcast`. Posting into an empty project room is allowed
    // (zero recipient rows) — later joiners see it via the room history listing.
    const recipientIds = broadcastRecipientIds(ctx, caller.room.id, caller.member.id);
    const kind: MessageKind = caller.room.kind === 'dm' ? 'dm' : 'broadcast';

    // Structured reply echo: inReplyTo must reference a message the caller can read.
    if (body.inReplyTo) {
      const ref = messageInRoom(ctx, caller.room.id, body.inReplyTo);
      if (!ref || !memberCanReadMessage(ctx, caller.member.id, ref)) {
        throw notFound('No such message to reply to');
      }
    }

    // Validate + decode attachments.
    const decoded: { id: string; filename: string; contentType: string; bytes: Buffer }[] = [];
    let total = 0;
    for (const att of body.attachments ?? []) {
      const bytes = Buffer.from(att.dataBase64, 'base64');
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw payloadTooLarge('Attachment is too large');
      total += bytes.length;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw payloadTooLarge('Attachments are too large');
      decoded.push({ id: newAttachmentId(), filename: att.filename, contentType: att.contentType, bytes });
    }

    const ts = nowIso();
    const messageId = newMessageId();
    // Identity snapshots (SPEC "Messages"): `senderId`/`recipientId` name per-room
    // MEMBERSHIPS, which are deleted when someone leaves, is removed, or (for an
    // agent) is destroyed. Freeze who each party actually was so the transcript
    // survives that; live names still win on read while the principal exists.
    const senderRef = memberIdentity(ctx, caller.member);
    const recipientRefs = new Map(
      recipientIds.map((id) => [id, memberIdentity(ctx, memberById(ctx, id))] as const),
    );
    ctx.db.transaction((tx) => {
      tx.insert(messages)
        .values({
          id: messageId,
          roomId: caller.room.id,
          senderId: caller.member.id,
          senderPrincipalType: senderRef.principalType,
          senderPrincipalId: senderRef.principalId,
          senderDisplayName: senderRef.displayName,
          kind,
          subject: body.subject ?? null,
          body: body.body,
          suggestedReplies: body.suggestedReplies ? JSON.stringify(body.suggestedReplies) : null,
          inReplyTo: body.inReplyTo ?? null,
          replyValue: body.replyValue ?? null,
          origin: body.origin ?? null,
          createdAt: ts,
        })
        .run();
      for (const rid of recipientIds) {
        const ref = recipientRefs.get(rid)!;
        tx.insert(messageRecipients)
          .values({
            messageId,
            recipientId: rid,
            recipientPrincipalType: ref.principalType,
            recipientPrincipalId: ref.principalId,
            recipientDisplayName: ref.displayName,
            readAt: null,
          })
          .run();
      }
      for (const att of decoded) {
        tx.insert(attachments)
          .values({
            id: att.id,
            messageId,
            filename: att.filename,
            contentType: att.contentType,
            sizeBytes: att.bytes.length,
            createdAt: ts,
          })
          .run();
      }
    });
    for (const att of decoded) {
      writeFileSync(path.join(ctx.handle.attachmentsDir, att.id), att.bytes);
    }

    const messageRow = ctx.db.select().from(messages).where(eq(messages.id, messageId)).get()!;
    const message = toMessage(ctx, messageRow);
    // Layer 3: the chat medium's timeline writer — one `chat.message` entry per
    // involved agent (SPEC "Unified attention → Entry types registry"). A room
    // with no agent member writes nothing. It runs before the SSE fan-out so a
    // client that reacts to `activity.appended` can immediately read the entry.
    appendChatMessageActivity(ctx, caller.room, messageRow);
    const { preview } = bodyPreview(body.body);
    emitMessageNew(ctx, caller.room.id, recipientIds, {
      messageId,
      from: message.from,
      preview,
      kind,
    });
    // Trigger (a): server-observed delivery. Any recipient whose principal holds
    // an open stream on this room at send time (the same online source of truth
    // presence uses) has just had `message.new` written to it — mark `received`
    // (once) and notify the sender.
    const onlineIds = new Set(ctx.rooms.onlineMemberIds(caller.room.id));
    for (const rid of recipientIds) {
      if (onlineIds.has(rid)) {
        markReceived(ctx, caller.room.id, caller.member.id, messageId, rid, ts);
      }
    }
    const response: SendMessageResponse = {
      message,
      unreadCount: unreadCountForMember(ctx, caller.member.id),
    };
    // NO hints here, ever. The right time to teach an agent is BETWEEN tasks:
    // a send is work in flight, and a lesson stapled to it competes with the job
    // the agent is doing. Teaching happens at the PAUSE (an empty
    // `POST /me/inbox/pop`) and when the agent ASKS (`GET /me/hints`).
    // `SendMessageResponse.hints` survives in common-types only for wire-compat
    // with older servers; this one never populates it.
    return reply.code(201).send(response);
  });

  /* ------------------------------- Clawback -------------------------- */
  // SPEC "Clawback": the SENDER retracts their own message while it is still
  // unread by EVERY recipient (`received` is delivery, not reading). Eligible
  // only among the sender's last CLAWBACK_WINDOW non-clawed messages in the
  // room. On success the row is dead on every read surface, its `chat.message`
  // activity entries are deleted (no phantom timeline line), and
  // `message.clawback` fans out to ALL members — receipts rows stay but no
  // longer matter. The 409 discriminators ride the error `message` verbatim
  // (`already_clawed_back` | `message_read` | `outside_window`).
  app.post<{ Params: { roomId: string; messageId: string } }>(
    '/api/v1/rooms/:roomId/messages/:messageId/clawback',
    (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
      assertNotArchived(caller.room);

      // Direct table read (not messageInRoom): "already clawed" must be
      // distinguishable from "never existed". A foreign or foreign-room message
      // is a plain 404 — ownership never leaks.
      const row = ctx.db
        .select()
        .from(messages)
        .where(eq(messages.id, request.params.messageId))
        .get();
      if (!row || row.roomId !== caller.room.id || row.senderId !== caller.member.id) {
        throw notFound('No such message');
      }
      if (row.clawedBackAt) throw conflict('already_clawed_back');

      // ANY recipient having READ it kills the clawback; `received` does not.
      const readByAnyone = ctx.db
        .select({ recipientId: messageRecipients.recipientId })
        .from(messageRecipients)
        .where(and(eq(messageRecipients.messageId, row.id), isNotNull(messageRecipients.readAt)))
        .get();
      if (readByAnyone) throw conflict('message_read');

      // The window: the sender's last CLAWBACK_WINDOW live messages in the room.
      const recent = ctx.db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.roomId, caller.room.id),
            eq(messages.senderId, caller.member.id),
            isNull(messages.clawedBackAt),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(sql`${messages}.rowid`))
        .limit(CLAWBACK_WINDOW)
        .all();
      const at = recent.findIndex((r) => r.id === row.id);
      if (at < 0) throw conflict('outside_window');

      // Eligibility is the TRAILING UNREAD RUN, not any-unread-in-window
      // (Jake, 2026-09-02): a READ message is a hard stop — an older unread
      // message behind one that was read is locked in, because the
      // conversation has already moved past it. Check every NEWER own message
      // (those before `at` in this newest-first list) for a read recipient.
      const newerIds = recent.slice(0, at).map((r) => r.id);
      if (newerIds.length > 0) {
        const newerRead = ctx.db
          .select({ messageId: messageRecipients.messageId })
          .from(messageRecipients)
          .where(
            and(
              inArray(messageRecipients.messageId, newerIds),
              isNotNull(messageRecipients.readAt),
            ),
          )
          .get();
        if (newerRead) throw conflict('behind_read');
      }

      const ts = nowIso();
      ctx.db.transaction((tx) => {
        tx.update(messages).set({ clawedBackAt: ts }).where(eq(messages.id, row.id)).run();
        // Layer 3: the timeline must not keep a phantom line — delete the
        // message's `chat.message` entries (one per involved agent) by ref.
        tx.delete(activityEntries).where(eq(activityEntries.messageId, row.id)).run();
      });

      emitMessageClawback(ctx, caller.room.id, {
        messageId: row.id,
        by: toMemberRef(ctx, caller.member),
        clawedBackAt: ts,
      });
      // The FULL message (body included) so the client can restore it into the
      // composer — this response is the last place it is ever readable.
      const response: ClawbackMessageResponse = { message: toMessage(ctx, row) };
      return reply.send(response);
    },
  );

  /* ------------------------------- ListInbox ------------------------- */
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/inbox', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    const query = parse(ListInboxQuerySchema, request.query ?? {});
    const limit = resolveLimit(query.limit);
    // Clawed messages are dead — excluded from the unread AND the `?all` view.
    const live = isNull(messages.clawedBackAt);
    const base = query.all
      ? and(eq(messageRecipients.recipientId, caller.member.id), live)
      : and(
          eq(messageRecipients.recipientId, caller.member.id),
          isNull(messageRecipients.readAt),
          live,
        );
    const cursor = cursorCondition(messages.createdAt, messages.id, query.cursor);
    const where = withCursor(base, cursor);
    const rows = ctx.db
      .select({ msg: messages, readAt: messageRecipients.readAt, receivedAt: messageRecipients.receivedAt })
      .from(messageRecipients)
      .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
      .where(where)
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit + 1)
      .all();
    // Trigger (b): listing a message is server-observed delivery. Mark each
    // RETURNED row `received` (once) and notify the sender per newly-marked item.
    const page = rows.length > limit ? rows.slice(0, limit) : rows;
    const markTs = nowIso();
    const effReceived = new Map<string, string | null>();
    for (const r of page) {
      effReceived.set(
        r.msg.id,
        r.receivedAt ??
          markReceived(ctx, caller.room.id, r.msg.senderId, r.msg.id, caller.member.id, markTs),
      );
    }
    const response: ListInboxResponse = pageResult(
      rows,
      limit,
      (r) => toInboxItem(ctx, r.msg, recipientStatus(r.readAt, effReceived.get(r.msg.id) ?? r.receivedAt)),
      (r) => ({ createdAt: r.msg.createdAt, id: r.msg.id }),
    );
    return reply.send(response);
  });

  /* --------------------------- ListRoomMessages ---------------------- */
  // The room's conversation history: full Messages the caller can see, newest
  // first, walked backwards with a `before` message-id cursor. A peek — no read
  // state is ever written (contrast ListInbox, which observes delivery).
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/messages', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    const query = parse(ListRoomMessagesQuerySchema, request.query ?? {});
    const limit = query.limit ?? MESSAGES_LIST_DEFAULT_LIMIT;

    // `before` is a message-id cursor: resolve its (createdAt, rowid) anchor
    // within this room. Only its position is used (a pure keyset), so visibility
    // is not required — but it must be a real message here, else it is invalid.
    let beforeCond: SQL | undefined;
    if (query.before) {
      const anchor = ctx.db
        .select({ createdAt: messages.createdAt, rowid: sql<number>`${messages}.rowid` })
        .from(messages)
        .where(and(eq(messages.id, query.before), eq(messages.roomId, caller.room.id)))
        .get();
      if (!anchor) throw badRequest('Invalid before cursor');
      beforeCond = or(
        lt(messages.createdAt, anchor.createdAt),
        and(eq(messages.createdAt, anchor.createdAt), lt(sql`${messages}.rowid`, anchor.rowid)),
      );
    }

    // Visibility: any current member of the room reads the WHOLE room history
    // (Slack-channel semantics). Recipient rows are delivery state only — they no
    // longer gate what is visible here — so every message in the room is returned,
    // including ones sent before the caller joined and directed (`dm`-kind) rows
    // that predate this contract.
    // Clawed messages (SPEC "Clawback") are excluded — history shows only live
    // rows. (The `before` anchor above stays position-only: a cursor held from
    // before a clawback keeps paginating instead of turning into a 400.)
    const rows = ctx.db
      .select({ msg: messages })
      .from(messages)
      .where(and(eq(messages.roomId, caller.room.id), isNull(messages.clawedBackAt), beforeCond))
      .orderBy(desc(messages.createdAt), desc(sql`${messages}.rowid`))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const response: ListRoomMessagesResponse = {
      items: page.map((r) => toMessage(ctx, r.msg)),
      nextBefore: hasMore && page.length > 0 ? page[page.length - 1]!.msg.id : null,
    };
    return reply.send(response);
  });

  /* ------------------------------- PopNext --------------------------- */
  app.post<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/inbox/pop', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    assertNotArchived(caller.room);
    const body = parse(PopNextMessageRequestSchema, request.body ?? {});
    const hit = oldestUnreadAcrossMembers(ctx, [caller.member.id]);
    if (!hit) {
      const empty: PopNextMessageResponse = { message: null };
      return reply.send(empty);
    }
    const ts = nowIso();
    ctx.db
      .update(messageRecipients)
      .set({ readAt: ts })
      .where(
        and(
          eq(messageRecipients.messageId, hit.row.id),
          eq(messageRecipients.recipientId, caller.member.id),
        ),
      )
      .run();
    const message: Message = toMessage(ctx, hit.row);
    emitMessageRead(ctx, caller.room.id, hit.row.senderId, {
      messageId: hit.row.id,
      by: toMemberRef(ctx, caller.member),
      readAt: ts,
    });
    if (body.ack) applyAck(ctx, caller.room.id, caller.member.id, message, body);
    const response: PopNextMessageResponse = { message };
    return reply.send(response);
  });

  /* ------------------------------- ReadMessage ----------------------- */
  app.get<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/messages/:id',
    (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
      const row = messageInRoom(ctx, caller.room.id, request.params.id);
      if (!row || !memberCanReadMessage(ctx, caller.member.id, row)) throw notFound('No such message');
      const query = parse(ReadMessageQuerySchema, request.query ?? {});
      // Archived rooms are force-peek (read state never written); else honor ?peek.
      const peek = query.peek || !!caller.room.archivedAt;
      if (!peek) {
        const rec = ctx.db
          .select()
          .from(messageRecipients)
          .where(
            and(
              eq(messageRecipients.messageId, row.id),
              eq(messageRecipients.recipientId, caller.member.id),
              isNull(messageRecipients.readAt),
            ),
          )
          .get();
        if (rec) {
          const ts = nowIso();
          ctx.db
            .update(messageRecipients)
            .set({ readAt: ts })
            .where(
              and(
                eq(messageRecipients.messageId, row.id),
                eq(messageRecipients.recipientId, caller.member.id),
              ),
            )
            .run();
          emitMessageRead(ctx, caller.room.id, row.senderId, {
            messageId: row.id,
            by: toMemberRef(ctx, caller.member),
            readAt: ts,
          });
        }
      }
      const response: ReadMessageResponse = { message: toMessage(ctx, row) };
      return reply.send(response);
    },
  );

  /* ------------------------------- ListOutbox ------------------------ */
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/outbox', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    const query = parse(ListOutboxQuerySchema, request.query ?? {});
    const limit = resolveLimit(query.limit);
    const cursor = cursorCondition(messages.createdAt, messages.id, query.cursor);
    // The sender's outbox drops clawed rows too — the message is dead from
    // EVERY view (the clawback response already handed the body back once).
    const where = withCursor(
      and(
        eq(messages.roomId, caller.room.id),
        eq(messages.senderId, caller.member.id),
        isNull(messages.clawedBackAt),
      ),
      cursor,
    );
    const rows = ctx.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit + 1)
      .all();
    const response: ListOutboxResponse = pageResult(
      rows,
      limit,
      (r) => toMessage(ctx, r),
      (r) => ({ createdAt: r.createdAt, id: r.id }),
    );
    return reply.send(response);
  });

  /* ----------------------------- GetMessageStatus ------------------- */
  app.get<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/messages/:id/status',
    (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
      const row = messageInRoom(ctx, caller.room.id, request.params.id);
      if (!row || !memberCanReadMessage(ctx, caller.member.id, row)) throw notFound('No such message');
      const recRows = ctx.db
        .select()
        .from(messageRecipients)
        .where(eq(messageRecipients.messageId, row.id))
        .all();
      const response: GetMessageStatusResponse = {
        id: row.id,
        kind: row.kind as MessageKind,
        createdAt: row.createdAt,
        recipients: recRows.map((rec) => {
          const memberRow = ctx.db.select().from(members).where(eq(members.id, rec.recipientId)).get();
          const ref = memberRow
            ? toMemberRef(ctx, memberRow)
            : { id: rec.recipientId, kind: 'human' as const, displayName: '', avatarUrl: null };
          return {
            ...ref,
            status: recipientStatus(rec.readAt, rec.receivedAt),
            receivedAt: rec.receivedAt ?? null,
            readAt: rec.readAt ?? null,
          };
        }),
      };
      return reply.send(response);
    },
  );

  /* ------------------------------- GetAttachment --------------------- */
  app.get<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/attachments/:id',
    (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
      const att = ctx.db.select().from(attachments).where(eq(attachments.id, request.params.id)).get();
      if (!att) throw notFound('No such attachment');
      const row = messageInRoom(ctx, caller.room.id, att.messageId);
      if (!row || !memberCanReadMessage(ctx, caller.member.id, row)) throw notFound('No such attachment');
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(ctx.handle.attachmentsDir, att.id));
      } catch {
        throw notFound('Attachment file missing');
      }
      return reply
        .header('content-type', att.contentType)
        .header('content-disposition', `attachment; filename="${att.filename.replace(/"/g, '')}"`)
        .send(bytes);
    },
  );

  /* ------------------------------- Whoami ---------------------------- */
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/whoami', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    const response: WhoamiResponse = toMember(ctx, caller.member);
    return reply.send(response);
  });
}
