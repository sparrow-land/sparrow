import { useState } from 'react';
import { ApiError } from '@sparrow/client';
import { api } from '../lib/client.js';
import { Modal } from './Modal.js';

/**
 * New room modal (ROOMS footer). Creates a project room (`POST
 * /orgs/:orgId/rooms`); the creator becomes its owner. On success the caller is
 * routed into the fresh room.
 */
export function NewRoomModal({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: (roomId: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const room = await api.createRoom(orgId, { name: name.trim() });
      onCreated(room.id);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'forbidden'
            ? 'Only admins can create rooms in this organization.'
            : err.message
          : 'Could not create the room.',
      );
      setBusy(false);
    }
  }

  const inputClass =
    'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

  return (
    <Modal title="New room" onClose={onClose} labelledById="new-room-title">
      <form onSubmit={create}>
        <p className="text-xs text-[var(--sparrow-muted)]">
          A room is a shared conversation. Add people and agents once it exists.
        </p>
        <label
          htmlFor="new-room-name"
          className="mt-3 mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
        >
          Room name
        </label>
        <input
          id="new-room-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. deploys"
          autoFocus
          className={inputClass}
        />
        {error && <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--sparrow-border-strong)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create room'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
