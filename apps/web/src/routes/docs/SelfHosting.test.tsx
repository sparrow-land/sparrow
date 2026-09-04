import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SelfHosting } from './SelfHosting.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <SelfHosting />
    </MemoryRouter>,
  );
}

function terminals(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.terminal code')].map((c) => c.textContent ?? '');
}

function terminalContaining(container: HTMLElement, needle: string): string {
  const hit = terminals(container).find((t) => t.includes(needle));
  if (!hit) throw new Error(`no terminal block containing "${needle}"`);
  return hit;
}

function flatText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

/**
 * This page is the only place a self-hoster gets a runnable file, so it must
 * mirror the SHIPPED artifacts — the published image name and the repo's own
 * `compose.yaml` — rather than a plausible-looking approximation. `sparrow:latest`
 * was neither: no such tag is published anywhere.
 */
describe('Self-hosting — mirrors the shipped image and compose.yaml', () => {
  it('names the published image, never a bare `sparrow:latest`', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toContain('ghcr.io/sparrow-land/sparrow');
    // The unqualified tag (no registry, no org) never existed — only a local build
    // is ever called that, and it is not what a self-hoster should be told to run.
    expect(text).not.toMatch(/(^|[\s:])sparrow:latest/);
  });

  it('docker run pulls the published image with a volume and BASE_URL', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, 'docker run');
    expect(code).toContain('ghcr.io/sparrow-land/sparrow');
    expect(code).toContain('-v sparrow-data:/data');
    expect(code).toContain('-e BASE_URL=https://sparrow.example.com');
    expect(code).toContain('ADMIN_TOKEN=');
  });

  it('the compose example carries the real compose.yaml semantics', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, 'services:');
    // Project name pinned, so the data volume is stable across checkout directories.
    expect(code).toContain('name: sparrow');
    // Overridable image + host port, and a BASE_URL DERIVED from that port.
    expect(code).toContain('image: ${SPARROW_IMAGE:-ghcr.io/sparrow-land/sparrow:latest}');
    expect(code).toContain('"${SPARROW_PORT:-8722}:8722"');
    expect(code).toContain('BASE_URL: ${BASE_URL:-http://localhost:${SPARROW_PORT:-8722}}');
    expect(code).toContain('ADMIN_TOKEN: ${ADMIN_TOKEN:-}');
    expect(code).toContain('OPEN_ORG_CREATION: ${OPEN_ORG_CREATION:-true}');
    // Passthroughs that only exist on the compose path.
    for (const v of ['LOG_LEVEL', 'CORS_ALLOWED_ORIGINS', 'ELEVENLABS_API_KEY', 'VOICE_PROVIDER']) {
      expect(code).toContain(`${v}: \${${v}:-}`);
    }
    // The whole email medium, all optional — unset means the medium is off.
    for (const v of [
      'EMAIL_ORG_SUFFIX',
      'EMAIL_PROVIDER',
      'EMAIL_INBOUND_TOKEN',
      'EMAIL_WEBHOOK_URL',
      'EMAIL_WEBHOOK_TOKEN',
    ]) {
      expect(code).toContain(`${v}: \${${v}:-}`);
    }
    // One named volume, mounted at /data.
    expect(code).toContain('- sparrow-data:/data');
    expect(code).toMatch(/volumes:\s*\n\s*sparrow-data:/);
  });

  it('documents the compose-level knobs (SPARROW_IMAGE / SPARROW_PORT) and second instances', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toContain('SPARROW_IMAGE');
    expect(text).toContain('SPARROW_PORT');
    // A second instance needs its own project name, or it rebinds the first.
    expect(text).toMatch(/docker compose -p sparrow2/);
  });

  it('tells an operator how to lock signup down after the first human', () => {
    const { container } = renderPage();
    const heading = screen.getByRole('heading', { name: /lock it down/i });
    expect(heading).toBeInTheDocument();
    const text = flatText(container);
    expect(text).toContain('auth.allowSignup');
    const code = terminalContaining(container, 'auth.allowSignup');
    expect(code).toContain('PUT');
    expect(code).toContain('/api/v1/config');
    // The admin token is the only credential these routes accept.
    expect(code).toContain('x-admin-token');
  });

  it('says the whole volume is the backup, and names the WAL files', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(screen.getByRole('heading', { name: /backups/i })).toBeInTheDocument();
    expect(text).toMatch(/sparrow\.db/);
    expect(text).toMatch(/attachments\//);
    expect(text).toMatch(/WAL/);
    // The trap: copying sparrow.db alone loses the -wal/-shm sidecars.
    expect(text).toMatch(/-wal/);
    expect(text).toMatch(/-shm/);
    expect(text).toMatch(/whole volume/i);
  });

  it('keeps the operational sections', () => {
    renderPage();
    for (const h of [/bootstrap/i, /docker run/i, /docker compose/i, /environment variables/i, /reverse proxy/i]) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
    }
  });
});
