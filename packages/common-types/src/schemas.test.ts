import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  PrincipalKindSchema,
  RoomRoleSchema,
  MessageKindSchema,
  RoomKindSchema,
  ReadStatusSchema,
  ErrorCodeSchema,
  ErrorResponseSchema,
  OkResponseSchema,
  pagedResponseSchema,
  listResponseSchema,
  PageQuerySchema,
  BoolishSchema,
  MemberRefSchema,
  HumanRefSchema,
  RoomRefSchema,
  RoomNameSchema,
  RoomSettingsSchema,
  RoomSchema,
  GetRoomResponseSchema,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  UpdateRoomRequestSchema,
  UpdateRoomResponseSchema,
  MemberSchema,
  GetMemberResponseSchema,
  WhoamiResponseSchema,
  ListMembersResponseSchema,
  AddMemberRequestSchema,
  MemberResponseSchema,
  SetMemberRoleRequestSchema,
  DmCounterpartSchema,
  MeRoomSchema,
  MeRoomsResponseSchema,
  EnsureDmRequestSchema,
  AgentDmBoxSchema,
  ListAgentDmsResponseSchema,
  EnsureDmResponseSchema,
  AttachmentMetaSchema,
  SuggestedReplyInputSchema,
  MessageOriginSchema,
  MessageSchema,
  InboxItemSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  HintSchema,
  HintActionSchema,
  HintLevelSchema,
  HintPreferencesResponseSchema,
  MeHintsResponseSchema,
  UpdateHintPreferencesRequestSchema,
  ListInboxQuerySchema,
  ListInboxResponseSchema,
  PopNextMessageRequestSchema,
  PopNextMessageResponseSchema,
  ReadMessageQuerySchema,
  ReadMessageResponseSchema,
  MessageStatusSchema,
  GetMessageStatusResponseSchema,
  DraftSchema,
  CreateDraftRequestSchema,
  CreateDraftResponseSchema,
  ListDraftsResponseSchema,
  InboxRoomRefSchema,
  ChatInboxEntrySchema,
  MeInboxResponseSchema,
  MeInboxPopResponseSchema,
  MeInboxQuerySchema,
  MemberStatusSchema,
  SetStatusRequestSchema,
  SetStatusResponseSchema,
  ListStatusesResponseSchema,
  SetPresenceRequestSchema,
  SetPresenceResponseSchema,
  PresenceSchema,
  PresenceStateSchema,
  RecipientStatusSchema,
  MessageNewEventSchema,
  MessageReadEventSchema,
  MessageReceivedEventSchema,
  MemberJoinedEventSchema,
  MemberUpdatedEventSchema,
  MemberRemovedEventSchema,
  RoomUpdatedEventSchema,
  StatusChangedEventSchema,
  PresenceChangedEventSchema,
  ReplayGapEventSchema,
  EventRoomRefSchema,
  CapabilitiesResponseSchema,
  TranscriptionRequestSchema,
  TranscriptionResponseSchema,
  HealthzResponseSchema,
} from './schemas.js';
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  QUIETABLE_EVENTS,
  quietEventNames,
} from './constants.js';

const memberRef = {
  id: 'mem_x7YtR2wQ9zKe',
  kind: 'agent' as const,
  displayName: 'deploy-bot',
  avatarUrl: null,
};
const humanRef = { id: 'mem_h', kind: 'human' as const, displayName: 'Jake', avatarUrl: null };

const member = {
  id: 'mem_x7YtR2wQ9zKe',
  kind: 'agent' as const,
  principalId: 'agt_pQ9rT2vX5mLk',
  displayName: 'deploy-bot',
  avatarUrl: null,
  roomRole: 'member' as const,
  lastSeenAt: '2026-08-20T17:00:00Z',
  createdAt: '2026-08-20T16:00:00Z',
};

const counterpart = {
  type: 'agent' as const,
  id: 'agt_pQ9rT2vX5mLk',
  displayName: 'deploy-bot',
  avatarUrl: null,
};

describe('primitive enums', () => {
  it('PrincipalKindSchema is human|agent', () => {
    expect(PrincipalKindSchema.parse('human')).toBe('human');
    expect(PrincipalKindSchema.parse('agent')).toBe('agent');
    expect(PrincipalKindSchema.safeParse('bot').success).toBe(false);
  });
  it('RoomRoleSchema is owner|admin|member', () => {
    for (const r of ['owner', 'admin', 'member']) expect(RoomRoleSchema.parse(r)).toBe(r);
    expect(RoomRoleSchema.safeParse('root').success).toBe(false);
  });
  it('RoomKindSchema is project|dm', () => {
    expect(RoomKindSchema.parse('project')).toBe('project');
    expect(RoomKindSchema.parse('dm')).toBe('dm');
    expect(RoomKindSchema.safeParse('channel').success).toBe(false);
  });
  it('MessageKindSchema / ReadStatusSchema', () => {
    expect(MessageKindSchema.parse('broadcast')).toBe('broadcast');
    expect(ReadStatusSchema.parse('unread')).toBe('unread');
    // Three-valued read state: unread → received → read.
    expect(ReadStatusSchema.parse('received')).toBe('received');
    expect(ReadStatusSchema.parse('read')).toBe('read');
  });
});

