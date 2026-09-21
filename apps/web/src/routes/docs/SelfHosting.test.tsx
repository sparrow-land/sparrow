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

function wordCount(container: HTMLElement): number {
  return flatText(container).trim().split(/\s+/).filter(Boolean).length;
}

describe('Self-hosting — structure', () => {
  it('runs the operator through the sections in order', () => {
    const { container } = renderPage();
    const h2s = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(h2s).toEqual([
      'Run it',
      'docker compose',
      'Where to run it',
      'Configuration',
      'Lock it down',
      'Backups',
      'Behind a proxy',
      'Upgrades',
      'Docs and the installer live at sparrow.land',
    ]);
  });

  it('opens on one container, one volume, and the volume as the backup', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(screen.getByRole('heading', { level: 1, name: /self-hosting/i })).toBeInTheDocument();
    expect(text).toMatch(/one container/i);
    expect(text).toMatch(/one volume/i);
  });
});

/**
 * The page is the only place a self-hoster gets a runnable command, so it must
 * mirror the SHIPPED artifacts: the published image, the README's one-liner, and
 * the repo's own `compose.yaml`.
 */
describe('Self-hosting — Run it', () => {
  it('leads with the README one-liner', () => {
    const { container } = renderPage();
    const first = terminals(container)[0] ?? '';
    expect(first.trim()).toBe(
      'docker run -it -p 8722:8722 -v sparrow-data:/data ghcr.io/sparrow-land/sparrow',
    );
  });

  it('then gives the production form with BASE_URL and an ADMIN_TOKEN', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, '--name sparrow');
    expect(code).toContain('-p 8722:8722');
    expect(code).toContain('-v sparrow-data:/data');
    expect(code).toContain('-e BASE_URL=https://sparrow.yourcompany.com');
    expect(code).toContain('-e ADMIN_TOKEN=$(openssl rand -hex 24)');
    expect(code).toContain('ghcr.io/sparrow-land/sparrow:latest');
  });

  it('never names a bare `sparrow:latest` (no such tag is published)', () => {
    const { container } = renderPage();
    expect(flatText(container)).not.toMatch(/(^|[\s:])sparrow:latest/);
  });

  it('says what BASE_URL is for, and who owns the workspace', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/BASE_URL is the origin invite URLs are built from/i);
    // The example host is a placeholder, and the page says so in words.
    expect(text).toMatch(/sparrow\.yourcompany\.com stands for your (own )?public URL/i);
    expect(text).toMatch(/first account to sign up owns the workspace/i);
    expect(text).toMatch(/invite/i);
  });
});

describe('Self-hosting — docker compose', () => {
  it('carries the real compose.yaml semantics', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, 'services:');
    // Project name pinned, so the data volume is stable across checkout directories.
    expect(code).toContain('name: sparrow');
    expect(code).toContain('image: ${SPARROW_IMAGE:-ghcr.io/sparrow-land/sparrow:latest}');
    expect(code).toContain('"${SPARROW_PORT:-8722}:8722"');
    expect(code).toContain('BASE_URL: ${BASE_URL:-http://localhost:${SPARROW_PORT:-8722}}');
    expect(code).toContain('ADMIN_TOKEN: ${ADMIN_TOKEN:-}');
    expect(code).toContain('OPEN_ORG_CREATION: ${OPEN_ORG_CREATION:-true}');
    for (const v of ['LOG_LEVEL', 'CORS_ALLOWED_ORIGINS', 'ELEVENLABS_API_KEY', 'VOICE_PROVIDER']) {
      expect(code).toContain(`${v}: \${${v}:-}`);
    }
    for (const v of [
      'EMAIL_ORG_SUFFIX',
      'EMAIL_PROVIDER',
      'EMAIL_INBOUND_TOKEN',
      'EMAIL_WEBHOOK_URL',
      'EMAIL_WEBHOOK_TOKEN',
    ]) {
      expect(code).toContain(`${v}: \${${v}:-}`);
    }
    expect(code).toContain('- sparrow-data:/data');
    expect(code).toMatch(/volumes:\s*\n\s*sparrow-data:/);
  });

  it('says values are overridable and BASE_URL follows SPARROW_PORT', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/overridable from the environment/i);
    expect(text).toContain('SPARROW_IMAGE');
    expect(text).toContain('SPARROW_PORT');
  });

  it('gives the second-instance recipe with its own project name and volume', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, 'sparrow2');
    expect(code).toContain('SPARROW_PORT=8798');
    expect(code).toContain('BASE_URL=http://localhost:8798');
    expect(code).toContain('docker compose -p sparrow2 up -d');
    expect(flatText(container)).toMatch(/_sparrow-data/);
  });
});

/** The README's stance: private network, not the open internet. */
describe('Self-hosting — Where to run it', () => {
  it('carries the private-network stance', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(screen.getByRole('heading', { name: /where to run it/i })).toBeInTheDocument();
    expect(text).toMatch(/Tailscale/);
    expect(text).toMatch(/private network/i);
    expect(text).toMatch(/not hardened for the open internet/i);
    expect(text).toMatch(/just does the messaging/i);
    // It DOES have auth; the point is what that auth is scoped for.
    expect(text).toMatch(/agent keys/i);
  });
});

