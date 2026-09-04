import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ActivityEntry,
  ContactTrust,
  EmailDisposition,
  Medium,
  Party,
} from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { agentEmailThreadPath, roomPath } from '../../lib/ids.js';
import { formatRelativeTime } from '../../lib/time.js';
import { headFromEntry, isEmailEntry, senderLabel, type EmailCardHead } from '../../lib/email.js';
import { isHintEntry } from '../../lib/activity.js';
import { HintEntryCard } from '../room/ActivityRows.js';
import { mergeHead, useAgentStream } from '../../lib/agentStream.js';
import { EmailCard } from '../../components/email/EmailCard.js';
import { PAGE_LIMIT } from './paging.js';
import type { ContactBook } from './contacts.js';

/**
 * The agent page's **Activity** tab: this agent's FULL timeline from
 * `GET /orgs/:orgId/agents/:agentId/activity` — every entry involving it, newest
 * first, across mediums. This is the "who is messaging with my agents" surface,
 * so it hides nothing: strangers who were rejected are here too.
 *
 * The wire IS newest-first (a transcript reads backward from now), so the loaded
 * window is kept in wire order and rendered as it came; "Load older activity"
 * pages backward with `before` and appends to the END.
 *
 * Rows are the same collapsed cards the conversation stream uses. Chat entries
 * render as a ONE-LINE message card (there are no bubbles outside a
 * conversation), email entries as the shared {@link EmailCard}, expandable in
 * place. The timeline is LIVE off the same `/me/events` fan-in the conversation
 * pane uses (SPEC v4 → *Web UI → the conversation view is an activity stream →
 * Live updates*): new entries arrive at the top and a resolution mutates a card
 * in place, without a refetch.
 *
 * The server decides who may read a timeline; this component is only rendered
 * for the owner or an org owner/admin and never filters for authorization
 * itself.
 */
export function ActivityTab({
  orgId,
  agentId,
  agentName,
  emailEnabled,
  owned,
  contacts,
  nowMs,
}: {
  orgId: string;
  agentId: string;
  agentName: string;
  /** `capabilities.email` — gates the Email filter chip (there is never a Voice one). */
  emailEnabled: boolean;
  /**
   * The caller OWNS this agent. `activity.appended` reaches the owner only, so
   * an org owner/admin reading someone else's agent polls the head instead.
   */
  owned: boolean;
  contacts: ContactBook;
  nowMs: number;
}) {
  const [filter, setFilter] = useState<'all' | Medium>('all');
  /** The loaded window in WIRE order — newest first, exactly as rendered. */
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const medium = filter === 'all' ? undefined : filter;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries([]);
    setBefore(null);
    void (async () => {
      try {
        const res = await api.agentActivity(orgId, agentId, { medium, limit: PAGE_LIMIT });
        if (cancelled) return;
        setEntries(res.items);
        setBefore(res.nextBefore);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load this timeline.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, agentId, medium]);

  const loadOlder = useCallback(async () => {
    if (!before || paging) return;
    setPaging(true);
    try {
      const res = await api.agentActivity(orgId, agentId, { medium, limit: PAGE_LIMIT, before });
      setEntries((prev) => [...prev, ...res.items]);
      setBefore(res.nextBefore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more activity.');
    } finally {
      setPaging(false);
    }
  }, [orgId, agentId, medium, before, paging]);

  // --- live ---------------------------------------------------------------
  // `entries` is read (not depended on) by the reconcile, so the callback the
  // stream holds never has to be rebuilt as the window grows.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const beforeRef = useRef(before);
  beforeRef.current = before;

  /**
   * Re-read the HEAD and fold it into the loaded window. Used where nothing can
   * be patched locally: a reconnect, a `replay.gap`, an `email.rejected` (no
   * email id on the frame), and the non-owner's poll. Silent on failure — the
   * window the viewer already has is better than an error banner.
   */
  const reconcile = useCallback(async () => {
    try {
      const res = await api.agentActivity(orgId, agentId, { medium, limit: PAGE_LIMIT });
      // The window's tail (and so its `before` cursor) is untouched by a head
      // read; only a window that was EMPTY gains one.
      const wasEmpty = entriesRef.current.length === 0;
      setEntries((prev) => mergeHead(res.items, prev));
      if (wasEmpty) setBefore(res.nextBefore);
    } catch {
      // Keep what we have.
    }
  }, [orgId, agentId, medium]);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  const onAppended = useCallback(
    (entry: ActivityEntry) => {
      // The active filter is part of the query; a live entry must respect it.
      if (medium && entry.medium !== medium) return;
      // Newest-first: "now" belongs at the TOP.
      setEntries((cur) => (cur.some((e) => e.id === entry.id) ? cur : [entry, ...cur]));
    },
    [medium],
  );

  const { dispositionOf } = useAgentStream({
    agentId,
    owned,
    onAppended,
    onReconcile: () => void reconcileRef.current(),
  });

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter activity">
        <FilterChip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterChip label="Chat" active={filter === 'chat'} onClick={() => setFilter('chat')} />
        {/* No Voice chip, ever: v4's voice medium writes no entries of its own. */}
        {emailEnabled && (
          <FilterChip label="Email" active={filter === 'email'} onClick={() => setFilter('email')} />
        )}
      </div>

      {error && <p className="mt-4 text-sm text-[var(--sparrow-danger)]">{error}</p>}

      {/*
        An EMPTY timeline is the NORMAL state of an agent that has not started
        working yet, and a bare panel reads as a broken page. The empty state
        therefore says what this surface is anchored to — it follows the AGENT,
        not the workspace — so "nothing here" lands as "nothing yet" rather than
        "nothing works".
      */}
      {loading && entries.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--sparrow-faint)]">Loading…</p>
      ) : entries.length === 0 && !error ? (
        <p className="mt-4 text-sm text-[var(--sparrow-muted)]">
          Nothing yet. This timeline follows {agentName} — it fills in as soon as {agentName} is in
          a conversation, and every message and email involving them lands here as it arrives.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <ActivityRow
                entry={entry}
                orgId={orgId}
                agentId={agentId}
                contacts={contacts}
                disposition={dispositionOf(entry)}
                expanded={expanded.has(entry.id)}
                onToggle={() => toggle(entry.id)}
                nowMs={nowMs}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Backward paging: the wire's own order puts older rows at the END. */}
      {before && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          disabled={paging}
          className="mt-4 min-h-[40px] w-full rounded-md border border-[var(--sparrow-border)] px-3 py-2 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
        >
          {paging ? 'Loading…' : 'Load older activity'}
        </button>
      )}
    </div>
  );
}

