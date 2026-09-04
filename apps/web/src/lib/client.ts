import { SparrowClient, ApiError } from '@sparrow/client';
import {
  MeResponseSchema,
  AvatarMutationResponseSchema,
  type MePrincipal,
  type ThemePreference,
} from '@sparrow/common-types';

/**
 * The web UI is served BY the API at the same origin, so every request is
 * same-origin and authenticates with the `sparrow_session` cookie (httpOnly,
 * SameSite=Lax) the browser attaches automatically. There is exactly ONE client
 * — no per-room, per-token instances (v3 purged the localStorage room-session
 * machinery). Bearer tokens are the CLI's business; the browser rides the cookie.
 *
 * The web app's live input is the single multiplexed `/me/events` stream (see
 * `lib/meEvents`), consumed over `fetch` and same-origin too, so the cookie
 * authenticates it without a `?token=`.
 */
export const api = new SparrowClient({
  server: '',
  // Resolve `globalThis.fetch` at CALL time (not construction), so tests that
  // `vi.stubGlobal('fetch', …)` after this module is imported are honored — the
  // client is a module singleton, so a bound-at-construction fetch would miss
  // the stub. Same-origin, so cookies flow automatically.
  fetch: (input, init) => globalThis.fetch(input, init),
});

/**
 * `PATCH /me` — update the caller's human account. Pass any subset of
 * `{ displayName, theme }` (at least one). A `displayName` change propagates live
 * in every room; a `theme` change is private to the caller. Thin same-origin
 * wrapper (cookie auth); returns the updated principal. Throws {@link ApiError}.
 */
export async function updateMe(patch: {
  displayName?: string;
  theme?: ThemePreference;
}): Promise<MePrincipal> {
  const res = await fetch('/api/v1/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } };
    throw new ApiError({
      code: err.error?.code ?? 'internal',
      status: res.status,
      message: err.error?.message ?? `HTTP ${res.status}`,
    });
  }
  return MeResponseSchema.parse(body).principal;
}

async function avatarFetch(init: RequestInit): Promise<string | null> {
  const res = await fetch('/api/v1/me/avatar', init);
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = parsed as { error?: { code?: string; message?: string } };
    throw new ApiError({
      code: err.error?.code ?? 'internal',
      status: res.status,
      message: err.error?.message ?? `HTTP ${res.status}`,
    });
  }
  return AvatarMutationResponseSchema.parse(parsed).avatarUrl;
}

/**
 * `PUT /api/v1/me/avatar` — upload the caller's avatar image (png/jpeg/webp,
 * ≤ AVATAR_MAX_BYTES). The server accepts the RAW image body with an `image/*`
 * content type. Returns the freshly resolved effective `avatarUrl`. Throws
 * {@link ApiError} on rejection. Same-origin cookie auth.
 */
export async function uploadAvatar(file: File): Promise<string | null> {
  return avatarFetch({ method: 'PUT', headers: { 'content-type': file.type }, body: file });
}

/**
 * `DELETE /api/v1/me/avatar` — clear the uploaded avatar. Returns the effective
 * `avatarUrl` after clearing (provider photo → gravatar → null).
 */
export async function deleteAvatar(): Promise<string | null> {
  return avatarFetch({ method: 'DELETE' });
}
