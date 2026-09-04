import { describe, it, expect, vi } from 'vitest';
import * as commonTypes from '@sparrow/common-types';
import type { MeRoom, SidebarHuman, VisibilityAgent } from '@sparrow/common-types';
import type { PrincipalEvent } from '@sparrow/client';
import {
  ME_EVENT_ROUTING,
  applyPrincipalEvent,
  renameInAgents,
  renameInHumans,
  renameInRooms,
  updateRoomRow,
  type PrincipalEventPatches,
  type PrincipalEventReloads,
} from './workspace.js';

/**
 * The `/me/events` dispatcher behind the whole shell. Extracted from the
 * provider so the routing table — the refetch half, the in-place-patch half,
 * the explicit ignores, and the forward-compat rule that an unrecognized event
 * is IGNORED rather than a crash — is testable without an SSE stream.
 */

interface Harness {
  reloads: PrincipalEventReloads;
  patches: PrincipalEventPatches;
  calls: Record<string, number>;
  /** Every in-place patch the frame drove, in order. */
  patched: unknown[];
}

function harness(): Harness {
  const calls: Record<string, number> = {
    humans: 0,
    agents: 0,
    rooms: 0,
    invitations: 0,
    approvals: 0,
    emailApprovals: 0,
  };
  const patched: unknown[] = [];
  return {
    calls,
    patched,
    reloads: {
      reloadHumans: async () => void (calls.humans! += 1),
      reloadAgents: async () => void (calls.agents! += 1),
      reloadRooms: async () => {
        calls.rooms! += 1;
        return [] as MeRoom[];
      },
      reloadInvitations: async () => void (calls.invitations! += 1),
      reloadApprovals: async () => void (calls.approvals! += 1),
      reloadEmailApprovals: async () => void (calls.emailApprovals! += 1),
    },
    patches: {
      renamePrincipal: (principalId, displayName, avatarUrl) =>
        void patched.push({ rename: { principalId, displayName, avatarUrl } }),
      updateRoom: (room) => void patched.push({ room }),
      applyPresence: (principalId, state) => void patched.push({ presence: { principalId, state } }),
    },
  };
}

function run(ev: PrincipalEvent, opts?: { knownRoomIds?: string[]; meId?: string }): Harness {
  const h = harness();
  applyPrincipalEvent(ev, {
    reloads: h.reloads,
    patches: h.patches,
    knownRoomIds: new Set(opts?.knownRoomIds ?? []),
    meId: opts?.meId,
  });
  return h;
}

/** Backwards-compatible shorthand for the refetch-only assertions. */
function apply(ev: PrincipalEvent, opts?: { knownRoomIds?: string[]; meId?: string }) {
  return run(ev, opts).calls;
}

const NOTHING = {
  rooms: 0,
  humans: 0,
  agents: 0,
  invitations: 0,
  approvals: 0,
  emailApprovals: 0,
};

const member = (principalId: string, displayName = 'Mira') => ({
  member: {
    id: 'mem_x',
    principalId,
    kind: 'human' as const,
    displayName,
    avatarUrl: null,
    roomRole: 'member' as const,
  },
});

