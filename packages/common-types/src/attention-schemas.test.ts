import { describe, it, expect } from 'vitest';
import {
  RoomRefSchema,
  InboxRoomRefSchema,
  WorkItemTypeSchema,
  WorkItemSchema,
  ChatWorkItemSchema,
  EmailWorkItemSchema,
  MeInboxPopResponseSchema,
  PopNextMessageRequestSchema,
  PopNextMessageResponseSchema,
  InboxItemSchema,
  InboxEntrySchema,
  ChatInboxEntrySchema,
  EmailInboxEntrySchema,
  InboxThreadRefSchema,
  MeInboxQuerySchema,
  MeInboxResponseSchema,
  ActivityEntryTypeSchema,
  ActivityActorKindSchema,
  ActivityActorSchema,
  ActivityRefsSchema,
  ActivityEntrySchema,
  ListActivityResponseSchema,
  MeActivityQuerySchema,
  AgentActivityQuerySchema,
  ActivityAppendedEventSchema,
  NotificationKindSchema,
  NotificationSchema,
  MediumSchema,
} from './schemas.js';
import { NOTIFICATION_TITLE_MAX, NOTIFICATION_BODY_MAX, ACTIVITY_SUMMARY_MAX, HINT_TEXT_MAX } from './constants.js';

const memberRef = { id: 'mem_x7YtR2wQ9zKe', kind: 'agent' as const, displayName: 'fable', avatarUrl: null };
const counterpart = { type: 'human' as const, id: 'usr_a', displayName: 'Jake', avatarUrl: null };

const message = {
  id: 'msg_j5Wt9uH2bY6a',
  from: memberRef,
  to: [memberRef],
  kind: 'dm' as const,
  subject: null,
  body: 'hi',
  attachments: [],
  suggestedReplies: [],
  inReplyTo: null,
  replyValue: null,
  origin: null,
  createdAt: '2026-08-31T12:00:00Z',
};

const roomRef = { id: 'room_8kQ2wN5dR3xF', name: 'ops', orgId: 'org_V1StGXR8z5jd', kind: 'project' as const };

const party = { email: 'dana@partner.example.com', name: 'Dana Reyes', contactId: 'ext_Y2hJ5nQ8dF4r' };

const threadRef = {
  id: 'eth_R4kD8sW1zQ2m',
  orgId: 'org_V1StGXR8z5jd',
  agentId: 'agt_pQ9rT2vX5mLk',
  subject: 'Q3 rollout',
  trusted: true,
  lastEmailAt: '2026-08-31T12:04:00Z',
  createdAt: '2026-08-31T12:00:00Z',
};

const email = {
  id: 'eml_7bN3xC6vT9pL',
  threadId: 'eth_R4kD8sW1zQ2m',
  direction: 'in' as const,
  from: party,
  to: [party],
  cc: [],
  bcc: [],
  subject: 'Re: Q3 rollout',
  text: 'body',
  html: null,
  attachments: [],
  rfcMessageId: '<a@b>',
  inReplyTo: null,
  verification: { spf: 'pass' as const, dkim: 'pass' as const, dmarc: 'pass' as const, domain: 'partner.example.com' },
  disposition: 'delivered' as const,
  reason: null,
  judge: null,
  status: 'unread' as const,
  createdAt: '2026-08-31T12:04:00Z',
  resolvedAt: null,
};

const emailPreview = {
  id: 'eml_7bN3xC6vT9pL',
  threadId: 'eth_R4kD8sW1zQ2m',
  direction: 'in' as const,
  from: party,
  subject: 'Re: Q3 rollout',
  preview: 'first 200 chars of the text body',
  truncated: true,
  attachmentCount: 1,
  disposition: 'delivered' as const,
  reason: null,
  status: 'unread' as const,
  createdAt: '2026-08-31T12:04:00Z',
};

/* ------------------------------------------------------------------ *
 * RoomRef — the compact room descriptor layer 3 carries
 * ------------------------------------------------------------------ */

