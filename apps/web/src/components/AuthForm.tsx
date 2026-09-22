import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '@sparrow-land/sdk';
import { useAuth } from '../lib/auth.js';
import { api } from '../lib/client.js';

/**
 * The credentials form — sign in, and create an account — with its validation,
 * its error voice, and the two API calls behind it.
 *
 * It lives here rather than inside {@link Login} because a SECOND surface signs
 * the browser in the same way: step 2 of the first-run onboarding wizard
 * (`/onboarding`), where the first account founds the workspace. That step is
 * this form with different chrome — a different button label, the workspace name
 * asked first, a reassurance underneath — and NOT a second copy of
 * `POST /auth/signup`. One form means one place where signing up can change.
 *
 * What stays with the host: the heading, the subtitle, the OAuth buttons, the
 * sign-in/create-account toggle, and where to go afterwards ({@link onDone}).
 */

/* ------------------------------------------------------------------ *
 * Validation copy
 * ------------------------------------------------------------------ */

/** Field names the API validates, in the words a person would use. */
const FIELD_LABEL: Record<string, string> = {
  password: 'Password',
  email: 'Email',
  displayName: 'Display name',
};

/** `displayName` → "Display name"; an unknown field → "Nickname". */
function fieldLabel(field: string): string {
  const known = FIELD_LABEL[field];
  if (known) return known;
  const spaced = field.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Turn the API's verbatim validation text into something a human wrote.
 *
 * `apps/api/src/validate.ts` renders a failed zod parse as `"<path>: <zod
 * message>"`, so a short password arrives at the browser as
 * `password: String must contain at least 8 character(s)` — machine grammar,
 * parenthesised plural and all, on the most-hit error path in the product.
 * We rewrite only shapes we RECOGNISE; anything else (a `forbidden`, a bad
 * password, a server's own sentence) is passed through untouched, because a
 * message we don't understand is exactly the one a person must still see.
 */
export function humanizeAuthError(raw: string): string {
  const message = raw.trim();

  const length = /^(\w+): String must contain at (least|most) (\d+) character\(s\)$/.exec(message);
  if (length) {
    const field = length[1] ?? '';
    const bound = length[2] ?? 'least';
    const n = Number(length[3] ?? 0);
    return `${fieldLabel(field)} must be at ${bound} ${n} ${n === 1 ? 'character' : 'characters'}.`;
  }

  if (/^email: Invalid email$/.test(message)) return 'Enter a valid email address.';

  return raw;
}

export const authInputClass =
  'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

export function AuthForm({
  view,
  founding,
  orgFirst = false,
  autoFocusEmail = true,
  submitLabel,
  busyLabel,
  footer,
  onDone,
}: {
  view: 'login' | 'signup';
  /**
   * This account would FOUND the instance's workspace, so the form asks what to
   * call it. Only then: on every other instance the workspace already exists,
   * and an "orgName" typed into a later signup would be silently dropped.
   */
  founding: boolean;
  /** Ask for the workspace name FIRST (the wizard's step is about the org). */
  orgFirst?: boolean;
  /** Off where the host moves focus itself (the wizard focuses its heading). */
  autoFocusEmail?: boolean;
  /** Override the button's words ("Create workspace" in the wizard). */
  submitLabel?: string;
  busyLabel?: string;
  /** Rendered under the button, inside the form (the wizard's reassurance). */
  footer?: ReactNode;
  /** Signed in (or signed up) and the org list refreshed — the host decides where to go. */
  onDone: () => void;
}) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Flipping sign-in ↔ create-account asks a different question; the answer to
  // the old one must not hang around underneath it.
  useEffect(() => setError(null), [view]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        view === 'signup'
          ? await api.signup({
              email: email.trim(),
              password,
              displayName: displayName.trim() || undefined,
              // Blank (or an instance that is not bootstrapping) sends nothing, and
              // the server falls back to "{displayName}'s org" exactly as before.
              orgName: (founding && orgName.trim()) || undefined,
            })
          : await api.login({ email: email.trim(), password });
      await auth.completeSignIn(res.user);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? humanizeAuthError(err.message)
          : view === 'signup'
            ? 'Could not create the account'
            : 'Could not sign in',
      );
      setBusy(false);
    }
  }

  const nameField = view === 'signup' && (
    <div key="name">
      <label
        htmlFor="login-name"
        className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
      >
        Display name
      </label>
      <input
        id="login-name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="e.g. Jake"
        autoComplete="name"
        className={authInputClass}
      />
    </div>
  );

  const orgField = view === 'signup' && founding && (
    <div key="org">
      <label
        htmlFor="login-org-name"
        className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
      >
        Workspace name
      </label>
      <input
        id="login-org-name"
        value={orgName}
        onChange={(e) => setOrgName(e.target.value)}
        placeholder="e.g. Acme Robotics"
        autoComplete="organization"
        aria-describedby="login-org-name-hint"
        className={authInputClass}
      />
      <p id="login-org-name-hint" className="mt-1 text-xs text-[var(--sparrow-faint)]">
        You are the first person here, so this account founds the workspace. Optional — leave it
        blank and we will name it after you; you can rename it later.
      </p>
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {orgFirst ? [orgField, nameField] : [nameField, orgField]}
      <div>
        <label
          htmlFor="login-email"
          className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
        >
          Email
        </label>
        <input
          id="login-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          autoFocus={autoFocusEmail}
          className={`mono ${authInputClass}`}
        />
      </div>
      <div>
        <label
          htmlFor="login-password"
          className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
        >
          Password
        </label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={view === 'signup' ? 'At least 8 characters' : '••••••••'}
          autoComplete={view === 'signup' ? 'new-password' : 'current-password'}
          className={`mono ${authInputClass}`}
        />
      </div>
      {error && <p className="text-sm text-[var(--sparrow-danger)]">{error}</p>}
      <button
        type="submit"
        disabled={busy || !email.trim() || !password}
        className="mt-1 rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy
          ? (busyLabel ?? (view === 'signup' ? 'Creating account…' : 'Signing in…'))
          : (submitLabel ?? (view === 'signup' ? 'Create account' : 'Sign in'))}
      </button>
      {footer}
    </form>
  );
}
