import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ActivityEntry, EmailDisposition } from '@sparrow/common-types';
import { EmailCard } from '../../components/email/EmailCard.js';
import { DispositionBadge } from '../../components/email/EmailBits.js';
import { MediumGlyph, MediumMark, infoBoxToneStyle } from '../../components/MediumGlyph.js';
import { dispositionBadge, headFromEntry } from '../../lib/email.js';
import { agentEmailThreadPath } from '../../lib/ids.js';
import { formatRelativeTime } from '../../lib/time.js';
import type { RenderRow } from '../../lib/activity.js';

/**
 * The NON-CHAT rows of a conversation's activity stream: one email card, a
 * collapsed same-thread run, and the muted divider a run of rejections becomes
 * (SPEC v4 → *Web UI → the conversation view is an activity stream →
 * Collapsing rules*). Every collapse is expandable and none of them hides state
 * the viewer must act on — a quarantined or held entry never reaches this file
 * as anything but its own card.
 *
 * Expansion is per entry and NOT persisted, so it lives as local state on the
 * row rather than in the surrounding pane.
 */

/** Where a pending card sends a viewer who may act on it. */
const APPROVALS_PATH = '/me/approvals';

/** A live override of an entry's derived disposition (`email.resolved`). */
export type DispositionOf = (entry: ActivityEntry) => EmailDisposition | null;

interface RowContext {
  orgId: string;
  /** The DM counterpart agent — email is anchored to an agent, not a room. */
  agentId: string;
  dispositionOf?: DispositionOf;
  nowMs: number;
}

/** One entry's collapsed card, expandable in place to the full email view. */
export function EmailEntryCard({
  entry,
  orgId,
  agentId,
  dispositionOf,
  nowMs,
}: RowContext & { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false);
  const head = headFromEntry(entry);
  // The live disposition rides ALONGSIDE the head, not merged into it: the card
  // needs both to tell "was pending, now denied" (gray + "Denied") from an
  // ordinary rejection.
  return (
    <EmailCard
      orgId={orgId}
      head={head}
      disposition={dispositionOf?.(entry) ?? null}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      threadHref={head.threadId ? agentEmailThreadPath(orgId, agentId, head.threadId) : null}
      reviewHref={APPROVALS_PATH}
      nowMs={nowMs}
    />
  );
}

/**
 * A run of 3+ consecutive entries in one email thread, as a single summary row:
 * "4 messages in *Re: deploy plan*" plus the newest entry's snippet and
 * disposition badge. Expanding reveals the individual cards in place.
 */
