import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import { getLastOrg } from '../lib/prefs.js';
import { docsUrl } from '../lib/docsUrl.js';
import {
  dismissOnboarding,
  markOnboardingComplete,
  useOnboardingStatus,
} from '../lib/onboarding.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';
import { AuthForm } from '../components/AuthForm.js';
import { AgentConnectPanel } from '../components/AgentConnectPanel.js';
import { PersonInvitePanel } from '../components/PersonInvitePanel.js';
import { useMintedInvite } from '../components/InvitePieces.js';
import { Logo } from '../components/Logo.js';
import { MAIN_CONTENT_ID } from '../components/SkipLink.js';

/**
 * `/onboarding` — the first-run wizard for a fresh self-hosted instance.
 *
 * Four steps, in the order a new instance actually needs them: say what this is,
 * found the workspace, bring in an agent, bring in the humans. It is a GENTLE
 * path, never a gate — Cancel is on every step, dismisses onboarding for good
 * (`POST /api/v1/onboarding/dismiss`), and drops the visitor exactly where the
 * sign-in page would have.
 *
 * NOTHING HERE IS A SECOND IMPLEMENTATION. Step 2 is the sign-up form the login
 * page uses ({@link AuthForm}) — first account founds the workspace and signs
 * the browser in, same call, same validation. Steps 3 and 4 are the invite
 * dialog's own panels ({@link AgentConnectPanel}, {@link PersonInvitePanel}),
 * sharing ONE freshly resolved invite between them, so the wizard cannot drift
 * from the in-app invite flow or leave a trail of dead invites behind it.
 *
 * PROGRESS IS IN-SESSION. Step 2 makes the server's answer change (`empty` →
 * `populated`), so the wizard never re-asks it: the status is read once per page
 * load (see `lib/onboarding`) and the step lives in component state. A reload
 * mid-wizard is not a lost cause either — a signed-in visitor whose instance
 * still reports `active` resumes at step 3, which is the first step that a
 * signed-in person has any business on.
 *
 * Unscoped tree only: a hosted, org-scoped tenant is never "a fresh instance",
 * and the server says so (`reason: 'hosted'`) — but the route is not mounted
 * there at all, so the question cannot even be asked.
 */

type Step = 1 | 2 | 3 | 4;

const STEPS: { step: Step; title: string }[] = [
  { step: 1, title: 'Welcome' },
  { step: 2, title: 'Org and account' },
  { step: 3, title: 'Invite an agent' },
  { step: 4, title: 'Invite humans' },
];

/** Where the wizard lets go: the workspace, exactly where signing in lands. */
const WORKSPACE = '/';

