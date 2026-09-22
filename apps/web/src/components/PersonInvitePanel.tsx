import { InviteByEmail } from './InviteByEmail.js';
import { eyebrowClass, InviteTerminal, LiveInviteNote } from './InvitePieces.js';

/**
 * Inviting a PERSON: the by-email form (admins only) and, either way, the link
 * a teammate opens in a browser.
 *
 * Shared by the {@link InviteDialog}'s person step and step 4 of the first-run
 * onboarding wizard, so "invite a human" says the same thing wherever it is
 * offered. The invite URL is resolved by the host and handed down (see
 * `useMintedInvite`) — both wizard steps hand out the SAME live invite.
 */
export function PersonInvitePanel({
  orgId,
  orgName,
  canByEmail,
  url,
  error,
  onInvited,
}: {
  orgId: string;
  orgName: string;
  /** Whether the caller may add a member directly (admins) — gates the email form. */
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
        {url && <LiveInviteNote orgName={orgName} />}
      </div>
    </div>
  );
}
