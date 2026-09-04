import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Mcp } from './Mcp.js';
import { serverOrigin } from '../../lib/origin.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <Mcp />
    </MemoryRouter>,
  );
}

function terminals(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
}

/**
 * Canonical public homes (SPEC): the installer comes from sparrow.land whatever
 * instance you use — but the SERVER the MCP process talks to is the instance's
 * own origin, and that distinction is the whole point of this page.
 */
describe('MCP server — install vs. server origin', () => {
  it('installs from the one canonical URL', () => {
    const { container } = renderPage();
    const install = terminals(container).find((t) => t.includes('install.sh'));
    expect(install).toBe('curl -fsSL https://sparrow.land/install.sh | sh');
  });

  it('still points SPARROW_SERVER at this instance', () => {
    const { container } = renderPage();
    const register = terminals(container).find((t) => t.includes('claude mcp add sparrow'));
    expect(register).toContain(`SPARROW_SERVER=${serverOrigin()}`);
  });
});
