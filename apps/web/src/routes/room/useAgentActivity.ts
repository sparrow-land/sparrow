import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry } from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { useAgentStream, type AgentStream } from '../../lib/agentStream.js';

/**
 * One agent's NON-CHAT timeline, live — the data half of "a conversation pane is
 * an activity stream" (SPEC v4 → *Web UI → the conversation view is an activity
 * stream*).
 *
 * The room route stays the authority for chat; this hook supplies only the
 * entries that come from the other mediums, plus the disposition overrides that
 * let a live `email.resolved` mutate a card WITHOUT a refetch. Callers merge the
 * two with `mergeStream` / `collapseStream`.
 *
 * Authorization is the SERVER's: a viewer who may not read the timeline gets a
 * `404`/`403` from the route and this hook degrades SILENTLY to "no entries", so
 * the pane is byte-for-byte v3's chat transcript. The client never filters for
 * authorization and never learns a medium exists by taking a 404 — `enabled` is
 * driven by `GET /capabilities` upstream.
 *
 * **The wire descends; this hook normalizes to ascending.** `GET …/activity` is
 * a transcript now — newest-first, paged backward with `before` — but a
 * conversation pane reads FORWARD, and `mergeStream`/`collapseStream` are
 * written against an ascending column (a collapsed run's `newest` is its LAST
 * entry). So a fetched page is reversed on the way in and live entries are
 * appended at the end, which is where "now" belongs in an ascending column.
 */

/** How many entries the visible window holds (one page, like every v3 list). */
export const ACTIVITY_WINDOW = 100;

export interface AgentActivity extends AgentStream {
  /** The agent's non-chat entries, ASCENDING (see the note above). */
  entries: ActivityEntry[];
}

export interface UseAgentActivityArgs {
  orgId: string;
  /** The counterpart agent, or `null` to stay pure chat (no fetch, no stream). */
  agentId: string | null;
  /** The caller OWNS this agent, so `activity.appended` reaches them. */
  owned: boolean;
}

const EMPTY: ActivityEntry[] = [];

export function useAgentActivity({ orgId, agentId, owned }: UseAgentActivityArgs): AgentActivity {
  const [entries, setEntries] = useState<ActivityEntry[]>(EMPTY);

  /** Refetch the HEAD of the visible window (reconnect / gap / poll reconcile). */
  const load = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await api.agentActivity(orgId, agentId, { limit: ACTIVITY_WINDOW });
      // The wire hands back the NEWEST page first; the pane reads forward.
      setEntries([...res.items].reverse());
    } catch {
      // 404/403 (not permitted, or the agent is gone) and anything else alike:
      // the pane degrades to pure chat rather than surfacing an error.
      setEntries(EMPTY);
    }
  }, [orgId, agentId]);

  // Initial load. Off entirely without an agent counterpart / without the medium.
  useEffect(() => {
    if (!agentId) {
      setEntries(EMPTY);
      return;
    }
    void load();
  }, [agentId, load]);

  const loadRef = useRef(load);
  loadRef.current = load;

  const onAppended = useCallback((entry: ActivityEntry) => {
    // "Now" is the END of an ascending column.
    setEntries((cur) => (cur.some((e) => e.id === entry.id) ? cur : [...cur, entry]));
  }, []);

  const { dispositionOf } = useAgentStream({
    agentId,
    owned,
    onAppended,
    onReconcile: () => void loadRef.current(),
  });

  return useMemo(() => ({ entries, dispositionOf }), [entries, dispositionOf]);
}
