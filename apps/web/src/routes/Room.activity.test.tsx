import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type {
  ActivityEntry,
  AgentDmBox,
  CapabilitiesResponse,
  InboxItem,
  Member,
  Message,
  Room as RoomResource,
} from '@sparrow/common-types';

/**
 * The conversation view as an ACTIVITY STREAM (SPEC v4 → *Web UI → the
 * conversation view is an activity stream*): in a DM pane with an agent whose
 * activity the viewer may read, non-chat entries interleave between the chat
 * bubbles as compact cards — and nowhere else.
 */

// Peripheral contexts + the room SSE manager, stubbed exactly as Room.test does.
const wsState: { rooms: unknown[]; agents: unknown[] } = { rooms: [], agents: [] };
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: wsState.rooms, agents: wsState.agents, reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread: vi.fn() }) }));
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: { subscribe: () => () => {} },
}));
vi.mock('../lib/drafts.js', () => ({ migrateLocalDrafts: async () => 0 }));

import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { activityEntry, email, hintEntry, preview, threadRef, AGENT_ID, ORG_ID, THREAD_ID } from '../test/fixtures.js';
import { Room } from './Room.js';

const SELF: Member = {
  id: 'mem_self',
  kind: 'human',
  avatarUrl: null,
  principalId: 'usr_self',
  displayName: 'Jake',
  roomRole: 'owner',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};
const AGENT: Member = {
  id: 'mem_fable',
  kind: 'agent',
  avatarUrl: null,
  principalId: AGENT_ID,
  displayName: 'fable',
  roomRole: 'member',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};

const DM_ROOM: RoomResource = {
  id: 'room_dm',
  orgId: ORG_ID,
  name: 'fable',
  kind: 'dm',
  archivedAt: null,
  settings: { description: '' },
};
const PROJECT_ROOM: RoomResource = { ...DM_ROOM, id: 'room_dm', name: 'general', kind: 'project' };

