import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomInvitation } from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { useOrg } from '../lib/org.js';
import { useWorkspace } from '../lib/workspace.js';
import { api } from '../lib/client.js';
import { orgAdminPath, roomPath } from '../lib/ids.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';
import { useShellPolicy } from '../components/AppShell.js';

/**
 * Org home (`/org/:orgId` index) — the calm landing shown in the shell's main
 * column when no room is selected. It greets by org name and points at the next
 * action (the sidebar's add affordances / New room live in the shell), and
 * surfaces any pending room invitations with Accept / Decline right here.
 *
 * Nested route: this is PAGE CONTENT (a scrollable, centered column), not a
 * layout — the shell owns the chrome around it.
 */
export function OrgHome() {
  const { orgId, name, isAdmin } = useOrg();
  useDocumentTitle(pageTitle(name));
  const ws = useWorkspace();
  // Describe only what the SHELL renders for this caller: with invites or room
  // creation restricted to admins those "+" buttons are hidden, and copy that
  // names a control the reader cannot see is the same bug as copy that names a
  // control nobody has. Unknown policy (still loading, or rendered outside the
  // shell) shows everything.
  const policy = useShellPolicy();
  const canInvite = policy?.canInvite ?? true;
  const canCreateRoom = policy?.canCreateRoom ?? true;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col px-4 py-10 sm:py-16">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--sparrow-text)]">
          {name ? `Welcome to ${name}` : 'Welcome'}
        </h1>
        <p className="mt-2 text-sm text-[var(--sparrow-muted)]">
          Pick a conversation from the sidebar, or start something new.
        </p>

        {ws.loading ? (
          <p className="mt-4 text-xs text-[var(--sparrow-faint)]">Loading your workspace…</p>
        ) : null}

        <ul className="mt-6 space-y-2 text-sm text-[var(--sparrow-muted)]">
          {/* Every control named below is one the shell actually renders, by its
              exact label — the sidebar section "+" buttons. Nothing here may name
              a top-bar action: that row collapses on phones. */}
          <li>
            <span className="text-[var(--sparrow-text)]">Message a person or agent</span> — click a
            name under HUMANS or AGENTS in the sidebar.
            {canInvite ? (
              <>
                {' '}
                Nobody there yet? Use the <span className="text-[var(--sparrow-text)]">+</span>{' '}
                beside HUMANS (
                <span className="text-[var(--sparrow-text)]">Invite a person</span>).
              </>
            ) : null}
          </li>
          {canInvite ? (
            <li>
              <span className="text-[var(--sparrow-text)]">Bring in an agent</span> — the{' '}
              <span className="text-[var(--sparrow-text)]">+</span> beside AGENTS (
              <span className="text-[var(--sparrow-text)]">Invite an agent</span>) shares a link an
              agent enrolls with.
            </li>
          ) : null}
          {canCreateRoom ? (
            <li>
              <span className="text-[var(--sparrow-text)]">Start a room</span> — the{' '}
              <span className="text-[var(--sparrow-text)]">+</span> at the top of the ROOMS section (
              <span className="text-[var(--sparrow-text)]">Create a room</span>) opens a shared
              broadcast conversation.
            </li>
          ) : null}
          {!canInvite && !canCreateRoom ? (
            <li>
              <span className="text-[var(--sparrow-text)]">Need a new room, or someone new?</span>{' '}
              This organization keeps invites and new rooms with its admins — ask one of them.
            </li>
          ) : null}
        </ul>

        {isAdmin ? (
          <p className="mt-6 text-sm text-[var(--sparrow-muted)]">
            You manage this org.{' '}
            <Link to={orgAdminPath(orgId)} className="text-[var(--sparrow-accent)] hover:underline">
              Open org settings
            </Link>{' '}
            for people, agents, invites, and approvals.
          </p>
        ) : null}

        {ws.invitations.length > 0 ? (
          <PendingInvitations invitations={ws.invitations} />
        ) : null}

        {/* Ambient oversight of agent↔agent DMs the caller can see both ends of. */}
      </div>
    </div>
  );
}

/** Pending room invitations for this org: Accept (join + go) / Decline. */
function PendingInvitations({ invitations }: { invitations: RoomInvitation[] }) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">
        Room invitations
        <span className="ml-2 rounded-full bg-[var(--sparrow-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--sparrow-accent)]">
          {invitations.length}
        </span>
      </h2>
      <ul className="mt-3 space-y-2">
        {invitations.map((inv) => (
          <InvitationRow key={inv.id} invitation={inv} />
        ))}
      </ul>
    </section>
  );
}

function InvitationRow({ invitation }: { invitation: RoomInvitation }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<null | 'accept' | 'decline'>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (busy) return;
    setBusy('accept');
    setError(null);
    try {
      await api.acceptRoomInvitation(invitation.id);
      await ws.reloadRooms();
      await ws.reloadInvitations();
      navigate(roomPath(invitation.room.orgId, invitation.room.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept the invitation.');
      setBusy(null);
    }
  }

  async function decline() {
    if (busy) return;
    setBusy('decline');
    setError(null);
    try {
      await api.declineRoomInvitation(invitation.id);
      await ws.reloadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not decline the invitation.');
      setBusy(null);
    }
  }

  return (
    <li className="rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-[var(--sparrow-text)]">{invitation.room.name}</p>
          <p className="mt-0.5 text-xs text-[var(--sparrow-faint)]">
            Invited by {invitation.invitedBy.displayName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void accept()}
            disabled={busy !== null}
            className="inline-flex min-h-[40px] items-center rounded-md bg-[var(--sparrow-accent)] px-3 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'accept' ? 'Joining…' : 'Accept'}
          </button>
          <button
            type="button"
            onClick={() => void decline()}
            disabled={busy !== null}
            className="inline-flex min-h-[40px] items-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
          >
            {busy === 'decline' ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </li>
  );
}