describe('RoomRef (layer 3)', () => {
  it('is { id, name, orgId, kind, counterpart? }', () => {
    expect(RoomRefSchema.parse(roomRef)).toEqual({ ...roomRef, counterpart: undefined });
    expect(RoomRefSchema.parse({ ...roomRef, kind: 'dm', name: '', counterpart }).counterpart?.displayName).toBe('Jake');
    expect(RoomRefSchema.parse(roomRef).counterpart).toBeUndefined();
    expect(RoomRefSchema.safeParse({ id: 'room_a', name: 'ops' }).success).toBe(false);
  });
  it('InboxRoomRef is the same shape (one descriptor, two names)', () => {
    expect(InboxRoomRefSchema.parse(roomRef).orgId).toBe(roomRef.orgId);
  });
});

/* ------------------------------------------------------------------ *
 * WorkItem — the medium-spanning pop
 * ------------------------------------------------------------------ */

describe('WorkItem', () => {
  const chatItem = { type: 'chat.message' as const, message, room: roomRef };
  const emailItem = { type: 'email' as const, email, thread: threadRef };

  it('WorkItemTypeSchema is chat.message|email (registry order)', () => {
    expect(WorkItemTypeSchema.options).toEqual(['chat.message', 'email']);
    expect(WorkItemTypeSchema.safeParse('voice.call').success).toBe(false);
  });

  it('the chat variant is { type, message, room }', () => {
    const parsed = ChatWorkItemSchema.parse(chatItem);
    expect(parsed.message.id).toBe(message.id);
    expect(parsed.room.orgId).toBe(roomRef.orgId);
    expect(ChatWorkItemSchema.safeParse({ type: 'chat.message', message }).success).toBe(false);
  });

  it('the email variant is { type, email, thread }', () => {
    const parsed = EmailWorkItemSchema.parse(emailItem);
    expect(parsed.email.id).toBe(email.id);
    expect(parsed.thread.subject).toBe('Q3 rollout');
    expect(EmailWorkItemSchema.safeParse({ type: 'email', email }).success).toBe(false);
  });

  it('WorkItemSchema discriminates on type and rejects a mismatched payload', () => {
    expect(WorkItemSchema.parse(chatItem).type).toBe('chat.message');
    expect(WorkItemSchema.parse(emailItem).type).toBe('email');
    // a chat payload under the email tag (and vice versa) is not a work item
    expect(WorkItemSchema.safeParse({ type: 'email', message, room: roomRef }).success).toBe(false);
    expect(WorkItemSchema.safeParse({ type: 'chat.message', email, thread: threadRef }).success).toBe(false);
    expect(WorkItemSchema.safeParse({ type: 'voice.call', call: {} }).success).toBe(false);
  });

  it('narrows by `type` as a discriminated union in TypeScript', () => {
    const item = WorkItemSchema.parse(emailItem);
    if (item.type === 'email') {
      expect(item.thread.agentId).toBe('agt_pQ9rT2vX5mLk');
    } else {
      throw new Error('expected the email variant');
    }
  });
});

