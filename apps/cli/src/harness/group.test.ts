import { describe, expect, it } from 'vitest';
import type { InboxEntry } from '@sparrow/common-types';
import { backoffMs, groupInbox, groupKeyOf, groupLabelOf, mergeIntoGroups, dropItem } from './group.js';

function chat(id: string, roomId: string, opts?: { name?: string; kind?: string; at?: string; from?: string }): InboxEntry {
  return {
    type: 'chat.message',
    id,
    from: { id: 'mem_1', kind: 'human', displayName: opts?.from ?? 'Jake Quist', avatarUrl: null },
    kind: 'chat',
    subject: null,
    preview: `preview of ${id}`,
    truncated: false,
    attachmentCount: 0,
    status: 'unread',
    createdAt: opts?.at ?? '2026-09-03T10:00:00.000Z',
    room: {
      id: roomId,
      name: opts?.name ?? 'Product',
      orgId: 'org_1',
      kind: (opts?.kind ?? 'project') as 'project',
      ...(opts?.kind === 'dm'
        ? { counterpart: { type: 'human' as const, id: 'usr_1', displayName: 'Jake Quist', avatarUrl: null } }
        : {}),
    },
  } as unknown as InboxEntry;
}

function email(id: string, threadId: string, at = '2026-09-03T10:00:00.000Z'): InboxEntry {
  return {
    type: 'email',
    id,
    threadId,
    direction: 'inbound',
    from: { email: 'kim@outside.example', name: 'Kim' },
    subject: 'Invoice question',
    preview: 'about the invoice',
    truncated: false,
    attachmentCount: 0,
    disposition: 'delivered',
    reason: null,
    status: 'unread',
    createdAt: at,
    thread: { id: threadId, subject: 'Invoice question', lastEmailAt: at },
  } as unknown as InboxEntry;
}

describe('harness grouping', () => {
  it('keys chat by room and email by thread', () => {
    expect(groupKeyOf(chat('msg_1', 'room_a'))).toBe('room:room_a');
    expect(groupKeyOf(email('eml_1', 'eth_9'))).toBe('thread:eth_9');
  });

  it('labels a project room with #, a dm with @, an email thread with its subject', () => {
    expect(groupLabelOf(chat('msg_1', 'room_a'))).toBe('#Product');
    expect(groupLabelOf(chat('msg_1', 'room_a', { kind: 'dm' }))).toBe('@Jake Quist (dm)');
    expect(groupLabelOf(email('eml_1', 'eth_9'))).toBe('“Invoice question”');
  });

  it('groups a burst by room/thread keeping arrival order', () => {
    const groups = groupInbox([
      chat('msg_1', 'room_a', { at: '2026-09-03T10:00:00.000Z' }),
      chat('msg_2', 'room_b', { at: '2026-09-03T10:00:01.000Z' }),
      chat('msg_3', 'room_a', { at: '2026-09-03T10:00:02.000Z' }),
      email('eml_1', 'eth_9', '2026-09-03T10:00:03.000Z'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['room:room_a', 'room:room_b', 'thread:eth_9']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['msg_1', 'msg_3']);
    expect(groups[2]!.kind).toBe('email');
    expect(groups[2]!.id).toBe('eth_9');
  });

  it('merges a later peek without duplicating items already pending', () => {
    const groups = groupInbox([chat('msg_1', 'room_a')]);
    const { added } = mergeIntoGroups(groups, [chat('msg_1', 'room_a'), chat('msg_2', 'room_a')]);
    expect(added.map((i) => i.id)).toEqual(['msg_2']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['msg_1', 'msg_2']);
  });

  it('merge preserves per-group failure/backoff bookkeeping', () => {
    const groups = groupInbox([chat('msg_1', 'room_a')]);
    groups[0]!.failures = 2;
    groups[0]!.nextAttemptAt = 12345;
    mergeIntoGroups(groups, [chat('msg_2', 'room_a')]);
    expect(groups[0]!.failures).toBe(2);
    expect(groups[0]!.nextAttemptAt).toBe(12345);
  });

  it('dropItem removes a clawed-back item and prunes an emptied group', () => {
    const groups = groupInbox([chat('msg_1', 'room_a'), chat('msg_2', 'room_b')]);
    expect(dropItem(groups, 'msg_1')).toBe(true);
    expect(groups.map((g) => g.key)).toEqual(['room:room_b']);
    expect(dropItem(groups, 'nope')).toBe(false);
  });

  it('backs off exponentially from 30s and caps at 5 minutes', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(10)).toBe(300_000);
  });
});
