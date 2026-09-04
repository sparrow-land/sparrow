import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Api } from './Api.js';
import { serverOrigin } from '../../lib/origin.js';

function flatText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

/**
 * Canonical public homes (SPEC): the per-endpoint Markdown docs live under
 * `DOCS_URL`, and an instance's `/docs/api/<path>` is a `302` to them. The
 * `docs` URL in a 4xx envelope is absolute for the same reason.
 */
describe('REST API — docs by convention point at the one docs home', () => {
  it('names the canonical per-endpoint docs URL, not this instance', () => {
    const { container } = render(
      <MemoryRouter>
        <Api />
      </MemoryRouter>,
    );
    const text = flatText(container);
    expect(text).toContain('https://sparrow.land/docs/api/rooms/status');
    expect(text).toMatch(/redirect/i);
    expect(text).not.toContain(`${serverOrigin()}/docs/api`);
  });
});
