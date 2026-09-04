import { describe, it, expect } from 'vitest';
import type { MemberStatus, StatusChangedEvent } from '@sparrow/common-types';
import {
  hydrateStatuses,
  applyStatusEvent,
  pruneExpired,
  statusForPartner,
  membersWithStatus,
  activeRoomStatuses,
  statusKey,
} from './status.js';

const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 1_000).toISOString();

const status = (memberId: string, to: string | null, expiresAt = future): MemberStatus => ({
  memberId,
  displayName: 'x',
  state: 'working',
  note: 'reading',
  to: to ? { id: to, kind: 'human', avatarUrl: null, displayName: 'y' } : null,
  sinceAt: new Date(Date.now() - 1_000).toISOString(),
  sticky: false,
  expiresAt,
});

describe('status map (v3 MemberStatus)', () => {
  it('hydrates room-wide and scoped statuses under distinct keys', () => {
    const map = hydrateStatuses([status('mem_a', null), status('mem_a', 'mem_me')]);
    expect(Object.keys(map)).toHaveLength(2);
    expect(map[statusKey('mem_a', null)]).toBeDefined();
    expect(map[statusKey('mem_a', 'mem_me')]).toBeDefined();
  });

  it('applies working/idle events', () => {
    let map = hydrateStatuses([]);
    const ev: StatusChangedEvent = {
      member: { id: 'mem_a', kind: 'agent', avatarUrl: null, displayName: 'bot' },
      state: 'working',
      note: 'thinking',
      to: null,
      sinceAt: new Date(Date.now() - 1_000).toISOString(),
      sticky: false,
      expiresAt: future,
    };
    map = applyStatusEvent(map, ev);
    expect(map[statusKey('mem_a', null)]?.note).toBe('thinking');
    map = applyStatusEvent(map, { ...ev, state: 'idle' });
    expect(map[statusKey('mem_a', null)]).toBeUndefined();
  });

  it('keeps a sticky working event (null expiresAt) in the map; only idle removes it', () => {
    let map = hydrateStatuses([]);
    const sticky: StatusChangedEvent = {
      member: { id: 'mem_s', kind: 'agent', avatarUrl: null, displayName: 'bot' },
      state: 'working',
      note: 'long task',
      to: null,
      sinceAt: new Date(Date.now() - 5_000).toISOString(),
      sticky: true,
      expiresAt: null,
    };
    map = applyStatusEvent(map, sticky);
    const entry = map[statusKey('mem_s', null)];
    expect(entry?.sticky).toBe(true);
    // A sticky status never self-expires client-side (Infinity survives prune).
    expect(entry?.expiresAtMs).toBe(Infinity);
    expect(Object.keys(pruneExpired(map, Date.now() + 10 * 60_000))).toHaveLength(1);
    map = applyStatusEvent(map, { ...sticky, state: 'idle' });
    expect(map[statusKey('mem_s', null)]).toBeUndefined();
  });

  it('prunes expired statuses', () => {
    const map = hydrateStatuses([status('mem_a', null, past)]);
    expect(Object.keys(pruneExpired(map, Date.now()))).toHaveLength(0);
  });

  it('resolves a partner status scoped to me or room-wide, but not to others', () => {
    const map = hydrateStatuses([status('mem_a', 'mem_other')]);
    expect(statusForPartner(map, 'mem_me', 'mem_a', Date.now())).toBeNull();
    const map2 = hydrateStatuses([status('mem_a', 'mem_me')]);
    expect(statusForPartner(map2, 'mem_me', 'mem_a', Date.now())).not.toBeNull();
  });

  it('lists members that currently hold a status', () => {
    const map = hydrateStatuses([status('mem_a', null), status('mem_b', null, past)]);
    const ids = membersWithStatus(map, Date.now());
    expect(ids.has('mem_a')).toBe(true);
    expect(ids.has('mem_b')).toBe(false);
  });
});

describe('activeRoomStatuses (project-room composer bubbles)', () => {
  const named = (memberId: string, displayName: string, to: string | null, expiresAt = future): MemberStatus => ({
    memberId,
    displayName,
    state: 'working',
    note: `${displayName} note`,
    to: to ? { id: to, kind: 'human', avatarUrl: null, displayName: 'y' } : null,
    sinceAt: new Date(Date.now() - 1_000).toISOString(),
    sticky: false,
    expiresAt,
  });

  it('excludes the caller and drops expired statuses', () => {
    const map = hydrateStatuses([
      named('mem_me', 'Me', null),
      named('mem_a', 'Ann', null),
      named('mem_b', 'Bob', null, past),
    ]);
    const list = activeRoomStatuses(map, 'mem_me', Date.now());
    expect(list.map((s) => s.memberId)).toEqual(['mem_a']);
  });

  it('collapses a member with both a room-wide and a caller-scoped status to one (latest-expiring)', () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 90_000).toISOString();
    const map = hydrateStatuses([
      { ...named('mem_a', 'Ann', null, soon), note: 'wide' },
      { ...named('mem_a', 'Ann', 'mem_me', later), note: 'scoped' },
    ]);
    const list = activeRoomStatuses(map, 'mem_me', Date.now());
    expect(list).toHaveLength(1);
    expect(list[0]?.note).toBe('scoped');
  });

  it('orders deterministically by display name', () => {
    const map = hydrateStatuses([
      named('mem_c', 'Cara', null),
      named('mem_a', 'Ann', null),
      named('mem_b', 'Bob', null),
    ]);
    const list = activeRoomStatuses(map, 'mem_me', Date.now());
    expect(list.map((s) => s.displayName)).toEqual(['Ann', 'Bob', 'Cara']);
  });
});
