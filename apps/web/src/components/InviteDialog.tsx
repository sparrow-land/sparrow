import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, ChevronLeft, ChevronRight, User } from 'lucide-react';
import type { EnrollmentSummary } from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../lib/client.js';
import { useWorkspace } from '../lib/workspace.js';
import { buildInviteBlob } from '../lib/inviteBlob.js';
import { INSTALL_COMMAND } from '../lib/docsUrl.js';
import { formatRelativeTime } from '../lib/time.js';
import { Modal } from './Modal.js';
import { Terminal } from './Terminal.js';
import { InviteByEmail } from './InviteByEmail.js';
import { LoopModeArt } from './LoopModeArt.js';

/**
 * THE invite dialog — one door, three entry points, one step at a time.
 *
 * The old pair (a human-only "By email / Invite link" dialog and a separate
 * agent-flavoured org modal) is gone: both audiences now start from the same
 * question and diverge into a step tuned for who is actually being invited.
 *
 *  - Header "Invite"      → {@link InviteStep} `who`    ("A person" / "An agent")
 *  - Humans section "+"   → `person`  (by-email form + a shareable link)
 *  - Agents section "+"   → `agent`   (harness vs. inline, then approvals)
 *
 * The entry point alone picks the step — the header button is the ONE door and
 * always asks `who`, however empty the org is. What an empty org changes is the
 * `agent` step's copy: with no agents yet it carries a first-agent lead-in,
 * whichever way the caller arrived. Only the AGENTS "+" opens on `agent`
 * without a `who` behind it, and only that open has no back chip.
 *
 * The classic invite (`POST /orgs/:id/invites`) is minted ONCE, lazily, the
 * first time a step needs a URL, and both agent variants share it — so the
 * harness command and the invitation blob always name the same invite, and a
 * user flipping between them does not leave a trail of dead invites.
 *
 * The `agent` step also CLOSES THE LOOP: pending enrollments arriving through
 * the caller's own invites (live, via the workspace's `/me/events` state) are
 * approved or denied right here — see {@link PendingApprovals}.
 */

export type InviteStep = 'who' | 'person' | 'agent';

/** How the agent will be driven — the one real choice on the `agent` step. */
type LoopMode = 'harness' | 'inline';

/** Which runner the harness spawns; only changes one flag on the command. */
type Runtime = 'claude' | 'codex' | 'gemini' | 'other';

const RUNTIMES: { id: Runtime; label: string; flag: string }[] = [
  { id: 'claude', label: 'Claude Code', flag: '' },
  { id: 'codex', label: 'Codex', flag: ' --codex' },
  { id: 'gemini', label: 'Gemini', flag: ' --gemini' },
  { id: 'other', label: 'Other', flag: " --exec '<your command>'" },
];

const eyebrowClass = 'text-xs uppercase tracking-wider text-[var(--sparrow-faint)]';
const helperClass = 'text-xs text-[var(--sparrow-muted)]';

