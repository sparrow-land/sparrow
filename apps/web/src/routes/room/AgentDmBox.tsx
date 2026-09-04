import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentDmBox, Message } from '@sparrow/common-types';
import type { PrincipalEvent } from '@sparrow/client';
import { api } from '../../lib/client.js';
import { useMeEventStream } from '../../lib/meEvents.js';
import { formatRelativeTime } from '../../lib/time.js';
import { MessageBody } from '../../components/MessageBody.js';
import { MediumGlyph, infoBoxToneStyle } from '../../components/MediumGlyph.js';

/**
 * Agent↔agent DM oversight — the ambient "who are my agents talking to each
 * other about" surface (SPEC "Direct conversations"). A collapsed card per
 * conversation, expandable in place to READ the thread, with NO composer and NO
 * unread count, interleaved into the human's DM pane with an involved agent —
 * the exact analogue of the email cards on that same rail (`interleaveAgentDms`
 * in `lib/activity.ts` does the positioning; `Room` renders the cards).
 *
 * The data is a human READ view onto rooms the human is not a member of, served
 * by `GET /orgs/:orgId/agent-dms(/:roomId/messages)` and gated server-side by
 * "can this human currently see BOTH agents" — so the set of boxes tracks the
 * caller's live visibility with no client authorization of its own.
 */

/**
 * The live box list. Fetches once, then reconciles on anything that can add,
 * drop, or update a box: a DM message (activity.appended, chat), a sharing
 * change, a room membership change, or a replay gap. The list read is cheap and
 * idempotent, so a broad trigger set costs little and closes every "box did not
 * appear/vanish" hole. Live like the email cards, it rides the app's ONE
 * `/me/events` fan-in; nothing here ever badges or notifies — the box is
 * ambient by design. `enabled: false` fetches nothing.
 */
export function useAgentDmBoxes({
  orgId,
  enabled,
}: {
  orgId: string;
  enabled: boolean;
}): { boxes: AgentDmBox[]; loaded: boolean } {
  const [boxes, setBoxes] = useState<AgentDmBox[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await api.agentDms(orgId);
      setBoxes(res.items);
    } catch {
      // Ambient surface: a transient failure keeps whatever we last had rather
      // than shouting an error onto the conversation.
    } finally {
      setLoaded(true);
    }
  }, [orgId, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const onEvent = useCallback((ev: PrincipalEvent) => {
    switch (ev.type) {
      case 'activity.appended': {
        const medium = (ev.data as { entry?: { medium?: string } } | undefined)?.entry?.medium;
        if (medium === 'chat') void reloadRef.current();
        return;
      }
      case 'agent.shared':
      case 'agent.unshared':
      case 'member.joined':
      case 'member.removed':
      // A human severed (or re-allowed) a pair anywhere — every overseer of
      // that pair gets the event, so every open box restates itself.
      case 'dm.severed':
      case 'dm.allowed':
      case 'replay.gap':
        void reloadRef.current();
        return;
      // Clawback (SPEC "Clawback") deliberately gets NO extra trigger here.
      // `message.clawback` is a ROOM event: it fans out to the agent DM's own
      // members, and this human overseer is not one, so no frame ever reaches
      // this client to key a reload on. If a clawed message was the box's
      // `lastMessage`, the preview is stale until the next chat
      // `activity.appended` / reconnect reload restates the list — acceptable
      // for an ambient, unread-free surface (and the expanded transcript is
      // re-read from the server on expand, which never shows a dead row).
      default:
        return;
    }
  }, []);
  useMeEventStream({ enabled, onEvent, onReconnect: () => void reloadRef.current() });

  return { boxes, loaded };
}

