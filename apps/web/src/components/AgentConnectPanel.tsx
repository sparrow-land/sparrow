import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import type { EnrollmentSummary } from '@sparrow-land/sdk/types';
import { api } from '../lib/client.js';
import { useWorkspace } from '../lib/workspace.js';
import { buildInviteBlob } from '../lib/inviteBlob.js';
import { INSTALL_COMMAND } from '../lib/docsUrl.js';
import { formatRelativeTime } from '../lib/time.js';
import {
  eyebrowClass,
  helperClass,
  Flag,
  InviteTerminal,
  LiveInviteNote,
  TabButton,
} from './InvitePieces.js';
// One home for what each runtime is and needs — shared with the invite LANDING
// PAGE, so the two surfaces cannot drift apart on it (see AgentRuntimes).
import {
  CodexInlineSteps,
  INLINE_RUNTIMES,
  RUNTIMES,
  RUNTIME_HINT,
  type InlineRuntime,
  type Runtime,
} from './AgentRuntimes.js';

/**
 * "How should the agent connect?" — the whole agent half of an invite, in one
 * component: the harness/inline choice, the runtime tabs, the copyable command
 * carrying THIS instance's live invite, and the approvals list that closes the
 * loop when the agent enrolls.
 *
 * Two surfaces render it and must never drift: the {@link InviteDialog}'s agent
 * step, and step 3 of the first-run onboarding wizard (`/onboarding`). The
 * invite itself is resolved by the HOST (see `useMintedInvite`) and handed down,
 * so a host with several panels — the wizard shows this one and then the person
 * one — hands out a single invite rather than a trail of dead ones.
 */

/** How the agent will be driven — the one real choice on this panel. */
type LoopMode = 'harness' | 'inline';

/**
 * The art on each mode card: who calls whom. The harness picture has sparrow
 * calling the agent's terminal; inline has the terminal calling sparrow — which
 * is the whole difference between the two modes, in one glance.
 */
const MODE_ART: Record<LoopMode, { src: string; alt: string }> = {
  harness: {
    src: '/onboarding/connect-harness.png',
    alt: 'A sparrow calling out to a desktop terminal',
  },
  inline: {
    src: '/onboarding/connect-inline.png',
    alt: 'A desktop terminal calling out to a sparrow',
  },
};

/**
 * The exact command the caller runs to stand a harness up against this invite.
 * The installer comes from its ONE home (SPEC: *Canonical public homes*), so
 * every reader is taught the same line; the invite URL is this instance's.
 */
export function harnessCommand(url: string, runtime: Runtime): string {
  const flag = RUNTIMES.find((r) => r.id === runtime)?.flag ?? '';
  return [
    '# on a machine that stays up',
    INSTALL_COMMAND,
    `sparrow harness${flag ? ` ${flag}` : ''} \\`,
    `  --url ${url}`,
  ].join('\n');
}