describe('shared refs', () => {
  it('MemberRefSchema is id/kind/displayName', () => {
    expect(MemberRefSchema.parse(memberRef)).toEqual(memberRef);
    expect(MemberRefSchema.safeParse({ id: 'mem_x', displayName: 'y' }).success).toBe(false);
    expect(MemberRefSchema.safeParse({ ...memberRef, kind: 'bot' }).success).toBe(false);
  });
  it('MemberRefSchema carries an optional principalId (additive; old payloads still parse)', () => {
    // New payloads: the stable principal id rides alongside the per-room member id.
    expect(MemberRefSchema.parse({ ...memberRef, principalId: 'agt_atlas' }).principalId).toBe(
      'agt_atlas',
    );
    // Old payloads (no principalId) parse and leave the field undefined.
    expect(MemberRefSchema.parse(memberRef).principalId).toBeUndefined();
  });
  it("MemberRefSchema accepts kind 'unknown' — an unresolved sender is never guessed into a human", () => {
    // A historical ref whose principal can no longer be identified says so,
    // rather than silently rendering as a blank human (which also misroutes on
    // `kind`). `Member.kind` stays the two real principal kinds.
    expect(MemberRefSchema.parse({ ...memberRef, kind: 'unknown' }).kind).toBe('unknown');
    expect(MemberSchema.safeParse({ ...member, kind: 'unknown' }).success).toBe(false);
  });
  it('HumanRefSchema / RoomRefSchema', () => {
    expect(HumanRefSchema.parse({ id: 'usr_a', displayName: 'Jake' }).displayName).toBe('Jake');
    // v4: RoomRef is layer 3's compact room descriptor ({ id, name, orgId, kind,
    // counterpart? }); the bare { id, name } form is gone. Full coverage lives in
    // attention-schemas.test.ts.
    expect(RoomRefSchema.parse({ id: 'room_a', name: 'ops', orgId: 'org_a', kind: 'project' }).name).toBe('ops');
    expect(RoomRefSchema.safeParse({ id: 'room_a', name: 'ops' }).success).toBe(false);
  });
});

