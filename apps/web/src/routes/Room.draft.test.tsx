import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Member, Message, Room as RoomResource } from '@sparrow/common-types';

// Same peripheral stubs as Room.test.tsx — this file is only about the
// composer's unsent text surviving navigation.
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: [], agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
vi.mock('../components/AppShell.js', () => ({
  useShell: () => ({ reportBroadcastUnread: vi.fn() }),
}));
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: { subscribe: () => () => {} },
}));

import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { Room } from './Room.js';
import { draftKey, loadDraft } from '../lib/composerDraft.js';

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

function roomResource(id: string, name: string): RoomResource {
  return { id, orgId: 'org_1', name, kind: 'project', archivedAt: null, settings: { description: '' } };
}

function makeMessage(over: Partial<Message>): Message {
  return {
    id: 'msg_1',
    from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
    to: [],
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

/** Every fetch the app made: method, path, and the raw request body. */
interface Call {
  method: string;
  url: string;
  body: string;
}

/**
 * Route a two-room workspace. `sendStatus` lets a test make `POST …/messages`
 * fail so the draft's survival on a rejected send can be asserted.
 */
function stubRooms(opts: { sendStatus?: number } = {}): { calls: Call[] } {
  const calls: Call[] = [];
  useFetch(async (input, init) => {
    const raw = String(input);
    const url = raw.split('?')[0]!;
    const method = init?.method ?? 'GET';
    calls.push({ method, url: raw, body: init?.body ? String(init.body) : '' });
    if (url.includes('/capabilities')) {
      return json({ voice: { stt: false, tts: false, sttStreaming: false } });
    }
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.endsWith('/messages/status')) return json({ items: [] });
    if (url.endsWith('/messages') && method === 'GET') return json({ items: [], nextBefore: null });
    if (url.endsWith('/messages') && method === 'POST') {
      if (opts.sendStatus && opts.sendStatus >= 400) {
        return errorJson('bad_request', opts.sendStatus, 'nope');
      }
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      return json({
        message: makeMessage({ body: (body as { body?: string }).body }),
        unreadCount: 0,
      });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_one$/.test(url)) return json(roomResource('room_one', 'one'));
    if (/\/rooms\/room_two$/.test(url)) return json(roomResource('room_two', 'two'));
    return errorJson('not_found', 404);
  });
  return { calls };
}

function renderRoom(bareId: string) {
  return render(
    <MemoryRouter initialEntries={[`/rooms/${bareId}`]}>
      <CapabilitiesProvider>
        <Routes>
          <Route path="/rooms/:roomId" element={<Room />} />
        </Routes>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );
}

/** The composer, once the room has booted enough to enable it. */
async function composer(): Promise<HTMLTextAreaElement> {
  const ta = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
  await waitFor(() => expect(ta).not.toBeDisabled());
  return ta;
}

function type(ta: HTMLTextAreaElement, text: string) {
  fireEvent.change(ta, { target: { value: text } });
}

const KEY_ONE = draftKey('org_1', 'room_one');
const KEY_TWO = draftKey('org_1', 'room_two');

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:mock') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('Room composer drafts', () => {
  it('restores a half-typed message after navigating away and back', async () => {
    stubRooms();
    const first = renderRoom('one');
    type(await composer(), 'half a thought about the dep');
    first.unmount();

    // Same room, fresh mount — the way coming back from another agent looks.
    stubRooms();
    renderRoom('one');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('half a thought about the dep'));
  });

  it('keeps each room’s draft to itself, and restores the first on return', async () => {
    stubRooms();
    const one = renderRoom('one');
    type(await composer(), 'for room one');
    one.unmount();

    // A different room opens empty — not carrying room one's words.
    stubRooms();
    const two = renderRoom('two');
    const taTwo = await composer();
    expect(taTwo).toHaveValue('');
    type(taTwo, 'for room two');
    two.unmount();

    stubRooms();
    renderRoom('one');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('for room one'));
    expect(loadDraft(KEY_TWO)).toBe('for room two');
  });

  it('a successful send clears the composer and the stored draft', async () => {
    stubRooms();
    const view = renderRoom('one');
    const ta = await composer();
    type(ta, 'ship it');
    await waitFor(() => expect(loadDraft(KEY_ONE)).toBe('ship it'));

    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    await waitFor(() => expect(localStorage.getItem(KEY_ONE)).toBeNull());

    // And it stays gone across a remount.
    view.unmount();
    stubRooms();
    renderRoom('one');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  });

  it('a failed send keeps the text in the composer and in storage', async () => {
    stubRooms({ sendStatus: 400 });
    const view = renderRoom('one');
    const ta = await composer();
    type(ta, 'this one will not land');

    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(await screen.findByText(/Couldn’t send/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('this one will not land');

    view.unmount();
    expect(loadDraft(KEY_ONE)).toBe('this one will not land');
  });

  it('never puts the draft on the wire except as the body of the send', async () => {
    const { calls } = stubRooms();
    const ta = await (async () => {
      renderRoom('one');
      return composer();
    })();
    const secret = 'draft-text-must-not-leak';
    type(ta, secret);
    await waitFor(() => expect(loadDraft(KEY_ONE)).toBe(secret));

    // Everything the room fetched while the draft sat unsent is clean.
    for (const c of calls) {
      expect(c.url).not.toContain(secret);
      expect(c.body).not.toContain(secret);
    }

    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));

    const carrying = calls.filter((c) => c.url.includes(secret) || c.body.includes(secret));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.method).toBe('POST');
    expect(carrying[0]!.url.split('?')[0]).toMatch(/\/messages$/);
    expect(JSON.parse(carrying[0]!.body).body).toBe(secret);
  });

  it('composes normally when localStorage throws on every access', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    stubRooms();
    const view = renderRoom('one');
    const ta = await composer();
    type(ta, 'storage is dead, typing is not');
    expect(ta).toHaveValue('storage is dead, typing is not');

    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    expect(() => view.unmount()).not.toThrow();
  });

  it('does not persist a draft past the cap, keeping the last good value', async () => {
    stubRooms();
    renderRoom('one');
    const ta = await composer();
    type(ta, 'a sane draft');
    await waitFor(() => expect(loadDraft(KEY_ONE)).toBe('a sane draft'));

    const huge = 'x'.repeat(20_001);
    type(ta, huge);
    // Still on screen — only the backup stops.
    expect(ta).toHaveValue(huge);
    await new Promise((r) => setTimeout(r, 400));
    expect(loadDraft(KEY_ONE)).toBe('a sane draft');
  });
});