/** One collapsed conversation, expandable in place to a read-only transcript. */
export function AgentDmCard({ orgId, box }: { orgId: string; box: AgentDmBox }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());
  /**
   * The sever state, held locally so the control answers immediately. The
   * server's value (via the box) wins whenever it changes: the SSE reload
   * behind this list is the authority, this is only the optimistic echo.
   */
  const [severedLocal, setSeveredLocal] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [governError, setGovernError] = useState<string | null>(null);
  const serverSevered = box.severedAt;
  useEffect(() => setSeveredLocal(undefined), [serverSevered]);
  const severedAt = severedLocal === undefined ? serverSevered : severedLocal;
  const label = `${box.agents[0].name} ↔ ${box.agents[1].name}`;

  /**
   * Sever / allow — the only WRITE on this otherwise read-only surface, and it
   * is shown ONLY to a human the server says may govern the pair (`canSever`:
   * an org owner/admin, or an owner of one of the two agents). Severing cuts
   * the agents off; it never removes what they already said from this card.
   */
  const govern = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setGovernError(null);
    try {
      if (severedAt) {
        await api.allowAgentDm(orgId, box.roomId);
        setSeveredLocal(null);
      } else {
        const sever = await api.severAgentDm(orgId, box.roomId);
        setSeveredLocal(sever.severedAt);
      }
    } catch {
      setGovernError(
        severedAt
          ? 'Could not allow this pair — an org owner or admin may need to lift it.'
          : 'Could not sever this conversation.',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, severedAt, orgId, box.roomId]);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && messages === null) {
      try {
        // Oldest-first for reading (the wire is newest-first); reading writes no
        // state — the box is a peek.
        const res = await api.agentDmMessages(orgId, box.roomId);
        setMessages([...res.items].reverse());
      } catch {
        setError('This conversation is no longer available to you.');
      }
    }
  }, [open, messages, orgId, box.roomId]);

  return (
    // The Tinted Etch container in the DM tone, at the full compact density —
    // an ambient one-line row like the hint box (no badge or link sets a floor
    // here the way it does on the email box).
    <div
      style={infoBoxToneStyle('agent-dm')}
      className="info-box flex flex-col gap-2 rounded-lg"
    >
      <div className="flex min-w-0 items-center">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-[7px] px-2 py-[5px] text-left"
      >
        {open ? (
          <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-[var(--sparrow-faint)]" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-[var(--sparrow-faint)]" />
        )}
        {/* The box's type mark, from the SAME registry as every other info
            box: paired speech bubbles + the bold "DM" word in the dm tone —
            two agents talking to each other. (The old hand-rolled icon + gray
            pill duplicated what the registry now says once.) */}
        <MediumGlyph medium="agent-dm" />
        <span className="shrink-0 text-xs font-medium text-[var(--sparrow-text)]">{label}</span>
        {box.lastMessage ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--sparrow-muted)]">
            {box.lastMessage.preview}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {box.lastMessage ? (
          <span className="shrink-0 text-[10.5px] text-[var(--sparrow-faint)]">
            {formatRelativeTime(box.lastMessage.at, nowMs)}
          </span>
        ) : null}
      </button>
        {severedAt ? (
          <span className="mr-1 shrink-0 rounded-full border border-[var(--sparrow-border)] px-2 py-0.5 text-[10.5px] text-[var(--sparrow-muted)]">
            Severed
          </span>
        ) : null}
        {box.canSever ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void govern()}
            className="mr-2 shrink-0 rounded-md border border-[var(--sparrow-border)] px-2 py-0.5 text-[10.5px] text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
          >
            {severedAt ? 'Allow' : 'Sever'}
          </button>
        ) : null}
      </div>
      {governError ? (
        <p className="px-2 pb-1 text-[11px] text-[var(--sparrow-danger)]">{governError}</p>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-2 border-t border-[var(--sparrow-border)] px-3 py-2">
          {error ? (
            <p className="text-xs text-[var(--sparrow-danger)]">{error}</p>
          ) : messages === null ? (
            <p className="text-xs text-[var(--sparrow-faint)]">Loading…</p>
          ) : messages.length === 0 ? (
            <p className="text-xs text-[var(--sparrow-muted)]">No messages yet.</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="text-sm">
                <span className="mr-2 text-xs font-medium text-[var(--sparrow-muted)]">
                  {m.from.displayName}
                </span>
                {/* Block wrapper: MessageBody emits block markdown (tables, lists). */}
                <div className="text-[var(--sparrow-text)]">
                  <MessageBody text={m.body} />
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
