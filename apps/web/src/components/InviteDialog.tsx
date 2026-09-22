import { useState, type ReactNode } from 'react';
import { Bot, ChevronLeft, ChevronRight, User } from 'lucide-react';
import { Modal } from './Modal.js';
import { AgentConnectPanel } from './AgentConnectPanel.js';
import { PersonInvitePanel } from './PersonInvitePanel.js';
import { helperClass, useMintedInvite } from './InvitePieces.js';

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
 * The two steps' bodies are NOT written here: they are the shared
 * {@link PersonInvitePanel} and {@link AgentConnectPanel}, which the first-run
 * onboarding wizard (`/onboarding`) renders too. This file owns the dialog —
 * the door, the back chip, the policy refusal — and nothing else.
 *
 * The classic invite (`POST /orgs/:id/invites`) is resolved ONCE, lazily, the
 * first time a step needs a URL, and both agent variants share it — so the
 * harness command and the invitation blob always name the same invite, and a
 * user flipping between them does not leave a trail of dead invites. Across
 * OPENS it is reused rather than re-minted (see `ensureOrgInvite`): an invite is
 * a live door, and re-reading the instructions is not a reason to open another
 * one (issue #5).
 *
 * The `agent` step also CLOSES THE LOOP: pending enrollments arriving through
 * the caller's own invites (live, via the workspace's `/me/events` state) are
 * approved or denied right there — see the panel's approvals list.
 */

export type InviteStep = 'who' | 'person' | 'agent';

/** Re-exported for the surfaces that print the harness command. */
export { harnessCommand } from './AgentConnectPanel.js';

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
  // FROZEN for this open. Approving an agent right here makes the org's first
  // agent — and an intro panel that vanishes under the button you just clicked
  // (taking the header's shape with it) is the dialog re-laying itself out mid
  // gesture (issue #7). What the dialog opened as, it stays.
  const [firstAgent] = useState(!hasAgents);
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
        <PersonInvitePanel
          orgId={orgId}
          orgName={org}
          canByEmail={canByEmail}
          url={url}
          error={error}
          onInvited={onInvited}
        />
      )}
      {step === 'agent' && !forbidden && (
        <AgentConnectPanel
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
