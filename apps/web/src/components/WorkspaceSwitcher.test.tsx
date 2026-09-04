import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

/**
 * The cloud workspace switcher. jsdom serves the page at http://localhost:3000,
 * so a workspace URL on that host is "current"; anything else navigates.
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DIRECTORY_URL = 'https://dir.example.com/api/v1/me/workspaces';

const items = [
  { slug: 'acme', name: 'Acme', url: 'http://localhost:3000/' }, // current host
  { slug: 'meteor', name: 'Meteor', url: 'https://meteor.example.com/' },
];

let assignSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assignSpy = vi.fn();
  // jsdom's real location.assign warns "Not implemented"; replace with a spy.
  Object.defineProperty(window, 'location', {
    value: { ...window.location, host: 'localhost:3000', assign: assignSpy },
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WorkspaceSwitcher', () => {
  it('does NOT fetch on mount — only on open (zero cost to a normal page view)', async () => {
    const fetchMock = vi.fn(async () => json({ items }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkspaceSwitcher orgName="Acme" config={{ directoryUrl: DIRECTORY_URL, createUrl: null }} />);

    // The header button shows the current org name; nothing fetched yet.
    expect(screen.getByRole('button', { name: /acme/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(DIRECTORY_URL, { credentials: 'include' });
  });

  it('lists workspaces: the current one is checked and non-navigating; others navigate on click', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));
    render(<WorkspaceSwitcher orgName="Acme" config={{ directoryUrl: DIRECTORY_URL, createUrl: null }} />);

    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    const menu = await screen.findByRole('menu', { name: /switch workspace/i });

    // The current workspace is a checked radio menu item and is NOT a button.
    const current = within(menu).getByRole('menuitemradio', { name: /acme/i });
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(current.tagName).not.toBe('BUTTON');

    // Another workspace navigates via window.location.assign.
    const other = within(menu).getByRole('menuitemradio', { name: /meteor/i });
    expect(other).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(other);
    expect(assignSpy).toHaveBeenCalledWith('https://meteor.example.com/');
  });

  it('exposes the workspace list as radios: exactly the current one is aria-checked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));
    render(<WorkspaceSwitcher orgName="Acme" config={{ directoryUrl: DIRECTORY_URL, createUrl: null }} />);

    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    const menu = await screen.findByRole('menu', { name: /switch workspace/i });

    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios).toHaveLength(2);
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(within(menu).getByRole('menuitemradio', { name: /acme/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows "Create a workspace" only when createUrl is set, and navigates to it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));
    const { unmount } = render(
      <WorkspaceSwitcher orgName="Acme" config={{ directoryUrl: DIRECTORY_URL, createUrl: null }} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: /create a workspace/i })).not.toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));
    render(
      <WorkspaceSwitcher
        orgName="Acme"
        config={{ directoryUrl: DIRECTORY_URL, createUrl: 'https://dir.example.com/new' }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    const create = await screen.findByRole('menuitem', { name: /create a workspace/i });
    await userEvent.click(create);
    expect(assignSpy).toHaveBeenCalledWith('https://dir.example.com/new');
  });

  it('on fetch failure, degrades to the org name + a single "Manage workspaces" link to the directory origin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'nope' }, 401)));
    render(<WorkspaceSwitcher orgName="Acme" config={{ directoryUrl: DIRECTORY_URL, createUrl: null }} />);

    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    const link = await screen.findByRole('link', { name: /manage workspaces/i });
    expect(link).toHaveAttribute('href', 'https://dir.example.com');
    // No workspace list rendered on failure.
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('shows a loading state while fetching', async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => (resolve = r));
    vi.stubGlobal('fetch', vi.fn(() => pending));
    render(<WorkspaceSwitcher orgName="Acme" config={{ directoryUrl: DIRECTORY_URL, createUrl: null }} />);

    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    resolve(json({ items }));
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
  });

  it('closes on Escape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));
    render(<WorkspaceSwitcher orgName="Acme" config={{ directoryUrl: DIRECTORY_URL, createUrl: null }} />);

    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
