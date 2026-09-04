import { useSyncExternalStore } from 'react';
import type { PresenceState } from '@sparrow/common-types';

/**
 * PresenceStore — the ONE client-side truth for principal-level presence
 * (`usr_…`/`agt_…` → online). Every surface that shows a presence dot for a
 * principal (the sidebar HUMANS/AGENTS rows, the DM chat header, the
 * agent-offline notice) reads from here, so two surfaces can never disagree —
 * the bug this replaces was the sidebar deriving presence from its own DM-room
 * stream inference while the chat header derived it from the room snapshot,
 * splitting gray-vs-green for the same agent.
 *
 * Feeds (last writer wins — each carries the freshest server knowledge at the
 * time it lands):
 *  - {@link hydrate}: the org-scoped principal snapshots (`GET /me/humans`,
 *    `GET /me/agents`), on load AND on the workspace's wake reconcile;
 *  - {@link apply}: live `presence.changed` events from EVERY subscribed room
 *    stream (the event's MemberRef carries `principalId`), plus the active DM
 *    room's status-snapshot mapping in the Room view.
 */
export class PresenceStore {
  private map: ReadonlyMap<string, boolean> = new Map();
  private listeners = new Set<() => void>();

  /** Record one live transition. No-op without a principal id (pre-fix servers). */
  apply(principalId: string | null | undefined, state: PresenceState): void {
    if (!principalId) return;
    this.write(new Map([[principalId, state === 'online']]));
  }

  /** Merge a principal-level snapshot (keys not listed keep their last value). */
  hydrate(entries: Iterable<{ principalId: string; online: boolean }>): void {
    const next = new Map<string, boolean>();
    for (const e of entries) next.set(e.principalId, e.online);
    this.write(next);
  }

  /** `true`/`false` when known, `undefined` before any feed mentioned the principal. */
  isOnline(principalId: string): boolean | undefined {
    return this.map.get(principalId);
  }

  /**
   * The full principal → online map. Identity is stable until a real transition
   * (so it is a valid `useSyncExternalStore` snapshot).
   */
  onlineMap(): ReadonlyMap<string, boolean> {
    return this.map;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Drop everything (test isolation; the app never forgets learned presence). */
  reset(): void {
    this.map = new Map();
  }

  /** Apply `updates`, emitting one change only if some value actually flipped. */
  private write(updates: ReadonlyMap<string, boolean>): void {
    let changed = false;
    for (const [id, online] of updates) {
      if (this.map.get(id) !== online) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next = new Map(this.map);
    for (const [id, online] of updates) next.set(id, online);
    this.map = next;
    for (const fn of [...this.listeners]) fn();
  }
}

/** App-wide singleton — every stream and snapshot feeds this one store. */
export const presenceStore = new PresenceStore();

const subscribe = (fn: () => void) => presenceStore.onChange(fn);
const getSnapshot = () => presenceStore.onlineMap();

/** Live principal → online map; re-renders the consumer on any transition. */
export function usePresence(): ReadonlyMap<string, boolean> {
  return useSyncExternalStore(subscribe, getSnapshot);
}
