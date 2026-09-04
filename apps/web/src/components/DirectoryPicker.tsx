import { useEffect, useState } from 'react';
import type { HumanContact } from '@sparrow/common-types';
import { api } from '../lib/client.js';

/**
 * Org directory search (`GET /orgs/:orgId/directory?q=`) — the reach surface for
 * starting a DM or inviting someone to a room. Debounced prefix search over the
 * org's people, capped at 25 server-side. Picking a result calls `onPick`.
 */
export function DirectoryPicker({
  orgId,
  onPick,
  excludeIds,
  autoFocus = true,
  placeholder = 'Search people by name or email…',
  emptyHint,
}: {
  orgId: string;
  onPick: (human: HumanContact) => void;
  excludeIds?: ReadonlySet<string>;
  autoFocus?: boolean;
  placeholder?: string;
  emptyHint?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<HumanContact[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void api
        .directory(orgId, q.trim() || undefined)
        .then((items) => {
          if (!cancelled) setResults(items);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [orgId, q]);

  const shown = results.filter((h) => !excludeIds?.has(h.id));

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label="Search people"
        className="mono w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]"
      />
      <ul role="list" className="mt-2 max-h-64 overflow-y-auto">
        {loading && shown.length === 0 ? (
          <li className="px-2 py-2 text-xs text-[var(--sparrow-faint)]">Searching…</li>
        ) : shown.length === 0 ? (
          <li className="px-2 py-2 text-xs text-[var(--sparrow-faint)]">
            {emptyHint ?? 'No one found.'}
          </li>
        ) : (
          shown.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onPick(h)}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors hover:bg-[var(--sparrow-panel-2)]"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--sparrow-text)]">
                  {h.displayName}
                </span>
                <span className="mono min-w-0 shrink truncate text-xs text-[var(--sparrow-muted)]">
                  {h.email}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
