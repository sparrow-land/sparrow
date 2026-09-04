/**
 * SPEC "Canonical public homes" + the `DOCS_URL` / `INSTALL_URL` rows of
 * "Server configuration (env)": two env vars, two defaults, trailing slash
 * stripped, and the URL builders every emitted docs/install link goes through.
 */
import { describe, expect, it } from 'vitest';
import { envConfig } from './config.js';
import {
  DEFAULT_DOCS_URL,
  DEFAULT_INSTALL_URL,
  apiDocMarkdownUrl,
  apiDocPageUrl,
  docsHome,
  docsPageUrl,
  installArtifactUrl,
  installHome,
} from './public-homes.js';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('envConfig — DOCS_URL / INSTALL_URL', () => {
  it('defaults to the canonical homes', () => {
    const c = envConfig(env({}));
    expect(c.docsUrl).toBe('https://sparrow.land/docs');
    expect(c.installUrl).toBe('https://sparrow.land');
    expect(DEFAULT_DOCS_URL).toBe('https://sparrow.land/docs');
    expect(DEFAULT_INSTALL_URL).toBe('https://sparrow.land');
  });

  it('takes an operator override', () => {
    const c = envConfig(
      env({ DOCS_URL: 'https://mirror.example.com/d', INSTALL_URL: 'https://mirror.example.com' }),
    );
    expect(c.docsUrl).toBe('https://mirror.example.com/d');
    expect(c.installUrl).toBe('https://mirror.example.com');
  });

  it('strips trailing slashes so no emitted URL ever doubles up', () => {
    const c = envConfig(
      env({ DOCS_URL: 'https://mirror.example.com/d//', INSTALL_URL: 'https://mirror.example.com/' }),
    );
    expect(c.docsUrl).toBe('https://mirror.example.com/d');
    expect(c.installUrl).toBe('https://mirror.example.com');
  });

  it('reads an empty or whitespace value as unset (compose always defines the var)', () => {
    const c = envConfig(env({ DOCS_URL: '', INSTALL_URL: '   ' }));
    expect(c.docsUrl).toBe(DEFAULT_DOCS_URL);
    expect(c.installUrl).toBe(DEFAULT_INSTALL_URL);
  });
});

describe('docsHome / installHome', () => {
  it('apply the defaults for a config that never set them (embedded buildServer, tests)', () => {
    expect(docsHome({})).toBe(DEFAULT_DOCS_URL);
    expect(installHome({})).toBe(DEFAULT_INSTALL_URL);
  });

  it('normalize a configured value', () => {
    expect(docsHome({ docsUrl: 'https://x.example/docs/' })).toBe('https://x.example/docs');
    expect(installHome({ installUrl: 'https://x.example//' })).toBe('https://x.example');
  });
});

describe('URL builders', () => {
  const DOCS = 'https://sparrow.land/docs';

  it('builds the markdown URL a machine caller gets', () => {
    expect(apiDocMarkdownUrl(DOCS, 'rooms/status')).toBe(
      'https://sparrow.land/docs/api/rooms/status.md',
    );
    expect(apiDocMarkdownUrl(DOCS)).toBe('https://sparrow.land/docs/api/index.md');
    expect(apiDocMarkdownUrl(DOCS, '')).toBe('https://sparrow.land/docs/api/index.md');
    expect(apiDocMarkdownUrl(DOCS, 'me/inbox/')).toBe('https://sparrow.land/docs/api/me/inbox.md');
  });

  it('builds the ONE rendered reference URL a browser gets — never per segment', () => {
    expect(apiDocPageUrl(DOCS)).toBe('https://sparrow.land/docs/api/');
    expect(apiDocPageUrl('https://mirror.example.com/handbook/')).toBe(
      'https://mirror.example.com/handbook/api/',
    );
  });

  it('builds a non-api docs page URL, with the getting-started index at the root', () => {
    expect(docsPageUrl(DOCS, 'cli')).toBe('https://sparrow.land/docs/cli/');
    expect(docsPageUrl(DOCS, 'self-hosting')).toBe('https://sparrow.land/docs/self-hosting/');
    expect(docsPageUrl(DOCS)).toBe('https://sparrow.land/docs/');
    expect(docsPageUrl(DOCS, '')).toBe('https://sparrow.land/docs/');
  });

  it('builds install artifact URLs', () => {
    expect(installArtifactUrl('https://sparrow.land', 'install.sh')).toBe(
      'https://sparrow.land/install.sh',
    );
    expect(installArtifactUrl('https://sparrow.land/', '/install/sparrow.js')).toBe(
      'https://sparrow.land/install/sparrow.js',
    );
  });
});