describe('POST /me/inbox/pop', () => {
  it('responds { item: WorkItem | null } — v3’s { message, room } is gone', () => {
    expect(MeInboxPopResponseSchema.parse({ item: null }).item).toBeNull();
    const chat = MeInboxPopResponseSchema.parse({ item: { type: 'chat.message', message, room: roomRef } });
    expect(chat.item?.type).toBe('chat.message');
    const mail = MeInboxPopResponseSchema.parse({ item: { type: 'email', email, thread: threadRef } });
    expect(mail.item?.type).toBe('email');
    // the v3 envelope no longer parses
    expect(MeInboxPopResponseSchema.safeParse({ message, room: roomRef }).success).toBe(false);
    expect(MeInboxPopResponseSchema.safeParse({ message: null }).success).toBe(false);
  });

  it('carries the optional hints array (absent, never empty)', () => {
    const withHints = MeInboxPopResponseSchema.parse({
      item: null,
      hints: [{ id: 'email-is-a-different-register', text: 'That was email, not chat.' }],
    });
    expect(withHints.hints).toHaveLength(1);
    expect(MeInboxPopResponseSchema.parse({ item: null }).hints).toBeUndefined();
  });

  it('the { ack, note, ttlSeconds } body survives unchanged', () => {
    expect(PopNextMessageRequestSchema.parse({ ack: true, note: 'reading' }).ack).toBe(true);
    expect(PopNextMessageRequestSchema.safeParse({ note: 'reading' }).success).toBe(false);
    expect(PopNextMessageRequestSchema.safeParse({ ttlSeconds: 30 }).success).toBe(false);
  });

  it('the ROOM-scoped pop keeps its v3 shape (a bare message; rooms have no email)', () => {
    expect(PopNextMessageResponseSchema.parse({ message: null }).message).toBeNull();
    expect(PopNextMessageResponseSchema.parse({ message }).message?.id).toBe(message.id);
    expect('type' in PopNextMessageResponseSchema.parse({ message })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * GET /me/inbox — the type-discriminated preview union
 * ------------------------------------------------------------------ */

describe('InboxEntry', () => {
  const chatEntry = {
    type: 'chat.message' as const,
    id: 'msg_j5Wt9uH2bY6a',
    from: memberRef,
    kind: 'broadcast' as const,
    subject: null,
    preview: 'first 200 chars',
    truncated: true,
    attachmentCount: 0,
    status: 'received' as const,
    createdAt: '2026-08-31T12:00:00Z',
    room: roomRef,
  };
  const emailEntry = {
    ...emailPreview,
    type: 'email' as const,
    thread: { id: 'eth_R4kD8sW1zQ2m', subject: 'Q3 rollout', lastEmailAt: '2026-08-31T12:04:00Z' },
  };

  it('the chat variant is the v3 InboxItem + type + room', () => {
    expect(ChatInboxEntrySchema.parse(chatEntry).room.name).toBe('ops');
    expect(ChatInboxEntrySchema.parse(chatEntry).status).toBe('received');
    expect(ChatInboxEntrySchema.safeParse({ ...chatEntry, room: undefined }).success).toBe(false);
  });

  it('the email variant is EmailPreview + type + a compact thread ref', () => {
    const parsed = EmailInboxEntrySchema.parse(emailEntry);
    expect(parsed.thread.lastEmailAt).toBe('2026-08-31T12:04:00Z');
    expect(parsed.disposition).toBe('delivered');
    expect(InboxThreadRefSchema.parse(emailEntry.thread).subject).toBe('Q3 rollout');
    // the compact thread ref carries no agentId/trusted — that is EmailThreadRef's job
    expect('trusted' in InboxThreadRefSchema.parse({ ...emailEntry.thread, trusted: true })).toBe(false);
    expect(InboxThreadRefSchema.parse({ id: 'eth_a', subject: 's', lastEmailAt: null }).lastEmailAt).toBeNull();
  });

  it('InboxEntrySchema discriminates on type', () => {
    expect(InboxEntrySchema.parse(chatEntry).type).toBe('chat.message');
    expect(InboxEntrySchema.parse(emailEntry).type).toBe('email');
    expect(InboxEntrySchema.safeParse({ ...chatEntry, type: 'email' }).success).toBe(false);
    // an untyped v3 item is no longer a principal-inbox entry
    const { type: _t, ...untyped } = chatEntry;
    expect(InboxEntrySchema.safeParse(untyped).success).toBe(false);
  });

  it('the ROOM-scoped InboxItem carries NO type (a room has no email)', () => {
    const { type: _t, room: _r, ...roomItem } = chatEntry;
    expect(InboxItemSchema.parse(roomItem).id).toBe(chatEntry.id);
    expect('type' in InboxItemSchema.parse({ ...roomItem, type: 'chat.message' })).toBe(false);
  });

  it('MeInbox is a paged list of entries; the query narrows by org/medium/all', () => {
    expect(MeInboxResponseSchema.parse({ items: [chatEntry, emailEntry], nextCursor: null }).items).toHaveLength(2);
    expect(MeInboxQuerySchema.parse({ org: 'org_a', medium: 'email', all: 'true' }).medium).toBe('email');
    expect(MeInboxQuerySchema.parse({}).medium).toBeUndefined();
    // only chat|email narrow the inbox — voice writes no work items
    expect(MeInboxQuerySchema.safeParse({ medium: 'voice' }).success).toBe(false);
    expect(MeInboxQuerySchema.safeParse({ medium: 'nope' }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The activity timeline
 * ------------------------------------------------------------------ */

describe('ActivityEntry', () => {
  const entry = {
    id: 'act_L9mZ3kP6wB1t',
    orgId: 'org_V1StGXR8z5jd',
    medium: 'email' as const,
    type: 'email.received' as const,
    agent: { id: 'agt_pQ9rT2vX5mLk', name: 'fable' },
    actor: { kind: 'contact' as const, id: 'ext_Y2hJ5nQ8dF4r', displayName: 'Dana Reyes' },
    summary: 'Re: Q3 rollout',
    refs: { emailId: 'eml_7bN3xC6vT9pL', emailThreadId: 'eth_R4kD8sW1zQ2m' },
    createdAt: '2026-08-31T17:00:00Z',
  };

  it('the type registry is closed and includes the reserved voice.transcribed', () => {
    for (const t of [
      'chat.message',
      'email.received',
      'email.sent',
      'email.quarantined',
      'email.held',
      'email.rejected',
      'email.resolved',
      'voice.transcribed',
      'hint.delivered',
    ]) {
      expect(ActivityEntryTypeSchema.parse(t)).toBe(t);
    }
    expect(ActivityEntryTypeSchema.options).toHaveLength(9);
    expect(ActivityEntryTypeSchema.safeParse('chat.reaction').success).toBe(false);
    expect(ActivityEntryTypeSchema.safeParse('email').success).toBe(false);
  });

  it('actor.kind is human|agent|contact|system; actor.id is null for system', () => {
    for (const k of ['human', 'agent', 'contact', 'system']) expect(ActivityActorKindSchema.parse(k)).toBe(k);
    expect(ActivityActorKindSchema.safeParse('bot').success).toBe(false);
    expect(ActivityActorSchema.parse({ kind: 'system', id: null, displayName: 'sparrow' }).id).toBeNull();
    expect(ActivityActorSchema.parse({ kind: 'human', id: 'usr_a', displayName: 'Jake' }).id).toBe('usr_a');
    expect(ActivityActorSchema.safeParse({ kind: 'human', displayName: 'Jake' }).success).toBe(false);
  });

  it('refs carries only the keys its medium sets', () => {
    expect(ActivityRefsSchema.parse({ roomId: 'room_a', messageId: 'msg_a' }).messageId).toBe('msg_a');
    expect(ActivityRefsSchema.parse({ emailThreadId: 'eth_a', emailId: 'eml_a' }).roomId).toBeUndefined();
    expect(ActivityRefsSchema.parse({})).toEqual({});
  });

  it('parses the spec envelope; agent is null for an org-level entry', () => {
    expect(ActivityEntrySchema.parse(entry)).toEqual(entry);
    expect(ActivityEntrySchema.parse({ ...entry, agent: null }).agent).toBeNull();
    expect(ActivityEntrySchema.parse({ ...entry, summary: null }).summary).toBeNull();
    expect(ActivityEntrySchema.safeParse({ ...entry, summary: 'x'.repeat(ACTIVITY_SUMMARY_MAX + 1) }).success).toBe(false);
    expect(ActivityEntrySchema.safeParse({ ...entry, medium: 'sms' }).success).toBe(false);
    expect(ActivityEntrySchema.safeParse({ ...entry, type: 'email.forwarded' }).success).toBe(false);
  });

  it('a hint.delivered entry may carry its hint payload inline (id + verbatim text)', () => {
    // The one payload exception: sparrow-the-medium has no fetch route, so the
    // delivered hint (small, immutable, ≤ HINT_TEXT_MAX) rides the entry itself.
    // `summary` holds the human-framed ownerLabel; `hint.text` is what the
    // agent was actually told.
    const hinted = {
      ...entry,
      medium: 'system' as const,
      type: 'hint.delivered' as const,
      actor: { kind: 'system' as const, id: null, displayName: 'sparrow' },
      summary: 'Sparrow hinted the agent to upgrade its sparrow CLI.',
      refs: {},
      hint: { id: 'upgrade-your-cli', text: 'Your Sparrow client is behind — upgrade.' },
    };
    expect(ActivityEntrySchema.parse(hinted).hint).toEqual(hinted.hint);
    // Optional: every other entry type omits it, and old hint entries may too.
    expect(ActivityEntrySchema.parse(entry).hint).toBeUndefined();
    // The verbatim text is bounded by the same cap the hint wire enforces.
    expect(
      ActivityEntrySchema.safeParse({
        ...hinted,
        hint: { id: 'x', text: 'y'.repeat(HINT_TEXT_MAX + 1) },
      }).success,
    ).toBe(false);
  });

  it('a chat entry carries roomId/messageId refs', () => {
    const chatEntry = {
      ...entry,
      medium: 'chat' as const,
      type: 'chat.message' as const,
      actor: { kind: 'human' as const, id: 'usr_a', displayName: 'Jake' },
      refs: { roomId: 'room_a', messageId: 'msg_a' },
    };
    expect(ActivityEntrySchema.parse(chatEntry).refs.roomId).toBe('room_a');
  });

  it('lists are paged; queries filter by org and medium', () => {
    // A timeline is a transcript: newest-first, `before` in and `nextBefore` out.
    expect(ListActivityResponseSchema.parse({ items: [entry], nextBefore: null }).items).toHaveLength(1);
    expect(ListActivityResponseSchema.parse({ items: [], nextBefore: 'act_a' }).nextBefore).toBe('act_a');
    expect(ListActivityResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(false);
    expect(MeActivityQuerySchema.parse({ before: 'act_a' }).before).toBe('act_a');
    expect('cursor' in MeActivityQuerySchema.parse({ cursor: 'opaque' })).toBe(false);
    expect(AgentActivityQuerySchema.parse({ before: 'act_a' }).before).toBe('act_a');
    expect(MeActivityQuerySchema.parse({ org: 'org_a', medium: 'chat', limit: '10' }).limit).toBe(10);
    expect(MeActivityQuerySchema.safeParse({ medium: 'nope' }).success).toBe(false);
    // voice IS a valid activity filter (unlike the inbox) — the registry reserves it
    expect(MeActivityQuerySchema.parse({ medium: 'voice' }).medium).toBe('voice');
    expect(AgentActivityQuerySchema.parse({ medium: 'email' }).medium).toBe('email');
    // the per-agent route is already org-scoped in its path
    expect('org' in AgentActivityQuerySchema.parse({ org: 'org_a', medium: 'email' })).toBe(false);
    void MediumSchema;
  });

  it('activity.appended wraps one entry (delivered to the involved agent’s owner)', () => {
    expect(ActivityAppendedEventSchema.parse({ entry }).entry.id).toBe(entry.id);
    expect(ActivityAppendedEventSchema.safeParse({ entry: { id: 'act_a' } }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The notification router
 * ------------------------------------------------------------------ */

describe('Notification', () => {
  const n = {
    orgId: 'org_V1StGXR8z5jd',
    to: { type: 'human' as const, id: 'usr_a' },
    kind: 'email.approval-needed' as const,
    title: 'fable has mail waiting',
    body: 'dana@partner.example.com wrote about Q3 rollout',
    refs: { emailThreadId: 'eth_a', emailId: 'eml_a' },
    createdAt: '2026-08-31T17:00:00Z',
  };

  it('the kind vocabulary is closed', () => {
    for (const k of [
      'chat.message',
      'email.received',
      'email.approval-needed',
      'email.resolved',
      'enrollment.requested',
      'room.invitation',
      'agent.shared',
    ]) {
      expect(NotificationKindSchema.parse(k)).toBe(k);
    }
    expect(NotificationKindSchema.options).toHaveLength(7);
    expect(NotificationKindSchema.safeParse('email.quarantined').success).toBe(false);
  });

  it('carries a channel-neutral title/body and the same refs shape as an entry', () => {
    expect(NotificationSchema.parse(n).refs.emailId).toBe('eml_a');
    expect(NotificationSchema.parse({ ...n, to: { type: 'agent', id: 'agt_a' } }).to.type).toBe('agent');
    expect(NotificationSchema.safeParse({ ...n, title: 'x'.repeat(NOTIFICATION_TITLE_MAX + 1) }).success).toBe(false);
    expect(NotificationSchema.safeParse({ ...n, body: 'x'.repeat(NOTIFICATION_BODY_MAX + 1) }).success).toBe(false);
    expect(NotificationSchema.safeParse({ ...n, to: { type: 'contact', id: 'ext_a' } }).success).toBe(false);
  });
});