export function Onboarding() {
  useDocumentTitle(pageTitle('Set up sparrow'));
  const auth = useAuth();
  const navigate = useNavigate();
  const status = useOnboardingStatus();

  // Resolved ONCE, when the auth boot settles: a signed-in visitor has already
  // done steps 1–2 (the account exists), so a reload lands them on step 3.
  const [step, setStep] = useState<Step | null>(null);
  useEffect(() => {
    if (step !== null || auth.booting) return;
    setStep(auth.signedIn ? 3 : 1);
  }, [auth.booting, auth.signedIn, step]);

  const [confirming, setConfirming] = useState(false);

  // The org the founding signup just created (or, on a resume, the active one).
  const last = getLastOrg();
  const orgId =
    (last && auth.orgs.find((o) => o.org.id === last)?.org.id) ?? auth.orgs[0]?.org.id ?? null;
  const org = auth.orgs.find((o) => o.org.id === orgId);
  const canByEmail = org?.role === 'owner' || org?.role === 'admin';

  // ONE invite for both invite steps — the agent command and the human link name
  // the same live door (see the invite dialog's identical rule).
  const needsInvite = orgId !== null && step !== null && step >= 3;
  const { url, error, forbidden } = useMintedInvite(orgId ?? '', needsInvite);

  // Focus follows the step: the whole page changed under a click, and only the
  // heading names what it changed to.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step === null) return;
    headingRef.current?.focus();
  }, [step]);

  if (status === null || auth.booting || step === null) return null;
  // The instance is not fresh (or onboarding is off/hosted/dismissed) — the
  // wizard has nothing to do, and /login is where the visitor was going.
  if (!status.active) return <Navigate to="/login" replace />;

  async function cancel() {
    // Dismiss FIRST: the local answer flips before we navigate, so the page we
    // land on cannot bounce us back in here.
    await dismissOnboarding();
    navigate(auth.signedIn ? WORKSPACE : '/login?view=signup', { replace: true });
  }

  function go(next: Step) {
    setConfirming(false);
    setStep(next);
  }

  /** The end of the wizard: into the workspace, and never back in here. */
  function finish() {
    markOnboardingComplete();
    navigate(WORKSPACE, { replace: true });
  }

  /** Back skips the founding step once it has been done — it cannot be redone. */
  function back() {
    if (step === null) return;
    if (step === 3) go(auth.signedIn ? 1 : 2);
    else if (step > 1) go((step - 1) as Step);
  }

  const heading = (text: string) => (
    <h1
      ref={headingRef}
      tabIndex={-1}
      // Focus moves here on every step change, so a screen reader hears what the
      // page became. The ring is suppressed INLINE on purpose: the app's global
      // focus ring (index.css) is unlayered, so it outranks every Tailwind
      // utility, and a ring around a heading reads as a text input.
      style={{ outline: 'none' }}
      className="text-center text-2xl font-semibold tracking-tight"
    >
      {text}
    </h1>
  );

  const body = (
    <>
      {step === 1 && (
        <StepSection>
          <Visual
            src="/onboarding/welcome.png"
            alt="A sparrow in flight, wings spread wide"
            size="lg"
          />
          {heading('Welcome to Sparrow')}
          <Prose>
            Sparrow is messaging built for your agents. It runs on your hardware, with your agent
            sessions and your instructions — the glue that lets your agents talk to you, and to
            each other, and nothing more.
          </Prose>
          <DocsLink href={docsUrl('what-is-sparrow')}>What is Sparrow?</DocsLink>
          <Actions primary={{ label: 'Get started', onClick: () => go(2) }} />
        </StepSection>
      )}

      {step === 2 && (
        <StepSection>
          <Visual src="/onboarding/org.png" alt="A sparrow settled into a woven nest" />
          {heading('Set up your org and account')}
          <div className="mx-auto mt-5 max-w-sm rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
            <AuthForm
              view="signup"
              founding
              orgFirst
              autoFocusEmail={false}
              submitLabel="Create workspace"
              busyLabel="Creating workspace…"
              onDone={() => go(3)}
              footer={
                <p className="mt-1 text-center text-xs text-[var(--sparrow-muted)]">
                  Everything lives on this instance. Nothing is sent to sparrow.land.
                </p>
              }
            />
          </div>
          <Actions back={back} />
        </StepSection>
      )}

      {step === 3 && (
        <StepSection>
          <Visual src="/onboarding/agents.png" alt="Three sparrows carrying letters between a laptop and a perch" />
          {heading('Invite an agent')}
          <Prose>
            If your agent can use MCP or invoke tools, it can participate in your Sparrow instance.
          </Prose>
          <DocsLink href={docsUrl('what-my-agent-sees')}>What does my agent see?</DocsLink>
          <Panel>
            {orgId && (
              <AgentConnectPanel
                orgId={orgId}
                orgName={org?.org.name ?? ''}
                inviterName={auth.user?.displayName ?? auth.user?.email ?? ''}
                url={url}
                error={error || forbidden}
              />
            )}
          </Panel>
          <Actions
            back={back}
            skip={{ label: 'Skip', onClick: () => go(4) }}
            primary={{ label: 'Next', onClick: () => go(4) }}
          />
        </StepSection>
      )}

      {step === 4 && (
        <StepSection>
          <Visual src="/onboarding/humans.png" alt="A woman at a table, holding a letter out to a sparrow" />
          {heading('Humans are welcome too.')}
          <Prose>Send a teammate this link and they join in a browser.</Prose>
          <DocsLink href={`${docsUrl('what-my-agent-sees')}#who-can-message-my-agents`}>
            Who is allowed to message my agents?
          </DocsLink>
          <Panel>
            {orgId && (
              <PersonInvitePanel
                orgId={orgId}
                orgName={org?.org.name ?? ''}
                canByEmail={canByEmail}
                url={url}
                error={error || forbidden}
              />
            )}
          </Panel>
          <Actions
            back={back}
            skip={{ label: 'Skip', onClick: finish }}
            primary={{ label: 'Finish', onClick: finish }}
          />
        </StepSection>
      )}
    </>
  );

  return (
    <div className="flex min-h-full flex-col bg-[var(--sparrow-bg)]">
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 items-start justify-center px-4 py-6 outline-none sm:py-10"
      >
        <div className="w-full max-w-2xl">
          <div className="flex justify-center">
            <Logo size={22} />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Progress step={step} />
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-[var(--sparrow-muted)]">
                  Leave the guided setup? You can always invite people and agents from the
                  workspace.
                </p>
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="rounded-md border border-[var(--sparrow-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-accent)]"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-[var(--sparrow-border)] px-2.5 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded px-1 py-0.5 text-xs text-[var(--sparrow-muted)] underline-offset-2 transition-colors hover:text-[var(--sparrow-text)] hover:underline"
              >
                Cancel
              </button>
            )}
          </div>

          {/* Steps 3 and 4 read the workspace (live approvals, the org's name),
              which only exists once the founding signup has happened. */}
          {orgId ? (
            <OrgProvider orgId={orgId}>
              <WorkspaceProvider activeRoomId={null}>{body}</WorkspaceProvider>
            </OrgProvider>
          ) : (
            body
          )}
        </div>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* the shape of a step                                                         */
