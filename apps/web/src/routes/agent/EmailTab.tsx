import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { EmailThread } from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { agentEmailThreadPath, agentTabPath } from '../../lib/ids.js';
import { formatRelativeTime } from '../../lib/time.js';
import { dispositionBadge, partyLabel } from '../../lib/email.js';
import { mergeHead, useAgentStream } from '../../lib/agentStream.js';
import { DispositionBadge, TrustPill } from '../../components/email/EmailBits.js';
import { PAGE_LIMIT } from './paging.js';
import { ThreadView } from './ThreadView.js';
import type { ContactBook } from './contacts.js';

/**
 * The agent page's **Email** tab: where multi-party threads live. A threads list
 * → a thread view, both scoped to this agent
 * (`GET /orgs/:orgId/agents/:agentId/email/threads[/:threadId]`).
 *
 * Which of the two renders is a QUERY param, not a route: `?tab=email` is the
 * list and `?tab=email&thread=<eth_id>` is one thread, so an email card's "Open
 * thread" anywhere in the app deep-links straight here.
 */
export function EmailTab({
  orgId,
  agentId,
  address,
  owned,
  contacts,
  nowMs,
}: {
  orgId: string;
  agentId: string;
  /** The agent's derived address — the empty state names it. */
  address: string | null;
  /**
   * The caller OWNS this agent. The `email.*` family reaches the owner (and the
   * org's owners/admins for the approval events); a viewer who owns nothing
   * here polls the head instead.
   */
  owned: boolean;
  contacts: ContactBook;
  nowMs: number;
}) {
  const [params] = useSearchParams();
  const threadId = params.get('thread');

  if (threadId) {
    return (
      <ThreadView
        orgId={orgId}
        agentId={agentId}
        threadId={threadId}
        backHref={agentTabPath(orgId, agentId, 'email')}
        contacts={contacts}
        nowMs={nowMs}
      />
    );
  }
  return (
    <ThreadsList orgId={orgId} agentId={agentId} address={address} owned={owned} nowMs={nowMs} />
  );
}

/**
 * The threads list. Rows: subject, participant chips (up to three, then "+N"),
 * last-activity time, unread dot, a `trusted` pill on approved threads, and the
 * newest email's disposition badge when it is quarantined/held/rejected. Every
 * one of those is a field of the `EmailThread` the list route now returns, so a
 * row costs no second request. Ordering is the wire's: newest-first by
 * `lastEmailAt`, paged backward with `before`.
 *
 * Live off the same `/me/events` fan-in every other email surface uses. A row is
 * an AGGREGATE — an unread count and the thread's newest disposition — so an
 * `email.*` frame for this agent re-reads the head rather than patching a row
 * from the frame: only the server can restate an aggregate honestly.
 */
