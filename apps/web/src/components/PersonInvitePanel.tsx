import { useCapabilities } from '../lib/capabilities.js';
import { InviteByEmail } from './InviteByEmail.js';
import { eyebrowClass, InviteTerminal, LiveInviteNote } from './InvitePieces.js';

/**
 * Inviting a PERSON: the by-email form (admins only, and only where the server
 * can actually send mail) and, either way, the link a teammate opens in a
 * browser.
 *
 * Shared by the {@link InviteDialog}'s person step and step 4 of the first-run
 * onboarding wizard, so "invite a human" says the same thing wherever it is
 * offered. The invite URL is resolved by the host and handed down (see
 * `useMintedInvite`) — both wizard steps hand out the SAME live invite.
 *
 * The by-email form needs TWO yeses: the caller may add a member (`canByEmail`),
 * and this instance can send mail at all (`capabilities.emailOutbound`, read
 * from the one boot-time capabilities fetch). The second is the exact condition
 * `POST /orgs/:id/members` checks before it emails the invitation, so a keyless
 * self-hosted instance never OFFERS to send one it would quietly not send — it
 * shows the link path alone, which is the path that always works.
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
  /** Whether the caller may add a member directly (admins) — half of the email gate. */
  canByEmail: boolean;
  url: string | null;
  error: boolean;
  onInvited?: () => void;
}) {
  // Render-gated, never discovery-gated: the capability says whether the offer
  // is honest here, and a client that cannot reach `/capabilities` sees the
  // all-off default — the link path, which needs no mail at all.
  const caps = useCapabilities();
  const byEmail = canByEmail && caps.emailOutbound;
  return (
    <div>
      {byEmail && <InviteByEmail orgId={orgId} onInvited={onInvited} />}
      <div className={byEmail ? 'mt-4 border-t border-[var(--sparrow-border)] pt-4' : ''}>
        <p className={eyebrowClass}>{byEmail ? 'Or share a link' : 'Share a link'}</p>
        <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
          Anyone with this link can join {orgName}.
          {byEmail && ' Use email when you want to know who’s coming.'}
        </p>
        <div className="mt-2">
          <InviteTerminal url={url} error={error} label="invite link" code={url ?? ''} />
        </div>
        {url && <LiveInviteNote orgName={orgName} />}
      </div>
    </div>
  );
}
