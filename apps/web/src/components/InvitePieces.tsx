import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@sparrow-land/sdk';
import { ensureOrgInvite } from '../lib/orgInvite.js';
import { Terminal } from './Terminal.js';

/**
 * The pieces every invite surface is built from — the org's one live invite, the
 * three states of a code block, and the sentence that says what the link IS.
 *
 * They were born inside {@link InviteDialog} and still behave exactly as they
 * did there; they live here because a SECOND surface now hands the same invite
 * over — the first-run onboarding wizard (`/onboarding`), whose steps 3 and 4
 * are the dialog's agent and person panels with wizard chrome around them. One
 * home means the two surfaces cannot drift on what an invite is or says.
 */

export const eyebrowClass = 'text-xs uppercase tracking-wider text-[var(--sparrow-faint)]';
export const helperClass = 'text-xs text-[var(--sparrow-muted)]';

/**
 * Resolve the org's classic invite once, the first time a caller actually needs
 * a URL: the caller's own blank, live, untouched invite if they have one, else a
 * freshly minted one ({@link ensureOrgInvite}). Re-renders (mode flips, runtime
 * flips, step changes) never re-resolve it.
 */
export function useMintedInvite(orgId: string, enabled: boolean) {
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
        const inviteUrl = await ensureOrgInvite(orgId);
        if (!cancelled) setUrl(inviteUrl);
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

export function MintError() {
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
export function InviteTerminal({
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

/**
 * What the link actually IS, said once wherever it is handed over: a live door
 * into the org, and a revocable one. The dialog used to mint a seven-day invite
 * per open and say nothing about it (issue #5) — now it reuses one, and names
 * both the standing consequence and the place to end it.
 */
export function LiveInviteNote({ orgName }: { orgName: string }) {
  return (
    <p className={`mt-2 ${helperClass}`}>
      This is a live invite: anyone who follows the link joins {orgName}. Revoke it any time in
      Org admin → Invites.
    </p>
  );
}

/** A flag or path rendered inline in helper prose, in the terminal's own voice. */
export function Flag({ children }: { children: ReactNode }) {
  return <code className="mono text-[var(--sparrow-text)]">{children}</code>;
}

export function TabButton({
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
