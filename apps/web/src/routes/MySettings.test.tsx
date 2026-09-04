import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// SHIM: the shared `api` client (packages/client) and the `updateMe` wrapper
// both read `globalThis.fetch` lazily, but the client is a module singleton, so
// we install a mutable indirection BEFORE importing it (via `vi.hoisted`, which
// runs above the imports below) and route each test's mock through it.
const fetchCtl = vi.hoisted(() => {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const original = g.fetch;
  let current: typeof fetch = original;
  g.fetch = ((...a: Parameters<typeof fetch>) => current(...a)) as typeof fetch;
  return {
    set: (f: typeof fetch) => {
      current = f;
    },
    reset: () => {
      current = original;
    },
  };
});

import { AuthProvider } from '../lib/auth.js';
import { ThemeProvider } from '../lib/theme-provider.js';
import { MySettings } from './MySettings.js';

const jake = {
  id: 'usr_1',
  email: 'jake@acme.com',
  displayName: 'Jake',
  provider: 'password',
  theme: 'auto' as const,
};

const acmeOrg = { id: 'org_acme', name: 'Acme', slug: 'acme' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface StubOptions {
  /** Extra orgs beyond the default Acme membership. */
  orgs?: { org: { id: string; name: string; slug: string }; role: string }[];
  /** Status for DELETE /orgs/:id/humans/:humanId (default 200). */
  leaveStatus?: number;
  leaveError?: { code: string; message: string };
}

/** Fetch stub: a signed-in human (Jake) who owns Acme. */
function settingsFetchMock(opts: StubOptions = {}) {
  const orgs = opts.orgs ?? [{ org: acmeOrg, role: 'owner' }];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/config')) {
      return json({ providers: [{ id: 'password', label: 'Password', kind: 'credentials' }], allowSignup: true });
    }
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) return json({ items: orgs });

    // PATCH /me — rename and/or theme.
    if (url.endsWith('/api/v1/me') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        displayName?: string;
        theme?: string;
      };
      return json({
        principal: {
          type: 'human',
          id: jake.id,
          email: jake.email,
          displayName: body.displayName ?? jake.displayName,
          theme: body.theme ?? jake.theme,
        },
      });
    }

    // DELETE /orgs/:id/humans/:humanId — leave.
    if (/\/orgs\/[^/]+\/humans\/[^/]+$/.test(url) && method === 'DELETE') {
      if ((opts.leaveStatus ?? 200) !== 200) {
        return json({ error: opts.leaveError! }, opts.leaveStatus!);
      }
      return json({ ok: true });
    }

    if (url.includes('/api/v1/config')) {
      return json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    }
    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
  return mock;
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/me/settings']}>
      <AuthProvider>
        <ThemeProvider>
          <Routes>
            <Route path="/me/settings" element={<MySettings />} />
            <Route path="/org/:orgId" element={<div>org home</div>} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </ThemeProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('My settings (/me/settings)', () => {
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('shows the account with a read-only email and provider', async () => {
    fetchCtl.set(settingsFetchMock());
    renderSettings();
    expect(await screen.findByRole('heading', { name: /your settings/i })).toBeInTheDocument();
    expect(screen.getByText('jake@acme.com')).toBeInTheDocument();
    expect(screen.getByText(/signed in with a password/i)).toBeInTheDocument();
  });

  it('edits the display name and Save calls PATCH /me, updating the shown name', async () => {
    const mock = settingsFetchMock();
    fetchCtl.set(mock);
    renderSettings();

    const input = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    expect(input.value).toBe('Jake');

    await userEvent.clear(input);
    await userEvent.type(input, 'Jacob');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([u, init]) =>
            String(u).endsWith('/api/v1/me') &&
            (init?.method ?? '').toUpperCase() === 'PATCH',
        ),
      ).toBe(true),
    );

    // The field reflects the server-canonical name and a Saved confirmation shows.
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('Jacob'));
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it('reverts the name and shows the error when PATCH /me fails', async () => {
    const mock = settingsFetchMock();
    // Make PATCH /me fail.
    fetchCtl.set(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.endsWith('/api/v1/me') && method === 'PATCH') {
          return json({ error: { code: 'internal', message: 'Server said no' } }, 500);
        }
        return mock(input, init);
      }) as typeof fetch,
    );
    renderSettings();

    const input = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'Jacob');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/server said no/i)).toBeInTheDocument();
    await waitFor(() => expect(input.value).toBe('Jake')); // reverted
  });

  it('lists an org membership with its role and a Leave button that calls DELETE', async () => {
    const mock = settingsFetchMock({ orgs: [{ org: acmeOrg, role: 'admin' }] });
    fetchCtl.set(mock);
    renderSettings();

    expect(await screen.findByRole('link', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^leave$/i }));

    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([u, init]) =>
            /\/orgs\/org_acme\/humans\/usr_1$/.test(String(u)) &&
            (init?.method ?? '').toUpperCase() === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  it('surfaces the server message when leaving is refused with a 409', async () => {
    fetchCtl.set(
      settingsFetchMock({
        orgs: [{ org: acmeOrg, role: 'owner' }],
        leaveStatus: 409,
        leaveError: { code: 'conflict', message: 'You’re the only owner of this organization.' },
      }),
    );
    renderSettings();

    await screen.findByRole('link', { name: 'Acme' });
    await userEvent.click(screen.getByRole('button', { name: /^leave$/i }));

    expect(await screen.findByText(/only owner of this organization/i)).toBeInTheDocument();
  });

  it('shows the Photo section with a generated avatar and an Upload button', async () => {
    fetchCtl.set(settingsFetchMock());
    renderSettings();
    expect(await screen.findByRole('heading', { name: /photo/i })).toBeInTheDocument();
    // Generated (SVG) avatar — Jake has no uploaded image.
    expect(screen.getByRole('img', { name: 'Jake' }).tagName.toLowerCase()).toBe('svg');
    expect(screen.getByRole('button', { name: /upload photo/i })).toBeInTheDocument();
  });

  it('uploads a valid image: PUTs /me/avatar and shows the new photo + a Remove button', async () => {
    const base = settingsFetchMock();
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/v1/me/avatar') && method === 'PUT') {
        return json({ avatarUrl: 'https://cdn/new.png' });
      }
      return base(input, init);
    });
    fetchCtl.set(mock as typeof fetch);
    renderSettings();

    await screen.findByRole('heading', { name: /photo/i });
    const input = screen.getByLabelText(/choose a photo/i) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' });
    await userEvent.upload(input, file);

    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([u, i]) => String(u).endsWith('/api/v1/me/avatar') && (i?.method ?? '').toUpperCase() === 'PUT',
        ),
      ).toBe(true),
    );
    const img = (await screen.findByRole('img', { name: 'Jake' })) as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('https://cdn/new.png');
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('rejects a non-image type inline and never calls the server', async () => {
    const mock = settingsFetchMock();
    fetchCtl.set(mock);
    renderSettings();

    await screen.findByRole('heading', { name: /photo/i });
    const input = screen.getByLabelText(/choose a photo/i) as HTMLInputElement;
    const bad = new File(['x'], 'notes.gif', { type: 'image/gif' });
    await userEvent.upload(input, bad);

    expect(await screen.findByText(/png, jpeg, or webp/i)).toBeInTheDocument();
    expect(mock.mock.calls.some(([u]) => String(u).endsWith('/api/v1/me/avatar'))).toBe(false);
  });

  it('rejects an oversized image inline', async () => {
    const mock = settingsFetchMock();
    fetchCtl.set(mock);
    renderSettings();

    await screen.findByRole('heading', { name: /photo/i });
    const input = screen.getByLabelText(/choose a photo/i) as HTMLInputElement;
    const big = new File([new Uint8Array([1])], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 2 * 1024 * 1024 });
    await userEvent.upload(input, big);

    expect(await screen.findByText(/larger than/i)).toBeInTheDocument();
    expect(mock.mock.calls.some(([u]) => String(u).endsWith('/api/v1/me/avatar'))).toBe(false);
  });

  it('removes an uploaded photo: DELETE /me/avatar reverts to the generated avatar', async () => {
    const base = settingsFetchMock();
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/v1/me/avatar') && method === 'PUT') return json({ avatarUrl: 'https://cdn/new.png' });
      if (url.endsWith('/api/v1/me/avatar') && method === 'DELETE') return json({ avatarUrl: null });
      return base(input, init);
    });
    fetchCtl.set(mock as typeof fetch);
    renderSettings();

    await screen.findByRole('heading', { name: /photo/i });
    const input = screen.getByLabelText(/choose a photo/i) as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array([1])], 'me.png', { type: 'image/png' }));

    await screen.findByRole('button', { name: /remove/i });
    await userEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([u, i]) => String(u).endsWith('/api/v1/me/avatar') && (i?.method ?? '').toUpperCase() === 'DELETE',
        ),
      ).toBe(true),
    );
    // Back to the generated (SVG) avatar.
    await waitFor(() => expect(screen.getByRole('img', { name: 'Jake' }).tagName.toLowerCase()).toBe('svg'));
  });

  it('shows the Appearance control with three theme options, Auto selected by default', async () => {
    fetchCtl.set(settingsFetchMock());
    renderSettings();

    expect(await screen.findByRole('heading', { name: /appearance/i })).toBeInTheDocument();
    const auto = screen.getByRole('radio', { name: /auto/i });
    const light = screen.getByRole('radio', { name: /light/i });
    const dark = screen.getByRole('radio', { name: /dark/i });
    // Jake's stored theme is `auto`, so Auto is the selected option.
    expect(auto).toHaveAttribute('aria-checked', 'true');
    expect(light).toHaveAttribute('aria-checked', 'false');
    expect(dark).toHaveAttribute('aria-checked', 'false');
  });

  it('choosing Dark selects it, applies data-theme, and PATCHes /me with the theme', async () => {
    const mock = settingsFetchMock();
    fetchCtl.set(mock);
    renderSettings();

    const dark = await screen.findByRole('radio', { name: /dark/i });
    await userEvent.click(dark);

    // Selection reflects immediately and the document root override is applied.
    await waitFor(() => expect(dark).toHaveAttribute('aria-checked', 'true'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('radio', { name: /auto/i })).toHaveAttribute('aria-checked', 'false');

    // The choice is persisted server-side via PATCH /me { theme: 'dark' }.
    await waitFor(() =>
      expect(
        mock.mock.calls.some(([u, init]) => {
          if (!String(u).endsWith('/api/v1/me') || (init?.method ?? '').toUpperCase() !== 'PATCH')
            return false;
          const body = JSON.parse(String(init?.body ?? '{}')) as { theme?: string };
          return body.theme === 'dark';
        }),
      ).toBe(true),
    );
    expect(localStorage.getItem('sparrow:theme')).toBe('dark');
  });

  it('prompts a signed-out visitor to sign in, linking to /login?next=/me/settings', async () => {
    fetchCtl.set(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/config')) {
          return json({ providers: [], allowSignup: true });
        }
        if (url.includes('/auth/me')) {
          return json({ error: { code: 'unauthorized', message: 'Sign-in required' } }, 401);
        }
        if (url.includes('/me/orgs')) return json({ items: [] });
        return json({ error: { code: 'not_found', message: url } }, 404);
      }) as typeof fetch,
    );
    renderSettings();

    const link = await screen.findByRole('link', { name: /^sign in$/i });
    expect(link).toHaveAttribute('href', '/login?next=/me/settings');
  });
});