export function AgentConnectPanel({
  orgId,
  orgName,
  inviterName,
  url,
  error,
  firstAgent = false,
}: {
  orgId: string;
  orgName: string;
  /** Shown in the invitation blob as the person doing the inviting. */
  inviterName: string;
  /** The org's live invite URL, or null while it is still being resolved. */
  url: string | null;
  /** The mint failed — the code block says so instead of showing half a command. */
  error: boolean;
  /** Lead in with "Your first agent." (the dialog's empty-org open). */
  firstAgent?: boolean;
}) {
  const [mode, setMode] = useState<LoopMode>('harness');
  const [runtime, setRuntime] = useState<Runtime>('claude');
  // Inline keeps its OWN pick: the two lists are different (the skill installs
  // for two providers; the harness execs anything), so one shared piece of state
  // would answer a question the other mode never asked.
  const [inlineRuntime, setInlineRuntime] = useState<InlineRuntime>('claude');

  const code =
    url === null
      ? ''
      : mode === 'harness'
        ? harnessCommand(url, runtime)
        : buildInviteBlob({ inviterName, orgName, url });

  return (
    <div>
      {firstAgent && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2.5">
          <Bot size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--sparrow-accent)]" />
          <p className="text-xs text-[var(--sparrow-muted)]">
            <strong className="font-semibold text-[var(--sparrow-text)]">Your first agent.</strong>{' '}
            Two ways to bring one in. Pick one; you can always add the other later.
          </p>
        </div>
      )}

      <p className="text-sm text-[var(--sparrow-muted)]">How should the agent connect?</p>

      <div
        role="radiogroup"
        aria-label="How the agent connects"
        className="mt-3 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2"
      >
        <ModeCard
          mode="harness"
          title="Harness"
          pill="Needs the CLI"
          detail="Most reliable. Sparrow's CLI runs the loop and calls your agent for every message."
          selected={mode === 'harness'}
          onSelect={() => setMode('harness')}
        />
        <ModeCard
          mode="inline"
          title="Inline"
          pill="No install"
          detail="Quickest. Paste the link into an agent you already have open. The agent runs the loop and checks Sparrow when it remembers to."
          selected={mode === 'inline'}
          onSelect={() => setMode('inline')}
        />
      </div>

      {mode === 'harness' ? (
        <div className="mt-4">
          <div
            role="tablist"
            aria-label="Agent runtime"
            className="inline-flex flex-wrap rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] p-0.5 text-xs"
          >
            {RUNTIMES.map((r) => (
              <TabButton
                key={r.id}
                active={runtime === r.id}
                onClick={() => setRuntime(r.id)}
              >
                {r.label}
              </TabButton>
            ))}
          </div>
          <div className="mt-3">
            <InviteTerminal url={url} error={error} label="sparrow harness" code={code} />
          </div>
          <p className={`mt-2 ${helperClass}`}>
            Installs the CLI, enrolls the agent, and keeps it online. Then approve it below.
          </p>
          <p className={`mt-1 ${helperClass}`}>
            Options:{' '}
            {RUNTIME_HINT[runtime] && (
              <>
                <Flag>{RUNTIME_HINT[runtime]!.flag}</Flag> {RUNTIME_HINT[runtime]!.what},{' '}
              </>
            )}
            <Flag>--cwd ~/proj</Flag> sets the working folder.
          </p>
        </div>
      ) : (
        <div className="mt-4">
          {/* Which agent is open on the other side decides what comes AFTER the
              paste: on Codex the skill needs a flag and two trust steps only a
              human can do. Same picker shape as the harness branch above. */}
          <div
            role="tablist"
            aria-label="Inline agent runtime"
            className="inline-flex flex-wrap rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] p-0.5 text-xs"
          >
            {INLINE_RUNTIMES.map((r) => (
              <TabButton
                key={r.id}
                active={inlineRuntime === r.id}
                onClick={() => setInlineRuntime(r.id)}
              >
                {r.label}
              </TabButton>
            ))}
          </div>
          <div className="mt-3">
            <InviteTerminal url={url} error={error} label="invitation" code={code} wrap />
          </div>
          <p className={`mt-2 ${helperClass}`}>
            Paste this into your agent. It fetches the URL, reads the onboarding doc, asks you for a
            name, and enrolls. Then approve it below.
          </p>
          {inlineRuntime === 'codex' && (
            <div className="mt-3 border-t border-[var(--sparrow-border)] pt-3">
              <p className={eyebrowClass}>Then, on Codex</p>
              <CodexInlineSteps className={`mt-1.5 ${helperClass}`} />
            </div>
          )}
        </div>
      )}

      {url && <LiveInviteNote orgName={orgName} />}

      <PendingApprovals orgId={orgId} />
    </div>
  );
}

/**
 * One of the two loop modes: the art (who holds the loop), the name, a NEUTRAL
 * capability pill (never "recommended" — the trade-off is the user's to make),
 * and the one-line trade-off itself.
 */
function ModeCard({
  mode,
  title,
  pill,
  detail,
  selected,
  onSelect,
}: {
  mode: LoopMode;
  title: string;
  pill: string;
  detail: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex flex-col rounded-lg border p-3 text-left transition-colors ${
        selected
          ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-accent-soft)]'
          : 'border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] hover:border-[var(--sparrow-border-strong)]'
      }`}
    >
      <img
        src={MODE_ART[mode].src}
        alt={MODE_ART[mode].alt}
        className="mx-auto mb-2 block w-full max-w-[200px]"
      />
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          aria-hidden="true"
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
            selected ? 'border-[var(--sparrow-accent)]' : 'border-[var(--sparrow-border-strong)]'
          }`}
        >
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-[var(--sparrow-accent)]" />}
        </span>
        <span className="text-sm font-semibold text-[var(--sparrow-text)]">{title}</span>
        <span className="whitespace-nowrap rounded border border-[var(--sparrow-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--sparrow-muted)]">
          {pill}
        </span>
      </span>
      <span className="mt-1.5 text-xs leading-relaxed text-[var(--sparrow-muted)]">{detail}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* approvals                                                                   */