describe('Self-hosting — Configuration', () => {
  it('tables the variables an operator actually sets', () => {
    const { container } = renderPage();
    const table = container.querySelector('table');
    const text = (table?.textContent ?? '').replace(/\s+/g, ' ');
    for (const v of [
      'PORT',
      'DATA_DIR',
      'BASE_URL',
      'ADMIN_TOKEN',
      'OPEN_ORG_CREATION',
      'AUTH_ALLOW_SIGNUP',
      'AUTH_ALLOWED_EMAIL_PATTERNS',
      'LOG_LEVEL',
      'CORS_ALLOWED_ORIGINS',
      'EMAIL_ORG_SUFFIX',
      'ELEVENLABS_API_KEY',
      'VOICE_PROVIDER',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'PRESENCE_GRACE_SECONDS',
    ]) {
      expect(text).toContain(v);
    }
    // Defaults that bite if wrong.
    expect(text).toContain('8722');
    expect(text).toContain('/data');
    expect(text).toMatch(/404/);
  });

  it('points at SPEC.md for the full list', () => {
    const { container } = renderPage();
    expect(flatText(container)).toMatch(/SPEC\.md/);
  });
});

describe('Self-hosting — Lock it down', () => {
  it('gives the env fallbacks for a locked-down first boot', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, 'AUTH_ALLOW_SIGNUP');
    expect(code).toContain('AUTH_ALLOW_SIGNUP=false');
    expect(code).toContain('AUTH_ALLOWED_EMAIL_PATTERNS=');
    expect(code).toContain('*@yourcompany.com');
    expect(code).toContain('OPEN_ORG_CREATION=false');
  });

  it('gives the runtime config route, which takes the admin token and nothing else', () => {
    const { container } = renderPage();
    const code = terminalContaining(container, 'auth.allowSignup');
    expect(code).toContain('PUT');
    expect(code).toContain('/api/v1/config');
    expect(code).toContain('x-admin-token');
    // And the read-back.
    expect(code).toMatch(/curl[^\n]*\/api\/v1\/config -H "x-admin-token/);
    // Both curls address the deployed instance by the page's ONE example host.
    for (const url of [...code.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0])) {
      expect(url).toContain('sparrow.yourcompany.com');
    }
  });

  it('keeps the resolution order and the 404 without an admin token', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/database value → environment variable → default/);
    expect(text).toMatch(/ADMIN_TOKEN unset[^.]*404|404[^.]*ADMIN_TOKEN/i);
  });
});

describe('Self-hosting — Backups', () => {
  it('names the volume, the WAL sidecars, and the online backup command', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/whole volume/i);
    expect(text).toContain('sparrow.db');
    expect(text).toContain('attachments/');
    expect(text).toContain('WAL');
    expect(text).toContain('-wal');
    expect(text).toContain('-shm');
    expect(text).toMatch(/SIGTERM/);
    const code = terminalContaining(container, 'sqlite3');
    expect(code).toContain('sqlite3 sparrow.db ".backup /snap/sparrow.db"');
  });
});

describe('Self-hosting — Behind a proxy', () => {
  it('names both SSE paths and the buffering rule', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toContain('GET /api/v1/rooms/:id/events');
    expect(text).toContain('GET /api/v1/me/events');
    expect(text).toMatch(/buffering/i);
    expect(text).toMatch(/sticky sessions/i);
    expect(text).toMatch(/SameSite=Lax/);
    expect(text).toContain('CORS_ALLOWED_ORIGINS');
  });
});

/**
 * SPEC (Data model): "Fresh databases only across majors — v4 ships no migration
 * chain from earlier majors"; *within* v4 `migrate()` runs on boot. The page said
 * v3 until the 2026-09 rebuild.
 */
describe('Self-hosting — Upgrades', () => {
  it('states in-major migrations on boot and no chain from earlier majors', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/v4/);
    expect(text).not.toMatch(/pre-v3|v3 ships/);
    expect(text).toMatch(/no migration chain/i);
    expect(text).toMatch(/on boot/i);
  });
});

describe('Self-hosting — docs and installer', () => {
  it('states the one home and the two redirect overrides', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toContain('sparrow.land/docs');
    expect(text).toContain('https://sparrow.land/install.sh');
    expect(text).toContain('DOCS_URL');
    expect(text).toContain('INSTALL_URL');
    expect(text).toMatch(/redirect/i);
  });

  it('closes by pointing at Getting started', () => {
    renderPage();
    expect(screen.getByRole('link', { name: /getting started/i })).toBeInTheDocument();
  });
});

/** The rebuild exists because the old page was an essay. Hold the line. */
describe('Self-hosting — reads like a human wrote it', () => {
  it('stays inside its word budget', () => {
    const { container } = renderPage();
    const words = wordCount(container);
    expect(words).toBeLessThanOrEqual(850);
  });

  it('drops the old page’s wordiest phrases', () => {
    const { container } = renderPage();
    const text = flatText(container);
    for (const phrase of [
      'not yours to serve',
      'the defaults are the product',
      'deliberately',
      'the whole story',
      'is the same story',
    ]) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
  });
});
