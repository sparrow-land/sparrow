import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VOICE_REGISTER_NOTE } from '@sparrow/common-types';
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
/**
 * The rendered REST API page. Its human half must document the same wire the
 * served markdown (`/docs/api/voice`) documents for agents — the two are read by
 * the same team, and a route that exists in one and not the other is how a
 * client ends up probing for a 404.
 */
function renderApi() {
  return render(
    <MemoryRouter>
      <Api />
    </MemoryRouter>,
  );
}

describe('the REST API docs page — Voice', () => {
  it('has a Voice section', () => {
    renderApi();
    expect(screen.getByRole('heading', { level: 2, name: /^Voice/ })).toBeInTheDocument();
  });

  it('documents every voice route: capabilities, both STT shapes, and speech', () => {
    const { container } = renderApi();
    const text = container.textContent ?? '';
    expect(text).toContain('/capabilities');
    expect(text).toContain('/voice/transcriptions');
    expect(text).toContain('/voice/transcriptions/stream');
    expect(text).toContain('/rooms/:roomId/messages/:id/speech');
  });

  it('spells out the streaming WebSocket contract (PCM16 up, JSON frames down)', () => {
    const { container } = renderApi();
    const text = container.textContent ?? '';
    expect(text).toMatch(/WebSocket/);
    expect(text).toContain('PCM16');
    expect(text).toContain('16 kHz');
    expect(text).toContain('"type":"commit"');
    expect(text).toContain('partial');
    expect(text).toContain('committed');
  });

  it('reports the three capability booleans, sttStreaming included', () => {
    const { container } = renderApi();
    const text = container.textContent ?? '';
    expect(text).toContain('sttStreaming');
  });

  it("explains origin: 'voice' on the send and on the Message", () => {
    const { container } = renderApi();
    const text = container.textContent ?? '';
    expect(text).toContain('origin');
    // Provenance, not verbatimness — editing a transcript does not clear it.
    expect(text).toMatch(/provenance/i);
  });

  it('carries the canonical register sentence verbatim', () => {
    const { container } = renderApi();
    expect(container.textContent ?? '').toContain(VOICE_REGISTER_NOTE);
  });

  it('keeps the full Message example honest about origin', () => {
    const { container } = renderApi();
    // The wire shape shown under Messages must list every field the API returns.
    expect(container.textContent ?? '').toContain('"origin"');
  });
});

describe('the REST API docs page — still intact', () => {
  it('renders its h1 and the sections around the new one', () => {
    renderApi();
    expect(screen.getByRole('heading', { level: 1, name: 'REST API' })).toBeInTheDocument();
    for (const name of ['Messages', 'Misc']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
  });

  it('the Voice section sits after Messages', () => {
    const { container } = renderApi();
    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent ?? '');
    expect(headings.findIndex((h) => h.startsWith('Voice'))).toBeGreaterThan(
      headings.indexOf('Messages'),
    );
  });
});
