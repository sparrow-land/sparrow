import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * BareShell is the minimal signed-in frame (slim app-style top bar + app
 * background) worn by org-less pages. It must read as "you ARE logged in"
 * (identity + Sign out) WITHOUT any marketing chrome (Docs/GitHub nav).
 */

const signOut = vi.fn();
let user: { displayName?: string; email?: string } | null;
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ user, signOut }) }));

import { BareShell } from './BareShell.js';

function renderShell() {
  return render(
    <MemoryRouter>
      <BareShell>
        <p>child content</p>
      </BareShell>
    </MemoryRouter>,
  );
}

describe('BareShell', () => {
  beforeEach(() => {
    signOut.mockReset();
    user = { displayName: 'Jake', email: 'jake@acme.com' };
  });

  it('renders a slim app bar with the identity, Sign out, and the children — no marketing nav', () => {
    renderShell();
    expect(screen.getByText('child content')).toBeInTheDocument();
    expect(screen.getByText('Jake')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    // The sparrow home logo link is present (app chrome), but NO marketing nav.
    expect(screen.getByRole('link', { name: /sparrow home/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /docs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /github/i })).not.toBeInTheDocument();
  });

  it('falls back to the email when there is no display name', () => {
    user = { email: 'jake@acme.com' };
    renderShell();
    expect(screen.getByText('jake@acme.com')).toBeInTheDocument();
  });

  it('signs out when the control is clicked', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  // Same iOS Safari 100vh trap as the AppShell: size to the dynamic viewport
  // and pad the bar past the status bar. jsdom can't lay it out — assert classes.
  it('sizes to the dynamic viewport and pads the bar past the status bar', () => {
    renderShell();
    const shell = screen.getByRole('banner').parentElement!;
    expect(shell.className).toContain('app-height');
    expect(shell.className).not.toContain('h-screen');
    const header = screen.getByRole('banner');
    expect(header.className).toContain('app-header');
    expect(header.className).not.toContain('h-12');
  });
});
