import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrgRoomSummary } from '@sparrow/common-types';
import { restoreFetch, useFetch, json } from '../../test/apiStub.js';
import { RoomsSection } from './Rooms.js';

const ORG_ID = 'org_1';

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

function room(overrides: Partial<OrgRoomSummary> = {}): OrgRoomSummary {
  return {
    id: 'room_1',
    name: 'Secret Project',
    kind: 'project',
    memberCount: 3,
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The section over a stubbed API; `rooms` is a live ref the PATCH answers from. */
function renderRooms(opts: { rooms: OrgRoomSummary[]; patchStatus?: number }) {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: String(init?.body ?? '') });
    if (url.includes(`/orgs/${ORG_ID}/rooms/`) && method === 'PATCH') {
      if (opts.patchStatus && opts.patchStatus >= 400) {
        return json(
          {
            error: {
              code: 'forbidden',
              message: 'You do not have permission to do that in this org',
            },
          },
          opts.patchStatus,
        );
      }
      const archived = JSON.parse(String(init?.body ?? '{}')).archived as boolean;
      const id = url.split('/rooms/')[1]!;
      const found = opts.rooms.find((r) => r.id === id)!;
      return json({
        room: { ...found, archivedAt: archived ? '2026-09-03T00:00:00.000Z' : null },
      });
    }
    if (url.includes(`/orgs/${ORG_ID}/rooms`) && method === 'GET') {
      return json({ items: opts.rooms });
    }
    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
  useFetch(fetchMock as unknown as typeof fetch);
  return { ...render(<RoomsSection orgId={ORG_ID} />), calls };
}

describe('OrgSettings → Rooms (org room governance)', () => {
  it('lists every room in the org with its size, and says it grants no reading', async () => {
    renderRooms({ rooms: [room(), room({ id: 'room_2', name: 'Ops', memberCount: 1 })] });
    expect(await screen.findByText('Secret Project')).toBeInTheDocument();
    expect(screen.getByText('Ops')).toBeInTheDocument();
    expect(screen.getByText(/3 members/)).toBeInTheDocument();
    expect(screen.getByText(/1 member\b/)).toBeInTheDocument();
    // The promise the server keeps, said out loud on the screen that lists
    // rooms an admin was never invited to.
    expect(screen.getByText(/cannot read it/i)).toBeInTheDocument();
    // No way in and nothing to read: no message preview, no "open" link.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('archives a room, then restores it', async () => {
    const { calls } = renderRooms({ rooms: [room()] });
    await userEvent.click(await screen.findByRole('button', { name: /archive/i }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.url.includes(`/orgs/${ORG_ID}/rooms/room_1`) &&
            c.body.includes('"archived":true'),
        ),
      ).toBe(true),
    );
    const row = (await screen.findByText('Secret Project')).closest('div')!.parentElement!;
    expect(within(row).getByText('Archived')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PATCH' && c.body.includes('"archived":false'))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByText('Archived')).toBeNull());
  });

  it('keeps the row and explains itself when the archive is refused', async () => {
    renderRooms({ rooms: [room()], patchStatus: 403 });
    await userEvent.click(await screen.findByRole('button', { name: /archive/i }));
    // The server's own sentence, not a swallowed one — and the row stays.
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.getByText('Secret Project')).toBeInTheDocument();
  });

  it('says so plainly when the org has no rooms', async () => {
    renderRooms({ rooms: [] });
    expect(await screen.findByText(/no rooms yet/i)).toBeInTheDocument();
  });
});
