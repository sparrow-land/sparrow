import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import { api } from '../lib/client.js';
import { AgentProfile } from './AgentProfile.js';

/**
 * Two-agent regression guard for the field report: an owner with an older agent
 * (`cos`) and a newer sibling, where a rename intended for the newer landed on
 * the older. The single-entry mock in `AgentProfile.test.tsx` can't see a
 * misdirection, so these render with BOTH agents visible and assert the rename
 * PATCH always targets the agent named in the URL — including after navigating
 * between two agent profiles (same route → the AgentProfile instance is reused),
 * and that a URL param matching no visible agent renders not-found rather than
 * defaulting to the first entry.
 */
type WithFetch = { _fetch: typeof fetch };
const REAL_FETCH = (api as unknown as WithFetch)._fetch;
function useFetch(f: typeof fetch) {
  vi.stubGlobal('fetch', f);
  (api as unknown as WithFetch)._fetch = f;
}
const jake = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Recorder { calls: { method: string; url: string; body: unknown }[] }

function mkAgent(id: string, name: string, createdAt: string) {
  return {
    agent: { id, name, orgId: 'org_1', online: true, lastSeenAt: '2026-08-20T17:00:00Z', sharing: 'selected', createdAt },
    owner: { id: 'usr_1', displayName: 'Jake' },
    sharedBy: null,
    rooms: [],
    sharedWith: [],
  };
}

// Two owned agents: older `cos` (agt_older), newer `newbie` (agt_newer).
function twoAgentMock(rec: Recorder) {
  const agents = [
    mkAgent('agt_older', 'cos', '2026-08-01T00:00:00Z'),
    mkAgent('agt_newer', 'newbie', '2026-08-01T00:30:00Z'),
  ];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') rec.calls.push({ method, url, body });
    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) return json({ items: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' }] });
    if (url.includes('/me/events')) return json('');
    if (url.includes('/orgs/org_1/me/humans')) return json({ items: [] });
    if (url.includes('/orgs/org_1/me/agents')) return json({ items: agents });
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });
    const m = url.match(/\/me\/agents\/(agt_\w+)$/);
    if (m && method === 'PATCH') {
      const a = agents.find((x) => x.agent.id === m[1])!;
      return json({ agent: { ...a.agent, name: body?.name ?? a.agent.name } });
    }
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <OrgProvider orgId="org_1">
          <WorkspaceProvider activeRoomId={null}>
            <Routes>
              <Route path="/org/:orgId" element={<div>ORG HOME</div>} />
              <Route
                path="/org/:orgId/agents/:agentId"
                element={
                  <>
                    <Link to="/org/org_1/agents/agt_older">go-older</Link>
                    <Link to="/org/org_1/agents/agt_newer">go-newer</Link>
                    <AgentProfile />
                  </>
                }
              />
            </Routes>
          </WorkspaceProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AgentProfile — two agents', () => {
  let rec: Recorder;
  beforeEach(() => { rec = { calls: [] }; localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); (api as unknown as WithFetch)._fetch = REAL_FETCH; });

  it('rename on newer agent PATCHes the newer id', async () => {
    useFetch(twoAgentMock(rec));
    renderAt('/org/org_1/agents/agt_newer');
    const input = (await screen.findByLabelText(/agent name/i)) as HTMLInputElement;
    expect(input.value).toBe('newbie');
    await userEvent.clear(input);
    await userEvent.type(input, 'bolide');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(rec.calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = rec.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/me/agents/agt_newer');
    expect(patch.url).not.toContain('/me/agents/agt_older');
  });

  it('navigate older→newer then rename PATCHes the newer id', async () => {
    useFetch(twoAgentMock(rec));
    renderAt('/org/org_1/agents/agt_older');
    // Start on older.
    let input = (await screen.findByLabelText(/agent name/i)) as HTMLInputElement;
    expect(input.value).toBe('cos');
    // Navigate to newer (same Route → AgentProfile instance reused).
    await userEvent.click(screen.getByText('go-newer'));
    await waitFor(() => {
      const el = screen.getByLabelText(/agent name/i) as HTMLInputElement;
      expect(el.value).toBe('newbie');
    });
    input = screen.getByLabelText(/agent name/i) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'bolide');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(rec.calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = rec.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/me/agents/agt_newer');
  });

  it('mismatched URL param renders not-found, not a default agent', async () => {
    useFetch(twoAgentMock(rec));
    renderAt('/org/org_1/agents/agt_ghost');
    expect(await screen.findByText(/can’t see this agent/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/agent name/i)).not.toBeInTheDocument();
  });
});