describe('applyPrincipalEvent (the /me/events routing table)', () => {
  it('enrollment events refresh the approvals source', () => {
    expect(apply({ type: 'enrollment.requested', data: {} } as PrincipalEvent).approvals).toBe(1);
    expect(apply({ type: 'enrollment.resolved', data: {} } as PrincipalEvent).approvals).toBe(1);
  });

  it('a room invitation refreshes invitations only', () => {
    const calls = apply({ type: 'room.invitation', data: {} } as PrincipalEvent);
    expect(calls).toMatchObject({ invitations: 1, rooms: 0, humans: 0, agents: 0, approvals: 0 });
  });

  it('share/unshare refreshes the agents source', () => {
    expect(apply({ type: 'agent.shared', data: {} } as PrincipalEvent).agents).toBe(1);
    expect(apply({ type: 'agent.unshared', data: {} } as PrincipalEvent).agents).toBe(1);
  });

  it('member.joined for an UNKNOWN room refreshes the sidebar sources', () => {
    const calls = apply(
      { type: 'member.joined', data: member('usr_other'), room: { id: 'room_new' } } as PrincipalEvent,
      { knownRoomIds: ['room_old'], meId: 'usr_me' },
    );
    expect(calls).toMatchObject({ rooms: 1, humans: 1, agents: 1 });
  });

  it('member.joined in a KNOWN room refreshes only the joiner’s list, not our rooms', () => {
    // Our own memberships did not change, so the ROOMS source is untouched —
    // but the principal lists can move: an agent in `room-members` sharing mode
    // becomes reachable the moment it joins a room we are in, and HUMANS is
    // scoped by shared rooms. Membership changes are rare enough to pay for.
    const human = apply(
      { type: 'member.joined', data: member('usr_other'), room: { id: 'room_old' } } as PrincipalEvent,
      { knownRoomIds: ['room_old'], meId: 'usr_me' },
    );
    expect(human).toMatchObject({ rooms: 0, humans: 1, agents: 0 });

    const agentJoin = apply(
      {
        type: 'member.joined',
        data: { member: { ...member('agt_9').member, kind: 'agent' } },
        room: { id: 'room_old' },
      } as unknown as PrincipalEvent,
      { knownRoomIds: ['room_old'], meId: 'usr_me' },
    );
    expect(agentJoin).toMatchObject({ rooms: 0, humans: 0, agents: 1 });
  });

  it('member.joined naming US in a known room still refreshes (we gained the membership)', () => {
    const calls = apply(
      { type: 'member.joined', data: member('usr_me'), room: { id: 'room_old' } } as PrincipalEvent,
      { knownRoomIds: ['room_old'], meId: 'usr_me' },
    );
    expect(calls).toMatchObject({ rooms: 1, humans: 1, agents: 1 });
  });

  it('member.removed refreshes rooms + humans + agents', () => {
    // Agents included: a `room-members` agent stops being reachable when the
    // last shared room goes, and a DELETED agent leaves its rooms this way —
    // the only signal a viewer gets that it is gone.
    const calls = apply({ type: 'member.removed', data: {} } as PrincipalEvent);
    expect(calls).toMatchObject({ rooms: 1, humans: 1, agents: 1 });
  });

  // --- the reported bug: a rename must land WITHOUT a refetch ----------------
  describe('member.updated (a principal was renamed)', () => {
    it('patches the sources in place and refetches NOTHING', () => {
      const h = run({
        type: 'member.updated',
        data: member('agt_1', 'vm9-sparrow'),
        room: { id: 'room_dm' },
      } as PrincipalEvent);
      expect(h.patched).toEqual([
        { rename: { principalId: 'agt_1', displayName: 'vm9-sparrow', avatarUrl: null } },
      ]);
      // The frame carries the new name, so nothing is worth asking the server
      // for — and a refetch would land a frame later than the other surfaces.
      expect(h.calls).toMatchObject(NOTHING);
    });

    it('carries the avatar through (a human avatar change rides the same event)', () => {
      const ev = {
        type: 'member.updated',
        data: {
          member: {
            ...member('usr_2', 'Mira').member,
            avatarUrl: 'https://cdn.example/a.png',
          },
        },
      } as unknown as PrincipalEvent;
      expect(run(ev).patched).toEqual([
        {
          rename: {
            principalId: 'usr_2',
            displayName: 'Mira',
            avatarUrl: 'https://cdn.example/a.png',
          },
        },
      ]);
    });

    it('a payload without a principalId is data, not a crash (pre-fix servers)', () => {
      const ev = {
        type: 'member.updated',
        data: { member: { id: 'mem_x', displayName: 'Mira' } },
      } as unknown as PrincipalEvent;
      const h = run(ev);
      expect(h.patched).toEqual([]);
      expect(h.calls).toMatchObject(NOTHING);
    });

    it('a malformed member.updated never throws', () => {
      for (const ev of [
        { type: 'member.updated', data: null },
        { type: 'member.updated', data: {} },
        { type: 'member.updated' },
      ] as unknown as PrincipalEvent[]) {
        const h = run(ev);
        expect(h.patched).toEqual([]);
        expect(h.calls).toMatchObject(NOTHING);
      }
    });
  });

  // --- room renames / archive land in place too ------------------------------
  describe('room.updated', () => {
    it('patches the room row in place, with no refetch', () => {
      const h = run({
        type: 'room.updated',
        data: {
          room: { id: 'room_1', name: 'deploys', archivedAt: '2026-08-31T00:00:00Z' },
          settings: { description: '' },
        },
      } as unknown as PrincipalEvent);
      expect(h.patched).toEqual([
        { room: { id: 'room_1', name: 'deploys', archivedAt: '2026-08-31T00:00:00Z' } },
      ]);
      expect(h.calls).toMatchObject(NOTHING);
    });

    it('reads the WRAPPED shape /me/events actually delivers', () => {
      // `room.updated` is the one event whose payload has a top-level `room`,
      // and the fan-in splices its own `room` ref into the same object — so the
      // payload's room wins the key and the client surfaces it as `ev.room`,
      // leaving `ev.data.room` undefined. Honoring the event on the room stream
      // only would leave the sidebar stale for every OTHER room.
      const h = run({
        type: 'room.updated',
        data: { settings: { description: '' } },
        room: { id: 'room_1', name: 'deploys-v2', archivedAt: null },
      } as unknown as PrincipalEvent);
      expect(h.patched).toEqual([{ room: { id: 'room_1', name: 'deploys-v2', archivedAt: null } }]);
    });

    it('prefers the payload room when BOTH shapes are present', () => {
      const h = run({
        type: 'room.updated',
        data: { room: { id: 'room_1', name: 'payload', archivedAt: null } },
        room: { id: 'room_1', name: 'wrapper', kind: 'project', orgId: 'org_1' },
      } as unknown as PrincipalEvent);
      expect(h.patched).toEqual([{ room: { id: 'room_1', name: 'payload', archivedAt: null } }]);
    });

    it('defaults a missing archivedAt to null rather than dropping the frame', () => {
      const h = run({
        type: 'room.updated',
        data: { room: { id: 'room_1', name: 'deploys' } },
      } as unknown as PrincipalEvent);
      expect(h.patched).toEqual([{ room: { id: 'room_1', name: 'deploys', archivedAt: null } }]);
    });

    it('a malformed room.updated never throws', () => {
      for (const ev of [
        { type: 'room.updated', data: null },
        { type: 'room.updated', data: {} },
        { type: 'room.updated', data: { room: {} } },
      ] as unknown as PrincipalEvent[]) {
        expect(run(ev).patched).toEqual([]);
      }
    });
  });

  // --- presence from EVERY room, including ones past the stream cap ----------
  it('presence.changed feeds the shared presence store, keyed by principal', () => {
    const h = run({
      type: 'presence.changed',
      data: {
        member: { id: 'mem_bot', kind: 'agent', displayName: 'Botty', principalId: 'agt_1' },
        state: 'online',
      },
    } as unknown as PrincipalEvent);
    expect(h.patched).toEqual([{ presence: { principalId: 'agt_1', state: 'online' } }]);
    expect(h.calls).toMatchObject(NOTHING);
  });

  it('a presence.changed without a principalId still routes (the store no-ops)', () => {
    const h = run({
      type: 'presence.changed',
      data: { member: { id: 'mem_bot', kind: 'agent', displayName: 'Botty' }, state: 'offline' },
    } as unknown as PrincipalEvent);
    expect(h.patched).toEqual([{ presence: { principalId: undefined, state: 'offline' } }]);
  });

  // --- v4: the email approvals queue is live for whoever may act on it -------
  it('email.quarantined / email.held / email.resolved refresh the email approvals source', () => {
    for (const type of ['email.quarantined', 'email.held', 'email.resolved']) {
      const calls = apply({ type, data: {} } as unknown as PrincipalEvent);
      expect(calls).toMatchObject({
        emailApprovals: 1,
        approvals: 0,
        rooms: 0,
        invitations: 0,
        humans: 0,
      });
    }
  });

  // --- v4: the AGENTS badge's email half rides on the agents list ------------
  // `VisibilityAgent.emailUnreadCount` is the ONLY producer of the fold, so any
  // event that moves what an agent has waiting has to refetch that list.
  it('the approval events refresh the agents list too (they move emailUnreadCount)', () => {
    for (const type of ['email.quarantined', 'email.held', 'email.resolved']) {
      const calls = apply({ type, data: {} } as unknown as PrincipalEvent);
      expect(calls).toMatchObject({ agents: 1, emailApprovals: 1 });
    }
  });

  it('email.received / email.sent refresh the agents list, and nothing else', () => {
    for (const type of ['email.received', 'email.sent']) {
      const calls = apply({ type, data: {} } as unknown as PrincipalEvent);
      expect(calls).toMatchObject({
        agents: 1,
        emailApprovals: 0,
        approvals: 0,
        rooms: 0,
        humans: 0,
        invitations: 0,
      });
    }
  });

  it('activity.appended refreshes the agents list ONLY for an email entry', () => {
    const entry = (medium: string) => ({
      type: 'activity.appended',
      data: {
        entry: { id: 'act_1', type: 'email.received', medium, createdAt: '2026-08-31T00:00:00Z' },
      },
    }) as unknown as PrincipalEvent;

    expect(apply(entry('email')).agents).toBe(1);
    // A chat entry fires on every message in every visible room; refetching the
    // agents list on each one is a cost the sidebar may not take.
    expect(apply(entry('chat')).agents).toBe(0);
    expect(apply(entry('voice')).agents).toBe(0);
  });

  it('a malformed activity.appended is data, not a crash', () => {
    for (const ev of [
      { type: 'activity.appended', data: null },
      { type: 'activity.appended', data: {} },
      { type: 'activity.appended' },
    ] as unknown as PrincipalEvent[]) {
      expect(apply(ev)).toMatchObject(NOTHING);
    }
  });

  // --- an incomplete replay is the one case that costs a full pass -----------
  it('replay.gap refetches EVERY source (the cursor predated retention)', () => {
    const h = run({ type: 'replay.gap', data: { reason: 'trimmed' } } as unknown as PrincipalEvent);
    expect(h.calls).toEqual({
      humans: 1,
      agents: 1,
      rooms: 1,
      invitations: 1,
      approvals: 1,
      emailApprovals: 1,
    });
    expect(h.patched).toEqual([]);
  });

  // --- forward compatibility (`/me/events` is an ADDITIVE fan-in) ------------
  it('ignores an event type it has never heard of, whatever its payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const ev of [
      { type: 'from.the.future', data: null },
      { type: 'no.data.at.all' },
      { type: 'member.reticulated', data: { member: member('usr_1').member } },
    ] as unknown as PrincipalEvent[]) {
      const h = run(ev);
      expect(h.calls).toMatchObject(NOTHING);
      expect(h.patched).toEqual([]);
    }
    // Forward compat is silent: an unknown event is data, not a defect to log.
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('routes every event without a patches context (refetch-only callers)', () => {
    // `patches` is optional; a caller that supplies none must not crash on the
    // store-driven events.
    for (const type of ['member.updated', 'room.updated', 'presence.changed']) {
      expect(() =>
        applyPrincipalEvent({ type, data: { member: member('agt_1').member } } as PrincipalEvent, {
          reloads: harness().reloads,
          knownRoomIds: new Set(),
          meId: 'usr_me',
        }),
      ).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Exhaustiveness: the wire's event list IS the table's key set               */
/* -------------------------------------------------------------------------- */

/** `MemberUpdatedEvent` → `member.updated` (every wire event name is two words). */
function eventNameOf(schemaExport: string): string {
  const words = schemaExport.replace(/EventSchema$/, '').match(/[A-Z][a-z0-9]*/g) ?? [];
  return words.map((w) => w.toLowerCase()).join('.');
}

/**
 * Every event name `@sparrow/common-types` defines, derived from its exported
 * `*EventSchema`s at RUNTIME — so adding a schema there fails this test until
 * the web decides what the new event means.
 */
function wireEventNames(): string[] {
  const names = Object.keys(commonTypes)
    .filter((k) => k.endsWith('EventSchema'))
    .map(eventNameOf);
  // `agent.shared` and `agent.unshared` are the same payload under two names,
  // so the schema list carries only the first.
  return [...new Set([...names, 'agent.unshared'])];
}

/** A minimal well-formed frame per event, good enough to observe its route. */
const SAMPLE: Record<string, unknown> = {
  'role.updated': { agentId: 'agt_1', roleTitle: 'Ops', roleUpdatedAt: '2026-09-01T00:00:00Z' },
  'dm.severed': {
    roomId: 'room_dm',
    orgId: 'org_1',
    agents: [
      { id: 'agt_a', name: 'alpha' },
      { id: 'agt_b', name: 'beta' },
    ],
    severedAt: '2026-09-01T00:00:00Z',
    by: { id: 'usr_1', displayName: 'Owner' },
  },
  'dm.allowed': {
    roomId: 'room_dm',
    orgId: 'org_1',
    agents: [
      { id: 'agt_a', name: 'alpha' },
      { id: 'agt_b', name: 'beta' },
    ],
    severedAt: null,
    by: { id: 'usr_1', displayName: 'Owner' },
  },
  'message.new': { messageId: 'msg_1', from: { id: 'mem_x' }, preview: 'hi', kind: 'broadcast' },
  'message.read': { messageId: 'msg_1', by: { id: 'mem_x' } },
  'message.clawback': {
    messageId: 'msg_1',
    by: { id: 'mem_x' },
    clawedBackAt: '2026-09-01T00:00:00Z',
  },
  'message.received': { messageId: 'msg_1', by: { id: 'mem_x' } },
  'member.joined': member('usr_other'),
  'member.updated': member('usr_other'),
  'member.removed': { member: { id: 'mem_x', displayName: 'Mira' } },
  'room.updated': { room: { id: 'room_1', name: 'deploys', archivedAt: null } },
  'status.changed': { member: { id: 'mem_x' }, state: 'working' },
  'presence.changed': { member: { id: 'mem_x', principalId: 'usr_1' }, state: 'online' },
  'enrollment.requested': { enrollment: {} },
  'enrollment.resolved': { enrollmentId: 'enr_1', status: 'approved' },
  'room.invitation': { invitation: {} },
  'agent.shared': { agent: {} },
  'agent.unshared': { agent: {} },
  // The medium gate is part of the route: only an EMAIL entry moves a source.
  'activity.appended': { entry: { id: 'act_1', medium: 'email' } },
  'email.received': { email: {}, thread: {} },
  'email.sent': { email: {}, thread: {} },
  'email.quarantined': { email: {}, agent: {} },
  'email.held': { email: {}, agent: {} },
  'email.resolved': { email: {}, thread: {} },
  'email.rejected': { agentId: 'agt_1' },
  'replay.gap': { reason: 'trimmed' },
};

describe('ME_EVENT_ROUTING — the table covers the whole wire', () => {
  it('has exactly one entry per event name common-types defines', () => {
    expect(Object.keys(ME_EVENT_ROUTING).sort()).toEqual(wireEventNames().sort());
  });

  it('every entry states a route: a refetch, a store patch, or WHY it is ignored', () => {
    for (const [name, route] of Object.entries(ME_EVENT_ROUTING)) {
      expect(route, name).toMatch(/^(refetch|store|ignored): \S/);
    }
  });

  it('every table entry has a sample frame, so the checks below are real', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(Object.keys(ME_EVENT_ROUTING).sort());
  });

  it('every NON-ignored event actually moves state', () => {
    for (const [name, route] of Object.entries(ME_EVENT_ROUTING)) {
      if (route.startsWith('ignored:')) continue;
      const h = run({ type: name, data: SAMPLE[name] } as PrincipalEvent, {
        // `member.joined` only acts on a room it does not already know.
        knownRoomIds: [],
        meId: 'usr_me',
      });
      const refetched = Object.values(h.calls).some((n) => n > 0);
      expect(refetched || h.patched.length > 0, `${name} → ${route}`).toBe(true);
      // A `store:` route must never quietly cost a request, and vice versa.
      if (route.startsWith('store:')) {
        expect(h.patched.length, name).toBeGreaterThan(0);
        expect(h.calls, name).toMatchObject(NOTHING);
      } else {
        expect(refetched, name).toBe(true);
      }
    }
  });

  it('every IGNORED event moves nothing at all', () => {
    for (const [name, route] of Object.entries(ME_EVENT_ROUTING)) {
      if (!route.startsWith('ignored:')) continue;
      const h = run({ type: name, data: SAMPLE[name] } as PrincipalEvent, {
        knownRoomIds: [],
        meId: 'usr_me',
      });
      expect(h.calls, `${name} → ${route}`).toMatchObject(NOTHING);
      expect(h.patched, `${name} → ${route}`).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The in-place patches themselves                                            */
/* -------------------------------------------------------------------------- */

const human = (id: string, displayName: string, avatarUrl: string | null = null): SidebarHuman => ({
  human: { id, displayName, avatarUrl },
  online: false,
  lastSeenAt: null,
});

const agent = (id: string, name: string): VisibilityAgent =>
  ({
    agent: {
      id,
      name,
      orgId: 'org_1',
      online: false,
      lastSeenAt: null,
      createdAt: '2026-08-01T00:00:00Z',
      emailAddress: `${name}@acme.sparrow.email`,
    },
    owner: { id: 'usr_1', displayName: 'Jake' },
    sharedBy: null,
    emailUnreadCount: null,
  }) as unknown as VisibilityAgent;

const dmRoom = (id: string, counterpartId: string, displayName: string): MeRoom =>
  ({
    room: {
      id,
      name: '',
      orgId: 'org_1',
      kind: 'dm',
      archivedAt: null,
      counterpart: { type: 'agent', id: counterpartId, displayName, avatarUrl: null },
    },
    memberId: 'mem_me',
    roomRole: 'owner',
  }) as MeRoom;

const projectRoom = (id: string, name: string, archivedAt: string | null = null): MeRoom =>
  ({
    room: { id, name, orgId: 'org_1', kind: 'project', archivedAt },
    memberId: 'mem_me',
    roomRole: 'owner',
  }) as MeRoom;

describe('in-place source patches', () => {
  it('renameInHumans renames one human and leaves the rest untouched', () => {
    const before = [human('usr_1', 'Jake'), human('usr_2', 'Mira')];
    const after = renameInHumans(before, 'usr_2', 'Mira Chen', null);
    expect(after.map((h) => h.human.displayName)).toEqual(['Jake', 'Mira Chen']);
    // Untouched rows keep their identity (no needless re-render downstream).
    expect(after[0]).toBe(before[0]);
  });

  it('renameInHumans carries a changed avatar (avatar changes ride member.updated)', () => {
    const before = [human('usr_2', 'Mira')];
    const after = renameInHumans(before, 'usr_2', 'Mira', 'https://cdn.example/a.png');
    expect(after[0]!.human.avatarUrl).toBe('https://cdn.example/a.png');
  });

  it('renameInHumans returns the SAME array when nothing changed', () => {
    const before = [human('usr_1', 'Jake'), human('usr_2', 'Mira')];
    // A rename ripples one member.updated per room the principal inhabits, so
    // the redundant frames must not re-render the shell.
    expect(renameInHumans(before, 'usr_2', 'Mira', null)).toBe(before);
    expect(renameInHumans(before, 'usr_nobody', 'Ghost', null)).toBe(before);
  });

  it('renameInAgents renames the agent and leaves its derived email address alone', () => {
    const before = [agent('agt_1', 'fable'), agent('agt_2', 'scout')];
    const after = renameInAgents(before, 'agt_1', 'vm9-sparrow');
    expect(after[0]!.agent.name).toBe('vm9-sparrow');
    // The frame does not carry the moved address; guessing it would be worse
    // than leaving the server's last word in place (nothing in the shell reads
    // it, and the agent page fetches its own copy).
    expect(after[0]!.agent.emailAddress).toBe('fable@acme.sparrow.email');
    expect(after[1]).toBe(before[1]);
  });

  it('renameInAgents returns the SAME array when nothing changed', () => {
    const before = [agent('agt_1', 'fable')];
    expect(renameInAgents(before, 'agt_1', 'fable')).toBe(before);
    expect(renameInAgents(before, 'agt_nobody', 'ghost')).toBe(before);
  });

  it('renameInRooms renames the DM counterpart — the crumb and header source', () => {
    const before = [dmRoom('room_dm', 'agt_1', 'fable'), projectRoom('room_p', 'deploys')];
    const after = renameInRooms(before, 'agt_1', 'vm9-sparrow', null);
    expect(after[0]!.room.counterpart!.displayName).toBe('vm9-sparrow');
    // A project room has no counterpart and must be passed through untouched.
    expect(after[1]).toBe(before[1]);
  });

  it('renameInRooms returns the SAME array when nothing changed', () => {
    const before = [dmRoom('room_dm', 'agt_1', 'fable')];
    expect(renameInRooms(before, 'agt_1', 'fable', null)).toBe(before);
    expect(renameInRooms(before, 'usr_9', 'Someone', null)).toBe(before);
  });

  it('updateRoomRow patches a room rename and an archive in place', () => {
    const before = [projectRoom('room_p', 'deploys'), projectRoom('room_q', 'design')];
    const renamed = updateRoomRow(before, { id: 'room_p', name: 'deploys-v2', archivedAt: null });
    expect(renamed[0]!.room.name).toBe('deploys-v2');
    expect(renamed[1]).toBe(before[1]);

    const archived = updateRoomRow(before, {
      id: 'room_q',
      name: 'design',
      archivedAt: '2026-08-31T00:00:00Z',
    });
    expect(archived[1]!.room.archivedAt).toBe('2026-08-31T00:00:00Z');
  });

  it('updateRoomRow returns the SAME array when nothing changed', () => {
    const before = [projectRoom('room_p', 'deploys')];
    expect(updateRoomRow(before, { id: 'room_p', name: 'deploys', archivedAt: null })).toBe(before);
    expect(updateRoomRow(before, { id: 'room_gone', name: 'x', archivedAt: null })).toBe(before);
  });
});
