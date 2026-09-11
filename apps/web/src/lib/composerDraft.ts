/**
 * UNSENT COMPOSER TEXT, kept across navigation.
 *
 * You start typing a message, switch to another conversation (or another agent,
 * or another tab) to check something, and come back — the half-drafted text is
 * still there. That is all this does.
 *
 * Deliberately NOT the server-backed draft queue (`@sparrow/common-types`'
 * `Draft`, Cmd/Ctrl+Enter, `lib/drafts.ts`): a queued draft is a thing you chose
 * to keep and the server knows about. This is scratch text that never leaves the
 * browser — nothing here is ever put on the wire.
 *
 * Backed by `localStorage`, one row per (org, room). Every access is wrapped:
 * storage can be absent, disabled, or over quota, and a composer that cannot
 * remember your text is fine — one that throws while you type is not.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

const PREFIX = 'sparrow:draft:';

/**
 * Longest draft we will store. A composer holds prose, not a pasted log; past
 * this we stop persisting rather than risk filling the origin's storage quota
 * (which would break every other `sparrow:` row too). The text stays on screen
 * either way — only the backup stops.
 */
export const COMPOSER_DRAFT_MAX_CHARS = 20_000;

/** Default write-behind delay: long enough to coalesce a burst of typing. */
export const COMPOSER_DRAFT_DEBOUNCE_MS = 300;

/**
 * Storage key for one conversation's unsent text. Scoped by org as well as room
 * so the same room id under two orgs (or a stale row after an org switch) can
 * never show one org's words in another's composer.
 */
export function draftKey(orgId: string, roomId: string): string {
  return `${PREFIX}${orgId}:${roomId}`;
}

/** The stored draft for `key`, or `''` when there is none (or storage is unusable). */
export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/**
 * Store `text` under `key`. Empty text removes the row (an empty composer is
 * the same as no draft). Text past {@link COMPOSER_DRAFT_MAX_CHARS} is dropped
 * silently, leaving whatever was last stored intact.
 */
export function saveDraft(key: string, text: string): void {
  if (text.length > COMPOSER_DRAFT_MAX_CHARS) return;
  try {
    if (text === '') localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch {
    /* storage unavailable/full — the draft just doesn't survive this page */
  }
}

/** Forget the draft for `key` (the message was sent, or deliberately dropped). */
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do — a stale row will be overwritten by the next save */
  }
}

/**
 * A composer value that remembers itself.
 *
 * Returns `[value, setValue, clear]`. `setValue` is a normal React setter
 * (functional updates included) that additionally schedules a debounced write;
 * `clear` empties the box AND forgets the stored row — call it on a successful
 * send. A FAILED send should call neither, so the text stays put.
 *
 * Changing `key` (a different conversation) flushes whatever the outgoing key
 * still owed and re-reads the incoming one, so a room never shows another
 * room's words. The pending write is also flushed on unmount and on
 * `pagehide`/`beforeunload`, which are the moments a debounce would otherwise
 * lose the last keystrokes.
 */
export function useDraft(
  key: string,
  { debounceMs = COMPOSER_DRAFT_DEBOUNCE_MS }: { debounceMs?: number } = {},
): [string, Dispatch<SetStateAction<string>>, () => void] {
  const [value, setValue] = useState(() => loadDraft(key));

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The write the timer owes, carrying the key it was typed under — a room
  // switch must not land the outgoing room's text under the incoming key.
  const pendingRef = useRef<{ key: string; text: string } | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Write the owed value now (if any) and forget it. Safe to call repeatedly. */
  const flush = useCallback(() => {
    cancelTimer();
    const owed = pendingRef.current;
    pendingRef.current = null;
    if (owed) saveDraft(owed.key, owed.text);
  }, [cancelTimer]);
  // Reachable from cleanups and listeners without re-subscribing them.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Re-initialize on key change. The CLEANUP is the load-bearing half: React
  // runs it before the next body (room switch) and on unmount (navigated away
  // mid-keystroke), which is exactly when a debounced write would be lost.
  const ownedKeyRef = useRef(key);
  useLayoutEffect(() => {
    if (ownedKeyRef.current !== key) {
      ownedKeyRef.current = key;
      setValue(loadDraft(key));
    }
    return () => flushRef.current();
  }, [key]);

  // Write-behind: each change replaces the owed write and restarts the clock,
  // so a burst of typing costs one `setItem`. Skipped when the value already IS
  // what storage holds — which covers the initial load and the post-switch
  // re-read, so neither re-writes what it just read.
  useEffect(() => {
    if (value === loadDraft(key)) {
      pendingRef.current = null;
      cancelTimer();
      return;
    }
    pendingRef.current = { key, text: value };
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const owed = pendingRef.current;
      pendingRef.current = null;
      if (owed) saveDraft(owed.key, owed.text);
    }, debounceMs);
    return cancelTimer;
  }, [key, value, debounceMs, cancelTimer]);

  // Closing the tab or backgrounding the page (bfcache) gets the same flush an
  // unmount gets — otherwise the last few characters die with the debounce.
  useEffect(() => {
    const onLeave = () => flushRef.current();
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('pagehide', onLeave);
    };
  }, []);

  const clear = useCallback(() => {
    cancelTimer();
    pendingRef.current = null;
    setValue('');
    clearDraft(keyRef.current);
  }, [cancelTimer]);

  return [value, setValue, clear];
}
