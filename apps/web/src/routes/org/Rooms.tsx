import { useCallback, useEffect, useState } from 'react';
import type { OrgRoomSummary } from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { ErrorText, Loading, Notice, Panel, Section, errMsg, fmtDate, ghostBtn } from './ui.js';

/**
 * Org admin → **Rooms** (SPEC "Rooms & members → Org room governance"). The
 * owner/admin's view of every room in the org, including the ones they were
 * never invited to, with the one verb governance needs: archive (and restore).
 *
 * What this section deliberately does NOT do is read. There is no message
 * preview, no member roster, no "join this room" button — archiving a room is
 * cleanup, not a way into a conversation, and the server enforces exactly that.
 * The copy says so out loud, because an admin screen that lists private rooms
 * had better be explicit about what it cannot see.
 */
export function RoomsSection({ orgId }: { orgId: string }) {
  const [rooms, setRooms] = useState<OrgRoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRooms(await api.listOrgRooms(orgId));
      setError(null);
    } catch (err) {
      setError(errMsg(err, 'Could not load rooms.'));
      setRooms((prev) => prev ?? []);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setArchived(room: OrgRoomSummary, archived: boolean) {
    if (busyId) return;
    setBusyId(room.id);
    setRowError((m) => {
      const next = { ...m };
      delete next[room.id];
      return next;
    });
    try {
      const updated = await api.setOrgRoomArchived(orgId, room.id, archived);
      // Replaced in place: the row you just acted on should stay under the
      // pointer, flipped, rather than the whole list jumping.
      setRooms((prev) => (prev ?? []).map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setRowError((m) => ({
        ...m,
        [room.id]: errMsg(err, archived ? 'Could not archive this room.' : 'Could not restore it.'),
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section
      id="rooms"
      title="Rooms"
      lead="Every room in your organization, including ones you are not in. You can archive a room to retire it — you cannot read it: archiving never adds you to a room or shows you a message."
    >
      {!rooms ? (
        <Panel>{error ? <ErrorText>{error}</ErrorText> : <Loading />}</Panel>
      ) : rooms.length === 0 ? (
        <Notice>No rooms yet.</Notice>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--sparrow-border)]">
          {rooms.map((room, i) => (
            <div
              key={room.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 bg-[var(--sparrow-panel)] p-3 ${
                i > 0 ? 'border-t border-[var(--sparrow-border)]' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm text-[var(--sparrow-text)]">
                    {room.name || '(unnamed)'}
                  </span>
                  {room.archivedAt && (
                    <span className="rounded-full border border-[var(--sparrow-border)] px-2 py-0.5 text-[11px] text-[var(--sparrow-muted)]">
                      Archived
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--sparrow-faint)]">
                  {room.memberCount} {room.memberCount === 1 ? 'member' : 'members'} · created{' '}
                  {fmtDate(room.createdAt)}
                </p>
                {rowError[room.id] && (
                  <p className="mt-1 text-xs text-[var(--sparrow-danger)]">{rowError[room.id]}</p>
                )}
              </div>
              <button
                type="button"
                disabled={busyId === room.id}
                onClick={() => void setArchived(room, !room.archivedAt)}
                className={
                  room.archivedAt
                    ? ghostBtn
                    : 'rounded-md border border-[var(--sparrow-border)] px-2.5 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50'
                }
              >
                {room.archivedAt ? 'Restore' : 'Archive'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
