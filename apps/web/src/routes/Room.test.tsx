import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

// Room leans on several peripheral contexts + the SSE manager; stub them so the
// test can focus on the voice wiring (mic → composer → origin, and the bubble
// provenance chip). The `api` client's fetch is routed via the shared apiStub.
// Mutable so a test can present a DM room with a counterpart. Reset in beforeEach.
const wsState: { rooms: unknown[] } = { rooms: [] };
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: wsState.rooms, agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread: vi.fn() }) }));
// Capture each Room's stream handler so tests can drive live SSE events
// (e.g. presence.changed) at it. Hoisted so the vi.mock factory can reach it.
const { streamHandlers } = vi.hoisted(() => ({ streamHandlers: [] as ((ev: unknown) => void)[] }));
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: {
    subscribe: (_roomId: string, cb: (ev: unknown) => void) => {
      streamHandlers.push(cb);
      return () => {};
    },
  },
}));
vi.mock('../lib/drafts.js', () => ({ migrateLocalDrafts: async () => 0 }));

import { act } from '@testing-library/react';
import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { Room } from './Room.js';
import { AGENT_WAKE_INSTRUCTIONS } from './room/AgentOfflineNotice.js';

const SELF: Member = {
  id: 'mem_self',
  kind: 'human', avatarUrl: null,
  principalId: 'usr_self',
  displayName: 'Jake',
  roomRole: 'owner',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};
const OTHER: Member = {
  id: 'mem_bot',
  kind: 'agent', avatarUrl: null,
  principalId: 'agt_bot',
  displayName: 'deploy-bot',
  roomRole: 'member',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};
const ROOM: RoomResource = {
  id: 'room_abc',
  orgId: 'org_1',
  name: 'general',
  kind: 'project',
  archivedAt: null,
  settings: { description: '' },
};

function makeMessage(over: Partial<Message>): Message {
  return {
    id: 'msg_1',
    from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
    to: [{ id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' }],
    kind: 'broadcast',
    subject: null,
    body: 'hi',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-08-20T10:05:00Z',
    ...over,
  };
}

interface Opts {
  outbox?: Message[];
  transcript?: string;
  onSend?: (body: unknown) => void;
}

/** Route the client's fetch for one room's boot + actions. */
function stubRoom(opts: Opts = {}) {
  const outbox = opts.outbox ?? [];
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: true, tts: true } });
    if (url.includes('/voice/transcriptions')) return json({ text: opts.transcript ?? 'dictated text' });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.includes('/messages/') && url.endsWith('/status')) {
      return json({ id: 'msg_1', kind: 'broadcast', createdAt: '2026-08-20T10:05:00Z', recipients: [] });
    }
    // Room history (newest-first) — what the thread renders.
    if (url.endsWith('/messages') && method === 'GET') {
      return json({ items: [...outbox].reverse(), nextBefore: null });
    }
    if (url.endsWith('/messages') && method === 'POST') {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      opts.onSend?.(body);
      return json({ message: makeMessage({ body: (body as { body?: string }).body }), unreadCount: 0 });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(ROOM);
    return errorJson('not_found', 404);
  });
}

// Minimal MediaRecorder/getUserMedia so the mic can drive a real record→stop.
class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_s: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? '';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function renderRoom() {
  render(
    <MemoryRouter initialEntries={['/rooms/abc']}>
      <CapabilitiesProvider>
        <Routes>
          <Route path="/rooms/:roomId" element={<Room />} />
        </Routes>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );
}

const DM_ROOM: RoomResource = { ...ROOM, id: 'room_abc', name: '', kind: 'dm' };
const COUNTERPART = { type: 'agent' as const, id: 'agt_bot', displayName: 'deploy-bot', avatarUrl: null };

/** Route a DM room's boot, advertising `partnerNote` as the counterpart's working status. */
function stubDmRoom(partnerNote: string | null) {
  wsState.rooms = [{ room: { ...DM_ROOM, counterpart: COUNTERPART }, memberId: SELF.id, roomRole: 'owner' }];
  const future = new Date(Date.now() + 60_000).toISOString();
  useFetch(async (input) => {
    const url = String(input).split('?')[0]!;
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.endsWith('/messages')) return json({ items: [], nextBefore: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.endsWith('/status')) {
      // A working agent is, by definition, online — mark it so the agent-offline
      // notice (which needs an OFFLINE agent) stays out of these working-indicator tests.
      return json({
        items: [{ memberId: OTHER.id, displayName: OTHER.displayName, state: 'working', note: partnerNote, to: null, sinceAt: future, sticky: false, expiresAt: future }],
        presence: { online: [OTHER.id] },
      });
    }
    if (/\/rooms\/room_abc$/.test(url)) return json(DM_ROOM);
    return errorJson('not_found', 404);
  });
}

beforeEach(() => {
  wsState.rooms = [];
  streamHandlers.length = 0;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:mock') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  restoreFetch();
});

