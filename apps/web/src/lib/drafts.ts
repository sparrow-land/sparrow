/**
 * One-time migration of the legacy localStorage draft queue to the server.
 *
 * Drafts used to live entirely in `localStorage` under `sparrow:drafts`
 * (`Record<roomId, {id,text,createdAt}[]>`); they now live server-side and the
 * app talks to the API directly. This helper is the ONLY survivor of the old
 * store: on room load it drains any locally-queued drafts for that room up to
 * the server, then forgets them. It is deliberately small and self-contained so
 * it can be deleted outright once every client has migrated.
 */
import type { Draft } from '@sparrow/common-types';

const LEGACY_KEY = 'sparrow:drafts';

/** The legacy on-disk row shape (`createdAt` was a JS timestamp, not ISO). */
interface LegacyDraft {
  id: string;
  text: string;
  createdAt: number;
}

/** Minimal slice of the API client this helper needs. */
interface DraftPoster {
  createDraft(roomId: string, text: string): Promise<Draft>;
}

/**
 * Migrate this room's legacy localStorage drafts to the server, oldest-first.
 * Each draft is removed from localStorage the instant its POST succeeds, so a
 * mid-flight failure leaves exactly the not-yet-migrated drafts behind to retry
 * on the next load (and never re-posts one twice). Other rooms are untouched.
 * Returns the number of drafts migrated. Best-effort by design — a corrupt or
 * unavailable store yields `0` rather than throwing.
 */
export async function migrateLocalDrafts(roomId: string, api: DraftPoster): Promise<number> {
  const store = readLegacyStore();
  const pending = sanitize(store[roomId]);
  if (pending.length === 0) return 0;

  let migrated = 0;
  for (const d of pending) {
    await api.createDraft(roomId, d.text);
    migrated += 1;
    // Persist progress after each success: drop the row we just uploaded.
    const rest = sanitize(readLegacyStore()[roomId]).filter((x) => x.id !== d.id);
    const next = readLegacyStore();
    if (rest.length === 0) delete next[roomId];
    else next[roomId] = rest;
    writeLegacyStore(next);
  }
  return migrated;
}

function readLegacyStore(): Record<string, LegacyDraft[]> {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, LegacyDraft[]>;
  } catch {
    return {};
  }
}

function writeLegacyStore(store: Record<string, LegacyDraft[]>): void {
  try {
    if (Object.keys(store).length === 0) localStorage.removeItem(LEGACY_KEY);
    else localStorage.setItem(LEGACY_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — migration is best-effort, so give up quietly */
  }
}

/** Keep only well-formed legacy rows; a partially corrupt list still yields its good ones. */
function sanitize(list: unknown): LegacyDraft[] {
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is LegacyDraft => {
    if (!d || typeof d !== 'object') return false;
    const o = d as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.text === 'string' && typeof o.createdAt === 'number';
  });
}
