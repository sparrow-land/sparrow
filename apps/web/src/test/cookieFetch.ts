import { vi } from 'vitest';

/**
 * Test helper: route the app's same-origin fetches (`/api/v1/...`) to a real
 * in-process fake server, with a minimal `sparrow_session` cookie jar (Node's
 * fetch has none). `clearCookies()` simulates a fresh browser context.
 */
export interface ServerFetch {
  clearCookies(): void;
}

export function installServerFetch(baseUrl: string): ServerFetch {
  const real = globalThis.fetch.bind(globalThis);
  let cookie: string | null = null;

  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw, baseUrl);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (cookie) headers.set('cookie', cookie);
    else headers.delete('cookie');
    const res = await real(url, { ...init, headers });
    const withSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      withSetCookie.getSetCookie?.() ??
      (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
    for (const c of setCookies) {
      const m = /sparrow_session=([^;]*)/.exec(c);
      if (!m) continue;
      if (!m[1] || /max-age=0/i.test(c)) cookie = null;
      else cookie = `sparrow_session=${m[1]}`;
    }
    return res;
  }) as typeof fetch;

  vi.stubGlobal('fetch', wrapped);
  return {
    clearCookies: () => {
      cookie = null;
    },
  };
}
