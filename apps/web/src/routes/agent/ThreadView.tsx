import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import type { Email, EmailThread } from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { headFromEmail } from '../../lib/email.js';
import { EmailCard } from '../../components/email/EmailCard.js';
import { PartyChip, TrustPill } from '../../components/email/EmailBits.js';
import { PAGE_LIMIT } from './paging.js';
import type { ContactBook } from './contacts.js';

/**
 * ONE email thread, scoped to this agent
 * (`GET /orgs/:orgId/agents/:agentId/email/threads/:threadId`, always a peek —
 * a human reading never marks the agent's mail read).
 *
 * Multi-party threads have no single counterpart, which is exactly why they are
 * not forced into a DM pane: this is the only place a thread is fully navigable.
 * The header carries the thread's ORIGINAL subject (a reply may re-subject; the
 * card below shows each email's own), its trusted state, and the full
 * participant set across the thread with trust pills. Below, the emails
 * ASCENDING, each rendering exactly like an expanded card.
 */
export function ThreadView({
  orgId,
  agentId,
  threadId,
  backHref,
  contacts,
  nowMs,
}: {
  orgId: string;
  agentId: string;
  threadId: string;
  backHref: string;
  contacts: ContactBook;
  nowMs: number;
}) {
  const [thread, setThread] = useState<EmailThread | null>(null);
  const [items, setItems] = useState<Email[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Emails the reader has collapsed; a thread opens fully expanded. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setThread(null);
    setItems([]);
    setCursor(null);
    void api
      .agentEmailThread(orgId, agentId, threadId, { limit: PAGE_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setThread(res.thread);
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) => {
        // A thread may be gone (its agent deleted, its rejected rows reaped);
        // that is a note, never a crash.
        if (!cancelled) {
          setError(
            err instanceof ApiError && err.code === 'not_found'
              ? 'This thread is no longer available.'
              : 'Could not load this thread.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, agentId, threadId]);

  const loadMore = useCallback(async () => {
    if (!cursor || paging) return;
    setPaging(true);
    try {
      const res = await api.agentEmailThread(orgId, agentId, threadId, {
        limit: PAGE_LIMIT,
        cursor,
      });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more of this thread.');
    } finally {
      setPaging(false);
    }
  }, [orgId, agentId, threadId, cursor, paging]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  return (
    <div>
      <Link
        to={backHref}
        className="inline-flex min-h-[40px] items-center gap-1 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
      >
        <ChevronLeft size={14} aria-hidden="true" />
        All threads
      </Link>

      {error ? (
        <p className="mt-4 text-sm text-[var(--sparrow-muted)]">{error}</p>
      ) : loading && !thread ? (
        <p className="mt-4 text-sm text-[var(--sparrow-faint)]">Loading…</p>
      ) : thread ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-base font-semibold tracking-tight text-[var(--sparrow-text)]">
              {thread.subject || '(no subject)'}
            </h2>
            {thread.trusted && <TrustPill trust="approved" />}
          </div>

          {thread.participants.length > 0 && (
            <div
              role="group"
              aria-label="Participants"
              className="mt-3 flex flex-wrap items-center gap-1.5"
            >
              {thread.participants.map((p, i) => (
                <span key={`${p.email}:${i}`} className="inline-flex items-center gap-1">
                  <PartyChip party={p} />
                  <TrustPill trust={contacts.trustOfParty(p)} />
                </span>
              ))}
            </div>
          )}

          {cursor && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={paging}
              className="mt-4 min-h-[40px] w-full rounded-md border border-[var(--sparrow-border)] px-3 py-2 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
            >
              {paging ? 'Loading…' : 'Load more of this thread'}
            </button>
          )}

          <ul className="mt-4 flex flex-col gap-3">
            {items.map((e) => (
              <li key={e.id}>
                <EmailCard
                  orgId={orgId}
                  head={headFromEmail(e)}
                  full={e}
                  trust={contacts.trustOfParty(e.direction === 'in' ? e.from : (e.to[0] ?? e.from))}
                  expanded={!collapsed.has(e.id)}
                  onToggle={() => toggle(e.id)}
                  reviewHref="/me/approvals"
                  nowMs={nowMs}
                />
              </li>
            ))}
          </ul>

          {items.length === 0 && (
            <p className="mt-4 text-sm text-[var(--sparrow-muted)]">
              This thread has no readable email.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
