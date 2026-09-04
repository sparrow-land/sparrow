import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '@sparrow/client';
import { useAuth } from '../lib/auth.js';
import { api } from '../lib/client.js';
import { setLastOrg } from '../lib/prefs.js';
import { orgPath } from '../lib/ids.js';
import { BareShell } from '../components/BareShell.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/**
 * `/welcome` — the create-an-org experience for a signed-in human who belongs to
 * no org yet. It lives on its OWN route (rather than inline on `/`) so the
 * client-side navigation here clears the stray `#` fragment Google appends on the
 * OAuth redirect, and so the page can wear the signed-in {@link BareShell} instead
 * of the marketing chrome.
 *
 * Guards: signed-out → `/login`; already has an org → `/` (never show stale).
 */
export function Welcome() {
  useDocumentTitle(pageTitle('Create your organization'));
  const auth = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.signedIn) return <Navigate to="/login" replace />;
  if (auth.orgs.length > 0) return <Navigate to="/" replace />;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const org = await api.createOrg({ name: name.trim() });
      await auth.refreshOrgs();
      setLastOrg(org.id);
      navigate(orgPath(org.id), { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'forbidden'
            ? 'Creating organizations is disabled on this instance. Ask for an invite.'
            : err.message
          : 'Could not create the organization.',
      );
      setBusy(false);
    }
  }

  const inputClass =
    'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

  return (
    <BareShell>
      <div className="flex items-start justify-center px-4 py-16 sm:py-24">
        <div className="w-full max-w-md">
          <h1 className="text-center text-xl font-semibold tracking-tight">
            Create your organization
          </h1>
          <p className="mt-1.5 text-center text-sm text-[var(--sparrow-muted)]">
            An organization holds your people, agents, and rooms. Once it exists you can invite
            your team — or connect your first agent. Or follow an invite link a teammate sent you
            to join theirs.
          </p>
          <form
            onSubmit={create}
            className="mt-6 rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5"
          >
            <label
              htmlFor="org-name"
              className="mb-1 block text-xs font-medium text-[var(--sparrow-muted)]"
            >
              Organization name
            </label>
            <input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Robotics"
              autoFocus
              className={inputClass}
            />
            {error && <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p>}
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="mt-3 w-full rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create organization'}
            </button>
          </form>
        </div>
      </div>
    </BareShell>
  );
}
