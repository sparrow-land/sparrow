import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GettingStarted } from './GettingStarted.js';
import { serverOrigin } from '../../lib/origin.js';
import { INSTALL_COMMAND } from '../../lib/docsUrl.js';

function renderPage() {
  return render(<MemoryRouter><GettingStarted /></MemoryRouter>);
}
function text(container: HTMLElement) {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}
function commands(container: HTMLElement) {
  return [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
}

describe('Getting started', () => {
  it('walks from a server to a conversation, then a room in four steps', () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Getting started' })).toBeInTheDocument();
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      '1. Run the server', '2. Sign up', '3. Invite an agent', '4. Make a room', 'Where next',
    ]);
    expect(text(container)).not.toContain('Your workspace');
  });

  it('starts the server and links to the correct instance', () => {
    const { container } = renderPage();
    expect(commands(container)).toContain(
      'docker run -it -p 8722:8722 -v sparrow-data:/data ghcr.io/sparrow-land/sparrow',
    );
    expect(screen.getByRole('link', { name: serverOrigin() })).toHaveAttribute('href', serverOrigin());
  });

  it('follows the first-run wizard and explains the existing-account path', () => {
    const { container } = renderPage();
    const copy = text(container);
    // Onboarding.tsx and the shared AuthForm.tsx, including orgFirst ordering.
    for (const label of ['Welcome to Sparrow', 'Get started', 'Set up your org and account',
      'Workspace name', 'Display name', 'Email', 'Password', 'Create workspace']) {
      expect(copy).toContain(label);
    }
    expect(copy).toMatch(/workspace name is optional/i);
    expect(copy).toMatch(/first account owns the workspace/i);
    expect(copy).toContain('sign in with your existing account');
    expect(copy).toContain('Humans are welcome too.');
    expect(copy).toContain('Finish');
    expect(copy).toContain('Skip');
  });

  it('embeds the approved demo at the start of the invite section', () => {
    const { container } = renderPage();
    const frame = screen.getByTitle('Demo: invite Claude Code into Sparrow and ask it to review an API');
    expect(frame).toHaveAttribute('src', '/demos/agent-invites/embed.html');
    expect(frame).toHaveAttribute('loading', 'lazy');
    const nodes = [...container.querySelectorAll('h2, iframe')];
    expect(nodes[2]?.textContent).toBe('3. Invite an agent');
    expect(nodes[3]).toBe(frame);
  });

  it('keeps real approval instructions with inviting and messaging', () => {
    const { container } = renderPage();
    const steps = [...container.querySelectorAll('ol > li')].map((li) => text(li as HTMLElement));
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('Inline (No install)');
    expect(steps[1]).toContain('requests to join');
    expect(steps[2]).toContain('Approvals');
    expect(steps[2]).toContain('Approve');
    expect(steps[3]).toContain('Click your agent under AGENTS');
    expect(steps[3]).toContain('press Enter');
    expect(text(container)).toContain('demo simplifies the interface and skips approval');
    expect(text(container)).toContain('Opening the URL alone does not enroll anyone');
  });

  it('keeps advanced connection setup optional and uses the canonical installer', () => {
    const { container } = renderPage();
    const harness = [...container.querySelectorAll('details')].find((d) => d.textContent?.includes('Harness'));
    expect(harness).toBeTruthy();
    expect(harness).not.toHaveAttribute('open');
    const code = commands(container).find((c) => c.includes('sparrow harness'))!;
    expect(code).toContain(INSTALL_COMMAND);
    expect(code).toContain(`sparrow harness --url ${serverOrigin()}/invite/ivk_…`);
    expect(text(container)).toContain('Keep the agent session running');
    expect(text(container)).toContain('resume listening');
  });

  it('drops obsolete signup and invite screenshots, retaining the room example', () => {
    const { container } = renderPage();
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute('src', '/docs/img/getting-started/room.png');
    expect(imgs[0]).toHaveAttribute('loading', 'lazy');
    expect(imgs[0]?.getAttribute('alt')?.length).toBeGreaterThan(40);
    expect(container.querySelector('figcaption')).toHaveTextContent('shared conversation');
  });

  it('shows room commands and links to the pages that own the detail', () => {
    const { container } = renderPage();
    expect(commands(container).join('\n')).toContain('sparrow room add my-agent --room build-crew');
    for (const href of ['/docs/cli', '/docs/concepts', '/docs/what-my-agent-sees', '/docs/api',
      '/docs/sdk', '/docs/mcp', '/docs/self-hosting', '/docs/self-hosting#lock-it-down']) {
      expect(container.querySelector(`a[href="${href}"]`)).toBeTruthy();
    }
  });
});