function ThreadsList({
  orgId,
  agentId,
  address,
  owned,
  nowMs,
}: {
  orgId: string;
  agentId: string;
  address: string | null;
  owned: boolean;
  nowMs: number;
}) {
  /** The loaded window in WIRE order — newest first, exactly as rendered. */
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchingMore, setFetchingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setThreads([]);
    setBefore(null);
    void (async () => {
      try {
        const res = await api.agentEmailThreads(orgId, agentId, { limit: PAGE_LIMIT });
        if (cancelled) return;
        setThreads(res.items);
        setBefore(res.nextBefore);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load this mailbox.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, agentId]);

  /** Older threads, appended to the END of the newest-first list. */
  const more = useCallback(async () => {
    if (!before || fetchingMore) return;
    setFetchingMore(true);
    try {
      const res = await api.agentEmailThreads(orgId, agentId, { limit: PAGE_LIMIT, before });
      setThreads((prev) => [...prev, ...res.items]);
      setBefore(res.nextBefore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more threads.');
    } finally {
      setFetchingMore(false);
    }
  }, [orgId, agentId, before, fetchingMore]);

  // --- live ---------------------------------------------------------------
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const reconcile = useCallback(async () => {
    try {
      const res = await api.agentEmailThreads(orgId, agentId, { limit: PAGE_LIMIT });
      const wasEmpty = threadsRef.current.length === 0;
      setThreads((prev) => mergeHead(res.items, prev));
      if (wasEmpty) setBefore(res.nextBefore);
    } catch {
      // Keep the window the viewer already has rather than blanking it.
    }
  }, [orgId, agentId]);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  useAgentStream({
    agentId,
    owned,
    onEmailChanged: () => void reconcileRef.current(),
    onReconcile: () => void reconcileRef.current(),
  });

  if (loading && threads.length === 0) {
    return <p className="text-sm text-[var(--sparrow-faint)]">Loading…</p>;
  }
  if (error) return <p className="text-sm text-[var(--sparrow-danger)]">{error}</p>;

  if (threads.length === 0) {
    return (
      <div>
        <p className="text-sm text-[var(--sparrow-text)]">No email yet.</p>
        <p className="mt-1 text-sm text-[var(--sparrow-muted)]">
          {address ? (
            <>
              Mail sent to <span className="mono text-[var(--sparrow-text)]">{address}</span> will
              appear here.
            </>
          ) : (
            <>Mail sent to this agent will appear here.</>
          )}
        </p>
      </div>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-[var(--sparrow-border)] overflow-hidden rounded-lg border border-[var(--sparrow-border)]">
        {threads.map((t) => (
          <li key={t.id}>
            <ThreadRow orgId={orgId} agentId={agentId} thread={t} nowMs={nowMs} />
          </li>
        ))}
      </ul>
      {before && (
        <button
          type="button"
          onClick={() => void more()}
          disabled={fetchingMore}
          className="mt-3 min-h-[40px] w-full rounded-md border border-[var(--sparrow-border)] px-3 py-2 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
        >
          {fetchingMore ? 'Loading…' : 'Show more threads'}
        </button>
      )}
    </div>
  );
}

/** How many participant chips a row shows before collapsing into "+N". */
const CHIP_LIMIT = 3;

/** One row. Every field comes down WITH the row — a list read, not a fan-out. */
function ThreadRow({
  orgId,
  agentId,
  thread,
  nowMs,
}: {
  orgId: string;
  agentId: string;
  thread: EmailThread;
  nowMs: number;
}) {
  const { participants, unreadCount: unread } = thread;
  const badge = dispositionBadge(thread.lastDisposition);
  const chips = participants.slice(0, CHIP_LIMIT);
  const overflow = participants.length - chips.length;

  return (
    <Link
      to={agentEmailThreadPath(orgId, agentId, thread.id)}
      className="flex min-h-[40px] flex-col gap-1 px-3 py-2.5 transition-colors hover:bg-[var(--sparrow-panel-2)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        {unread > 0 && (
          <>
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full bg-[var(--sparrow-accent)]"
            />
            <span className="sr-only">{unread} unread</span>
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--sparrow-text)]">
          {thread.subject || '(no subject)'}
        </span>
        {thread.trusted && <TrustPill trust="approved" />}
        {badge && <DispositionBadge label={badge} />}
        <span className="shrink-0 text-[11px] text-[var(--sparrow-faint)]">
          {formatRelativeTime(thread.lastEmailAt ?? thread.createdAt, nowMs)}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {chips.map((p, i) => (
            <span
              key={`${p.email}:${i}`}
              title={p.email}
              className="inline-flex max-w-[10rem] items-center gap-1 truncate rounded-full border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-2 py-0.5 text-[11px] text-[var(--sparrow-muted)]"
            >
              <span className="truncate">{partyLabel(p)}</span>
            </span>
          ))}
          {overflow > 0 && (
            <span className="text-[11px] text-[var(--sparrow-faint)]">+{overflow}</span>
          )}
        </div>
      )}
    </Link>
  );
}
