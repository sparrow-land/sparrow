import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App.js';
import { useFetch, restoreFetch, errorJson } from '../test/apiStub.js';
import { DEFAULT_TITLE } from '../lib/title.js';

/**
 * The SPA half of issue #35. The server's catch-all now hands the HTML shell to
 * any browser navigation outside `/api/` (with a `404` status for a path it does
 * not enumerate), so these paths finally REACH the SPA — this file is the other
 * side of that contract: once the shell boots at an unknown path, the app must
 * render its designed 404 page rather than a blank screen.
 *
 * A signed-out boot is the honest case for a stranger following a bad link, and
 * it is also the fastest: every probe 401s, the app settles signed-out, and the
 * unscoped route tree's `path="*"` takes over.
 */
afterEach(() => {
  restoreFetch();
  document.title = DEFAULT_TITLE;
});

function renderAt(path: string) {
  useFetch(async () => errorJson('unauthorized', 401));
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('unknown routes render the app 404 page', () => {
  // The exact paths QA hit in a real browser, which came back as raw JSON.
  it.each(['/totally-bogus', '/rooms', '/org', '/wp-admin', '/a/b/c'])(
    '%s renders the designed 404, not a blank shell',
    async (path) => {
      renderAt(path);
      expect(
        await screen.findByRole('heading', { level: 1, name: /this page isn’t here/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /back home/i })).toBeInTheDocument();
    },
  );

  it('titles the tab so a lost visitor can see where they are', async () => {
    renderAt('/totally-bogus');
    await screen.findByRole('heading', { level: 1, name: /this page isn’t here/i });
    await waitFor(() => expect(document.title).toBe('Page not found — sparrow'));
  });

  // Negative control: a path the SERVER enumerates as an SPA route must not be
  // claimed by the catch-all, or the two lists would disagree in the other
  // direction (server serves the shell, app shows 404 on a real page).
  it('does not claim a real client route', async () => {
    renderAt('/login');
    await screen.findByRole('heading', { level: 1, name: /sign in/i });
    expect(screen.queryByText(/this page isn’t here/i)).toBeNull();
  });
});