export function InviteDialog({
  orgId,
  orgName,
  inviterName,
  canByEmail,
  hasAgents = true,
  initialStep = 'who',
  onClose,
  onInvited,
}: {
  orgId: string;
  orgName: string;
  /** Shown in the invitation blob as the person doing the inviting. */
  inviterName: string;
  /** Whether the caller may add a member directly (admins) — gates the email form. */
  canByEmail: boolean;
  /** Does the org already have at least one agent? Drives the first-agent open. */
  hasAgents?: boolean;
  initialStep?: InviteStep;
  onClose: () => void;
  onInvited?: () => void;
}) {
  const firstAgent = !hasAgents;
  // The entry point IS the step: the header's `who` is never skipped, or the one
  // door would strand a brand-new owner trying to invite a teammate on the agent
  // step. (The AGENTS "+" passes `agent` itself; it needs no short-cut here.)
  const [step, setStep] = useState<InviteStep>(initialStep);
  // Once the caller has SEEN the who step, back is always a real destination.
  const [sawWho, setSawWho] = useState(step === 'who');

  const org = orgName || 'your organization';
  const needsUrl = step !== 'who';
  const { url, error, forbidden } = useMintedInvite(orgId, needsUrl);

  // The AGENTS "+" open of a first-agent org has no `who` behind it; every other
  // step does — including the agent step reached from `who` in that same org, so
  // a lead-in and a back chip happily coexist.
  const showBack = step !== 'who' && (sawWho || !(firstAgent && step === 'agent'));

  const title =
    step === 'who' ? 'Invite' : step === 'person' ? 'Invite a person' : 'Invite an agent';

  function goto(next: InviteStep) {
    if (next === 'who') setSawWho(true);
    setStep(next);
  }

  return (
    <Modal
      labelledById="invite-dialog-title"
      onClose={onClose}
      title={
        showBack ? (
          <span className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => goto('who')}
              className="-ml-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-xs font-medium text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
            >
              <ChevronLeft size={13} aria-hidden="true" />
              Back
            </button>
            <span
              aria-hidden="true"
              className="h-3.5 w-px bg-[var(--sparrow-border-strong)]"
            />
            <span>{title}</span>
          </span>
        ) : (
          title
        )
      }
    >
      {step === 'who' && <WhoStep orgName={org} onPick={goto} />}
      {/* A 403 is the org's INVITE POLICY answering, not a hiccup: the step is
          replaced by the rule in plain words. Nothing was created, so nothing
          downstream of an invite (captions, approvals) may be rendered. */}
      {step !== 'who' && forbidden && <PolicyBlocked audience={step} />}
      {step === 'person' && !forbidden && (
        <PersonStep
          orgId={orgId}
          orgName={org}
          canByEmail={canByEmail}
          url={url}
          error={error}
          onInvited={onInvited}
        />
      )}
      {step === 'agent' && !forbidden && (
        <AgentStep
          orgId={orgId}
          orgName={org}
          inviterName={inviterName}
          url={url}
          error={error}
          firstAgent={firstAgent}
        />
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* the invite itself                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Mint the org's classic invite once, the first time a step actually needs a
 * URL. Re-renders (mode flips, runtime flips, step changes) never mint again;
 * the token appears exactly once, inside `url`.
 */
function useMintedInvite(orgId: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  /** The mint was refused by org policy (`invites.who: 'admins'`), not by luck. */
  const [forbidden, setForbidden] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.createInvite(orgId, {});
        if (!cancelled) setUrl(res.url);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, enabled]);

  return { url, error, forbidden };
}

/**
 * The org's invite policy, said out loud. Shown INSTEAD of a step whose invite
 * the server refused — never alongside a half-built command, an orphaned caption
 * or an approvals list waiting on an invite that was never created.
 */
function PolicyBlocked({ audience }: { audience: 'person' | 'agent' }) {
  return (
    <div>
      <p className="rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2.5 text-sm text-[var(--sparrow-text)]">
        {audience === 'agent'
          ? 'Only admins can invite agents in this organization.'
          : 'Only admins can invite people in this organization.'}
      </p>
      <p className={`mt-2 ${helperClass}`}>
        Ask an owner or admin to send the invite, or to change the policy in org
        admin.
      </p>
    </div>
  );
}

function MintError() {
  return (
    <p className="rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2.5 text-sm text-[var(--sparrow-danger)]">
      Could not create the invite. Close and try again.
    </p>
  );
}

/** The terminal's placeholder while the invite is still being minted. */
function TerminalSkeleton({ label }: { label: string }) {
  return (
    <div className="terminal" aria-hidden="true">
      <div className="terminal-bar">
        <span className="terminal-dot" style={{ background: '#e0555b' }} />
        <span className="terminal-dot" style={{ background: '#d3924b' }} />
        <span className="terminal-dot" style={{ background: '#5bb98b' }} />
        <span className="mono ml-1 text-xs text-[var(--sparrow-muted)]">{label}</span>
      </div>
      <pre className="terminal-body text-[var(--sparrow-faint)]">creating invite…</pre>
    </div>
  );
}

/** Terminal, mint-error, or skeleton — the three states of every code block here. */
function InviteTerminal({
  url,
  error,
  label,
  code,
  wrap = true,
}: {
  url: string | null;
  error: boolean;
  label: string;
  code: string;
  /**
   * Every block in this dialog carries an invite URL — bare, or as the tail of a
   * command — and an invite URL is long. Unwrapped, the tail sat behind a
   * horizontal scrollbar: invisible, and MISSING from a copy made by selecting
   * the text (issue #63). So these soft-wrap by default; the copy button is
   * still the exact route, and a wrapped command has never been the thing
   * anyone actually retypes.
   */
  wrap?: boolean;
}) {
  if (error) return <MintError />;
  if (!url) return <TerminalSkeleton label={label} />;
  return <Terminal code={code} label={label} wrap={wrap} />;
}

/* -------------------------------------------------------------------------- */
/* step: who                                                                   */
/* -------------------------------------------------------------------------- */

function WhoStep({ orgName, onPick }: { orgName: string; onPick: (s: InviteStep) => void }) {
  return (
    <div>
      <p className="text-sm text-[var(--sparrow-muted)]">Who are you inviting to {orgName}?</p>
      <div className="mt-3 flex flex-col gap-2">
        <ChoiceRow
          icon={<User size={16} aria-hidden="true" />}
          title="A person"
          detail="A teammate. They join in a browser."
          onClick={() => onPick('person')}
        />
        <ChoiceRow
          icon={<Bot size={16} aria-hidden="true" />}
          title="An agent"
          detail="Claude Code, Codex, Gemini, or your own."
          onClick={() => onPick('agent')}
        />
      </div>
    </div>
  );
}

function ChoiceRow({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-3 text-left transition-colors hover:border-[var(--sparrow-accent-2)]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] text-[var(--sparrow-accent)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[var(--sparrow-text)]">{title}</span>
        <span className="block text-xs text-[var(--sparrow-muted)]">{detail}</span>
      </span>
      <ChevronRight
        size={16}
        aria-hidden="true"
        className="shrink-0 text-[var(--sparrow-faint)] transition-colors group-hover:text-[var(--sparrow-accent)]"
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* step: person                                                                */
/* -------------------------------------------------------------------------- */

function PersonStep({
  orgId,
  orgName,
  canByEmail,
  url,
  error,
  onInvited,
}: {
  orgId: string;
  orgName: string;
  canByEmail: boolean;
  url: string | null;
  error: boolean;
  onInvited?: () => void;
}) {
  return (
    <div>
      {canByEmail && <InviteByEmail orgId={orgId} onInvited={onInvited} />}
      <div className={canByEmail ? 'mt-4 border-t border-[var(--sparrow-border)] pt-4' : ''}>
        <p className={eyebrowClass}>{canByEmail ? 'Or share a link' : 'Share a link'}</p>
        <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
          Anyone with this link can join {orgName}. Use email when you want to know who&rsquo;s
          coming.
        </p>
        <div className="mt-2">
          <InviteTerminal url={url} error={error} label="invite link" code={url ?? ''} />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* step: agent                                                                 */
/* -------------------------------------------------------------------------- */

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
    `sparrow harness${flag} \\`,
    `  --url ${url}`,
  ].join('\n');
}

function AgentStep({
  orgId,
  orgName,
  inviterName,
  url,
  error,
  firstAgent,
}: {
  orgId: string;
  orgName: string;
  inviterName: string;
  url: string | null;
  error: boolean;
  firstAgent: boolean;
}) {
  const [mode, setMode] = useState<LoopMode>('harness');
  const [runtime, setRuntime] = useState<Runtime>('claude');

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
            Options: <Flag>--model sonnet</Flag> picks a model, <Flag>--cwd ~/proj</Flag> sets the
            working folder.
          </p>
        </div>
      ) : (
        <div className="mt-4">
          <InviteTerminal url={url} error={error} label="invitation" code={code} wrap />
          <p className={`mt-2 ${helperClass}`}>
            Paste this into your agent. It fetches the URL, reads the onboarding doc, asks you for a
            name, and enrolls. Then approve it below.
          </p>
        </div>
      )}

      <PendingApprovals orgId={orgId} />
    </div>
  );
}

/** A flag rendered inline in helper prose, in the terminal's own voice. */
function Flag({ children }: { children: ReactNode }) {
  return <code className="mono text-[var(--sparrow-text)]">{children}</code>;
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
      <LoopModeArt mode={mode} size="card" className="mx-auto mb-2 w-full max-w-[200px]" />
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded px-3 py-1.5 font-medium transition-colors ${
        active
          ? 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-text)]'
          : 'text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* approvals                                                                   */
/* -------------------------------------------------------------------------- */

/** Per-row resolution the caller has driven from this dialog (persisted after the
 * row leaves the live list so the flip to approved/denied stays visible). */
type Resolution = 'approved' | 'denied';

/**
 * The live approvals list inside the invite dialog — the other half of the loop.
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

  // Hydrate the current pending list the moment the step opens; live
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
            // "via <how it enrolled> · <age>" when the enrollment carried a note;
            // otherwise the age alone — never an invented provenance.
            const age = formatRelativeTime(e.createdAt);
            const provenance = e.note ? `via ${e.note} · ${age}` : age;
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
