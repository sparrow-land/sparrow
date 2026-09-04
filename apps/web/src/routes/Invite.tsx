import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@sparrow/client';
import type { InviteInfoResponse, OrgSummary } from '@sparrow/common-types';
import { useAuth } from '../lib/auth.js';
import { useAutoSso } from '../lib/auto-sso.js';
import { api } from '../lib/client.js';
import { orgPath } from '../lib/ids.js';
import { serverOrigin } from '../lib/origin.js';
import { INSTALL_COMMAND } from '../lib/docsUrl.js';
import { Logo } from '../components/Logo.js';
import { LoopModeArt } from '../components/LoopModeArt.js';
// The dialog is the canonical picker; the landing page shows the same hints so
// the two surfaces cannot drift apart on what each runtime's options are.
import { RUNTIME_HINT } from '../components/InviteDialog.js';
import { Terminal } from '../components/Terminal.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { MAIN_CONTENT_ID } from '../components/SkipLink.js';
import { SiteFooter } from '../components/SiteFooter.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/**
 * The invite landing page (`/invite/:token`) — the browser rendering of the
 * invite URL (agents fetching the same URL with a non-HTML `Accept` get the
 * markdown onboarding doc instead). The human hero (org name, inviter, agent
 * policy) comes from `GET /invite/:token/info` (`api.inviteInfo`), whose failure
 * modes are distinct and are shown as such, so the visitor knows what happened:
 *  - `404` (unknown token) → "This invite isn't valid".
 *  - `410` `gone` (revoked or expired) → "This invite is no longer valid", with
 *    the SERVER's message rendered verbatim as the body — revoked and expired
 *    read differently and the API stays the single source of that wording.
 *  - anything else (network failure, 5xx) → a neutral "We couldn't load this
 *    invite"; we never claim the invite is bad when we simply couldn't ask.
 * The Agent tab still shows the exact markdown onboarding doc verbatim (fetched
 * with `Accept: text/markdown`).
 *
 * A "Join as a person" / "Connect an agent" segmented toggle (person default)
 * splits the two audiences:
 *  - PERSON: sign in (if needed), then a single Join button (no note — the wire
 *    still accepts `note?` for CLI/API callers). A valid invite IS the approval,
 *    so a signed-in human is admitted immediately (`member`). The `pending`/poll
 *    path is kept only as a defensive fallback (the API never returns it here).
 *  - AGENT: the two ways to connect an agent, as equal-weight cards — HARNESS
 *    (`sparrow harness --url …`: sparrow's CLI holds the loop and calls the
 *    agent for every message) first, then INLINE (paste the URL into an agent
 *    that is already open; the agent holds the loop). The markdown onboarding
 *    doc an inline agent actually reads is tucked behind a disclosure.
 */
