import { useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import type { AddOrgMemberResponse, OrgRole } from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../lib/client.js';
import { Terminal } from './Terminal.js';

const inputClass =
  'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

const primaryBtn =
  'rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50';

/**
 * The shared "invite by email" form + success/error UI, used by BOTH the org
 * admin People section and the leftnav invite dialog. It adds a person to the
 * org directly (`POST /orgs/:orgId/members`): the server reuses or provisions the
 * human, emails them an invitation when email is configured, and always returns a
 * shareable `ivk_` invite link.
 *
 * On success it confirms the outcome (emailed vs. link-only), shows the copyable
 * link, and offers an "Invite another" reset so several people can be added
 * back-to-back. `onInvited` lets a host refresh a roster after each add.
 */
export function InviteByEmail({
  orgId,
  onInvited,
}: {
  orgId: string;
  onInvited?: (result: AddOrgMemberResponse) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ email: string; inviteUrl: string; emailSent: boolean } | null>(
    null,
  );
  const emailRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value || adding) return;
    setAdding(true);
    setError(null);
    setAdded(null);
    try {
      const res = await api.addOrgMember(orgId, { email: value, role });
      setEmail('');
      setRole('member');
      setAdded({ email: res.member.human.email, inviteUrl: res.inviteUrl, emailSent: res.emailSent });
      onInvited?.(res);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'That person is already in this organization.'
          : err instanceof ApiError && err.status === 400
            ? 'Enter a valid email address.'
            : err instanceof ApiError
              ? err.message
              : 'Could not add this person.',
      );
    } finally {
      setAdding(false);
    }
  }

  function inviteAnother() {
    setAdded(null);
    setError(null);
    setEmail('');
    emailRef.current?.focus();
  }

  return (
    <form onSubmit={submit}>
      <label
        htmlFor="add-member-email"
        className="block text-xs uppercase tracking-wider text-[var(--sparrow-faint)]"
      >
        Invite by email
      </label>
      <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
        They&rsquo;re added right away. We&rsquo;ll email them an invitation if email is set up, and
        you always get a link to share.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id="add-member-email"
          ref={emailRef}
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
            setAdded(null);
          }}
          placeholder="person@example.com"
          className={`min-w-0 flex-1 ${inputClass}`}
        />
        <select
          aria-label="Role for the new person"
          value={role}
          onChange={(e) => setRole(e.target.value as OrgRole)}
          className="rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-2 py-2.5 text-sm text-[var(--sparrow-text)] outline-none focus:border-[var(--sparrow-accent)]"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" disabled={adding || !email.trim()} className={primaryBtn}>
          {adding ? 'Inviting…' : 'Invite'}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p>}
      {added && (
        <div className="mt-3" role="status">
          <p className="text-sm text-[var(--sparrow-good)]">
            <Check size={14} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline align-[-2px]" />
            {added.emailSent
              ? `Invitation emailed to ${added.email}.`
              : `They’re in — send them this link.`}
          </p>
          {added.emailSent && (
            <p className="mt-1.5 text-xs text-[var(--sparrow-muted)]">or share this link</p>
          )}
          <div className="mt-1.5">
            <Terminal code={added.inviteUrl} label="invite link" wrap />
          </div>
          <button
            type="button"
            onClick={inviteAnother}
            className="mt-2 rounded-md border border-[var(--sparrow-border)] px-3 py-1.5 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-border-strong)] hover:text-[var(--sparrow-text)]"
          >
            Invite another
          </button>
        </div>
      )}
    </form>
  );
}
