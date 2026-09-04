import { describe, it, expect } from 'vitest';
import type { MeRoom, SidebarHuman, VisibilityAgent } from '@sparrow/common-types';
import type { RoomBadges } from './roomStreams.js';
import {
  buildDmMap,
  humanEntries,
  agentEntries,
  roomEntries,
  unreadTooltip,
  pendingTooltip,
} from './sidebar.js';

const agent = (
  id: string,
  name: string,
  online: boolean,
  owner = 'usr_me',
  sharedBy: string | null = null,
  emailAddress: string | null = null,
  /** The owner-only mail count the visibility list carries (null = not countable). */
  emailUnreadCount: number | null = null,
  /** The agent's org-visible role title, or null when it has no role. */
  roleTitle: string | null = null,
): VisibilityAgent => ({
  agent: {
    id,
    name,
    orgId: 'org_1',
    emailAddress,
    online,
    lastSeenAt: null,
    sharing: 'selected',
    roleTitle,
    createdAt: '2026-08-20T00:00:00Z',
  },
  owner: { id: owner, displayName: 'Owner' },
  sharedBy: sharedBy ? { id: sharedBy, displayName: 'Sharer' } : null,
  emailUnreadCount,
  roleInstructions: null,
});

const human = (
  id: string,
  name: string,
  online: boolean,
  lastSeenAt: string | null = null,
): SidebarHuman => ({
  human: { id, displayName: name, avatarUrl: null },
  online,
  lastSeenAt,
});

const dmRoom = (roomId: string, counterpartId: string, type: 'human' | 'agent'): MeRoom => ({
  room: {
    id: roomId,
    name: '',
    orgId: 'org_1',
    kind: 'dm',
    archivedAt: null,
    counterpart: { type, id: counterpartId, displayName: 'x', avatarUrl: null },
  },
  memberId: 'mem_x',
  roomRole: 'member',
});

const projectRoom = (roomId: string, name: string, archivedAt: string | null = null): MeRoom => ({
  room: { id: roomId, name, orgId: 'org_1', kind: 'project', archivedAt },
  memberId: 'mem_p',
  roomRole: 'owner',
});

const badges = (unread: Record<string, number>): RoomBadges => ({
  unread,
  statuses: {},
});

/** A principal-keyed presence-store snapshot (see lib/presenceStore). */
const presence = (entries: Record<string, boolean> = {}): ReadonlyMap<string, boolean> =>
  new Map(Object.entries(entries));

