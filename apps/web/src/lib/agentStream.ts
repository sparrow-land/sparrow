import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActivityAppendedEvent,
  ActivityEntry,
  EmailDisposition,
  EmailHeldEvent,
  EmailQuarantinedEvent,
  EmailReceivedEvent,
  EmailRejectedEvent,
  EmailResolvedEvent,
  EmailSentEvent,
} from '@sparrow/common-types';
import type { PrincipalEvent } from '@sparrow/client';
import { useMeEventStream } from './meEvents.js';

/**
 * The LIVE half of every agent-scoped surface (SPEC v4 → *Web UI → the
 * conversation view is an activity stream → Live updates*, and → *Agent page →
 * Activity*).
 *
 * Three surfaces need the same routing table — a DM pane's stream, the agent
 * page's Activity tab, and its Email tab — so the agent-scoped routing lives
 * here ONCE. The CONNECTION itself is not ours: every surface in the app shares
 * the single `/me/events` stream in {@link ../lib/meEvents}, so mounting an
 * agent page costs a subscription, not a socket.
 *
 * Authorization is the SERVER's throughout: this module never decides who may
 * read a timeline, it only routes the frames the server chose to send.
 */

/**
 * How often a viewer who does NOT receive `activity.appended` re-reads the head.
 * `activity.appended` goes to the agent's OWNER only, so an org owner/admin
 * reading someone else's agent polls instead.
 */
export const ACTIVITY_POLL_MS = 30_000;

export interface AgentStream {
  /**
   * A live override of an entry's derived disposition. It returns `null` when
   * nothing has changed, so the caller's derived value wins.
   */
  dispositionOf: (entry: ActivityEntry) => EmailDisposition | null;
}

export interface UseAgentStreamArgs {
  /** The agent these events are about, or `null` to subscribe to nothing. */
  agentId: string | null;
  /** The caller OWNS this agent, so `activity.appended` reaches them. */
  owned: boolean;
  /** A new entry for this agent (owner-only). Omit on a surface that pages. */
  onAppended?: (entry: ActivityEntry) => void;
  /**
   * An `email.*` frame named this agent. Dispositions are already folded into
   * {@link AgentStream.dispositionOf}; this fires for surfaces whose rows are
   * AGGREGATES (unread counts, a thread's newest disposition) and therefore
   * cannot be patched locally at all.
   */
  onEmailChanged?: () => void;
  /**
   * The loaded window may be stale: refetch its head. Fired on a reconnect, a
   * `replay.gap`, an `email.rejected` (which carries no email id, so nothing
   * can be patched), and on the poll tick a non-owner falls back to.
   */
  onReconcile: () => void;
}

/**
 * The agent-scoped routing table over {@link useMeEventStream}, plus the poll a
 * viewer who does not own the agent needs. Returns the disposition overrides
 * that let a live `email.resolved` mutate a card WITHOUT a refetch — the
 * mutation SPEC names: a `Held` badge flips to none when approved, a denial
 * grays the card in place.
 */
export function useAgentStream({
  agentId,
  owned,
  onAppended,
  onEmailChanged,
  onReconcile,
}: UseAgentStreamArgs): AgentStream {
  const [overrides, setOverrides] = useState<Record<string, EmailDisposition>>({});

  // Reset the overrides when the surface moves to a different agent — a stale
  // map would badge the new agent's cards with the old agent's resolutions.
  useEffect(() => {
    setOverrides({});
  }, [agentId]);

  const appendedRef = useRef(onAppended);
  appendedRef.current = onAppended;
  const emailChangedRef = useRef(onEmailChanged);
  emailChangedRef.current = onEmailChanged;
  const reconcileRef = useRef(onReconcile);
  reconcileRef.current = onReconcile;

  /** Fold one email's current disposition into the override map. */
  const noteDisposition = useCallback((emailId: string, disposition: EmailDisposition) => {
    setOverrides((cur) => (cur[emailId] === disposition ? cur : { ...cur, [emailId]: disposition }));
  }, []);

  const onEvent = useCallback(
    (ev: PrincipalEvent) => {
      switch (ev.type) {
        case 'activity.appended': {
          const { entry } = ev.data as ActivityAppendedEvent;
          // Only THIS agent's timeline; the fan-in carries every agent's.
          if (entry.agent?.id !== agentId) return;
          appendedRef.current?.(entry);
          return;
        }
        case 'email.received':
        case 'email.sent': {
          const { email, thread } = ev.data as EmailReceivedEvent | EmailSentEvent;
          if (thread.agentId !== agentId) return;
          noteDisposition(email.id, email.disposition);
          emailChangedRef.current?.();
          return;
        }
        case 'email.quarantined':
        case 'email.held': {
          const { email, agent } = ev.data as EmailQuarantinedEvent | EmailHeldEvent;
          if (agent.id !== agentId) return;
          noteDisposition(email.id, email.disposition);
          emailChangedRef.current?.();
          return;
        }
        case 'email.resolved': {
          const { email, thread } = ev.data as EmailResolvedEvent;
          if (thread.agentId !== agentId) return;
          noteDisposition(email.id, email.disposition);
          emailChangedRef.current?.();
          return;
        }
        case 'email.rejected': {
          // A refusal carries no email id (it is a security record, never
          // pushed as content) — reconcile instead so the entry appears.
          const { agentId: rejectedFor } = ev.data as EmailRejectedEvent;
          if (rejectedFor !== agentId) return;
          reconcileRef.current();
          return;
        }
        case 'replay.gap':
          // Our cursor predates retention: replay is incomplete, so refetch the
          // head rather than trusting the stream.
          reconcileRef.current();
          return;
        default:
          // Unknown to this client version — data, not a defect. Ignored.
          return;
      }
    },
    [agentId, noteDisposition],
  );

  useMeEventStream({
    enabled: agentId !== null,
    onEvent,
    onReconnect: () => reconcileRef.current(),
  });

  // An org owner/admin reading someone ELSE's agent gets no `activity.appended`
  // (it goes to the owner only), so their surface stays live by polling.
  useEffect(() => {
    if (!agentId || owned) return;
    const t = setInterval(() => reconcileRef.current(), ACTIVITY_POLL_MS);
    return () => clearInterval(t);
  }, [agentId, owned]);

  const dispositionOf = useCallback(
    (entry: ActivityEntry): EmailDisposition | null => {
      const id = entry.refs.emailId;
      return (id ? overrides[id] : undefined) ?? null;
    },
    [overrides],
  );

  return { dispositionOf };
}

/**
 * Reconcile a freshly-read HEAD page into a loaded newest-first window: the new
 * page wins for every row it carries (a thread row's unread count and last
 * disposition are AGGREGATES — only the server can restate them), and whatever
 * the viewer had paged in below it is kept. Both inputs descend, so the
 * concatenation still descends.
 */
export function mergeHead<T extends { id: string }>(head: T[], loaded: T[]): T[] {
  const fresh = new Set(head.map((row) => row.id));
  return [...head, ...loaded.filter((row) => !fresh.has(row.id))];
}