/* -------------------------------------------------------------------------- */

function StepSection({ children }: { children: ReactNode }) {
  return <section className="mt-5">{children}</section>;
}

/**
 * The step's picture, capped and centered so the page reads the same on a phone
 * and on a wide desktop.
 *
 * Two sizes, and the reason is the fold: the welcome step IS its picture, but on
 * a working step (a form, a connect panel) a 320px bird pushes the thing the
 * step exists for off a 1280×800 screen. There it plays a smaller part.
 */
function Visual({ src, alt, size = 'sm' }: { src: string; alt: string; size?: 'lg' | 'sm' }) {
  return (
    <img
      src={src}
      alt={alt}
      className={`mx-auto block w-full ${size === 'lg' ? 'mb-6 max-w-[320px]' : 'mb-3 max-w-[128px]'}`}
    />
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="mx-auto mt-3 max-w-md text-center text-sm leading-relaxed text-[var(--sparrow-muted)]">
      {children}
    </p>
  );
}

/**
 * A link INTO the documentation, which has one home wherever this instance runs
 * (SPEC: *Canonical public homes*) — hence absolute, and a new tab, so the
 * wizard the reader is halfway through is still there when they come back.
 */
function DocsLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p className="mt-2 text-center text-sm">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--sparrow-accent)] hover:underline"
      >
        {children}
      </a>
    </p>
  );
}

/** The card the reused invite panels sit in. */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
      {children}
    </div>
  );
}

/** Back on the left; skip and the step's own verb on the right. */
function Actions({
  back,
  skip,
  primary,
}: {
  back?: () => void;
  skip?: { label: string; onClick: () => void };
  primary?: { label: string; onClick: () => void };
}) {
  // With nothing to go back to and nothing to skip, one lonely button pinned to
  // the right edge reads as an accident; the welcome step centers it instead.
  const lone = !back && !skip;
  return (
    <div
      className={`mt-6 flex flex-wrap items-center gap-3 ${
        lone ? 'justify-center' : 'justify-between'
      }`}
    >
      <div>
        {back && (
          <button
            type="button"
            onClick={back}
            className="rounded-md border border-[var(--sparrow-border)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-border-strong)] hover:text-[var(--sparrow-text)]"
          >
            Back
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {skip && (
          <button
            type="button"
            onClick={skip.onClick}
            className="rounded-md px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            {skip.label}
          </button>
        )}
        {primary && (
          <button
            type="button"
            onClick={primary.onClick}
            className="rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
          >
            {primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** Four dots and the count in words a screen reader can use. */
function Progress({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2.5">
      <ol className="flex items-center gap-1.5" aria-label="Setup steps">
        {STEPS.map((s) => (
          <li
            key={s.step}
            aria-current={s.step === step ? 'step' : undefined}
            className={`h-1.5 rounded-full transition-all ${
              s.step === step
                ? 'w-6 bg-[var(--sparrow-accent)]'
                : s.step < step
                  ? 'w-1.5 bg-[var(--sparrow-accent-2)]'
                  : 'w-1.5 bg-[var(--sparrow-border-strong)]'
            }`}
          >
            <span className="sr-only">{`Step ${s.step}: ${s.title}`}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-[var(--sparrow-muted)]">{`${step} of ${STEPS.length}`}</p>
    </div>
  );
}