describe('sidebar sources are room-independent (the #borg regression)', () => {
  it('agents come from the visibility list regardless of any active room', () => {
    // A room the caller is in has agent co-members, but ONLY the visibility list
    // shapes the AGENTS section — co-membership confers nothing.
    const agents = [agent('agt_1', 'deploy', true)];
    const dm = buildDmMap([], {});
    const entries = agentEntries(agents, dm, 'usr_me');
    expect(entries.map((e) => e.agentId)).toEqual(['agt_1']);
    expect(entries[0]!.owned).toBe(true);
    expect(entries[0]!.online).toBe(true); // principal-level, from the source
  });

  it('carries the agent’s derived email address through (null when the medium is off)', () => {
    // v4 plumbing: the row holds the address so the email wave can render it
    // behind `capabilities.email` without another pass through this layer. With
    // the medium off the API sends `null`, and nothing downstream renders.
    const dm = buildDmMap([], {});
    expect(agentEntries([agent('agt_1', 'deploy', true)], dm, 'usr_me')[0]!.emailAddress).toBeNull();
    const addressed = agent('agt_2', 'sla', true, 'usr_me', null, 'sla@acme.example.com');
    expect(agentEntries([addressed], dm, 'usr_me')[0]!.emailAddress).toBe('sla@acme.example.com');
  });

  it('a shared agent names its owner and is not "yours"', () => {
    const entries = agentEntries([agent('agt_2', 'sla', false, 'usr_other', 'usr_boss')], buildDmMap([], {}), 'usr_me');
    expect(entries[0]!.owned).toBe(false);
    expect(entries[0]!.ownerName).toBe('Owner');
  });

  it('carries the agent’s org-visible role title (null when it has no role)', () => {
    const dm = buildDmMap([], {});
    expect(agentEntries([agent('agt_1', 'deploy', true)], dm, 'usr_me')[0]!.roleTitle).toBeNull();
    const roled = agent('agt_2', 'sla', true, 'usr_me', null, null, null, 'Support triage');
    expect(agentEntries([roled], dm, 'usr_me')[0]!.roleTitle).toBe('Support triage');
  });

  it('a dynamically-visible agent (room-members/org mode, no explicit share) still appears, un-owned', () => {
    // Dynamic access carries no `sharedBy`; the agent is owned by someone else,
    // so it lands in the AGENTS section as a non-"yours" entry.
    const entries = agentEntries(
      [agent('agt_dyn', 'orgbot', true, 'usr_other', null)],
      buildDmMap([], {}),
      'usr_me',
    );
    expect(entries.map((e) => e.agentId)).toEqual(['agt_dyn']);
    expect(entries[0]!.owned).toBe(false);
    expect(entries[0]!.ownerName).toBe('Owner');
  });

  it('DM-room unread + working attach to the matching principal', () => {
    const rooms = [dmRoom('room_dm', 'agt_1', 'agent')];
    const b = { room_dm: badges({ all: 3 }) };
    const dm = buildDmMap(rooms, b);
    const entries = agentEntries([agent('agt_1', 'deploy', true)], dm, 'usr_me');
    expect(entries[0]!.unread).toBe(3);
    expect(entries[0]!.dmRoomId).toBe('room_dm');
  });

  it('humans come from the humans source, unread from their DM room', () => {
    const rooms = [dmRoom('room_h', 'usr_a', 'human')];
    const dm = buildDmMap(rooms, { room_h: badges({ all: 2 }) });
    const entries = humanEntries([human('usr_a', 'Alice', true)], dm, presence());
    expect(entries[0]!.displayName).toBe('Alice');
    expect(entries[0]!.online).toBe(true);
    expect(entries[0]!.unread).toBe(2);
    expect(entries[0]!.dmRoomId).toBe('room_h');
  });

  it('carries the human avatarUrl when present, else null', () => {
    const dm = buildDmMap([], {});
    const withPic: SidebarHuman = {
      human: { id: 'usr_p', displayName: 'Pat', avatarUrl: 'https://x/p.png' } as SidebarHuman['human'],
      online: true,
      lastSeenAt: null,
    };
    expect(humanEntries([withPic], dm, presence())[0]!.avatarUrl).toBe('https://x/p.png');
    expect(humanEntries([human('usr_a', 'Alice', true)], dm, presence())[0]!.avatarUrl).toBeNull();
  });

  it('ROOMS lists only project rooms (DMs are hidden), with broadcast unread', () => {
    const rooms = [projectRoom('room_p', 'deploys'), dmRoom('room_dm', 'agt_1', 'agent')];
    const entries = roomEntries(rooms, { room_p: badges({ all: 5 }) });
    expect(entries.map((r) => r.roomId)).toEqual(['room_p']);
    expect(entries[0]!.unread).toBe(5);
  });

  it('humans: the shared presence store overrides the snapshot in both directions', () => {
    const dm = buildDmMap([], {});
    // Snapshot says offline, the store learned online (a live presence.changed
    // from ANY subscribed room, or a fresher hydrate) -> the dot lights.
    expect(humanEntries([human('usr_a', 'Alice', false)], dm, presence({ usr_a: true }))[0]!.online).toBe(
      true,
    );
    // Snapshot says online, the store learned offline -> the dot clears.
    expect(humanEntries([human('usr_a', 'Alice', true)], dm, presence({ usr_a: false }))[0]!.online).toBe(
      false,
    );
  });

  it('agents: the shared presence store overrides the snapshot in both directions', () => {
    const dm = buildDmMap([], {});
    expect(
      agentEntries([agent('agt_1', 'deploy', false)], dm, 'usr_me', presence({ agt_1: true }))[0]!.online,
    ).toBe(true);
    expect(
      agentEntries([agent('agt_1', 'deploy', true)], dm, 'usr_me', presence({ agt_1: false }))[0]!.online,
    ).toBe(false);
  });

  it('falls back to the source snapshot when the store has no entry yet', () => {
    const dm = buildDmMap([], {});
    expect(humanEntries([human('usr_a', 'Alice', true)], dm, presence())[0]!.online).toBe(true);
    expect(humanEntries([human('usr_a', 'Alice', false)], dm, presence())[0]!.online).toBe(false);
    expect(agentEntries([agent('agt_1', 'deploy', true)], dm, 'usr_me', presence())[0]!.online).toBe(true);
  });

  it('flags a never-seen member (offline + null lastSeenAt) for dimmed rendering', () => {
    const dm = buildDmMap([], {});
    const entries = humanEntries(
      [
        human('usr_new', 'Newbie', false, null), // added by email, never active
        human('usr_seen', 'Seen', false, '2026-08-20T00:00:00Z'), // offline but has been active
        human('usr_on', 'Onliner', true, null), // online now, even if null lastSeen
      ],
      dm,
    );
    const byId = new Map(entries.map((e) => [e.principalId, e]));
    expect(byId.get('usr_new')!.neverSeen).toBe(true);
    expect(byId.get('usr_seen')!.neverSeen).toBe(false);
    expect(byId.get('usr_on')!.neverSeen).toBe(false);
  });

  // --- v4: the AGENTS badge fold (chat + email in ONE number) ---------------
  it('folds email unread into the agent badge (one number per agent)', () => {
    const rooms = [dmRoom('room_ag', 'agt_1', 'agent')];
    const dm = buildDmMap(rooms, { room_ag: badges({ all: 1 }) });
    const [entry] = agentEntries(
      [agent('agt_1', 'deploy', true)],
      dm,
      'usr_me',
      presence(),
      { agt_1: 2 },
    );
    expect(entry!.chatUnread).toBe(1);
    expect(entry!.emailUnread).toBe(2);
    expect(entry!.unread).toBe(3);
  });

  it('behaves exactly as v3 with no email-unread map (the medium off, or a shared-to-me agent)', () => {
    const rooms = [dmRoom('room_ag', 'agt_1', 'agent')];
    const dm = buildDmMap(rooms, { room_ag: badges({ all: 4 }) });
    expect(agentEntries([agent('agt_1', 'deploy', true)], dm, 'usr_me')[0]!.unread).toBe(4);
    const explicit = agentEntries([agent('agt_1', 'deploy', true)], dm, 'usr_me', presence(), {});
    expect(explicit[0]!.unread).toBe(4);
    expect(explicit[0]!.emailUnread).toBe(0);
  });

  it('email unread counts with no DM room at all — and never reorders the rows', () => {
    const dm = buildDmMap([], {});
    const entries = agentEntries(
      [agent('agt_b', 'bbb', true), agent('agt_a', 'aaa', true)],
      dm,
      'usr_me',
      presence(),
      { agt_b: 2 },
    );
    // The fold is visible in the badge…
    expect(entries.find((e) => e.agentId === 'agt_b')!.unread).toBe(2);
    expect(entries.find((e) => e.agentId === 'agt_b')!.emailUnread).toBe(2);
    // …but ordering stays alphanumerical: an email badge must not make rows leapfrog.
    expect(entries.map((e) => e.agentId)).toEqual(['agt_a', 'agt_b']);
  });

  it('unreadTooltip breaks the fold down in text', () => {
    expect(unreadTooltip(1, 2)).toBe('3 unread — 1 message, 2 emails');
    expect(unreadTooltip(2, 1)).toBe('3 unread — 2 messages, 1 email');
    // One medium only: the tooltip names just that one.
    expect(unreadTooltip(3, 0)).toBe('3 unread — 3 messages');
    expect(unreadTooltip(0, 1)).toBe('1 unread — 1 email');
    // Nothing unread: no tooltip at all (no badge is rendered either).
    expect(unreadTooltip(0, 0)).toBeNull();
  });

  it('pendingTooltip splits the pill count in text', () => {
    expect(pendingTooltip(1, 1)).toBe('2 waiting — 1 enrollment, 1 email');
    expect(pendingTooltip(2, 3)).toBe('5 waiting — 2 enrollments, 3 emails');
    expect(pendingTooltip(2, 0)).toBe('2 waiting — 2 enrollments');
    expect(pendingTooltip(0, 1)).toBe('1 waiting — 1 email');
    expect(pendingTooltip(0, 0)).toBeNull();
  });

  it('sorts humans alphabetically by name regardless of unread/online signals', () => {
    const rooms = [dmRoom('r_b', 'usr_b', 'human')];
    const dm = buildDmMap(rooms, { r_b: badges({ all: 1 }) });
    const entries = humanEntries(
      [human('usr_c', 'Zed', true), human('usr_b', 'Bob', false), human('usr_a', 'Amy', false)],
      dm,
    );
    // Alphabetical only — Bob's unread and Zed's presence must not reorder rows.
    expect(entries.map((e) => e.displayName)).toEqual(['Amy', 'Bob', 'Zed']);
  });

  it('sorts agents alphabetically regardless of API response order', () => {
    const entries = agentEntries(
      [agent('agt_3', 'zeta', false), agent('agt_1', 'alpha', false), agent('agt_2', 'mira', true)],
      buildDmMap([], {}),
      'usr_me',
    );
    expect(entries.map((e) => e.displayName)).toEqual(['alpha', 'mira', 'zeta']);
  });

  it('agent order is unchanged when presence/unread events land', () => {
    const source = [agent('agt_a', 'alpha', false), agent('agt_m', 'mira', false), agent('agt_z', 'zeta', false)];
    const quiet = agentEntries(source, buildDmMap([], {}), 'usr_me');
    expect(quiet.map((e) => e.displayName)).toEqual(['alpha', 'mira', 'zeta']);

    // zeta gains unread and mira comes online — the order must not move.
    const rooms = [dmRoom('r_z', 'agt_z', 'agent'), dmRoom('r_m', 'agt_m', 'agent')];
    const dm = buildDmMap(rooms, { r_z: badges({ all: 4 }) });
    const noisy = agentEntries(source, dm, 'usr_me', presence({ agt_m: true }));
    expect(noisy.map((e) => e.displayName)).toEqual(['alpha', 'mira', 'zeta']);
    expect(noisy.find((e) => e.displayName === 'zeta')!.unread).toBe(4);
    expect(noisy.find((e) => e.displayName === 'mira')!.online).toBe(true);
  });

  it('name sort is numeric-aware and case-insensitive (bot-2 < bot-10, Amy ~ amy)', () => {
    const entries = agentEntries(
      [agent('agt_10', 'bot-10', false), agent('agt_2', 'bot-2', false), agent('agt_b', 'Bot-1', false)],
      buildDmMap([], {}),
      'usr_me',
    );
    expect(entries.map((e) => e.displayName)).toEqual(['Bot-1', 'bot-2', 'bot-10']);
  });
});