describe('Room voice dictation → origin on send', () => {
  it('dictates into the composer and sends with origin:"voice"', async () => {
    const sends: unknown[] = [];
    stubRoom({ transcript: 'deploy the build', onSend: (b) => sends.push(b) });
    renderRoom();

    // Record → stop drives transcribe → transcript lands in the composer.
    await userEvent.click(await screen.findByRole('button', { name: /record voice/i }));
    await userEvent.click(await screen.findByRole('button', { name: /stop recording/i }));

    const textarea = await screen.findByRole('textbox');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('deploy the build'));
    expect(screen.getByLabelText(/composed by voice/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ to: 'all', body: 'deploy the build', origin: 'voice' });
  });
});

describe('Room DM working indicator (iMessage-style, bottom placement)', () => {
  it('renders the partner working indicator at the bottom (above the composer), not in the header', async () => {
    stubDmRoom('reviewing the PR');
    renderRoom();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('working');
    expect(status).toHaveTextContent('reviewing the PR');

    // Not in the header: the header carries the presence dot + name, never the status text now.
    const header = screen.getByText('deploy-bot').closest('div');
    expect(header).not.toBeNull();
    expect(header).not.toContainElement(status);

    // Sits above the composer: the status precedes the composer textbox in the DOM.
    const textbox = screen.getByRole('textbox');
    expect(status.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no working indicator when the partner is not working', async () => {
    stubDmRoom(null);
    // A working status with a null note still renders "working"; to assert absence we
    // present a room whose only status is the caller's own (filtered out by scope).
    wsState.rooms = [{ room: { ...DM_ROOM, counterpart: COUNTERPART }, memberId: SELF.id, roomRole: 'owner' }];
    useFetch(async (input) => {
      const url = String(input).split('?')[0]!;
      if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
      if (url.includes('/whoami')) return json(SELF);
      if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
      if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
      if (url.endsWith('/messages')) return json({ items: [], nextBefore: null });
      if (url.includes('/drafts')) return json({ items: [] });
      // Agent online (no working status) → neither the working indicator nor the
      // agent-offline notice should render.
      if (url.endsWith('/status')) return json({ items: [], presence: { online: [OTHER.id] } });
      if (/\/rooms\/room_abc$/.test(url)) return json(DM_ROOM);
      return errorJson('not_found', 404);
    });
    renderRoom();

    await screen.findByRole('textbox');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/** Route a DM room whose counterpart (agent or human, per `type`) is OFFLINE. */
function stubOfflineDm(type: 'agent' | 'human') {
  const counterpart = { ...COUNTERPART, type };
  wsState.rooms = [{ room: { ...DM_ROOM, counterpart }, memberId: SELF.id, roomRole: 'owner' }];
  const other = { ...OTHER, kind: type };
  useFetch(async (input) => {
    const url = String(input).split('?')[0]!;
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, other], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.endsWith('/messages')) return json({ items: [], nextBefore: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(DM_ROOM);
    return errorJson('not_found', 404);
  });
}

describe('Room agent-offline notice (ephemeral, client-only)', () => {
  it('shows the wake notice for an offline agent DM once presence has hydrated', async () => {
    stubOfflineDm('agent');
    renderRoom();

    expect(await screen.findByText(/deploy-bot isn.?t listening yet/i)).toBeInTheDocument();
    // It carries the single copyable instruction constant the human pastes to the agent.
    expect(screen.getByText(AGENT_WAKE_INSTRUCTIONS)).toBeInTheDocument();
  });

  it('hides the notice live when the agent comes online (presence.changed)', async () => {
    stubOfflineDm('agent');
    renderRoom();
    await screen.findByText(/isn.?t listening yet/i);

    // Drive a live presence.changed → online at the Room's stream handler.
    act(() => {
      for (const h of streamHandlers) {
        h({ type: 'presence.changed', data: { state: 'online', member: { id: OTHER.id } } });
      }
    });

    await waitFor(() => expect(screen.queryByText(/isn.?t listening yet/i)).toBeNull());
  });

  it('never shows the notice for a human-human DM', async () => {
    stubOfflineDm('human');
    renderRoom();

    await screen.findByRole('textbox');
    expect(screen.queryByText(/isn.?t listening yet/i)).toBeNull();
  });
});

describe('Room historical bubbles are never collapsed (always full body, no ellipsis)', () => {
  // Historical bubbles must show the WHOLE body — no ellipsis, no clipped
  // preview left behind (the old "collapsed bubble" bug). The room history route
  // returns FULL Messages, so there is no second fetch to lose: the body is
  // there the moment the thread is. The distinguishing marker lives after the
  // 200-char boundary, where a triage preview would have cut it off.
  const LONG_BODY =
    'First line of the message.\nSecond line in the middle.\n' + 'x'.repeat(220) + '\nFULLBODYONLY_endmarker';

  function fullInbound(over: Partial<Message> = {}): Message {
    return makeMessage({
      id: 'msg_in1',
      from: { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
      to: [{ id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }],
      kind: 'broadcast',
      body: LONG_BODY,
      createdAt: '2026-08-20T10:05:00Z',
      ...over,
    });
  }

  /** Boot a room whose history is one long inbound message and no delivery rows. */
  function stubHistoryRoom(msg: Message, room: RoomResource = ROOM) {
    useFetch(async (input) => {
      const url = String(input).split('?')[0]!;
      if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
      if (url.includes('/whoami')) return json(SELF);
      if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
      if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
      if (url.includes('/drafts')) return json({ items: [] });
      if (url.endsWith('/messages')) return json({ items: [msg], nextBefore: null });
      if (url.endsWith('/status')) return json({ items: [], presence: { online: [OTHER.id] } });
      if (/\/rooms\/room_abc$/.test(url)) return json(room);
      return errorJson('not_found', 404);
    });
  }

  it('renders the full multi-line body (every line, no ellipsis) right after mount', async () => {
    stubHistoryRoom(fullInbound());
    renderRoom();

    // The end marker only exists past the 200-char triage cut — its presence
    // proves the bubble rendered the whole message.
    await waitFor(() => expect(screen.getByText(/FULLBODYONLY_endmarker/)).toBeInTheDocument());
    // No collapse ellipsis anywhere in the conversation.
    expect(document.body.textContent).not.toContain('…');
  });

  it('renders a kind:dm history bubble in a DM room in full', async () => {
    // The old prod bug this replaces: a `kind:'dm'` bubble in a DM room was never
    // in hydrateThread's fetch list, so its body was never fetched and it stayed
    // stuck on the 200-char preview forever. The history route ends the class of
    // bug — the body arrives with the message.
    wsState.rooms = [{ room: { ...DM_ROOM, counterpart: COUNTERPART }, memberId: SELF.id, roomRole: 'owner' }];
    stubHistoryRoom(fullInbound({ id: 'msg_dm1', kind: 'dm' }), DM_ROOM);
    renderRoom();

    await waitFor(() => expect(screen.getByText(/FULLBODYONLY_endmarker/)).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('…');
  });
});

describe('Room composer attachments', () => {
  it('stages a pasted image, sends it as a base64 attachment, and clears the chip', async () => {
    const sends: unknown[] = [];
    stubRoom({ onSend: (b) => sends.push(b) });
    renderRoom();

    const textarea = await screen.findByRole('textbox');
    const file = new File(['PNGDATA'], 'shot.png', { type: 'image/png' });
    // Paste a screenshot (clipboard carries a file, no text).
    fireEvent.paste(textarea, { clipboardData: { files: [file], items: [] } });

    // A chip for the staged image appears with its filename.
    expect(await screen.findByText('shot.png')).toBeInTheDocument();

    await userEvent.type(textarea, 'here is the screenshot');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sends).toHaveLength(1));
    const sent = sends[0] as { body: string; attachments?: Array<Record<string, string>> };
    expect(sent.body).toBe('here is the screenshot');
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]).toEqual({
      filename: 'shot.png',
      contentType: 'image/png',
      dataBase64: Buffer.from('PNGDATA').toString('base64'),
    });

    // Chip is cleared after a successful send.
    await waitFor(() => expect(screen.queryByText('shot.png')).toBeNull());
  });

  it('rejects an oversize file with a visible error and no chip', async () => {
    stubRoom();
    renderRoom();

    const textarea = await screen.findByRole('textbox');
    const big = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    fireEvent.paste(textarea, { clipboardData: { files: [big], items: [] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/huge\.bin.*5 MB/);
    expect(screen.queryByText('huge.bin')).toBeNull();
  });

  it('sends an attachment with no body text (empty-body attachment-only send)', async () => {
    const sends: unknown[] = [];
    stubRoom({ onSend: (b) => sends.push(b) });
    renderRoom();

    const textarea = await screen.findByRole('textbox');
    const file = new File(['DOC'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.paste(textarea, { clipboardData: { files: [file], items: [] } });
    await screen.findByText('a.pdf');

    // No text typed — Send is still enabled because a file is staged.
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await userEvent.click(send);

    await waitFor(() => expect(sends).toHaveLength(1));
    const sent = sends[0] as { body: string; attachments?: unknown[] };
    expect(sent.body).toBe('');
    expect(sent.attachments).toHaveLength(1);
  });
});

describe('Room voice provenance chip on bubbles', () => {
  it('renders a "voice" chip on a message whose origin is voice', async () => {
    stubRoom({ outbox: [makeMessage({ id: 'msg_v1', body: 'shipping now', origin: 'voice' })] });
    renderRoom();

    expect(await screen.findByText('shipping now')).toBeInTheDocument();
    expect(screen.getByLabelText('Voice message')).toBeInTheDocument();
    // TTS enabled → the bubble also offers a speaker control.
    expect(screen.getAllByRole('button', { name: /play message/i }).length).toBeGreaterThan(0);
  });
});
