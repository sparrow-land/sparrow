import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Draft } from '@sparrow/common-types';
import { migrateLocalDrafts } from './drafts.js';

const KEY = 'sparrow:drafts';

/** A createDraft stub that mints a server-shaped Draft per call, recording texts. */
function fakeApi() {
  const texts: string[] = [];
  let seq = 0;
  const createDraft = vi.fn(async (_roomId: string, text: string): Promise<Draft> => {
    texts.push(text);
    return { id: `drf_${seq++}`, text, createdAt: '2026-08-20T00:00:00.000Z' };
  });
  return { createDraft, texts };
}

describe('migrateLocalDrafts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('is a no-op (0 migrated) when there is no legacy store', async () => {
    const api = fakeApi();
    expect(await migrateLocalDrafts('room_a', api)).toBe(0);
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  it('is a no-op when the room has no legacy drafts', async () => {
    localStorage.setItem(KEY, JSON.stringify({ room_b: [{ id: 'x', text: 'hi', createdAt: 1 }] }));
    const api = fakeApi();
    expect(await migrateLocalDrafts('room_a', api)).toBe(0);
    expect(api.createDraft).not.toHaveBeenCalled();
    // room_b is left untouched.
    expect(JSON.parse(localStorage.getItem(KEY)!).room_b).toHaveLength(1);
  });

  it('POSTs the room’s drafts oldest-first, then clears them from localStorage', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        room_a: [
          { id: 'a', text: 'first', createdAt: 1 },
          { id: 'b', text: 'second', createdAt: 2 },
        ],
        room_b: [{ id: 'c', text: 'other', createdAt: 3 }],
      }),
    );
    const api = fakeApi();
    expect(await migrateLocalDrafts('room_a', api)).toBe(2);
    expect(api.texts).toEqual(['first', 'second']);
    const store = JSON.parse(localStorage.getItem(KEY)!);
    expect(store.room_a).toBeUndefined();
    // Other rooms are preserved for their own later migration.
    expect(store.room_b).toHaveLength(1);
  });

  it('ignores malformed / corrupt legacy entries', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ room_a: [{ id: 'ok', text: 'good', createdAt: 1 }, { text: 'no-id' }, 42] }),
    );
    const api = fakeApi();
    expect(await migrateLocalDrafts('room_a', api)).toBe(1);
    expect(api.texts).toEqual(['good']);
  });

  it('recovers from a corrupt blob → 0 migrated', async () => {
    localStorage.setItem(KEY, 'not json{');
    const api = fakeApi();
    expect(await migrateLocalDrafts('room_a', api)).toBe(0);
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  it('on a POST failure, keeps the un-migrated drafts in localStorage to retry', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        room_a: [
          { id: 'a', text: 'first', createdAt: 1 },
          { id: 'b', text: 'second', createdAt: 2 },
        ],
      }),
    );
    const createDraft = vi
      .fn((_roomId: string, text: string): Promise<Draft> => Promise.resolve({ id: 'drf_0', text, createdAt: 'x' }))
      .mockResolvedValueOnce({ id: 'drf_0', text: 'first', createdAt: 'x' })
      .mockRejectedValueOnce(new Error('boom'));
    await expect(migrateLocalDrafts('room_a', { createDraft })).rejects.toThrow('boom');
    // The successfully-posted one is gone; the failed one survives for a retry.
    const store = JSON.parse(localStorage.getItem(KEY)!);
    expect(store.room_a.map((d: { text: string }) => d.text)).toEqual(['second']);
  });
});