export function Invite() {
  const { token = '' } = useParams<{ token: string }>();

  const [load, setLoad] = useState<LoadState>('loading');
  const [loadMessage, setLoadMessage] = useState('');
  const [info, setInfo] = useState<InviteInfoResponse | null>(null);
  const [doc, setDoc] = useState('');
  const [tab, setTab] = useState<Audience>('person');

  // Named by the org once the token resolves; a plain "Invitation" while the
  // info call is in flight (and for a dead token, which names no org).
  useDocumentTitle(pageTitle(info ? `Join ${info.org.name}` : 'Invitation'));

  // The info endpoint is authoritative for validity + the hero. 404 = unknown
  // token, 410 = revoked or expired (the server's message says which), anything
  // else = we couldn't reach the server, which says nothing about the invite.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.inviteInfo(token);
        if (cancelled) return;
        setInfo(res);
        setLoad('ok');
      } catch (err) {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        setLoadMessage(err instanceof ApiError ? err.message.trim() : '');
        if (status === 410) setLoad('gone');
        else if (status === 404) setLoad('not-found');
        else setLoad('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The markdown onboarding doc (Agent tab), fetched separately and best-effort.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/invite/${encodeURIComponent(token)}`, {
          headers: { Accept: 'text/markdown' },
        });
        const text = await res.text();
        if (!cancelled && res.ok) setDoc(text);
      } catch {
        /* Agent tab just shows an empty block on failure; info gates validity. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 items-start justify-center px-4 py-12 sm:py-20 outline-none"
      >
        <div className={`w-full ${tab === 'agent' && load === 'ok' ? 'max-w-3xl' : 'max-w-xl'}`}>
          {load === 'loading' && <LoadingCard />}
          {load !== 'loading' && load !== 'ok' && (
            <DeadInviteCard state={load} message={loadMessage} />
          )}
          {load === 'ok' && info && (
            <>
              <div className="flex justify-center">
                <Logo size={28} />
              </div>
              <h1 className="mt-5 text-center text-xl font-semibold tracking-tight">
                Join {info.org.name}
              </h1>
              {/* NAME only. The invite URL is a bearer token — whoever holds
                  the link sees this page, and the inviter's email address is
                  not theirs to hand out. */}
              {info.inviter?.displayName?.trim() && (
                <p className="mt-1 text-center text-sm text-[var(--sparrow-muted)]">
                  Invited by {info.inviter.displayName}
                </p>
              )}
              <p className="mx-auto mt-3 max-w-md text-center text-sm text-[var(--sparrow-muted)]">
                sparrow is a shared workspace of message rooms for people and their AI agents. This
                invite is one door for both.
              </p>

              <div className="mt-6 flex justify-center">
                <AudienceToggle tab={tab} onChange={setTab} />
              </div>

              <div className="mt-6">
                {tab === 'person' ? (
                  <>
                    <HumanPanel token={token} />
                    <p className="mt-4 text-center text-sm text-[var(--sparrow-muted)]">
                      Here to connect an AI agent instead? Switch to{' '}
                      <span className="text-[var(--sparrow-text)]">Connect an agent</span> above.
                    </p>
                  </>
                ) : (
                  <AgentPanel
                    token={token}
                    doc={doc}
                    orgName={info.org.name}
                    agentPolicy={info.agentPolicy}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Audience toggle
 * ------------------------------------------------------------------ */

type Audience = 'person' | 'agent';

const AUDIENCE_LABEL: Record<Audience, string> = {
  person: 'Join as a person',
  agent: 'Connect an agent',
};

function AudienceToggle({ tab, onChange }: { tab: Audience; onChange: (t: Audience) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Who is this invite for?"
      className="inline-flex rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] p-0.5 text-sm"
    >
      {(['person', 'agent'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => onChange(t)}
          className={`rounded px-4 py-1.5 font-medium transition-colors ${
            tab === t
              ? 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-text)]'
              : 'text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
          }`}
        >
          {AUDIENCE_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Human panel
 * ------------------------------------------------------------------ */

type HumanPhase = 'form' | 'submitting' | 'pending' | 'member' | 'denied';

function HumanPanel({ token }: { token: string }) {
  const auth = useAuth();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<HumanPhase>('form');
  const [error, setError] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const retryRef = useRef(5);

  // Most link holders have never seen sparrow, so the primary door is the
  // create-account view (`?view=signup`); the sign-in door sits under it for the
  // minority who already have an account. Both return to this invite.
  const back = encodeURIComponent(`/invite/${token}`);
  const signupUrl = `/login?view=signup&next=${back}`;
  const signinUrl = `/login?next=${back}`;

  // Invitees bounce silently through a primary oauth provider when signed out
  // (see useAutoSso). The loop-guard is keyed by the invite token so it never
  // collides with the login page's own auto-SSO marker.
  const willAutoRedirect = useAutoSso({
    guardKey: `sparrow.invite.sso.${token}`,
    next: `/invite/${token}`,
  });

  const { refreshOrgs } = auth;

  const requestJoin = useCallback(async () => {
    setPhase('submitting');
    setError(null);
    try {
      const res = await api.enrollHuman(token, {});
      if (res.status === 'member') {
        // The membership is real server-side, but `auth.orgs` was fetched at
        // boot and still says otherwise — and `/org/:orgId` bounces non-members
        // to `/`, which sends an org-less user on to "Create your organization".
        // Re-ask BEFORE the success card (and its "Go to <org>" link) exists, so
        // the destination guard passes on the first click, without a reload.
        await refreshOrgs();
        setOrg(res.org);
        setPhase('member');
      } else {
        setEnrollmentId(res.enrollment.id);
        setPhase('pending');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your request.');
      setPhase('form');
    }
  }, [token, refreshOrgs]);

  // While pending, poll the enrollment (honoring `retryAfterSeconds`) until it
  // resolves: approved → refresh orgs and enter the org; denied → refusal state.
  useEffect(() => {
    if (phase !== 'pending' || !enrollmentId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const res = await api.pollEnrollment(token, enrollmentId!);
        if (cancelled) return;
        if (res.status === 'pending') {
          retryRef.current = res.retryAfterSeconds || 5;
          timer = setTimeout(tick, retryRef.current * 1000);
        } else if (res.status === 'approved' && 'org' in res) {
          await auth.refreshOrgs();
          if (!cancelled) navigate(orgPath(res.org.id));
        } else {
          setPhase('denied');
        }
      } catch {
        if (cancelled) return;
        // Transient error — keep waiting rather than tearing the calm state down.
        timer = setTimeout(tick, retryRef.current * 1000);
      }
    }

    timer = setTimeout(tick, retryRef.current * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, enrollmentId, token, auth, navigate]);

  // Signed out with a primary SSO provider → we're bouncing them through it now.
  if (!auth.signedIn && willAutoRedirect) {
    return (
      <Card>
        <p className="text-sm text-[var(--sparrow-muted)]">Taking you to sign in…</p>
      </Card>
    );
  }

  // Signed out → send them through login and back here.
  if (!auth.signedIn) {
    return (
      <Card>
        <p className="text-sm text-[var(--sparrow-muted)]">
          Create your sparrow account to join. We&apos;ll bring you right back to this invite.
        </p>
        <Link
          to={signupUrl}
          className="mt-4 block rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-center text-sm font-semibold text-black transition-opacity hover:opacity-90"
        >
          Create an account to join
        </Link>
        <p className="mt-3 text-center text-sm text-[var(--sparrow-muted)]">
          Already have one?{' '}
          <Link to={signinUrl} className="text-[var(--sparrow-accent)] hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    );
  }

  if (phase === 'member' && org) {
    return (
      <Card>
        <h2 className="text-lg font-semibold text-[var(--sparrow-good)]">You&apos;re in</h2>
        <p className="mt-1 text-sm text-[var(--sparrow-muted)]">
          You&apos;re now a member of {org.name}.
        </p>
        <Link
          to={orgPath(org.id)}
          className="mt-4 block rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-center text-sm font-semibold text-black transition-opacity hover:opacity-90"
        >
          Go to {org.name}
        </Link>
      </Card>
    );
  }

  if (phase === 'pending') {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <Logo size={20} markOnly className="sparrow-mark" />
          <h2 className="text-lg font-semibold">Waiting for approval</h2>
        </div>
        <p className="mt-2 text-sm text-[var(--sparrow-muted)]">
          Your request was sent. An approver reviews new members — this can take a few minutes.
          Keep this page open; you&apos;ll be brought into the org automatically once approved.
        </p>
      </Card>
    );
  }

  if (phase === 'denied') {
    return (
      <Card>
        <h2 className="text-lg font-semibold">Request not approved</h2>
        <p className="mt-2 text-sm text-[var(--sparrow-muted)]">
          This request wasn&apos;t approved. If you think that&apos;s a mistake, reach out to
          whoever shared the invite with you.
        </p>
      </Card>
    );
  }

  // phase: form | submitting
  const busy = phase === 'submitting';
  return (
    <Card>
      <p className="text-sm text-[var(--sparrow-muted)]">
        This invite lets you in right away — join and you&apos;re a member of the workspace
        immediately.
      </p>
      {error && <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p>}
      <button
        type="button"
        onClick={() => void requestJoin()}
        disabled={busy}
        className="mt-4 w-full rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Joining…' : 'Join workspace'}
      </button>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Agent panel
 * ------------------------------------------------------------------ */

/** The agent runner the harness spawns — the picker only rewrites one flag. */
type Runtime = 'claude' | 'codex' | 'gemini' | 'other';

const RUNTIMES: [Runtime, string][] = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['gemini', 'Gemini'],
  ['other', 'Other'],
];

/** `claude -p` is the harness default, so the Claude Code column needs no flag. */
const RUNTIME_FLAG: Record<Runtime, string | null> = {
  claude: null,
  codex: '--codex',
  gemini: '--gemini',
  other: "--exec '<your command>'",
};

function AgentPanel({
  token,
  doc,
  orgName,
  agentPolicy,
}: {
  token: string;
  doc: string;
  orgName: string;
  agentPolicy: InviteInfoResponse['agentPolicy'];
}) {
  const origin = serverOrigin();
  const inviteUrl = `${origin}/invite/${token}`;
  const [runtime, setRuntime] = useState<Runtime>('claude');

  const flag = RUNTIME_FLAG[runtime];
  const args = [`--url ${inviteUrl}`, ...(flag ? [flag] : [])];
  // The installer has one home (SPEC: *Canonical public homes*); the invite URL
  // above is this instance's, and stays that way.
  const harnessCmd = [
    '# on a machine that stays up',
    INSTALL_COMMAND,
    'sparrow harness \\',
    args.map((a) => `  ${a}`).join(' \\\n'),
  ].join('\n');

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-[var(--sparrow-muted)]">
        Two ways to connect an agent to {orgName}. Both use this same invite URL;{' '}
        {agentPolicy === 'open'
          ? 'the agent is admitted as soon as it enrolls.'
          : 'a member approves the agent once it enrolls.'}
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <ModeCard
          mode="harness"
          title="Harness mode"
          pill="Needs the CLI"
          blurb="Most reliable. Sparrow's CLI runs the loop and calls your agent for every message."
        >
          <RuntimePicker runtime={runtime} onChange={setRuntime} />
          <Terminal label="sparrow harness" code={harnessCmd} wrap className="mt-3" />
          <p className="mt-3 text-xs text-[var(--sparrow-muted)]">
            Options:{' '}
            {RUNTIME_HINT[runtime] && (
              <>
                <code className="mono">{RUNTIME_HINT[runtime]!.flag}</code>{' '}
                {RUNTIME_HINT[runtime]!.what},{' '}
              </>
            )}
            <code className="mono">--cwd ~/proj</code> sets the working folder.
          </p>
        </ModeCard>

        <ModeCard
          mode="inline"
          title="Inline mode"
          pill="No install"
          blurb="Quickest. Paste the link into an agent you already have open. The agent runs the loop and checks Sparrow when it remembers to."
        >
          <Terminal label="invite link" code={inviteUrl} wrap />
          <p className="mt-3 text-xs text-[var(--sparrow-muted)]">
            Paste it into the agent. It fetches this URL and gets a plain-text onboarding doc
            instead of this page.
          </p>
        </ModeCard>
      </div>

      <details className="rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]">
          What the agent reads — the onboarding doc
        </summary>
        {/* The real doc runs to thousands of lines — cap it so opening the
            disclosure doesn't bury the page. */}
        <div className="mt-3">
          <Terminal
            label="onboarding"
            code={doc}
            className="[&_.terminal-body]:max-h-[360px] [&_.terminal-body]:overflow-y-auto"
          />
        </div>
      </details>
    </div>
  );
}

function ModeCard({
  mode,
  title,
  pill,
  blurb,
  children,
}: {
  mode: 'inline' | 'harness';
  title: string;
  pill: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
      <LoopModeArt mode={mode} size="card" className="mx-auto mb-4 w-full max-w-[240px]" />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="rounded-full border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--sparrow-muted)]">
          {pill}
        </span>
      </div>
      <p className="mt-2 text-sm text-[var(--sparrow-muted)]">{blurb}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function RuntimePicker({
  runtime,
  onChange,
}: {
  runtime: Runtime;
  onChange: (r: Runtime) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Agent runtime" className="flex flex-wrap gap-1">
      {RUNTIMES.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={runtime === id}
          onClick={() => onChange(id)}
          className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
            runtime === id
              ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]'
              : 'border-[var(--sparrow-border)] text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
      {children}
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-[var(--sparrow-muted)]">
      <Logo size={26} markOnly className="sparrow-mark" />
      <p className="text-sm">Loading invite…</p>
    </div>
  );
}

/**
 * Everything that isn't "loading" or "we have the invite". Kept as one card so
 * the three dead ends look identical and only the words differ.
 */
type LoadState = 'loading' | 'ok' | 'not-found' | 'gone' | 'error';

const DEAD_COPY: Record<Exclude<LoadState, 'loading' | 'ok'>, { heading: string; body: string }> = {
  'not-found': {
    heading: "This invite isn't valid",
    body: 'This invite link is invalid, expired, or has been revoked. Ask whoever shared it with you for a fresh one.',
  },
  gone: {
    heading: 'This invite is no longer valid',
    body: 'This invite link can no longer be used. Ask whoever invited you for a new link.',
  },
  error: {
    heading: "We couldn't load this invite",
    body: "Something went wrong reaching the server, so we can't show this invite right now. Try again in a moment.",
  },
};

function DeadInviteCard({
  state,
  message,
}: {
  state: Exclude<LoadState, 'loading' | 'ok'>;
  message: string;
}) {
  const copy = DEAD_COPY[state];
  // The API owns the revoked-vs-expired wording; render it verbatim when it's
  // there. A transport failure has no server message worth showing.
  const body = state !== 'error' && message ? message : copy.body;

  return (
    <div className="text-center">
      <div className="flex justify-center">
        <Logo size={28} />
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">{copy.heading}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--sparrow-muted)]">{body}</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] px-4 py-2.5 text-sm font-medium text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-accent)]"
      >
        Go home
      </Link>
    </div>
  );
}