describe('errors, paging, helpers', () => {
  it('ErrorCodeSchema accepts every documented code', () => {
    for (const code of [
      'bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict',
      'gone', 'rate_limited', 'payload_too_large', 'internal',
    ]) {
      expect(ErrorCodeSchema.parse(code)).toBe(code);
    }
  });
  it('ErrorResponseSchema wraps { code, message } and tolerates an optional docs url', () => {
    expect(ErrorResponseSchema.parse({ error: { code: 'not_found', message: 'nope' } })).toBeTruthy();
    expect(ErrorResponseSchema.safeParse({ error: { code: 'boom', message: 'x' } }).success).toBe(false);
    const withDocs = ErrorResponseSchema.parse({
      error: { code: 'bad_request', message: 'x', docs: 'https://h.example/docs/api/rooms/status' },
    });
    expect(withDocs.error.docs).toBe('https://h.example/docs/api/rooms/status');
  });
  it('OkResponseSchema requires ok:true literal', () => {
    expect(OkResponseSchema.parse({ ok: true }).ok).toBe(true);
    expect(OkResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
  it('HintSchema: id + text required, action/docs optional, text length-capped', () => {
    expect(HintSchema.parse({ id: 'x', text: 'do the thing' }).action).toBeUndefined();
    const full = HintSchema.parse({
      id: 'drain-your-inbox',
      text: 'Pop your inbox.',
      action: { method: 'POST', path: '/api/v1/me/inbox/pop', exampleBody: { ack: true } },
      docs: 'https://h/docs/api/me/inbox',
    });
    expect(full.action?.method).toBe('POST');
    expect(HintSchema.safeParse({ id: 'x', text: 'y'.repeat(301) }).success).toBe(false);
    expect(HintActionSchema.safeParse({ method: 'GET' }).success).toBe(false);
  });
  it('HintLevelSchema + hint-preferences envelopes', () => {
    expect(HintLevelSchema.parse('aggressive')).toBe('aggressive');
    expect(HintLevelSchema.safeParse('loud').success).toBe(false);
    expect(UpdateHintPreferencesRequestSchema.parse({ level: 'off' }).level).toBe('off');
    const resp = HintPreferencesResponseSchema.parse({
      level: 'normal',
      choices: [{ level: 'off', summary: '...' }, { level: 'normal', summary: '...' }],
    });
    expect(resp.choices).toHaveLength(2);
  });
  it('quietEventNames maps `?quiet=` tokens to event names and drops the rest', () => {
    expect(quietEventNames(undefined)).toEqual(new Set());
    expect(quietEventNames('')).toEqual(new Set());
    expect(quietEventNames('presence')).toEqual(new Set(['presence.changed']));
    expect(quietEventNames('presence,status')).toEqual(
      new Set(['presence.changed', 'status.changed']),
    );
    // Whitespace/case tolerated; a token this server never heard of is IGNORED,
    // never an error — a newer client must still be able to connect.
    expect(quietEventNames(' Status , , telepathy ')).toEqual(new Set(['status.changed']));
    expect(QUIETABLE_EVENTS.presence).toBe('presence.changed');
  });
  it('MeHintsResponseSchema: hints REQUIRED and may be empty (the tips read is a list)', () => {
    // Unlike the decorated pop response — where `hints` is absent, never empty —
    // `GET /me/hints` is an explicit question, so the array is always present and
    // `[]` is the honest "nothing right now" answer.
    expect(MeHintsResponseSchema.parse({ hints: [] }).hints).toEqual([]);
    const many = MeHintsResponseSchema.parse({
      hints: [
        { id: 'start-listening', text: 'Open your events stream.' },
        { id: 'set-a-status', text: 'Advertise a working status.', docs: 'https://h/docs/api/rooms/status' },
      ],
    });
    expect(many.hints).toHaveLength(2);
    expect(MeHintsResponseSchema.safeParse({}).success).toBe(false);
  });
  it('pagedResponseSchema / listResponseSchema', () => {
    const paged = pagedResponseSchema(z.number());
    expect(paged.parse({ items: [1, 2], nextCursor: null }).nextCursor).toBeNull();
    expect(paged.safeParse({ items: 1, nextCursor: null }).success).toBe(false);
    expect(listResponseSchema(z.number()).parse({ items: [1] }).items).toEqual([1]);
  });
  it('PageQuerySchema coerces limit and bounds it', () => {
    expect(PageQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(PageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
  it('BoolishSchema parses query-string booleans', () => {
    expect(ListInboxQuerySchema.parse({ all: 'true' }).all).toBe(true);
    expect(ListInboxQuerySchema.parse({ all: '0' }).all).toBe(false);
    expect(ReadMessageQuerySchema.parse({ peek: '1' }).peek).toBe(true);
    expect(ListInboxQuerySchema.safeParse({ all: 'maybe' }).success).toBe(false);
    void BoolishSchema;
  });
});

describe('rooms & settings', () => {
  it('RoomSettingsSchema merges defaults and rejects unknown keys', () => {
    expect(RoomSettingsSchema.parse({})).toEqual({ description: '' });
    expect(RoomSettingsSchema.parse({ description: '  hi  ' }).description).toBe('hi');
    expect(RoomSettingsSchema.safeParse({ description: 'x'.repeat(241) }).success).toBe(false);
    expect(RoomSettingsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
  it('RoomNameSchema trims, requires non-empty, caps at 80', () => {
    expect(RoomNameSchema.parse('  ops  ')).toBe('ops');
    expect(RoomNameSchema.safeParse('   ').success).toBe(false);
    expect(RoomNameSchema.safeParse('x'.repeat(81)).success).toBe(false);
  });
  it('RoomNameSchema strips a leading # (people say a room name with one)', () => {
    // `sparrow room create "#launch-readiness"` must not store the literal `#`;
    // the sidebar prepends its own, which used to render `##launch-readiness`.
    expect(RoomNameSchema.parse('#ops')).toBe('ops');
    expect(RoomNameSchema.parse('  #ops ')).toBe('ops');
    expect(RoomNameSchema.parse('##ops')).toBe('ops');
    expect(RoomNameSchema.parse('#  ops')).toBe('ops');
    // Only LEADING hashes go.
    expect(RoomNameSchema.parse('a#b')).toBe('a#b');
    expect(RoomNameSchema.parse('#a#b')).toBe('a#b');
    // Nothing but hashes normalizes to empty → rejected.
    expect(RoomNameSchema.safeParse('#').success).toBe(false);
    expect(RoomNameSchema.safeParse('###').success).toBe(false);
    expect(RoomNameSchema.safeParse('  #  ').success).toBe(false);
    // Max length is measured AFTER normalization.
    expect(RoomNameSchema.parse('#' + 'x'.repeat(80))).toBe('x'.repeat(80));
    expect(RoomNameSchema.safeParse('#' + 'x'.repeat(81)).success).toBe(false);
  });
  it('RoomSchema / GetRoomResponse is id/orgId/name/kind/archivedAt/settings', () => {
    const room = {
      id: 'room_V1StGXR8z5jd', orgId: 'org_a', name: 'ops', kind: 'project' as const,
      archivedAt: null, settings: {},
    };
    const parsed = GetRoomResponseSchema.parse(room);
    expect(parsed.settings).toEqual({ description: '' });
    expect(parsed.kind).toBe('project');
    // kind is required (no default).
    expect(RoomSchema.safeParse({ ...room, kind: undefined }).success).toBe(false);
  });
  it('CreateRoom request/response', () => {
    expect(CreateRoomRequestSchema.parse({ name: '  demo ' }).name).toBe('demo');
    expect(CreateRoomRequestSchema.parse({ name: '#ops' }).name).toBe('ops');
    const r = CreateRoomResponseSchema.parse({
      room: { id: 'room_a', orgId: 'org_a', name: 'demo', kind: 'project', archivedAt: null, settings: {} },
    });
    expect(r.room.id).toBe('room_a');
  });
  it('UpdateRoom requires at least one key, and envelopes its response as { room }', () => {
    expect(UpdateRoomRequestSchema.parse({ name: ' renamed ' }).name).toBe('renamed');
    expect(UpdateRoomRequestSchema.parse({ name: '#renamed' }).name).toBe('renamed');
    expect(UpdateRoomRequestSchema.safeParse({ archived: true }).success).toBe(true);
    expect(UpdateRoomRequestSchema.safeParse({ settings: { description: 'x' } }).success).toBe(true);
    expect(UpdateRoomRequestSchema.safeParse({}).success).toBe(false);
    const room = {
      id: 'room_a', orgId: 'org_a', name: 'renamed', kind: 'project' as const,
      archivedAt: null, settings: {},
    };
    // Mutations envelope their resource — same shape as CreateRoom, not the bare
    // GetRoom body PATCH used to answer with.
    expect(UpdateRoomResponseSchema.parse({ room }).room.settings.description).toBe('');
    expect(UpdateRoomResponseSchema.safeParse(room).success).toBe(false);
  });
});

describe('members', () => {
  it('MemberSchema is the full resource', () => {
    expect(MemberSchema.parse(member)).toEqual(member);
    expect(MemberSchema.parse({ ...member, lastSeenAt: null }).lastSeenAt).toBeNull();
    expect(MemberSchema.safeParse({ ...member, kind: 'bot' }).success).toBe(false);
  });
  it('GetMember / Whoami return the bare Member', () => {
    expect(GetMemberResponseSchema.parse(member).id).toBe(member.id);
    expect(WhoamiResponseSchema.parse(member).id).toBe(member.id);
  });
  it('ListMembers is paged', () => {
    expect(ListMembersResponseSchema.parse({ items: [member], nextCursor: null }).items).toHaveLength(1);
  });
  it('AddMember request + { member } response', () => {
    expect(AddMemberRequestSchema.parse({ principal: 'agt_x' }).principal).toBe('agt_x');
    expect(AddMemberRequestSchema.safeParse({ principal: '' }).success).toBe(false);
    expect(MemberResponseSchema.parse({ member }).member.id).toBe(member.id);
  });
  it('SetMemberRole body', () => {
    expect(SetMemberRoleRequestSchema.parse({ roomRole: 'admin' }).roomRole).toBe('admin');
    expect(SetMemberRoleRequestSchema.safeParse({ roomRole: 'root' }).success).toBe(false);
  });
});

describe('/me/rooms + DMs', () => {
  it('DmCounterpartSchema type is human|agent', () => {
    expect(DmCounterpartSchema.parse(counterpart).id).toBe('agt_pQ9rT2vX5mLk');
    expect(DmCounterpartSchema.safeParse({ ...counterpart, type: 'guest' }).success).toBe(false);
  });
  it('MeRoomSchema carries room + memberId + roomRole; counterpart optional', () => {
    const project = MeRoomSchema.parse({
      room: { id: 'room_a', name: 'ops', orgId: 'org_a', kind: 'project', archivedAt: null },
      memberId: 'mem_a', roomRole: 'owner',
    });
    expect(project.room.counterpart).toBeUndefined();
    const dm = MeRoomSchema.parse({
      room: { id: 'room_dm', name: '', orgId: 'org_a', kind: 'dm', archivedAt: null, counterpart },
      memberId: 'mem_b', roomRole: 'member',
    });
    expect(dm.room.counterpart).toEqual(counterpart);
    expect(MeRoomsResponseSchema.parse({ items: [project, dm] }).items).toHaveLength(2);
  });
  it('EnsureDm request accepts optional orgId; response pins kind:dm', () => {
    expect(EnsureDmRequestSchema.parse({ principal: 'usr_x' }).orgId).toBeUndefined();
    expect(EnsureDmRequestSchema.parse({ principal: 'usr_x', orgId: 'org_a' }).orgId).toBe('org_a');
    expect(EnsureDmRequestSchema.safeParse({ principal: '' }).success).toBe(false);
    const r = EnsureDmResponseSchema.parse({
      room: { id: 'room_dm', kind: 'dm', orgId: 'org_a' }, counterpart, memberId: 'mem_a',
    });
    expect(r.room.kind).toBe('dm');
    expect(EnsureDmResponseSchema.safeParse({
      room: { id: 'room_dm', kind: 'project', orgId: 'org_a' }, counterpart, memberId: 'mem_a',
    }).success).toBe(false);
  });
  it('AgentDmBox: exactly two agent refs, nullable lastMessage; list wraps items', () => {
    const box = {
      roomId: 'room_dm',
      orgId: 'org_a',
      agents: [{ id: 'agt_a', name: 'alpha' }, { id: 'agt_b', name: 'beta' }],
      lastMessage: { preview: 'hi', at: '2026-09-01T00:00:00.000Z' },
    };
    expect(AgentDmBoxSchema.parse(box).agents).toHaveLength(2);
    expect(AgentDmBoxSchema.parse({ ...box, lastMessage: null }).lastMessage).toBeNull();
    // A one- or three-agent tuple is not a pair.
    expect(AgentDmBoxSchema.safeParse({ ...box, agents: [box.agents[0]] }).success).toBe(false);
    expect(ListAgentDmsResponseSchema.parse({ items: [box] }).items).toHaveLength(1);
  });
});

describe('messages', () => {
  const fullMessage = {
    id: 'msg_x7YtR2wQ9zKe',
    from: memberRef,
    to: [humanRef],
    kind: 'dm' as const,
    subject: null,
    body: 'full text',
    attachments: [{ id: 'att_p2LmV8cX4nRt', filename: 'a.txt', contentType: 'text/plain', sizeBytes: 123 }],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-08-20T17:00:00Z',
  };

  it('MessageSchema uses MemberRefs for from/to', () => {
    expect(MessageSchema.parse(fullMessage)).toEqual(fullMessage);
    // from must be a MemberRef (needs kind).
    expect(MessageSchema.safeParse({ ...fullMessage, from: { id: 'mem_x', displayName: 'y' } }).success)
      .toBe(false);
  });
  it('MessageSchema requires suggestedReplies / inReplyTo / replyValue keys', () => {
    const { suggestedReplies: _s, ...missing } = fullMessage;
    expect(MessageSchema.safeParse(missing).success).toBe(false);
  });
  it('AttachmentMetaSchema rejects negative sizeBytes', () => {
    expect(AttachmentMetaSchema.safeParse({ id: 'att_x', filename: 'a', contentType: 't', sizeBytes: -1 }).success)
      .toBe(false);
  });
  it('SuggestedReplyInputSchema defaults value to label', () => {
    expect(SuggestedReplyInputSchema.parse({ label: 'Wait' })).toEqual({ label: 'Wait', value: 'Wait' });
  });
  it('SendMessageRequestSchema: to/body, attachments cap, suggested replies, reply echo', () => {
    expect(SendMessageRequestSchema.parse({ to: 'all', body: 'hi' }).to).toBe('all');
    // `to` is optional (accepted-and-ignored server-side); only `body` is required.
    expect(SendMessageRequestSchema.parse({ body: 'hi' }).to).toBeUndefined();
    expect(SendMessageRequestSchema.safeParse({ to: 'all' }).success).toBe(false);
    expect(SendMessageRequestSchema.safeParse({}).success).toBe(false);
    const att = { filename: 'a.txt', contentType: 'text/plain', dataBase64: 'aGk=' };
    expect(SendMessageRequestSchema.safeParse({ to: 'all', body: 'x', attachments: Array(9).fill(att) }).success)
      .toBe(false);
    const parsed = SendMessageRequestSchema.parse({
      to: 'mem_b', body: 'ship?', suggestedReplies: [{ label: 'Ship it', value: 'ship' }, { label: 'Wait' }],
    });
    expect(parsed.suggestedReplies).toEqual([
      { label: 'Ship it', value: 'ship' }, { label: 'Wait', value: 'Wait' },
    ]);
    expect(SendMessageRequestSchema.safeParse({ to: 'b', body: 'x', suggestedReplies: [] }).success).toBe(false);
    expect(SendMessageRequestSchema.safeParse({ to: 'b', body: 'x', suggestedReplies: Array(5).fill({ label: 'ok' }) }).success)
      .toBe(false);
    expect(SendMessageRequestSchema.parse({ to: 'b', body: 'x', inReplyTo: 'msg_a', replyValue: 'ship' }).replyValue)
      .toBe('ship');
    expect(SendMessageRequestSchema.safeParse({ to: 'b', body: 'x', replyValue: 'ship' }).success).toBe(false);
  });
  it('MessageOriginSchema round-trips voice and rejects other strings', () => {
    expect(MessageOriginSchema.parse('voice')).toBe('voice');
    expect(MessageOriginSchema.safeParse('email').success).toBe(false);
    expect(MessageOriginSchema.safeParse('typed').success).toBe(false);
  });
  it('MessageSchema origin is nullable and defaults when absent', () => {
    expect(MessageSchema.parse({ ...fullMessage, origin: 'voice' }).origin).toBe('voice');
    expect(MessageSchema.parse({ ...fullMessage, origin: null }).origin).toBeNull();
    // absent origin defaults to null: new clients tolerate pre-voice servers.
    const { origin: _o, ...missing } = fullMessage;
    expect(MessageSchema.parse(missing).origin).toBeNull();
    // any non-'voice' value rejected.
    expect(MessageSchema.safeParse({ ...fullMessage, origin: 'email' }).success).toBe(false);
  });
  it('SendMessageRequestSchema origin: absent ok, voice ok, other rejected', () => {
    expect(SendMessageRequestSchema.parse({ to: 'all', body: 'hi' }).origin).toBeUndefined();
    expect(SendMessageRequestSchema.parse({ to: 'all', body: 'hi', origin: 'voice' }).origin).toBe('voice');
    expect(SendMessageRequestSchema.safeParse({ to: 'all', body: 'hi', origin: 'email' }).success).toBe(false);
  });
  it('SendMessageResponse requires a non-negative integer unreadCount', () => {
    expect(SendMessageResponseSchema.parse({ message: fullMessage, unreadCount: 3 }).unreadCount).toBe(3);
    expect(SendMessageResponseSchema.safeParse({ message: fullMessage }).success).toBe(false);
    expect(SendMessageResponseSchema.safeParse({ message: fullMessage, unreadCount: -1 }).success).toBe(false);
  });
  // RESERVED, not populated: since v0.1.7 hints attach only to the pause (the
  // `{ item: null }` pop). The field stays in the schema so a NEW client still
  // parses an OLD server's hinted send response instead of dropping it.
  it('SendMessageResponse keeps the reserved hints field parseable (old-server compatible)', () => {
    const quiet = SendMessageResponseSchema.parse({ message: fullMessage, unreadCount: 0 });
    expect('hints' in quiet).toBe(false);
    const hinted = SendMessageResponseSchema.parse({
      message: fullMessage,
      unreadCount: 0,
      hints: [{ id: 'set-a-status', text: 'Advertise a working status.' }],
    });
    expect(hinted.hints?.[0]!.id).toBe('set-a-status');
  });
  it('MeInboxPopResponse tolerates an optional hints array', () => {
    const hinted = MeInboxPopResponseSchema.parse({
      item: null,
      hints: [{ id: 'start-listening', text: 'Open your events stream.', docs: 'https://h/docs/api/me/events' }],
    });
    expect(hinted.hints?.[0]!.docs).toContain('/docs/api/me/events');
  });
  it('InboxItemSchema preview shape', () => {
    const item = {
      id: 'msg_a', from: memberRef, kind: 'dm', subject: null, preview: 'hi',
      truncated: true, attachmentCount: 1, status: 'unread', createdAt: '2026-08-20T17:00:00Z',
    };
    expect(InboxItemSchema.parse(item)).toEqual(item);
  });
  it('ListInbox / Pop / Read / Status envelopes', () => {
    expect(ListInboxResponseSchema.parse({ items: [], nextCursor: null })).toBeTruthy();
    expect(PopNextMessageRequestSchema.parse({ ack: true, note: 'reading' }).ack).toBe(true);
    expect(PopNextMessageResponseSchema.parse({ message: null }).message).toBeNull();
    expect(ReadMessageResponseSchema.parse({ message: fullMessage }).message.id).toBe(fullMessage.id);
    const status = {
      id: 'msg_a', kind: 'broadcast', createdAt: '2026-08-20T17:00:00Z',
      recipients: [{ ...humanRef, status: 'read', receivedAt: '2026-08-20T17:04:00Z', readAt: '2026-08-20T17:05:00Z' }],
    };
    expect(MessageStatusSchema.parse(status).recipients[0]!.status).toBe('read');
    expect(GetMessageStatusResponseSchema.parse(status)).toBeTruthy();
    // recipient entries are MemberRef + status/readAt.
    expect(MessageStatusSchema.safeParse({ ...status, recipients: [{ id: 'x', status: 'read', readAt: null }] }).success)
      .toBe(false);
  });
  it('RecipientStatusSchema: receivedAt defaults null, tolerates present', () => {
    // Pre-received servers omit receivedAt — new clients default it to null.
    const legacy = RecipientStatusSchema.parse({ ...humanRef, status: 'unread', readAt: null });
    expect(legacy.receivedAt).toBeNull();
    // received state carries a timestamp.
    const recv = RecipientStatusSchema.parse({ ...humanRef, status: 'received', receivedAt: '2026-08-20T17:04:00Z', readAt: null });
    expect(recv.receivedAt).toBe('2026-08-20T17:04:00Z');
    expect(recv.status).toBe('received');
  });
});

describe('voice (STT & TTS)', () => {
  it('CapabilitiesResponseSchema accepts the voice booleans, rejects bad shapes', () => {
    expect(CapabilitiesResponseSchema.parse({ voice: { stt: true, tts: false } }).voice.stt).toBe(true);
    expect(CapabilitiesResponseSchema.safeParse({ voice: { stt: true } }).success).toBe(false);
    expect(CapabilitiesResponseSchema.safeParse({ voice: { stt: 'yes', tts: false } }).success).toBe(false);
    expect(CapabilitiesResponseSchema.safeParse({}).success).toBe(false);
  });
  it('CapabilitiesResponseSchema defaults voice.sttStreaming to false (pre-streaming servers)', () => {
    // Additive and defaulted: a server that predates streaming STT omits the
    // field entirely and a new client still parses its capabilities.
    const parsed = CapabilitiesResponseSchema.parse({ voice: { stt: true, tts: false } });
    expect(parsed.voice.sttStreaming).toBe(false);
    expect(CapabilitiesResponseSchema.parse({ voice: { stt: true, tts: true, sttStreaming: true } }).voice.sttStreaming)
      .toBe(true);
    expect(CapabilitiesResponseSchema.safeParse({ voice: { stt: true, tts: true, sttStreaming: 'yes' } }).success)
      .toBe(false);
  });
  it('TranscriptionRequestSchema requires non-empty audio + contentType, language optional', () => {
    expect(TranscriptionRequestSchema.parse({ audioBase64: 'aGk=', contentType: 'audio/webm' }).language)
      .toBeUndefined();
    expect(TranscriptionRequestSchema.parse({ audioBase64: 'aGk=', contentType: 'audio/webm', language: 'en' }).language)
      .toBe('en');
    expect(TranscriptionRequestSchema.safeParse({ audioBase64: '', contentType: 'audio/webm' }).success).toBe(false);
    expect(TranscriptionRequestSchema.safeParse({ audioBase64: 'aGk=', contentType: '' }).success).toBe(false);
    expect(TranscriptionRequestSchema.safeParse({ contentType: 'audio/webm' }).success).toBe(false);
  });
  it('TranscriptionResponseSchema requires text, language optional', () => {
    expect(TranscriptionResponseSchema.parse({ text: 'hello' }).text).toBe('hello');
    expect(TranscriptionResponseSchema.parse({ text: 'hola', language: 'es' }).language).toBe('es');
    expect(TranscriptionResponseSchema.safeParse({ language: 'en' }).success).toBe(false);
  });
  it('MAX_TRANSCRIPTION_AUDIO_BYTES is 15 MiB', () => {
    expect(MAX_TRANSCRIPTION_AUDIO_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe('drafts', () => {
  const draft = { id: 'drf_x7YtR2wQ9zKe', text: 'work in progress', createdAt: '2026-08-20T17:00:00Z' };
  it('DraftSchema is { id, text, createdAt }', () => {
    expect(DraftSchema.parse(draft)).toEqual(draft);
    expect(DraftSchema.safeParse({ id: 'drf_x', text: 'x' }).success).toBe(false);
  });
  it('CreateDraftRequestSchema trims + requires non-empty text', () => {
    expect(CreateDraftRequestSchema.parse({ text: '  hi  ' }).text).toBe('hi');
    expect(CreateDraftRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(CreateDraftRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(CreateDraftRequestSchema.safeParse({}).success).toBe(false);
  });
  it('CreateDraft / ListDrafts envelopes', () => {
    expect(CreateDraftResponseSchema.parse({ draft }).draft.id).toBe(draft.id);
    expect(ListDraftsResponseSchema.parse({ items: [draft] }).items[0]!.text).toBe(draft.text);
    expect(ListDraftsResponseSchema.parse({ items: [] }).items).toEqual([]);
  });
});

describe('principal inbox', () => {
  const room = { id: 'room_dm', name: '', orgId: 'org_a', kind: 'dm' as const, counterpart };
  it('MeInboxQuery accepts org + all', () => {
    expect(MeInboxQuerySchema.parse({ org: 'org_a', all: 'true' }).all).toBe(true);
  });
  it('InboxRoomRef carries orgId + optional counterpart', () => {
    expect(InboxRoomRefSchema.parse(room).counterpart).toEqual(counterpart);
    expect(InboxRoomRefSchema.parse({ id: 'room_a', name: 'ops', orgId: 'org_a', kind: 'project' }).counterpart)
      .toBeUndefined();
  });
  it('the chat inbox entry is the v3 InboxItem + type + room; paged', () => {
    const item = {
      type: 'chat.message', id: 'msg_a', from: memberRef, kind: 'dm', subject: null, preview: 'hi',
      truncated: false, attachmentCount: 0, status: 'unread', createdAt: '2026-08-20T00:00:00Z', room,
    };
    expect(ChatInboxEntrySchema.parse(item).room.kind).toBe('dm');
    expect(MeInboxResponseSchema.parse({ items: [item], nextCursor: null }).items).toHaveLength(1);
  });
  it('MeInboxPop returns { item: WorkItem | null } (v3’s { message, room } is gone)', () => {
    expect(MeInboxPopResponseSchema.parse({ item: null }).item).toBeNull();
    const full = MeInboxPopResponseSchema.parse({
      item: {
        type: 'chat.message',
        message: {
          id: 'msg_a', from: memberRef, to: [humanRef], kind: 'dm', subject: null, body: 'hi',
          attachments: [], suggestedReplies: [], inReplyTo: null, replyValue: null, origin: null,
          createdAt: '2026-08-20T00:00:00Z',
        },
        room,
      },
    });
    expect(full.item?.type === 'chat.message' && full.item.room.kind).toBe('dm');
    expect(MeInboxPopResponseSchema.safeParse({ message: null }).success).toBe(false);
  });
});

describe('working status & presence', () => {
  const status = {
    memberId: 'mem_a', displayName: 'Jake', state: 'working' as const, note: 'thinking',
    to: humanRef, sinceAt: '2026-08-20T17:00:00Z', sticky: false, expiresAt: '2026-08-20T17:01:00Z',
  };
  it('MemberStatusSchema accepts working with scope and null note/to', () => {
    expect(MemberStatusSchema.parse(status)).toEqual(status);
    expect(MemberStatusSchema.parse({ ...status, note: null, to: null }).to).toBeNull();
    expect(MemberStatusSchema.safeParse({ ...status, state: 'idle' }).success).toBe(false);
  });
  it('MemberStatusSchema accepts a sticky status with null expiresAt', () => {
    const sticky = { ...status, sticky: true, expiresAt: null };
    expect(MemberStatusSchema.parse(sticky).expiresAt).toBeNull();
    expect(MemberStatusSchema.parse(sticky).sticky).toBe(true);
    // sinceAt is required (honest staleness needs it).
    const { sinceAt: _omit, ...noSince } = status;
    expect(MemberStatusSchema.safeParse(noSince).success).toBe(false);
  });
  it('SetStatusRequestSchema validates state, note, ttl, to, sticky', () => {
    expect(SetStatusRequestSchema.parse({ state: 'working', ttlSeconds: 600 }).ttlSeconds).toBe(600);
    expect(SetStatusRequestSchema.parse({ state: 'idle', to: 'mem_b' }).to).toBe('mem_b');
    expect(SetStatusRequestSchema.parse({ state: 'working', sticky: true }).sticky).toBe(true);
    expect(SetStatusRequestSchema.safeParse({ state: 'busy' }).success).toBe(false);
    expect(SetStatusRequestSchema.safeParse({ state: 'working', note: 'x'.repeat(141) }).success).toBe(false);
    expect(SetStatusRequestSchema.safeParse({ state: 'working', ttlSeconds: 0 }).success).toBe(false);
    expect(SetStatusRequestSchema.safeParse({ state: 'working', ttlSeconds: 601 }).success).toBe(false);
    // sticky and ttlSeconds are mutually exclusive.
    expect(SetStatusRequestSchema.safeParse({ state: 'working', sticky: true, ttlSeconds: 60 }).success).toBe(false);
  });
  it('SetStatusResponse + ListStatuses', () => {
    expect(SetStatusResponseSchema.parse({ status: null }).status).toBeNull();
    expect(SetStatusResponseSchema.parse({ status }).status).toEqual(status);
    const list = ListStatusesResponseSchema.parse({ items: [status], presence: { online: ['mem_a'] } });
    expect(list.presence.online).toEqual(['mem_a']);
    // presence is required (not defaulted).
    expect(ListStatusesResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });
  it('SetPresenceRequestSchema caps ttl at PRESENCE_TTL_MAX; allows 0 (clear)', () => {
    expect(SetPresenceRequestSchema.parse({ ttlSeconds: 300 }).ttlSeconds).toBe(300);
    expect(SetPresenceRequestSchema.parse({ ttlSeconds: 0 }).ttlSeconds).toBe(0);
    expect(SetPresenceRequestSchema.safeParse({ ttlSeconds: 301 }).success).toBe(false);
    expect(SetPresenceRequestSchema.safeParse({ ttlSeconds: -1 }).success).toBe(false);
  });
  it('SetPresenceResponseSchema carries onlineUntil (nullable)', () => {
    expect(SetPresenceResponseSchema.parse({ onlineUntil: '2026-08-20T17:05:00Z' }).onlineUntil).toBe('2026-08-20T17:05:00Z');
    expect(SetPresenceResponseSchema.parse({ onlineUntil: null }).onlineUntil).toBeNull();
  });
  it('PresenceSchema / PresenceStateSchema', () => {
    expect(PresenceSchema.parse({ online: ['mem_a'] }).online).toEqual(['mem_a']);
    expect(PresenceSchema.safeParse({ online: [1] }).success).toBe(false);
    expect(PresenceStateSchema.parse('offline')).toBe('offline');
    expect(PresenceStateSchema.safeParse('working').success).toBe(false);
  });
});

describe('SSE room events', () => {
  it('message.new / message.read carry MemberRefs', () => {
    expect(MessageNewEventSchema.parse({ messageId: 'msg_a', from: memberRef, preview: 'hi', kind: 'dm' }).from.kind)
      .toBe('agent');
    expect(MessageReadEventSchema.parse({ messageId: 'msg_a', by: humanRef, readAt: '2026-08-20T17:05:00Z' }).by.kind)
      .toBe('human');
  });
  it('message.new carries the message origin, defaulted to null', () => {
    // A voice-origin message tells an SSE-woken agent the sender's register
    // BEFORE it pops. Defaulted so pre-voice servers' frames still parse.
    expect(MessageNewEventSchema.parse({ messageId: 'msg_a', from: memberRef, preview: 'hi', kind: 'dm' }).origin)
      .toBeNull();
    expect(
      MessageNewEventSchema.parse({ messageId: 'msg_a', from: memberRef, preview: 'hi', kind: 'dm', origin: 'voice' })
        .origin,
    ).toBe('voice');
    expect(
      MessageNewEventSchema.parse({ messageId: 'msg_a', from: memberRef, preview: 'hi', kind: 'dm', origin: null })
        .origin,
    ).toBeNull();
    expect(
      MessageNewEventSchema.safeParse({ messageId: 'msg_a', from: memberRef, preview: 'hi', kind: 'dm', origin: 'email' })
        .success,
    ).toBe(false);
  });
  it('message.received carries { messageId, by, receivedAt }', () => {
    const evt = { messageId: 'msg_a', by: humanRef, receivedAt: '2026-08-20T17:04:00Z' };
    const parsed = MessageReceivedEventSchema.parse(evt);
    expect(parsed).toEqual(evt);
    expect(parsed.by.kind).toBe('human');
    // receivedAt is required on the event (unlike the defaulted RecipientStatus field).
    expect(MessageReceivedEventSchema.safeParse({ messageId: 'msg_a', by: humanRef }).success).toBe(false);
  });
  it('member.joined / updated / removed', () => {
    expect(MemberJoinedEventSchema.parse({ member }).member.id).toBe(member.id);
    expect(MemberUpdatedEventSchema.parse({ member }).member.roomRole).toBe('member');
    expect(MemberRemovedEventSchema.parse({ member: { id: 'mem_a', displayName: 'Jake' } }).member.id).toBe('mem_a');
    // member.removed carries only id + displayName.
    expect(MemberRemovedEventSchema.safeParse({ member: { id: 'mem_a' } }).success).toBe(false);
  });
  it('room.updated carries room (with archivedAt) + settings', () => {
    const e = RoomUpdatedEventSchema.parse({ room: { id: 'room_a', name: 'ops', archivedAt: null }, settings: {} });
    expect(e.settings.description).toBe('');
    expect(RoomUpdatedEventSchema.safeParse({ room: { id: 'room_a', name: 'ops' }, settings: {} }).success).toBe(false);
  });
  it('status.changed accepts working and idle (null expiresAt) payloads', () => {
    expect(StatusChangedEventSchema.parse({ member: memberRef, state: 'working', note: 'x', to: humanRef, sinceAt: '2026-08-20T17:00:00Z', sticky: false, expiresAt: '2026-08-20T17:01:00Z' }).state)
      .toBe('working');
    expect(StatusChangedEventSchema.parse({ member: memberRef, state: 'idle', note: null, to: null, sinceAt: null, sticky: false, expiresAt: null }).expiresAt)
      .toBeNull();
  });
  it('status.changed accepts a sticky working payload (null expiresAt, sticky true)', () => {
    const ev = StatusChangedEventSchema.parse({ member: memberRef, state: 'working', note: 'long task', to: null, sinceAt: '2026-08-20T17:00:00Z', sticky: true, expiresAt: null });
    expect(ev.sticky).toBe(true);
    expect(ev.expiresAt).toBeNull();
  });
  it('presence.changed carries a MemberRef + online/offline', () => {
    expect(PresenceChangedEventSchema.parse({ member: memberRef, state: 'online' }).state).toBe('online');
    expect(PresenceChangedEventSchema.safeParse({ member: memberRef, state: 'idle' }).success).toBe(false);
  });
  it('EventRoomRef wraps /me/events room events with id/name/orgId/kind', () => {
    expect(EventRoomRefSchema.parse({ id: 'room_a', name: 'ops', orgId: 'org_a', kind: 'project' }))
      .toEqual({ id: 'room_a', name: 'ops', orgId: 'org_a', kind: 'project' });
  });
  it('replay.gap echoes the requested since cursor as a number', () => {
    expect(ReplayGapEventSchema.parse({ since: 42 }).since).toBe(42);
    expect(ReplayGapEventSchema.safeParse({ since: '42' }).success).toBe(false);
  });
});

describe('misc', () => {
  it('HealthzResponseSchema', () => {
    expect(HealthzResponseSchema.parse({ ok: true, version: '3.0.0' }).version).toBe('3.0.0');
    expect(HealthzResponseSchema.safeParse({ ok: false, version: 'x' }).success).toBe(false);
  });
});