function ThreadRunRow({ row, ...ctx }: RowContext & { row: Extract<RenderRow, { kind: 'thread-run' }> }) {
  const [open, setOpen] = useState(false);
  const newest = headFromEntry(row.newest);
  const badge = dispositionBadge(ctx.dispositionOf?.(row.newest) ?? newest.disposition);
  const count = row.entries.length;
  return (
    <div className="flex flex-col gap-2">
      {/* An email-family box: the Tinted Etch container in the email tone, at
          the email FLOOR density (py-1.5 — the badge needs its air), never the
          hint compact. The old dashed hairline is gone with every other info-
          box border; the chevron + count already say "this is a fold". */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={infoBoxToneStyle('email')}
        className="info-box flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-[var(--sparrow-faint)]" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-[var(--sparrow-faint)]" />
        )}
        {/* A collapsed run is a non-chat box too — it carries the same mark as
            the cards it opens into, so the stream's registers stay legible
            whether a thread is folded or not. */}
        <MediumGlyph medium="email" />
        <span className="shrink-0 text-xs text-[var(--sparrow-text)]">
          {count} message{count === 1 ? '' : 's'} in
        </span>
        <em className="min-w-0 truncate text-xs text-[var(--sparrow-text)]">{row.subject}</em>
        {newest.snippet && (
          <span aria-hidden="true" className="hidden min-w-0 flex-1 truncate text-[11px] text-[var(--sparrow-muted)] sm:inline">
            {newest.snippet}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10.5px] text-[var(--sparrow-faint)]">
          {formatRelativeTime(newest.createdAt, ctx.nowMs)}
        </span>
        {badge && <DispositionBadge label={badge} />}
      </button>
      {open && (
        <div className="flex flex-col gap-2 pl-4">
          {row.entries.map((entry) => (
            <EmailEntryCard key={entry.id} entry={entry} {...ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Consecutive rejections, as one muted divider. Rejected mail is a security
 * record, not a conversation — it never occupies the stream by default, and is
 * never silently dropped either.
 */
function RejectedRunRow({ row, ...ctx }: RowContext & { row: Extract<RenderRow, { kind: 'rejected-run' }> }) {
  const [open, setOpen] = useState(false);
  const count = row.entries.length;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 px-1 py-0.5 text-left text-xs text-[var(--sparrow-faint)]"
      >
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--sparrow-border)]" />
        <span className="shrink-0">
          {count} message{count === 1 ? '' : 's'} rejected
        </span>
        {open ? (
          <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" className="shrink-0" />
        )}
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--sparrow-border)]" />
      </button>
      {open && (
        <div className="flex flex-col gap-2 opacity-70">
          {row.entries.map((entry) => (
            <EmailEntryCard key={entry.id} entry={entry} {...ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A delivered hint, as one quiet INFO BOX: the system taught the agent
 * something, and the owner gets to see the lesson. The collapsed row is the
 * OWNER'S framing — the trigger's server-side `ownerLabel`, carried as the
 * entry summary ("Sparrow hinted the agent to …") — never the agent-directed
 * imperative. When the entry carries its `hint` payload, the box expands in
 * place (the email card's exact affordance: click the row, `aria-expanded`,
 * hairline-divided body) to reveal the VERBATIM text conveyed to the agent,
 * plus the trigger id. Entries that predate the payload have nothing hidden,
 * so they render without any expand affordance.
 */
export function HintEntryCard({ entry, nowMs }: { entry: ActivityEntry; nowMs: number }) {
  const [expanded, setExpanded] = useState(false);
  const verbatim = entry.hint ?? null;

  // The hint box takes the full compact density (~28px rows): the Tinted Etch
  // container in the hint tone, type one notch down, tight padding. Only the
  // sentence and time shrink — the type mark's label holds its size (identity
  // does not compact with density).
  const headContent = (
    <>
      <MediumGlyph medium={entry.medium} />
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--sparrow-muted)]">
        {entry.summary ?? ''}
      </span>
      <span className="ml-auto shrink-0 text-[10.5px] text-[var(--sparrow-faint)]">
        {formatRelativeTime(entry.createdAt, nowMs)}
      </span>
    </>
  );

  if (!verbatim) {
    return (
      <div
        style={infoBoxToneStyle(entry.medium)}
        className="info-box flex min-w-0 items-center gap-[7px] rounded-lg px-2 py-[5px]"
      >
        {headContent}
      </div>
    );
  }

  return (
    <div style={infoBoxToneStyle(entry.medium)} className="info-box rounded-lg">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-[7px] px-2 py-[5px] text-left"
      >
        {headContent}
      </button>
      {expanded && (
        <div className="flex flex-col gap-2.5 border-t border-[var(--sparrow-border)] px-3 py-3">
          <MediumMark medium={entry.medium} />
          <div className="flex flex-col gap-1">
            {/* The verbatim payload, attributed: the owner sees exactly what
                the system said to their agent, in the agent's register. */}
            <span className="text-[10px] uppercase tracking-wider text-[var(--sparrow-faint)]">
              What sparrow told the agent
            </span>
            <p className="whitespace-pre-wrap text-sm text-[var(--sparrow-text)]">
              {verbatim.text}
            </p>
          </div>
          <span className="mono self-start text-[11px] text-[var(--sparrow-faint)]">
            {verbatim.id}
          </span>
        </div>
      )}
    </div>
  );
}

/** Dispatch one non-chat {@link RenderRow} to its row component. */
export function ActivityRow({ row, ...ctx }: RowContext & { row: Exclude<RenderRow, { kind: 'chat' }> }) {
  if (row.kind === 'email') return <EmailEntryCard entry={row.entry} {...ctx} />;
  if (row.kind === 'hint') return <HintEntryCard entry={row.entry} nowMs={ctx.nowMs} />;
  if (row.kind === 'thread-run') return <ThreadRunRow row={row} {...ctx} />;
  return <RejectedRunRow row={row} {...ctx} />;
}
