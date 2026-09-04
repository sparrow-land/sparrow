import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EmailApprovalItem,
  EmailHeldEvent,
  EmailQuarantinedEvent,
  EmailResolvedEvent,
} from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { useMeEventStream } from '../../lib/meEvents.js';
import {
  EmailApprovalRow,
  type ExternalResolution,
} from '../../components/email/EmailApprovalRow.js';
import { ErrorText, Panel } from './ui.js';

/**
 * The email half of org admin's org-wide **Approvals** block (SPEC v4 → *Web UI
 * → Org admin*): every pending quarantine and hold in the ORG — not just the
 * admin's own agents — beside the pending enrollments, with the same affordances
 * and the same live events.
 *
 * Live (`/me/events`, which fans `email.quarantined`/`email.held`/`email.resolved`
 * to the org's owners and admins as well as the owning human):
 *  - `email.quarantined` / `email.held` insert a row;
 *  - `email.resolved` resolves a row IN PLACE — including when someone else acted
 *    first, so two approvers never fight over it.
 *
 * The row itself (approve/deny, durable trust, resolution-is-final) is
 * {@link EmailApprovalRow}, shared with `/me/approvals`.
 */
export function OrgEmailApprovals({
  orgId,
  onCount,
}: {
  orgId: string;
  /** Reports the number still waiting, so the block can badge and empty-state. */
  onCount?: (n: number) => void;
}) {
  const [items, setItems] = useState<EmailApprovalItem[] | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ExternalResolution>>({});
  const [settled, setSettled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listEmailApprovals(orgId, { limit: 100 });
      setItems(res.items);
    } catch {
      setError('Could not load email waiting for approval.');
      setItems((prev) => prev ?? []);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live over the app's ONE `/me/events` subscription (lib/meEvents) — mounting
  // this panel costs a handler, not a socket. A reconnect — and a `replay.gap` —
  // reconciles by refetching the queue rather than trusting the frames it may
  // have missed.
  const loadRef = useRef(load);
  loadRef.current = load;
  const insert = useCallback((data: EmailQuarantinedEvent | EmailHeldEvent) => {
    setItems((prev) => {
      const list = prev ?? [];
      if (list.some((i) => i.email.id === data.email.id)) return list;
      return [
        ...list,
        {
          email: data.email,
          thread: data.thread,
          agent: data.agent,
          // The event carries no verification block and no judge verdict — a
          // ref, not a body. The row renders what it has and nothing more.
          verification: null,
          judge: null,
        },
      ];
    });
  }, []);
  useMeEventStream({
    enabled: true,
    onReconnect: () => void loadRef.current(),
    onEvent: (ev) => {
      if (ev.type === 'email.quarantined' || ev.type === 'email.held') {
        insert(ev.data as EmailQuarantinedEvent);
      } else if (ev.type === 'email.resolved') {
        const data = ev.data as EmailResolvedEvent;
        setResolutions((prev) => ({
          ...prev,
          [data.email.id]: { resolution: data.resolution, by: data.by },
        }));
        setSettled((prev) => new Set(prev).add(data.email.id));
      } else if (ev.type === 'replay.gap') {
        void loadRef.current();
      }
    },
  });

  const pendingCount = (items ?? []).filter((i) => !settled.has(i.email.id)).length;
  const report = useRef(onCount);
  report.current = onCount;
  useEffect(() => {
    report.current?.(pendingCount);
  }, [pendingCount]);

  if (error && !items?.length) {
    return (
      <Panel>
        <ErrorText>{error}</ErrorText>
      </Panel>
    );
  }
  // Nothing while loading: the enrollment half of the block owns the one
  // "Loading…" line, and an empty queue adds no chrome of its own.
  if (!items || items.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <EmailApprovalRow
          key={item.email.id}
          orgId={orgId}
          item={item}
          resolution={resolutions[item.email.id] ?? null}
          onResolved={(emailId) => setSettled((prev) => new Set(prev).add(emailId))}
        />
      ))}
    </div>
  );
}
