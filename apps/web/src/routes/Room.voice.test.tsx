import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

/**
 * Room ↔ hands-free mode (voice v2). Everything the OVERLAY does is tested in
 * `room/HandsFreeOverlay.test.tsx`; what only the room can prove is the wiring:
 * a spoken turn goes out through the ordinary send path carrying
 * `origin:'voice'`, and the replies that come back are routed into the open
 * overlay — the counterpart's, never the caller's own.
 */

const wsState: { rooms: unknown[] } = { rooms: [] };
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: wsState.rooms, agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
const { streamHandlers, reportBroadcastUnread } = vi.hoisted(() => ({
  streamHandlers: [] as ((ev: unknown) => void)[],
  reportBroadcastUnread: vi.fn(),
}));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread }) }));
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: {
    subscribe: (_roomId: string, cb: (ev: unknown) => void) => {
      streamHandlers.push(cb);
      return () => {};
    },
  },
}));
vi.mock('../lib/drafts.js', () => ({ migrateLocalDrafts: async () => 0 }));

import { useFetch, restoreFetch, json, errorJson, binary } from '../test/apiStub.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { Room } from './Room.js';

/* ------------------------------------------------------------------ *
 * Media fakes. The fallback (non-streaming) capture path is what this
 * file drives: it is the shortest route from a tap to a sent message.
 * ------------------------------------------------------------------ */

const trackStop = vi.fn();
const audioPlay = vi.fn(async () => {});

class FakeAudio {
  src = '';
  onended: (() => void) | null = null;
  play = audioPlay;
  pause = vi.fn();
}

