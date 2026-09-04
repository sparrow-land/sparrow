import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import type { CapabilitiesResponse } from '@sparrow/common-types';
import { App } from './App.js';
import { api } from './lib/client.js';
import { detectPathScope, detectHostScope, type Scope } from './lib/scope.js';
import { setScopedMode } from './lib/ids.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

/**
 * Could this host be `<slug><suffix>` for some suffix? A single-label host
 * (`localhost`, an intranet name) or a bare IP never is — skip the capabilities
 * round-trip and render immediately. Anything with a dot (`foo.localhost`,
 * `foo.example.com`) might be, so we fetch the advertised suffix to decide.
 */
function hostMightBeScoped(host: string): boolean {
  const name = host.replace(/:\d+$/, '');
  if (!name.includes('.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false; // IPv4
  return true;
}

/**
 * Resolve the org scope for this load. Path scope (`/orgs/<slug>`) is
 * synchronous; host scope (`<slug><suffix>`) needs the advertised
 * `ORG_HOST_SUFFIX`, fetched from `GET /capabilities`. Resolving BEFORE the app
 * mounts avoids a subdomain flashing the unscoped app (and a wrong redirect).
 */
async function resolveScope(): Promise<{ scope: Scope | null; caps?: CapabilitiesResponse }> {
  const pathScope = detectPathScope(window.location.pathname);
  if (pathScope) return { scope: pathScope };
  if (!hostMightBeScoped(window.location.host)) return { scope: null };
  let caps: CapabilitiesResponse | undefined;
  try {
    caps = await api.getCapabilities();
  } catch {
    // Unreachable /capabilities — treat as unscoped; the app still boots.
    return { scope: null };
  }
  return { scope: detectHostScope(window.location.host, caps.orgHostSuffix), caps };
}

void resolveScope().then(({ scope, caps }) => {
  // Path scope mounts under `/orgs/<slug>`; host scope (and unscoped) under `/`.
  const basename = scope?.basename ?? '/';
  setScopedMode(scope !== null);
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={basename}>
        <App scope={scope} capabilities={caps} />
      </BrowserRouter>
    </StrictMode>,
  );
});
