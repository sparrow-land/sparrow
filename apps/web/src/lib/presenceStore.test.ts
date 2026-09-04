import { describe, it, expect, vi } from 'vitest';
import { PresenceStore } from './presenceStore.js';

/**
 * PresenceStore — the one client-side truth for principal-level presence.
 * Fed by snapshot hydrates (me/humans, me/agents) and live `presence.changed`
 * events from every subscribed room stream; read by BOTH the sidebar and the
 * chat header, so the two can never disagree (the gray-vs-green split bug).
 */
describe('PresenceStore', () => {
  it('starts unknown, learns from apply(), last writer wins', () => {
    const store = new PresenceStore();
    expect(store.isOnline('agt_1')).toBeUndefined();

    store.apply('agt_1', 'online');
    expect(store.isOnline('agt_1')).toBe(true);

    store.apply('agt_1', 'offline');
    expect(store.isOnline('agt_1')).toBe(false);
  });

  it('ignores apply() without a principal id (pre-fix server payloads)', () => {
    const store = new PresenceStore();
    store.apply(undefined, 'online');
    expect(store.onlineMap().size).toBe(0);
  });

  it('hydrate() merges snapshot entries per key without dropping others', () => {
    const store = new PresenceStore();
    store.apply('agt_live', 'online');
    store.hydrate([
      { principalId: 'usr_a', online: true },
      { principalId: 'agt_b', online: false },
    ]);
    expect(store.isOnline('usr_a')).toBe(true);
    expect(store.isOnline('agt_b')).toBe(false);
    expect(store.isOnline('agt_live')).toBe(true); // untouched by the hydrate
  });

  it('a later hydrate overrides a stale event value (wake reconcile)', () => {
    const store = new PresenceStore();
    store.apply('agt_1', 'offline'); // stale: went online while we slept
    store.hydrate([{ principalId: 'agt_1', online: true }]);
    expect(store.isOnline('agt_1')).toBe(true);
  });

  it('notifies onChange only on real transitions, with a fresh map identity', () => {
    const store = new PresenceStore();
    const fn = vi.fn();
    store.onChange(fn);

    const before = store.onlineMap();
    store.apply('agt_1', 'online');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.onlineMap()).not.toBe(before); // new identity → React re-renders

    const same = store.onlineMap();
    store.apply('agt_1', 'online'); // no-op: already online
    store.hydrate([{ principalId: 'agt_1', online: true }]); // no-op hydrate
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.onlineMap()).toBe(same); // stable identity when nothing changed
  });

  it('unsubscribes via the onChange disposer, and reset() clears all state', () => {
    const store = new PresenceStore();
    const fn = vi.fn();
    const off = store.onChange(fn);
    off();
    store.apply('agt_1', 'online');
    expect(fn).not.toHaveBeenCalled();

    store.reset();
    expect(store.isOnline('agt_1')).toBeUndefined();
    expect(store.onlineMap().size).toBe(0);
  });
});