const CAPS: CapabilitiesResponse = {
  email: true,
  emailReviewer: false,
  voice: { stt: false, tts: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};

function outMessage(over: Partial<Message>): Message {
  return {
    id: 'msg_out',
    from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
    to: [{ id: 'mem_fable', kind: 'agent', avatarUrl: null, displayName: 'fable' }],
    kind: 'broadcast',
    subject: null,
    body: 'morning ping',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-08-31T10:00:00Z',
    ...over,
  };
}

function inboxItem(over: Partial<InboxItem>): InboxItem {
  return {
    id: 'msg_in',
    from: { id: 'mem_fable', kind: 'agent', avatarUrl: null, displayName: 'fable' },
    kind: 'broadcast',
    subject: null,
    preview: 'on it',
    truncated: false,
    attachmentCount: 0,
    status: 'read',
    createdAt: '2026-08-31T13:00:00Z',
    ...over,
  } as InboxItem;
}

interface Opts {
  room?: RoomResource;
  inbox?: InboxItem[];
  outbox?: Message[];
  entries?: ActivityEntry[];
  /** Fail the activity route with this status (403/404 → silent pure chat). */
  activityStatus?: number;
  /** Agent↔agent DM oversight boxes the org answers with (default none). */
  agentDms?: AgentDmBox[];
  /** Transcript the oversight read route answers with (newest-first). */
  agentDmMessages?: Message[];
}

interface Stub {
  /** How many times `GET .../activity` was requested. */
  activityCalls: () => number;
  /** Push a raw SSE frame down the open `/me/events` stream. */
  push: (frame: string) => Promise<void>;
  /** Swap what the activity route answers with on the NEXT call. */
  setEntries: (entries: ActivityEntry[]) => void;
}

/** The inbound preview as the room-history route returns it (a full Message). */
function inboundMessage(it: InboxItem): Message {
  return outMessage({
    id: it.id,
    from: it.from,
    to: [{ id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' }],
    kind: it.kind,
    body: it.preview,
    createdAt: it.createdAt,
  });
}

function stubRoom(opts: Opts = {}): Stub {
  const room = opts.room ?? DM_ROOM;
  // Room history (newest-first): both halves of the conversation, which is what
  // the thread renders — inbox/outbox are delivery state only.
  const history = [...(opts.outbox ?? []), ...(opts.inbox ?? []).map(inboundMessage)].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  let entries = opts.entries ?? [];
  let activityCalls = 0;
  let enqueue: ((s: string) => void) | null = null;

  useFetch(async (input, init) => {
    const full = String(input);
    const url = full.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json(CAPS);
    if (url.includes('/agent-dms/') && url.endsWith('/messages')) {
      return json({ items: opts.agentDmMessages ?? [], nextBefore: null });
    }
    if (url.includes('/agent-dms')) return json({ items: opts.agentDms ?? [] });
    if (url.includes('/me/events')) {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(': open\n\n'));
          enqueue = (s: string) => c.enqueue(new TextEncoder().encode(s));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('/activity')) {
      activityCalls += 1;
      if (opts.activityStatus) return errorJson('not_found', opts.activityStatus);
      // A TRANSCRIPT: the wire answers newest-first with `nextBefore`. Fixtures
      // are written in reading order (ascending), so the stub reverses them the
      // way the server would — `useAgentActivity` normalizes back on the way in.
      return json({ items: [...entries].reverse(), nextBefore: null });
    }
    if (url.includes('/email/emails/')) return json({ email: email() });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, AGENT], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: opts.inbox ?? [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.includes('/messages/') && url.endsWith('/status')) {
      return json({ id: 'msg_out', kind: 'broadcast', createdAt: '2026-08-31T10:00:00Z', recipients: [] });
    }
    if (url.includes('/messages/') && method === 'GET') {
      return json({ message: outMessage({ id: 'msg_in', body: 'on it' }) });
    }
    if (url.endsWith('/messages') && method === 'GET') {
      return json({ items: history, nextBefore: null });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_dm$/.test(url)) return json(room);
    return errorJson('not_found', 404);
  });

  return {
    activityCalls: () => activityCalls,
    setEntries: (next) => {
      entries = next;
    },
    push: async (frame: string) => {
      await act(async () => {
        enqueue?.(frame);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

function renderRoom(caps: CapabilitiesResponse = CAPS) {
  return render(
    <CapabilitiesProvider initial={caps}>
      <MemoryRouter initialEntries={['/org/1/rooms/dm']}>
        <Routes>
          <Route path="/org/:orgId/rooms/:roomId" element={<Room />} />
        </Routes>
      </MemoryRouter>
    </CapabilitiesProvider>,
  );
}

/** The DM room the sidebar knows about, with an AGENT counterpart. */
function dmWorkspace() {
  wsState.rooms = [
    {
      room: {
        id: 'room_dm',
        name: 'fable',
        orgId: ORG_ID,
        kind: 'dm',
        archivedAt: null,
        counterpart: { type: 'agent', id: AGENT_ID, displayName: 'fable', avatarUrl: null },
      },
      memberId: 'mem_self',
      roomRole: 'member',
    },
  ];
  wsState.agents = [
    { agent: { id: AGENT_ID, name: 'fable' }, owner: { id: 'usr_self', displayName: 'Jake' }, sharedBy: null },
  ];
}

/** An SSE frame for the `/me/events` fan-in. */
function frame(type: string, data: unknown, id = '1'): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeEach(() => {
  wsState.rooms = [];
  wsState.agents = [];
});
afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('Room — the conversation view is an activity stream', () => {
  it('interleaves an email card between the chat bubbles, ordered by createdAt', async () => {
    dmWorkspace();
    stubRoom({
      outbox: [outMessage({ body: 'morning ping', createdAt: '2026-08-31T10:00:00Z' })],
      inbox: [inboxItem({ preview: 'on it', createdAt: '2026-08-31T13:00:00Z' })],
      entries: [activityEntry()], // 12:04 — between the two bubbles
    });
    renderRoom();

    const card = await screen.findByRole('button', { name: /Received email from Dana Lee — Re: Q3 rollout/ });
    expect(card).toBeTruthy();

    // Bubbles are untouched, and the card sits between them in DOM order.
    const feed = card.closest('.flex.flex-col.gap-3')!;
    const text = feed.textContent ?? '';
    expect(text.indexOf('morning ping')).toBeLessThan(text.indexOf('Re: Q3 rollout'));
    expect(text.indexOf('Re: Q3 rollout')).toBeLessThan(text.indexOf('on it'));
  });

  // Jake's dogfood note on his first real email card: nothing said "this box is
  // not a regular internal message". The disposition badge is off the happy
  // path, so the medium mark is what carries it — on the card AND on a run.
  it('marks the medium on non-chat rows, and leaves chat bubbles unmarked', async () => {
    dmWorkspace();
    stubRoom({
      outbox: [outMessage({ body: 'morning ping', createdAt: '2026-08-31T10:00:00Z' })],
      inbox: [inboxItem({ preview: 'on it', createdAt: '2026-08-31T13:00:00Z' })],
      entries: [activityEntry()],
    });
    renderRoom();

    const card = await screen.findByRole('button', {
      name: /Received email from Dana Lee — Re: Q3 rollout/,
    });
    // Exactly one marked row in the stream: the email card. Chat is the default
    // register and must stay glyph-free — a mark on every bubble says nothing.
    const marks = screen.getAllByTestId('medium-glyph');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute('data-medium', 'email');
    expect(card.contains(marks[0]!)).toBe(true);

    // The etched container belongs to info boxes only: a chat bubble keeps its
    // border + panel and never wears the tinted-etch class.
    const bubble = screen.getByText('morning ping').closest('.rounded-lg')!;
    expect(bubble.classList.contains('info-box')).toBe(false);
    expect(bubble.className).toContain('border');
  });

  it('marks a collapsed thread run too, so a fold is still legible as email', async () => {
    dmWorkspace();
    stubRoom({
      entries: [
        activityEntry({ id: 'act_1', createdAt: '2026-08-31T12:01:00Z' }),
        activityEntry({ id: 'act_2', createdAt: '2026-08-31T12:02:00Z', type: 'email.sent' }),
        activityEntry({ id: 'act_3', createdAt: '2026-08-31T12:03:00Z' }),
      ],
    });
    renderRoom();

    const summary = await screen.findByRole('button', { name: /3 messages in Re: Q3 rollout/ });
    const mark = within(summary).getByTestId('medium-glyph');
    expect(mark).toHaveAttribute('data-medium', 'email');
    // A fold is an email-family box too: same tinted-etch container, same tone,
    // no more dashed hairline.
    expect(summary.classList.contains('info-box')).toBe(true);
    expect(summary.style.getPropertyValue('--info-tone')).toBe('var(--sparrow-type-email)');
    expect(summary.className).not.toContain('border-dashed');
  });

  it('a project room stays pure chat — no activity is fetched', async () => {
    // No counterpart: a broadcast room conversation.
    wsState.rooms = [
      {
        room: { id: 'room_dm', name: 'general', orgId: ORG_ID, kind: 'project', archivedAt: null },
        memberId: 'mem_self',
        roomRole: 'member',
      },
    ];
    const stub = stubRoom({
      room: PROJECT_ROOM,
      inbox: [inboxItem({ preview: 'on it' })],
      entries: [activityEntry()],
    });
    renderRoom();

    await screen.findByText('on it');
    expect(stub.activityCalls()).toBe(0);
    expect(screen.queryByText('Re: Q3 rollout')).toBeNull();
  });

  // The timeline is CORE, not an email feature: hint deliveries ride it with
  // the medium off, so the merge always runs and the SERVER decides what the
  // timeline contains (with email off it simply never writes email entries).
  it('with capabilities.email false the timeline still merges — the server curates it', async () => {
    dmWorkspace();
    const stub = stubRoom({ inbox: [inboxItem({ preview: 'on it' })], entries: [activityEntry()] });
    renderRoom({ ...CAPS, email: false });

    await screen.findByText('on it');
    await waitFor(() => expect(stub.activityCalls()).toBeGreaterThan(0));
    // The client renders what it was handed — it never filters for capability.
    expect(await screen.findByText('Re: Q3 rollout')).toBeInTheDocument();
  });

  it('degrades silently to pure chat when the activity route 404s', async () => {
    dmWorkspace();
    const stub = stubRoom({
      inbox: [inboxItem({ preview: 'on it' })],
      entries: [activityEntry()],
      activityStatus: 404,
    });
    renderRoom();

    await screen.findByText('on it');
    await waitFor(() => expect(stub.activityCalls()).toBeGreaterThan(0));
    expect(screen.queryByText('Re: Q3 rollout')).toBeNull();
    // No error surface: the pane is a plain chat transcript.
    expect(screen.queryByText(/no longer available/i)).toBeNull();
  });

  it('collapses a same-thread run of three into a summary row that expands in place', async () => {
    dmWorkspace();
    stubRoom({
      entries: [
        activityEntry({ id: 'act_1', createdAt: '2026-08-31T12:01:00Z' }),
        activityEntry({ id: 'act_2', createdAt: '2026-08-31T12:02:00Z', type: 'email.sent' }),
        activityEntry({ id: 'act_3', createdAt: '2026-08-31T12:03:00Z' }),
      ],
    });
    renderRoom();

    const summary = await screen.findByRole('button', { name: /3 messages in Re: Q3 rollout/ });
    // Collapsed: the individual cards are not rendered.
    expect(screen.queryByRole('button', { name: /Received email from Dana Lee/ })).toBeNull();

    await userEvent.click(summary);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /email from Dana Lee|email to Dana Lee/ }).length).toBe(3),
    );
  });

  // The wire DESCENDS; `collapseStream` reads a run's NEWEST entry as its last.
  // If the hook stopped normalizing the fetched page back to ascending, this
  // summary would name the oldest subject instead.
  it('normalizes the descending wire, so a collapsed run is titled by its NEWEST entry', async () => {
    dmWorkspace();
    stubRoom({
      entries: [
        activityEntry({ id: 'act_1', summary: 'first', createdAt: '2026-08-31T12:01:00Z' }),
        activityEntry({ id: 'act_2', summary: 'second', createdAt: '2026-08-31T12:02:00Z' }),
        activityEntry({ id: 'act_3', summary: 'third', createdAt: '2026-08-31T12:03:00Z' }),
      ],
    });
    renderRoom();

    expect(await screen.findByRole('button', { name: /3 messages in third/ })).toBeTruthy();
  });

  it('collapses consecutive rejected entries into one muted divider', async () => {
    dmWorkspace();
    stubRoom({
      entries: [
        activityEntry({ id: 'act_r1', type: 'email.rejected', createdAt: '2026-08-31T12:01:00Z' }),
        activityEntry({ id: 'act_r2', type: 'email.rejected', createdAt: '2026-08-31T12:02:00Z' }),
        activityEntry({ id: 'act_r3', type: 'email.rejected', createdAt: '2026-08-31T12:03:00Z' }),
      ],
    });
    renderRoom();

    const divider = await screen.findByRole('button', { name: /3 messages rejected/ });
    expect(screen.queryByRole('button', { name: /Received email from Dana Lee/ })).toBeNull();

    await userEvent.click(divider);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Received email from Dana Lee/ }).length).toBe(3),
    );
  });

  it('never collapses quarantined entries and gives each one a Review link', async () => {
    dmWorkspace();
    stubRoom({
      entries: [
        activityEntry({ id: 'act_q1', type: 'email.quarantined', createdAt: '2026-08-31T12:01:00Z' }),
        activityEntry({ id: 'act_q2', type: 'email.quarantined', createdAt: '2026-08-31T12:02:00Z' }),
        activityEntry({ id: 'act_q3', type: 'email.quarantined', createdAt: '2026-08-31T12:03:00Z' }),
      ],
    });
    renderRoom();

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Received email from Dana Lee/ }).length).toBe(3),
    );
    expect(screen.getAllByText('Quarantined').length).toBe(3);
    const reviews = screen.getAllByRole('link', { name: 'Review' });
    expect(reviews.length).toBe(3);
    expect(reviews[0]!.getAttribute('href')).toBe('/me/approvals');
  });

  it('deep-links each card to the agent page thread view', async () => {
    dmWorkspace();
    stubRoom({ entries: [activityEntry()] });
    renderRoom();

    const card = await screen.findByRole('button', { name: /Received email from Dana Lee/ });
    await userEvent.click(card);
    const link = await screen.findByRole('link', { name: 'Open thread' });
    expect(link.getAttribute('href')).toBe(
      `/org/1/agents/1?tab=email&thread=${encodeURIComponent(THREAD_ID)}`,
    );
  });

  it('appends a live activity.appended entry in place', async () => {
    dmWorkspace();
    const stub = stubRoom({ inbox: [inboxItem({ preview: 'on it' })], entries: [] });
    renderRoom();

    await screen.findByText('on it');
    expect(screen.queryByText('Re: Q3 rollout')).toBeNull();

    await stub.push(
      frame('activity.appended', {
        entry: activityEntry({ id: 'act_live', createdAt: '2026-08-31T14:00:00Z' }),
      }),
    );

    await screen.findByRole('button', { name: /Received email from Dana Lee — Re: Q3 rollout/ });
    // Appended in place: no second read of the activity list.
    expect(stub.activityCalls()).toBe(1);
  });

  it('ignores activity.appended for a different agent', async () => {
    dmWorkspace();
    const stub = stubRoom({ inbox: [inboxItem({ preview: 'on it' })], entries: [] });
    renderRoom();
    await screen.findByText('on it');

    await stub.push(
      frame('activity.appended', {
        entry: activityEntry({ id: 'act_other', agent: { id: 'agt_other', name: 'other' } }),
      }),
    );
    expect(screen.queryByText('Re: Q3 rollout')).toBeNull();
  });

  it('email.resolved flips a Held badge to none without refetching the list', async () => {
    dmWorkspace();
    const stub = stubRoom({
      entries: [activityEntry({ id: 'act_h', type: 'email.held', createdAt: '2026-08-31T12:01:00Z' })],
    });
    renderRoom();

    await screen.findByText('Held');
    expect(screen.getByRole('link', { name: 'Review' })).toBeTruthy();

    await stub.push(
      frame('email.resolved', {
        email: preview({ id: 'eml_1', direction: 'out', disposition: 'sent' }),
        thread: threadRef(),
        resolution: 'approved',
        by: { id: 'usr_self', displayName: 'Jake' },
      }),
    );

    await waitFor(() => expect(screen.queryByText('Held')).toBeNull());
    // Mutated in place — the activity list was read exactly once.
    expect(stub.activityCalls()).toBe(1);
    expect(screen.queryByRole('link', { name: 'Review' })).toBeNull();
  });

  // The card MUTATES in place — "the card grays to 'Denied'". It does not fold
  // itself into the rejected divider: collapsing reads the entry's own type, so
  // a live resolution never re-flows the column under the viewer.
  it('email.resolved to a denial grays the card in place to “Denied”', async () => {
    dmWorkspace();
    const stub = stubRoom({
      entries: [activityEntry({ id: 'act_q', type: 'email.quarantined', createdAt: '2026-08-31T12:01:00Z' })],
    });
    renderRoom();

    await screen.findByText('Quarantined');
    await stub.push(
      frame('email.resolved', {
        email: preview({ id: 'eml_1', disposition: 'rejected', reason: 'denied' }),
        thread: threadRef(),
        resolution: 'denied',
        by: { id: 'usr_self', displayName: 'Jake' },
      }),
    );

    expect(await screen.findByText('Denied')).toBeInTheDocument();
    expect(screen.queryByText('Quarantined')).toBeNull();
    // Still a card in the stream, not a divider, and no refetch was needed.
    expect(screen.queryByRole('button', { name: /message rejected/ })).toBeNull();
    expect(stub.activityCalls()).toBe(1);
  });
});