/** One filter chip. State rides in `aria-pressed`, never in colour alone. */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[40px] rounded-full border px-4 py-1.5 text-xs transition-colors ${
        active
          ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]'
          : 'border-[var(--sparrow-border)] text-[var(--sparrow-muted)] hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)]'
      }`}
    >
      {label}
    </button>
  );
}

/** Dispatch one entry to its medium's row. Unknown mediums render nothing. */
function ActivityRow({
  entry,
  orgId,
  agentId,
  contacts,
  disposition,
  expanded,
  onToggle,
  nowMs,
}: {
  entry: ActivityEntry;
  orgId: string;
  agentId: string;
  contacts: ContactBook;
  /**
   * A LIVE disposition from the stream, riding ALONGSIDE the head rather than
   * merged into it: the card needs both to tell "was pending, now denied" from
   * an ordinary rejection.
   */
  disposition: EmailDisposition | null;
  expanded: boolean;
  onToggle: () => void;
  nowMs: number;
}) {
  if (entry.medium === 'chat' && entry.type === 'chat.message') {
    return <ChatEntryCard entry={entry} orgId={orgId} nowMs={nowMs} />;
  }
  // Sparrow speaking: a delivered hint, same info box as the DM pane renders.
  if (isHintEntry(entry)) {
    return <HintEntryCard entry={entry} nowMs={nowMs} />;
  }
  if (isEmailEntry(entry)) {
    const { head, trust } = emailHead(entry, contacts);
    return (
      <EmailCard
        orgId={orgId}
        head={head}
        disposition={disposition}
        trust={trust}
        expanded={expanded}
        onToggle={onToggle}
        threadHref={
          head.threadId ? agentEmailThreadPath(orgId, agentId, head.threadId) : null
        }
        reviewHref="/me/approvals"
        nowMs={nowMs}
      />
    );
  }
  // Readers MUST ignore entries whose type or medium they do not recognize.
  return null;
}

/**
 * The collapsed email head for a timeline entry, plus the counterpart's trust.
 *
 * A timeline entry is a REF: it carries a frozen `actor_label`, not an address.
 * When the actor is an external contact AND the caller may read the org's
 * contacts, we resolve the real address + display name + trust so the row reads
 * as an external contact (SPEC v4 → *Agent page → Activity*); otherwise the
 * frozen label stands alone and no pill renders, which is exactly the rendering
 * for an unknown contact.
 */
function emailHead(
  entry: ActivityEntry,
  contacts: ContactBook,
): { head: EmailCardHead; trust: ContactTrust | null } {
  const head = headFromEntry(entry);
  if (entry.actor.kind !== 'contact') return { head, trust: null };
  const found = contacts.contactById(entry.actor.id);
  if (!found) return { head, trust: null };
  const party: Party = {
    email: found.email,
    name: found.displayName,
    principalId: null,
    contactId: found.id,
  };
  return {
    head: {
      ...head,
      counterpart: party,
      // The contact book may carry the sender's self-chosen name; an UNTRUSTED
      // entry (quarantined / inbound-rejected) still renders the address only.
      counterpartLabel: senderLabel(party, head.direction, head.disposition),
    },
    trust: found.trust,
  };
}

/**
 * A chat entry, as ONE LINE: who spoke, what they said, when. There are no
 * bubbles outside a conversation, so this is a card, not a transcript — the room
 * link is where the conversation itself lives.
 */
function ChatEntryCard({
  entry,
  orgId,
  nowMs,
}: {
  entry: ActivityEntry;
  orgId: string;
  nowMs: number;
}) {
  const roomId = entry.refs.roomId ?? null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-2.5 py-2">
      <span className="min-w-0 shrink-0 max-w-[9rem] truncate text-xs text-[var(--sparrow-muted)]">
        {entry.actor.displayName}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--sparrow-text)]">
        {entry.summary ?? ''}
      </span>
      {roomId && (
        <Link
          to={roomPath(orgId, roomId)}
          className="shrink-0 text-[11px] text-[var(--sparrow-accent)] hover:underline"
        >
          Open room
        </Link>
      )}
      <span className="shrink-0 text-[11px] text-[var(--sparrow-faint)]">
        {formatRelativeTime(entry.createdAt, nowMs)}
      </span>
    </div>
  );
}
