import { vi } from 'vitest';
import { api } from '../lib/client.js';

/**
 * Shared client stub for web tests. The `api` singleton binds `globalThis.fetch`
 * at CALL time, but tests also touch the bare `fetch` (e.g. same-origin probes),
 * so we point BOTH at the mock and restore afterwards. This mirrors the
 * `useFetch` helper duplicated across the route tests, centralized.
 */
type WithFetch = { _fetch: typeof fetch };
const REAL_FETCH = (api as unknown as WithFetch)._fetch;

export function useFetch(f: typeof fetch): void {
  vi.stubGlobal('fetch', f);
  (api as unknown as WithFetch)._fetch = f;
}

export function restoreFetch(): void {
  (api as unknown as WithFetch)._fetch = REAL_FETCH;
  vi.unstubAllGlobals();
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorJson(code: string, status: number, message = code): Response {
  return json({ error: { code, message } }, status);
}

/** A binary response (e.g. TTS speech), streamable/decodable like the real API. */
export function binary(bytes: Uint8Array, contentType: string, status = 200): Response {
  return new Response(bytes as BlobPart, { status, headers: { 'Content-Type': contentType } });
}
