import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { CapabilitiesResponse } from '@sparrow/common-types';
import { api } from './client.js';

/**
 * Instance capabilities (v4). Optional mediums are vendor-key-gated: the server
 * reports which providers are registered via `GET /capabilities` (public, no
 * auth). Clients GATE RENDER, never discovery — a client must not learn about a
 * medium by taking a 404. Voice (STT & TTS) hides every mic/speaker control when
 * its boolean is false; `email` hides every email surface the same way, so a
 * keyless dev stack shows neither.
 *
 * `emailReviewer` is not a medium but a fact ABOUT one: whether an automatic
 * reviewer (an LLM judge) is registered here. It gates no surface — it lets org
 * admin state the server's degrade-to-approve rule plainly instead of hedging.
 *
 * Fetched once at boot alongside auth/config. Any failure (unreachable, 404,
 * schema drift) leaves the safe default — every optional medium off, and no
 * reviewer — so the app always boots; controls simply stay hidden.
 */
/**
 * The instance capabilities the web app reads. Aliased so voice v2's
 * `voice.sttStreaming` has one name here even while the wire schema settles —
 * use sites still read it as `voice.sttStreaming ?? false`, because a server
 * that omits it (an older build) means "buffered one-shot STT", which is a
 * working hands-free mode, just without live words.
 */
export type Capabilities = CapabilitiesResponse;

const DEFAULT_CAPABILITIES: Capabilities = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};

interface CapabilitiesState {
  caps: Capabilities;
  /** True once the `GET /capabilities` fetch has settled (success OR failure). */
  loaded: boolean;
}

const CapabilitiesContext = createContext<CapabilitiesState>({
  caps: DEFAULT_CAPABILITIES,
  loaded: false,
});

/**
 * The instance's capabilities. Returns the all-off default when no provider is
 * mounted (e.g. isolated component tests) — voice controls stay hidden rather
 * than throwing, so presentational components can render outside the provider.
 */
export function useCapabilities(): Capabilities {
  return useContext(CapabilitiesContext).caps;
}

/**
 * Whether the capabilities fetch has settled. Host-scope detection depends on
 * `orgHostSuffix`, so scoped boot waits for this before deciding a subdomain is
 * (or isn't) an org.
 */
export function useCapabilitiesLoaded(): boolean {
  return useContext(CapabilitiesContext).loaded;
}

export function CapabilitiesProvider({
  initial,
  children,
}: {
  /**
   * Pre-fetched capabilities (from the boot bootstrap, which may already have
   * fetched them to resolve host scope). When provided, the provider seeds from
   * it and skips its own fetch — one `GET /capabilities` per load.
   */
  initial?: Capabilities;
  children: ReactNode;
}) {
  const [state, setState] = useState<CapabilitiesState>(
    initial ? { caps: initial, loaded: true } : { caps: DEFAULT_CAPABILITIES, loaded: false },
  );

  useEffect(() => {
    if (initial) return; // already seeded
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.getCapabilities();
        if (!cancelled) setState({ caps: next, loaded: true });
      } catch {
        // No /capabilities (unreachable / unregistered) — stay all-off but mark
        // loaded so anything waiting on the fetch stops waiting.
        if (!cancelled) setState({ caps: DEFAULT_CAPABILITIES, loaded: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial]);

  return <CapabilitiesContext.Provider value={state}>{children}</CapabilitiesContext.Provider>;
}
