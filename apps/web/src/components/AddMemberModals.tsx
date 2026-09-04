import { useState } from 'react';
import { ApiError } from '@sparrow/client';
import { api } from '../lib/client.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { Modal } from './Modal.js';
import { DirectoryPicker } from './DirectoryPicker.js';

/**
 * The two room member-add flows, shared by the main Room view and the Room
 * settings surface so both reuse one implementation (invitation POST for humans,
 * direct AddMember POST for agents, gated by the caller's agent visibility).
 */

/** Invite an org human to the room (creates a pending invitation they accept). */
export function AddPeopleModal({
  roomId,
  orgId,
  onClose,
  onInvited,
}: {
  roomId: string;
  orgId: string;
  onClose: () => void;
  /** Fired after a successful invite, so a host that lists invitations can refresh. */
  onInvited?: () => void;
}) {
  const { user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  // The org directory answers with everyone, the caller included — and you are
  // already here. Offering yourself was only ever a dead end (the server rejects
  // inviting a member of the room), so drop yourself from the candidates.
  const excludeIds = user ? new Set([user.id]) : undefined;
  return (
    <Modal title="Add people" onClose={onClose} labelledById="add-people-title">
      <p className="mb-3 text-xs text-[var(--sparrow-muted)]">
        Invite someone from your organization. They&rsquo;ll get an invitation to accept.
      </p>
      <DirectoryPicker
        orgId={orgId}
        excludeIds={excludeIds}
        onPick={async (h) => {
          try {
            await api.inviteHuman(roomId, h.id);
            setMessage(`Invited ${h.displayName}.`);
            onInvited?.();
          } catch (e) {
            setMessage(e instanceof ApiError ? e.message : 'Could not invite that person.');
          }
        }}
      />
      {message && <p className="mt-2 text-sm text-[var(--sparrow-accent)]">{message}</p>}
    </Modal>
  );
}

/** Attach an agent the caller can see; it joins the room immediately (AddMember). */
export function AddAgentModal({
  roomId,
  existingMemberPrincipalIds,
  onClose,
  onAdded,
}: {
  roomId: string;
  existingMemberPrincipalIds: ReadonlySet<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const ws = useWorkspace();
  const [message, setMessage] = useState<string | null>(null);
  const options = ws.agents.filter((a) => !existingMemberPrincipalIds.has(a.agent.id));
  return (
    <Modal title="Add an agent" onClose={onClose} labelledById="add-agent-title">
      <p className="mb-3 text-xs text-[var(--sparrow-muted)]">
        Attach an agent you can see. It joins the room immediately.
      </p>
      {options.length === 0 ? (
        <p className="text-sm text-[var(--sparrow-faint)]">
          No agents to add. Create or get access to one first.
        </p>
      ) : (
        <ul role="list" className="max-h-64 overflow-y-auto">
          {options.map((a) => (
            <li key={a.agent.id}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await api.addMember(roomId, a.agent.id);
                    onAdded();
                    setMessage(`Added ${a.agent.name}.`);
                  } catch (e) {
                    setMessage(e instanceof ApiError ? e.message : 'Could not add that agent.');
                  }
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors hover:bg-[var(--sparrow-panel-2)]"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{a.agent.name}</span>
                <span className="mono shrink-0 text-xs text-[var(--sparrow-muted)]">
                  {a.sharedBy ? `shared by ${a.owner.displayName}` : 'yours'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p className="mt-2 text-sm text-[var(--sparrow-accent)]">{message}</p>}
    </Modal>
  );
}