describe('Room — hint deliveries surface as info boxes in the DM pane', () => {
  it('renders a marked Hint card between the bubbles, ordered by createdAt', async () => {
    dmWorkspace();
    stubRoom({
      outbox: [outMessage({ body: 'morning ping', createdAt: '2026-08-31T10:00:00Z' })],
      inbox: [inboxItem({ preview: 'on it', createdAt: '2026-08-31T13:00:00Z' })],
      entries: [hintEntry({ createdAt: '2026-08-31T11:00:00Z' })], // between the bubbles
    });
    renderRoom();

    // The info box carries its visible type label ("Hint"), the same rule
    // every non-chat box follows since the type-label pass.
    const mark = await screen.findByText('Hint');
    expect(mark).toBeInTheDocument();
    // The collapsed row shows the OWNER-framed sentence, not the agent text.
    const summary = screen.getByText(/Sparrow hinted the agent to advertise a working status/);
    const feed = summary.closest('.flex.flex-col.gap-3')!;
    const text = feed.textContent ?? '';
    expect(text.indexOf('morning ping')).toBeLessThan(text.indexOf('Sparrow hinted'));
    expect(text.indexOf('Sparrow hinted')).toBeLessThan(text.indexOf('on it'));
  });

  it('hints flow even with the email capability OFF — the timeline is core, not email', async () => {
    dmWorkspace();
    stubRoom({
      outbox: [outMessage({ body: 'morning ping', createdAt: '2026-08-31T10:00:00Z' })],
      entries: [hintEntry({ createdAt: '2026-08-31T11:00:00Z' })],
    });
    renderRoom({ ...CAPS, email: false });

    expect(await screen.findByText('Hint')).toBeInTheDocument();
  });
});