class FakeMediaRecorder {
  static isTypeSupported(t: string) {
    return t === 'audio/webm;codecs=opus';
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
    this.ondataavailable?.({ data: new Blob(['a'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

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
const BOT: Member = {
  id: 'mem_bot',
  kind: 'agent',
  avatarUrl: null,
  principalId: 'agt_bot',
  displayName: 'qa-bot',
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

function message(over: Partial<Message>): Message {
  return {
    id: 'msg_1',
    from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'qa-bot' },
    to: [{ id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' }],
    kind: 'broadcast',
    subject: null,
    body: 'hello',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-08-20T10:05:00Z',
    ...over,
  };
}

interface Sent {
  body: string;
  origin?: string;
}

interface StubOpts {
  tts?: boolean;
  /** A reply the server already holds by the time the send's re-list runs. */
  replyOnSend?: Message;
}

function stubRoom(initial: Message[] = [], opts: StubOpts = {}) {
  const state = { history: [...initial], inbox: [] as InboxItem[], sent: [] as Sent[], speech: [] as string[] };
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) {
      return json({ voice: { stt: true, tts: opts.tts ?? false, sttStreaming: false } });
    }
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, BOT], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: state.inbox, nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.includes('/voice/transcriptions') && method === 'POST') {
      return json({ text: 'ship it please' });
    }
    const sp = url.match(/\/messages\/([^/]+)\/speech$/);
    if (sp) {
      state.speech.push(sp[1]!);
      return binary(new Uint8Array([1]), 'audio/mpeg');
    }
    const st = url.match(/\/messages\/([^/]+)\/status$/);
    if (st) {
      return json({ id: st[1]!, kind: 'broadcast', createdAt: '2026-08-20T10:05:00Z', recipients: [] });
    }
    const one = url.match(/\/messages\/([^/]+)$/);
    if (one && method === 'GET') {
      const found = state.history.find((m) => m.id === one[1]!);
      return found ? json({ message: found }) : errorJson('not_found', 404);
    }
    if (url.endsWith('/messages') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Sent;
      state.sent.push(body);
      const msg = message({
        id: `msg_sent_${state.sent.length}`,
        from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
        body: body.body,
        origin: (body.origin as Message['origin']) ?? null,
        createdAt: '2026-08-20T10:06:00Z',
      });
      state.history.push(msg);
      // The counterpart can already have answered by the time the send's own
      // re-list runs — that listing, not a later `message.new`, is where the
      // reply first appears.
      if (opts.replyOnSend) state.history.push(opts.replyOnSend);
      return json({ message: msg, unreadCount: 0 }, 201);
    }
    if (url.endsWith('/messages') && method === 'GET') {
      const items = [...state.history].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json({ items, nextBefore: null });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(ROOM);
    return errorJson('not_found', 404);
  });
  return state;
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

async function pushRoomEvent(ev: unknown) {
  await act(async () => {
    for (const h of [...streamHandlers]) h(ev);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Open hands-free mode and complete one spoken turn through the fallback path. */
async function speakOneTurn() {
  await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
  // The composer has a Send of its own behind the overlay — scope to the dialog.
  const dialog = await screen.findByRole('dialog', { name: /hands-free/i });
  await userEvent.click(within(dialog).getByRole('button', { name: /tap to talk/i }));
  await userEvent.click(await within(dialog).findByRole('button', { name: /^stop$/i }));
  await userEvent.click(await within(dialog).findByRole('button', { name: /^send$/i }));
}

beforeEach(() => {
  wsState.rooms = [];
  streamHandlers.length = 0;
  reportBroadcastUnread.mockClear();
  trackStop.mockClear();
  audioPlay.mockClear();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }) as unknown as MediaStream),
    },
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:x') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  restoreFetch();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('Room — hands-free mode', () => {
  it('mounts the mic in the composer when the instance has STT', async () => {
    stubRoom();
    renderRoom();
    expect(await screen.findByRole('button', { name: /hands-free/i })).toBeInTheDocument();
  });

  it('a spoken turn is sent through the ordinary path with origin:"voice"', async () => {
    const state = stubRoom();
    renderRoom();
    await speakOneTurn();

    await waitFor(() => expect(state.sent).toHaveLength(1));
    expect(state.sent[0]).toMatchObject({ body: 'ship it please', origin: 'voice' });
    // We stay in the mode for the answer, and the composer draft is untouched.
    expect(screen.getByRole('dialog', { name: /hands-free/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('routes a counterpart reply into the open overlay', async () => {
    const state = stubRoom();
    renderRoom();
    await speakOneTurn();
    await waitFor(() => expect(state.sent).toHaveLength(1));

    state.history.push(message({ id: 'msg_reply', body: 'shipping now', createdAt: '2026-08-20T10:07:00Z' }));
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_reply' } });

    // TTS is off on this instance, so the reply is READ, not heard.
    expect(await screen.findByTestId('hands-free-last-reply')).toHaveTextContent('shipping now');
  });

  it('never routes the caller’s OWN message into the overlay', async () => {
    const state = stubRoom();
    renderRoom();
    await speakOneTurn();
    await waitFor(() => expect(state.sent).toHaveLength(1));

    // The send's own `message.new` echo (and any later self-send) is not a reply.
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_sent_1' } });
    expect(screen.queryByTestId('hands-free-last-reply')).toBeNull();
    expect(screen.getByTestId('hands-free-awaiting')).toBeInTheDocument();
  });

  it('stops collecting replies once the mode is closed', async () => {
    const state = stubRoom();
    renderRoom();
    await speakOneTurn();
    await waitFor(() => expect(state.sent).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));

    state.history.push(message({ id: 'msg_reply', body: 'too late', createdAt: '2026-08-20T10:07:00Z' }));
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_reply' } });

    // It lands as an ordinary bubble; nothing is queued for speech.
    expect(await screen.findByText('too late')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /hands-free/i })).toBeNull();
  });

  it('routes a reply that only a RECONCILE turned up (the phone-locks case)', async () => {
    // A reply that arrives while the stream is down is absorbed by the wake
    // reconcile, which writes history without ever announcing an arrival. Read
    // only from the `message.new` path, hands-free mode would sit in `awaiting`
    // for a reply that is already on screen behind it.
    const state = stubRoom();
    renderRoom();
    await speakOneTurn();
    await waitFor(() => expect(state.sent).toHaveLength(1));

    state.history.push(
      message({ id: 'msg_reply', body: 'after the reconnect', createdAt: '2026-08-20T10:07:00Z' }),
    );
    await pushRoomEvent({ type: 'sync' });

    expect(await screen.findByTestId('hands-free-last-reply')).toHaveTextContent(
      'after the reconnect',
    );
  });

  it('routes a reply the post-send re-list absorbed — and speaks it exactly once', async () => {
    const reply = message({
      id: 'msg_reply',
      body: 'already answered',
      createdAt: '2026-08-20T10:07:00Z',
    });
    const state = stubRoom([], { tts: true, replyOnSend: reply });
    renderRoom();
    await speakOneTurn();
    await waitFor(() => expect(state.speech).toEqual(['msg_reply']));

    // The `message.new` for that same reply lands afterwards; it is old news.
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_reply' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.speech).toEqual(['msg_reply']);
  });

  it('opening the mode does not read the history already on screen', async () => {
    const state = stubRoom(
      [message({ id: 'msg_old', body: 'old news', createdAt: '2026-08-20T10:01:00Z' })],
      { tts: true },
    );
    renderRoom();
    await screen.findByText('old news');
    await userEvent.click(screen.getByRole('button', { name: /hands-free/i }));
    await screen.findByRole('dialog', { name: /hands-free/i });

    await new Promise((r) => setTimeout(r, 20));
    expect(state.speech).toEqual([]);
    expect(screen.queryByTestId('hands-free-last-reply')).toBeNull();
  });

  it('a message sent by voice keeps its provenance chip on the bubble', async () => {
    const state = stubRoom();
    renderRoom();
    await speakOneTurn();
    await waitFor(() => expect(state.sent).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: /leave hands-free/i }));
    expect(await screen.findByText('ship it please')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/voice message/i).length).toBeGreaterThan(0);
  });
});