/* -------------------------------------------------------------------------- */

/** Per-row resolution the caller has driven from this panel (persisted after the
 * row leaves the live list so the flip to approved/denied stays visible). */
type Resolution = 'approved' | 'denied';

/**
 * The live approvals list under the connect panel — the other half of the loop.
 * Reads the workspace's pending enrollments (already scoped to the caller's own
 * invites for this org, hydrated on open and kept fresh by `/me/events`) and
 * lets each be approved or denied in place. Once resolved here, the row is KEPT
 * — with its outcome — even after the live list drops it, so the caller sees the
 * result without the row vanishing under their cursor.
 */
function PendingApprovals({ orgId }: { orgId: string }) {
  const { enrollments, reloadApprovals } = useWorkspace();
  const [busy, setBusy] = useState<Record<string, Resolution>>({});
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  const [errored, setErrored] = useState<Record<string, string>>({});
  // Every enrollment we've ever shown, so resolved rows survive leaving the list.
  const seen = useRef<Map<string, EnrollmentSummary>>(new Map());
  for (const e of enrollments) seen.current.set(e.id, e);

  // Hydrate the current pending list the moment the panel opens; live
  // `enrollment.requested` / `enrollment.resolved` events keep it fresh after.
  useEffect(() => {
    void reloadApprovals();
  }, [reloadApprovals]);

  const ids = new Set<string>(enrollments.map((e) => e.id));
  for (const id of Object.keys(resolved)) ids.add(id);
  const rows = [...ids]
    .map((id) => seen.current.get(id))
    .filter((e): e is EnrollmentSummary => e !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const act = async (id: string, kind: Resolution) => {
    setBusy((b) => ({ ...b, [id]: kind }));
    setErrored((e) => {
      const { [id]: _drop, ...rest } = e;
      return rest;
    });
    try {
      if (kind === 'approved') await api.approveEnrollment(orgId, id);
      else await api.denyEnrollment(orgId, id);
      setResolved((r) => ({ ...r, [id]: kind }));
      void reloadApprovals();
    } catch {
      setErrored((e) => ({ ...e, [id]: `Could not ${kind === 'approved' ? 'approve' : 'deny'}.` }));
    } finally {
      setBusy((b) => {
        const { [id]: _drop, ...rest } = b;
        return rest;
      });
    }
  };

  return (
    <div className="mt-4 border-t border-[var(--sparrow-border)] pt-4">
      <p className={eyebrowClass}>Approvals</p>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-xs text-[var(--sparrow-faint)]">
          Waiting for an agent to enroll with this invite… When one does, it shows up here for you
          to approve.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((e) => {
            const name =
              e.kind === 'agent'
                ? (e.proposedName ?? 'agent')
                : (e.displayName ?? e.email ?? 'person');
            // The note is free text the requester typed — quote it AS a note.
            // "via <note>" claimed a provenance nobody ever established (issue
            // #7); with no note, the age stands alone.
            const age = formatRelativeTime(e.createdAt);
            const provenance = e.note ? `note: ${e.note} · ${age}` : age;
            const outcome = resolved[e.id];
            const pending = busy[e.id];
            const err = errored[e.id];
            return (
              <li
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-[var(--sparrow-text)]">{name}</span>
                    <span className="shrink-0 rounded border border-[var(--sparrow-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--sparrow-muted)]">
                      {e.kind}
                    </span>
                  </div>
                  {provenance && (
                    <p className="mt-0.5 truncate text-xs text-[var(--sparrow-muted)]">
                      {provenance}
                    </p>
                  )}
                  {err && <p className="mt-0.5 text-xs text-[var(--sparrow-danger)]">{err}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {outcome ? (
                    <span
                      className={`text-xs font-medium ${
                        outcome === 'approved'
                          ? 'text-[var(--sparrow-good)]'
                          : 'text-[var(--sparrow-muted)]'
                      }`}
                    >
                      {outcome === 'approved' ? 'Approved' : 'Denied'}
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={pending !== undefined}
                        onClick={() => void act(e.id, 'approved')}
                        className="rounded-md border border-[var(--sparrow-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-good)] hover:text-[var(--sparrow-good)] disabled:opacity-50"
                      >
                        {pending === 'approved' ? 'Approving…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== undefined}
                        onClick={() => void act(e.id, 'denied')}
                        className="rounded-md border border-[var(--sparrow-border)] px-2.5 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
                      >
                        {pending === 'denied' ? 'Denying…' : 'Deny'}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