describe('Room — agent↔agent DM oversight boxes interleave in the DM pane', () => {
  const dmBox = (over: Partial<AgentDmBox> = {}): AgentDmBox => ({
    roomId: 'room_agents',
    orgId: ORG_ID,
    agents: [
      { id: AGENT_ID, name: 'fable' },
      { id: 'agt_other', name: 'scout' },
    ],
    lastMessage: { preview: 'compare notes?', at: '2026-08-31T11:00:00Z' },
    severedAt: null,
    canSever: false,
    ...over,
  });

  it('shows a collapsed box between the bubbles, positioned by its last message', async () => {
    dmWorkspace();
    stubRoom({
      outbox: [outMessage({ body: 'morning ping', createdAt: '2026-08-31T10:00:00Z' })],
      inbox: [inboxItem({ preview: 'on it', createdAt: '2026-08-31T13:00:00Z' })],
      agentDms: [dmBox()], // 11:00 — between the two bubbles
    });
    renderRoom();

    const card = await screen.findByRole('button', { name: /fable ↔ scout/ });
    expect(card).toHaveAttribute('aria-expanded', 'false');
    const feed = card.closest('.flex.flex-col.gap-3')!;
    const text = feed.textContent ?? '';
    expect(text.indexOf('morning ping')).toBeLessThan(text.indexOf('compare notes?'));
    expect(text.indexOf('compare notes?')).toBeLessThan(text.indexOf('on it'));
  });

  it('only boxes involving THIS counterpart render; others stay out of the pane', async () => {
    dmWorkspace();
    stubRoom({
      outbox: [outMessage({ body: 'morning ping', createdAt: '2026-08-31T10:00:00Z' })],
      agentDms: [
        dmBox(),
        dmBox({
          roomId: 'room_unrelated',
          agents: [
            { id: 'agt_x', name: 'xerxes' },
            { id: 'agt_y', name: 'yolanda' },
          ],
          lastMessage: { preview: 'not ours', at: '2026-08-31T11:30:00Z' },
        }),
      ],
    });
    renderRoom();

    await screen.findByRole('button', { name: /fable ↔ scout/ });
    expect(screen.queryByRole('button', { name: /xerxes ↔ yolanda/ })).toBeNull();
  });

  it('renders no boxes in a project room — the pane is oversight-free outside DMs', async () => {
    wsState.rooms = [
      { room: { ...PROJECT_ROOM, counterpart: null }, memberId: 'mem_self', roomRole: 'member' },
    ];
    stubRoom({
      room: PROJECT_ROOM,
      outbox: [outMessage({ body: 'morning ping', createdAt: '2026-08-31T10:00:00Z' })],
      agentDms: [dmBox()],
    });
    renderRoom();

    await screen.findByText('morning ping');
    expect(screen.queryByRole('button', { name: /fable ↔ scout/ })).toBeNull();
  });
});
