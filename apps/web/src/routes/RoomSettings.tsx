import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Member, Room, RoomInvitationAdmin, RoomRole, RoomUpdatedEvent } from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../lib/client.js';
import { wire, orgPath, roomPath } from '../lib/ids.js';
import { useOrg } from '../lib/org.js';
import { useWorkspace } from '../lib/workspace.js';
import { roomStreams } from '../lib/roomStreams.js';
import { readAvatarUrl } from '../lib/avatar.js';
import { Avatar } from '../components/Avatar.js';
import { AddPeopleModal, AddAgentModal } from '../components/AddMemberModals.js';
import { Saved } from './org/ui.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/**
 * Room settings (`/org/:orgId/rooms/:roomId/settings`): Room (name, description),
 * Members (kind + role, with role control + remove for permitted callers, live
 * via member.* events), pending invitations, and a Danger zone (leave / archive
 * / restore). Archived rooms are read-only with a Restore action.
 */
export function RoomSettings() {
  const { roomId: bareRoomId = '' } = useParams<{ roomId: string }>();
  const roomId = wire('room', bareRoomId);
  const { orgId, isAdmin } = useOrg();
  const ws = useWorkspace();
  const navigate = useNavigate();

  const [room, setRoom] = useState<Room | null>(null);
  const [self, setSelf] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<RoomInvitationAdmin[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  /** Confirmation tick after a successful save — the org admin page's pattern. */
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dangerError, setDangerError] = useState<string | null>(null);
  const [addPeople, setAddPeople] = useState(false);
  const [addAgent, setAddAgent] = useState(false);

  const archived = room?.archivedAt != null;
  const isDm = room?.kind === 'dm';
  // Named by the room once it loads; the bare page name while it's in flight.
  useDocumentTitle(
    pageTitle(isDm ? 'Conversation settings' : 'Room settings', room ? `#${room.name}` : null),
  );
  const ownRole = self?.roomRole ?? 'member';
  const canAdmin = ownRole === 'owner' || ownRole === 'admin' || isAdmin;
  const canOwner = ownRole === 'owner' || isAdmin;

  const reloadMembers = useCallback(() => {
    void api
      .listMembers(roomId, { limit: 100 })
      .then((r) => setMembers(r.items))
      .catch(() => {});
  }, [roomId]);

  const reloadInvitations = useCallback(() => {
    void api.listRoomInvitations(roomId).then(setInvitations).catch(() => {});
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [rm, me, mem] = await Promise.all([
          api.getRoom(roomId),
          api.whoami(roomId),
          api.listMembers(roomId, { limit: 100 }).then((r) => r.items),
        ]);
        if (cancelled) return;
        setRoom(rm);
        setSelf(me);
        setMembers(mem);
        setName(rm.name);
        setDescription(rm.settings.description);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          navigate(orgPath(orgId));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, navigate, orgId]);

  // Pending invitations (admin surface).
  useEffect(() => {
    if (!roomId || !canAdmin || isDm) return;
    reloadInvitations();
  }, [roomId, canAdmin, isDm, reloadInvitations]);

  // Live member.* updates.
  useEffect(() => {
    if (!roomId) return;
    return roomStreams.subscribe(roomId, (ev) => {
      if (ev.type === 'member.joined' || ev.type === 'member.updated' || ev.type === 'member.removed') {
        reloadMembers();
      } else if (ev.type === 'room.updated') {
        const d = ev.data as RoomUpdatedEvent;
        setRoom((prev) =>
          prev ? { ...prev, name: d.room.name, archivedAt: d.room.archivedAt, settings: d.settings } : prev,
        );
      }
    });
  }, [roomId, reloadMembers]);

  async function saveRoom(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.updateRoom(roomId, { name: name.trim(), settings: { description: description.trim() } });
      setRoom(res);
      setSaved(true);
      void ws.reloadRooms();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(next: boolean) {
    setDangerError(null);
    try {
      const res = await api.updateRoom(roomId, { archived: next });
      setRoom(res);
      void ws.reloadRooms();
    } catch (err) {
      setDangerError(err instanceof ApiError ? err.message : 'Could not update the room.');
    }
  }

  async function leave() {
    setDangerError(null);
    try {
      await api.leaveRoom(roomId);
      await ws.reloadRooms();
      navigate(orgPath(orgId));
    } catch (err) {
      setDangerError(
        err instanceof ApiError
          ? err.status === 409
            ? 'You are the only owner. Make someone else an owner, or archive the room, first.'
            : err.message
          : 'Could not leave the room.',
      );
    }
  }

  if (!room) return <div className="p-6 text-sm text-[var(--sparrow-faint)]">Loading…</div>;

  const inputClass =
    'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)] disabled:opacity-50';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2 text-sm">
          <Link to={roomPath(orgId, roomId)} className="text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]">
            ← Back to {isDm ? 'conversation' : `#${room.name}`}
          </Link>
        </div>
        <h1 className="text-lg font-semibold">{isDm ? 'Conversation settings' : 'Room settings'}</h1>
        {archived && (
          <div className="mt-3 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2 text-sm text-[var(--sparrow-muted)]">
            This room is archived — read-only.
          </div>
        )}

        {!isDm && (
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">Room</h2>
            <form onSubmit={saveRoom} className="mt-2 rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-4">
              <label htmlFor="rs-name" className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]">
                Name
              </label>
              <input
                id="rs-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                disabled={!canAdmin || archived}
                className={inputClass}
              />
              <label htmlFor="rs-desc" className="mb-1 mt-3 block text-xs font-medium text-[var(--sparrow-muted)]">
                Description
              </label>
              <textarea
                id="rs-desc"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setSaved(false);
                }}
                disabled={!canAdmin || archived}
                rows={2}
                maxLength={240}
                className={`${inputClass} resize-none`}
              />
              {error && <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p>}
              {canAdmin && !archived && (
                <div className="mt-3 flex items-center justify-end gap-3">
                  {saved && <Saved />}
                  <button
                    type="submit"
                    disabled={saving || !name.trim()}
                    className="rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </form>
          </section>
        )}

        {!isDm && (
          <section className="mt-6">
            <div className="flex items-center gap-2">
              <h2 className="flex-1 text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
                Members
              </h2>
              {canAdmin && !archived && (
                <>
                  <button
                    type="button"
                    onClick={() => setAddPeople(true)}
                    className="shrink-0 rounded-md border border-[var(--sparrow-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
                  >
                    Add people
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddAgent(true)}
                    className="shrink-0 rounded-md border border-[var(--sparrow-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
                  >
                    Add agent
                  </button>
                </>
              )}
            </div>
            <div className="mt-2 divide-y divide-[var(--sparrow-border)] rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)]">
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  canManage={canAdmin && !archived && m.id !== self?.id}
                  canManageOwner={canOwner}
                  roomId={roomId}
                  onChanged={reloadMembers}
                />
              ))}
            </div>
          </section>
        )}

        {!isDm && canAdmin && invitations.length > 0 && (
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
              Pending invitations
            </h2>
            <div className="mt-2 divide-y divide-[var(--sparrow-border)] rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)]">
              {invitations.map((inv) => (
                <div key={inv.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{inv.human.displayName}</span>
                  <span className="text-xs text-[var(--sparrow-faint)]">invited by {inv.invitedBy.displayName}</span>
                  {!archived && (
                    <button
                      onClick={() =>
                        void api
                          .revokeRoomInvitation(roomId, inv.id)
                          .then(() => setInvitations((v) => v.filter((i) => i.id !== inv.id)))
                          .catch(() => {})
                      }
                      className="rounded border border-[var(--sparrow-border-strong)] px-2 py-1 text-xs text-[var(--sparrow-muted)] hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)]"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">Danger zone</h2>
          <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-4">
            <button
              onClick={() => void leave()}
              className="rounded-md border border-[var(--sparrow-border-strong)] px-3 py-1.5 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)]"
            >
              Leave {isDm ? 'conversation' : 'room'}
            </button>
            {!isDm && canOwner && (
              archived ? (
                <button
                  onClick={() => void setArchived(false)}
                  className="rounded-md border border-[var(--sparrow-accent-2)] bg-[var(--sparrow-accent-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--sparrow-accent)] transition-colors hover:border-[var(--sparrow-accent)]"
                >
                  Restore room
                </button>
              ) : (
                <button
                  onClick={() => void setArchived(true)}
                  className="rounded-md border border-[var(--sparrow-border-strong)] px-3 py-1.5 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)]"
                >
                  Archive room
                </button>
              )
            )}
          </div>
          {dangerError && <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{dangerError}</p>}
        </section>
      </div>

      {addPeople && (
        <AddPeopleModal
          roomId={roomId}
          orgId={orgId}
          onClose={() => setAddPeople(false)}
          onInvited={reloadInvitations}
        />
      )}
      {addAgent && (
        <AddAgentModal
          roomId={roomId}
          existingMemberPrincipalIds={new Set(members.map((m) => m.principalId))}
          onClose={() => setAddAgent(false)}
          onAdded={reloadMembers}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  canManage,
  canManageOwner,
  roomId,
  onChanged,
}: {
  member: Member;
  canManage: boolean;
  canManageOwner: boolean;
  roomId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAgent = member.kind === 'agent';

  async function setRole(role: RoomRole) {
    if (busy || role === member.roomRole) return;
    setBusy(true);
    setError(null);
    try {
      await api.setMemberRole(roomId, member.id, role);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeMember(roomId, member.id);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
      <Avatar
        kind={member.kind}
        id={member.principalId}
        displayName={member.displayName}
        avatarUrl={readAvatarUrl(member)}
        size={24}
      />
      <span className="min-w-0 flex-1 truncate">{member.displayName}</span>
      <span
        className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
          isAgent ? 'bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]' : 'bg-[rgba(91,185,139,0.14)] text-[var(--sparrow-good)]'
        }`}
      >
        {member.kind}
      </span>
      {canManage && !isAgent ? (
        <select
          value={member.roomRole}
          disabled={busy}
          onChange={(e) => void setRole(e.target.value as RoomRole)}
          aria-label={`Role for ${member.displayName}`}
          className="rounded border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-bg)] px-2 py-1 text-xs text-[var(--sparrow-text)]"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
          {canManageOwner && <option value="owner">owner</option>}
        </select>
      ) : (
        <span className="mono text-xs text-[var(--sparrow-muted)]">{member.roomRole}</span>
      )}
      {canManage && (
        <button
          onClick={() => void remove()}
          disabled={busy}
          className="rounded border border-[var(--sparrow-border-strong)] px-2 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
        >
          Remove
        </button>
      )}
      {error && <span className="w-full text-xs text-[var(--sparrow-danger)]">{error}</span>}
    </div>
  );
}
