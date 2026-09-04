import { BareShell } from '../components/BareShell.js';
import { useAuth } from '../lib/auth.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/**
 * Shown when a signed-in human opens a scoped workspace (host `<slug><suffix>` or
 * a `/orgs/<slug>` path) they do NOT belong to — the slug resolves to no org they
 * can see. A calm, terminal state (NOT a redirect), so there is no loop back to a
 * workspace they can't enter. The signed-in {@link BareShell} frame gives them a
 * way out: Sign out (to try another account). Unknown slugs and non-membership
 * are indistinguishable here — the server never leaks which workspaces exist.
 */
export function NotMember() {
  const auth = useAuth();
  useDocumentTitle(pageTitle('Not a member'));
  const identity = auth.user?.displayName || auth.user?.email || 'You';

  return (
    <BareShell>
      <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 py-16 text-center">
        <h1 className="text-lg font-semibold text-[var(--sparrow-text)]">
          Not a member of this workspace
        </h1>
        <p className="mt-3 text-sm text-[var(--sparrow-muted)]">
          {identity} doesn&rsquo;t have access to this workspace. If you expected to be here, ask
          someone inside for an invite — or use <span className="font-medium">Sign out</span> above to
          sign in with a different account.
        </p>
      </div>
    </BareShell>
  );
}
