import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';
import { getLastOrg } from '../lib/prefs.js';
import { orgPath } from '../lib/ids.js';

/**
 * `/` — the entry point. Signed-out visitors go to `/login`. Signed-in humans
 * are redirected to their last-active org (or their only/first one). A human
 * with NO org is sent to `/welcome` — a real client-side navigation, which also
 * clears the stray `#` fragment Google leaves on the OAuth redirect.
 */
export function Home() {
  const auth = useAuth();

  if (!auth.signedIn) return <Navigate to="/login" replace />;

  if (auth.orgs.length > 0) {
    const last = getLastOrg();
    const target =
      (last && auth.orgs.find((o) => o.org.id === last)?.org.id) ?? auth.orgs[0]!.org.id;
    return <Navigate to={orgPath(target)} replace />;
  }

  return <Navigate to="/welcome" replace />;
}
