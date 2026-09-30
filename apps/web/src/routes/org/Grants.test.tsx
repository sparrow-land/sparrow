import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Grant, OrgRole } from '@sparrow-land/sdk/types';
import { AuthProvider } from '../../lib/auth.js';
import { OrgProvider } from '../../lib/org.js';
import { useFetch, restoreFetch, json } from '../../test/apiStub.js';
import { ORG_ID } from '../../test/fixtures.js';
import { OrgSettings } from '../OrgSettings.js';

/**
 * Org admin's **Grants** section (SPEC.md, *Agent visibility*; spec §5 "Org
 * settings gains a Grants list"): every grant in the org — any member may read
 * it — with revoke where the viewer may (admins, the grant's creator, the holder
 * giving it up), and a form to grant `tags:*` or `tag:<slug>` to a human or an
 * agent (admins: both scopes; `tags:*` holders: `tag:<slug>` only).
 */

const ME = { id: 'usr_jake', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

function grant(principalId: string, scope: string, id: string, grantedBy = 'usr_pat'): Grant {
  return {
    id,
    orgId: ORG_ID,
    principalId,
    principalKind: principalId.startsWith('agt_') ? 'agent' : 'human',
    scope,
    grantedBy,
    createdAt: '2026-09-01T00:00:00Z',
  };
}

const HUMANS = [
  { human: { id: 'usr_jake', displayName: 'Jake', email: 'jake@acme.com', avatarUrl: null }, role: 'member', joinedAt: '2026-08-01T00:00:00Z' },
  { human: { id: 'usr_pat', displayName: 'Pat', email: 'pat@acme.com', avatarUrl: null }, role: 'owner', joinedAt: '2026-08-01T00:00:00Z' },
  { human: { id: 'usr_dana', displayName: 'Dana', email: 'dana@acme.com', avatarUrl: null }, role: 'member', joinedAt: '2026-08-01T00:00:00Z' },
];

function agent(id: string, name: string, tags: string[]) {
  return {
    agent: { id, name, orgId: ORG_ID, emailAddress: null, online: false, lastSeenAt: null, tags, messaging: 'any', createdAt: '2026-08-01T00:00:00Z' },
    owner: { id: 'usr_pat', displayName: 'Pat' },
  };
}
const AGENTS = [agent('agt_chief', 'vm9-chief', []), agent('agt_cubey', 'cubey', ['cubes'])];

function mock(role: OrgRole, grants: Grant[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: ME });
    if (url.includes('/me/orgs')) return json({ items: [{ org: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role }] });
    if (path.endsWith(`/orgs/${ORG_ID}/grants`) && method === 'GET') return json({ items: grants });
    if (path.endsWith(`/orgs/${ORG_ID}/grants`) && method === 'POST') {
      return json({ grant: grant(body.principalId, body.scope, 'grt_new', ME.id) }, 201);
    }
    if (/\/grants\/[^/]+$/.test(path) && method === 'DELETE') return json({ ok: true });
    if (path.endsWith(`/orgs/${ORG_ID}/humans`)) return json({ items: HUMANS, nextCursor: null });
    if (path.endsWith(`/orgs/${ORG_ID}/me/agents`)) {
      return json({ items: AGENTS.map((a) => ({ ...a, sharedBy: { id: 'usr_pat', displayName: 'Pat' } })) });
    }
    if (path.endsWith(`/orgs/${ORG_ID}/agents`)) {
      if (role === 'member') return json({ error: { code: 'forbidden', message: 'admins only' } }, 403);
      return json({ items: AGENTS });
    }
    if (path.includes(`/orgs/${ORG_ID}`) && method === 'GET' && path.endsWith(ORG_ID)) {
      return json({ org: { id: ORG_ID, name: 'Acme', slug: 'acme', settings: { invites: { who: 'members' }, enroll: { agents: 'approval' }, rooms: { create: 'members' } }, createdAt: '2026-01-01T00:00:00Z' } });
    }
    return json({ items: [] });
  });
  useFetch(f as unknown as typeof fetch);
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/o/${ORG_ID}/admin`]}>
      <AuthProvider>
        <OrgProvider orgId={ORG_ID}>
          <OrgSettings />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => restoreFetch());

describe('Org admin → Grants', () => {
  it('an admin sees every grant, named, and can revoke any of them', async () => {
    const calls = mock('admin', [grant('agt_chief', 'tags:*', 'grt_chief'), grant('usr_dana', 'tag:cubes', 'grt_dana')]);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Grants' });
    await waitFor(() => expect(within(list).getByText('vm9-chief')).toBeInTheDocument());
    expect(within(list).getByText('Dana')).toBeInTheDocument();
    expect(within(list).getByText('tags:*')).toBeInTheDocument();
    expect(within(list).getByText('tag:cubes')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Revoke tag:cubes from Dana' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/grants/grt_dana'))).toBe(true),
    );
  });

  it('an admin grants tags:* to an agent, or tag:<slug> to a human', async () => {
    const calls = mock('admin', []);
    renderPage();
    const form = await screen.findByRole('form', { name: 'Grant access' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: /vm9-chief/ })).toBeInTheDocument(),
    );
    // Never yourself.
    expect(within(form).queryByRole('option', { name: /^Jake/ })).toBeNull();
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Who' }), 'agt_chief');
    await userEvent.click(within(form).getByRole('radio', { name: /every tag/i }));
    await userEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ principalId: 'agt_chief', scope: 'tags:*' });

    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Who' }), 'usr_dana');
    await userEvent.click(within(form).getByRole('radio', { name: /one tag/i }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tag' }), 'Cubes');
    await userEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({ principalId: 'usr_dana', scope: 'tag:cubes' });
  });

  it('a plain member reads the list, may give up their own grant, and gets no form', async () => {
    const calls = mock('member', [grant('usr_jake', 'tag:cubes', 'grt_mine'), grant('usr_dana', 'tag:docs', 'grt_dana')]);
    renderPage();
    expect(await screen.findByText(/don’t have access to org admin/i)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Grants' });
    await waitFor(() => expect(within(list).getByText('Dana')).toBeInTheDocument());
    expect(within(list).queryByRole('button', { name: /revoke/i })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Grant access' })).toBeNull();
    await userEvent.click(within(list).getByRole('button', { name: 'Give up tag:cubes' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/grants/grt_mine'))).toBe(true),
    );
  });

  it('a member who created a grant may revoke it', async () => {
    mock('member', [grant('usr_dana', 'tag:docs', 'grt_dana', 'usr_jake'), grant('usr_jake', 'tags:*', 'grt_mine')]);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Grants' });
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Revoke tag:docs from Dana' })).toBeInTheDocument());
  });

  it('a tags:* holder who is not an admin may grant tag:<slug> only', async () => {
    const calls = mock('member', [grant('usr_jake', 'tags:*', 'grt_mine')]);
    renderPage();
    const form = await screen.findByRole('form', { name: 'Grant access' });
    expect(within(form).queryByRole('radio', { name: /every tag/i })).toBeNull();
    expect(within(form).getByText(/only org owners and admins can grant tags:\*/i)).toBeInTheDocument();
    await waitFor(() => expect(within(form).getByRole('option', { name: /Dana/ })).toBeInTheDocument());
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Who' }), 'usr_dana');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tag' }), 'ops');
    await userEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ principalId: 'usr_dana', scope: 'tag:ops' });
  });
});
