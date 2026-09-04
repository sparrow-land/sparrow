import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Mic, Reply, Settings } from 'lucide-react';
import type {
  Member,
  MemberRefKind,
  InboxItem,
  Message,
  MessageStatus,
  MessageClawbackEvent,
  MessageReadEvent,
  MessageReceivedEvent,
  PresenceChangedEvent,
  RoomUpdatedEvent,
  StatusChangedEvent,
  Room as RoomResource,
  Draft,
} from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../lib/client.js';
import { wire, orgPath, roomSettingsPath } from '../lib/ids.js';
import { useAuth } from '../lib/auth.js';
import { useOrg } from '../lib/org.js';
import { useWorkspace } from '../lib/workspace.js';
import { useShell } from '../components/AppShell.js';
import { buildConversation, statusById, unreadCounts, type ThreadItem } from '../lib/conversation.js';
import { formatRelativeTime } from '../lib/time.js';
import {
  hydrateStatuses,
  pruneExpired,
  statusForPartner,
  membersWithStatus,
  activeRoomStatuses,
  applyStatusEvent,
  type StatusMap,
} from '../lib/status.js';
import { presenceDot, applyPresenceEvent } from '../lib/presence.js';
import { presenceStore, usePresence } from '../lib/presenceStore.js';
import { avatarSeed, readAvatarUrl } from '../lib/avatar.js';
import { Avatar } from '../components/Avatar.js';
import { PresenceAvatar } from '../components/PresenceAvatar.js';
import { WorkingBubble } from '../components/StatusIndicator.js';
import { MessageBody } from '../components/MessageBody.js';
import { CopyMessageButton } from '../components/CopyMessageButton.js';
import { AddPeopleModal, AddAgentModal } from '../components/AddMemberModals.js';
import { Composer, type ReplyEcho } from './room/Composer.js';
import { SpeakerButton } from './room/SpeakerButton.js';
import type { HandsFreeIncoming } from './room/HandsFreeOverlay.js';
import { Attachment } from './room/Attachment.js';
import { useCapabilities } from '../lib/capabilities.js';
import { DraftsModal } from './room/DraftsModal.js';
import { AgentOfflineNotice } from './room/AgentOfflineNotice.js';
import { migrateLocalDrafts } from '../lib/drafts.js';
import { roomStreams } from '../lib/roomStreams.js';
import { useAgentActivity } from './room/useAgentActivity.js';
import { ActivityRow } from './room/ActivityRows.js';
import { AgentDmCard, useAgentDmBoxes } from './room/AgentDmBox.js';
import { mergeStream, collapseStream, interleaveAgentDms } from '../lib/activity.js';
import { stageFiles, fileToAttachmentInput, type PendingAttachment } from '../lib/attachments.js';
import { registerHotkey } from '../lib/hotkeys.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

// How many messages of room history the pane loads (SPEC caps `limit` at 200).
const HISTORY_LIMIT = 100;

// Wake/reconnect reconcile throttle: minimum gap between full reconciles for one
// room, so tab focus-flapping (visibilitychange/focus/online firing in bursts)
// can't hammer the API. Leading-edge — the first signal reconciles immediately,
// further signals inside the window are dropped.
const RECONCILE_THROTTLE_MS = 5_000;

// How long the transient "Message pulled back" note lingers after a clawback.
const CLAWBACK_NOTE_MS = 4_000;

/**
 * How much of an arriving message the live region reads out. Long enough to
 * carry the gist, short enough that a screen reader isn't stuck narrating a wall
 * of text before the user can act.
 */
export const ANNOUNCE_PREVIEW_CHARS = 120;

/**
 * A one-line, speakable preview of a message body: markdown line structure and
 * runs of whitespace collapse to single spaces (a screen reader reads the string
 * verbatim), then it is truncated with an ellipsis.
 */
export function announcePreview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= ANNOUNCE_PREVIEW_CHARS) return flat;
  return `${flat.slice(0, ANNOUNCE_PREVIEW_CHARS - 1).trimEnd()}…`;
}

/**
 * Room view (`/org/:orgId/rooms/:roomId`). The room IS the broadcast conversation
 * for a project room, or the single direct conversation for a DM room. Per-DM
 * threads with other principals are reached from the sidebar, not here. Keyed by
 * roomId in App so switching rooms remounts with fresh state.
 */
export function Room() {
  const navigate = useNavigate();
  const { roomId: bareRoomId = '' } = useParams<{ roomId: string }>();
  const roomId = wire('room', bareRoomId);
  const { orgId } = useOrg();
  const auth = useAuth();
  const ws = useWorkspace();
  const { reportBroadcastUnread } = useShell();

  const [room, setRoom] = useState<RoomResource | null>(null);
  const [self, setSelf] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  // The room's conversation history (`GET /rooms/:id/messages`, newest-first) —
  // THE source of what the thread renders. Delivery rows are not a visibility
  // filter: a member who joined late has none, and used to see an empty room.
  const [history, setHistory] = useState<Message[]>([]);
  // The caller's OPEN delivery rows (unread + received) for this room. Never a
  // content source — only the read-state the thread renders and advances.
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [receipts, setReceipts] = useState<Record<string, MessageStatus>>({});
  const [draft, setDraft] = useState('');
  // Hands-free mode (voice v2). The overlay owns the spoken turn end to end —
  // nothing dictated reaches this composer any more — so the room keeps only
  // what the overlay cannot know: whether the mode is up, and which arrivals
  // belong to it. `handsFreeOpenRef` shadows the state because the live stream
  // handler is a stable closure that must read the CURRENT value.
  const handsFreeOpenRef = useRef(false);
  const [voiceIncoming, setVoiceIncoming] = useState<HandsFreeIncoming[]>([]);
  /**
   * Message ids hands-free mode has already been handed (seeded on open with
   * everything then on screen). The queue cannot be derived from "what the
   * announcer called an arrival": THREE places write `historyRef` — the
   * `message.new` handler, the wake/reconnect reconcile, and the send's own
   * re-list — and only the first announces. A reply absorbed by either of the
   * others is real, on screen, and (without this) never spoken, leaving the
   * overlay waiting for something that already came.
   */
  const voiceSeenRef = useRef<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Files staged on the composer (paste / paperclip / drag-drop), sent with the
  // next composed message. Cleared on a successful send; kept on failure. Room is
  // keyed by roomId so these reset when switching rooms.
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [statusNow, setStatusNow] = useState(Date.now());
  const [onlineIds, setOnlineIds] = useState<Set<string>>(() => new Set());
  // True once the initial `GET /status` (presence hydration) has resolved. The
  // agent-offline notice waits for this so it never flashes before we know who
  // is online.
  const [presenceHydrated, setPresenceHydrated] = useState(false);
  const [addPeople, setAddPeople] = useState(false);
  const [addAgent, setAddAgent] = useState(false);
  // Server-backed draft queue for THIS room (loaded on mount; Room is keyed by
  // roomId in App, so it remounts on room switch and refetches the right room's).
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);

  const isDm = room?.kind === 'dm';
  const meRoom = ws.rooms.find((r) => r.room.id === roomId);
  const counterpart = meRoom?.room.counterpart ?? null;
  const archived = room?.archivedAt != null;
  // The tab names the conversation, so history and the window list are
  // readable: `@dana` for a DM, `#general` for a broadcast room. Null until the
  // room resolves, so the tab never flashes a placeholder.
  const conversationTitle = room
    ? isDm
      ? `@${counterpart?.displayName ?? 'direct message'}`
      : `#${room.name || 'room'}`
    : null;
  // `null` while the room read is in flight, so the tab keeps whatever it had
  // instead of flashing the bare product name for the length of the fetch —
  // routing the not-yet-known subject through `pageTitle` would turn "still
  // loading" into a real title ("sparrow") and defeat the hook's null contract.
  useDocumentTitle(conversationTitle === null ? null : pageTitle(conversationTitle));

  // The conversation pane is an ACTIVITY STREAM (SPEC v4). The timeline is
  // anchored to an AGENT, not a room, so non-chat entries interleave only in a
  // DM pane whose counterpart is an agent — a broadcast room stays pure chat.
  // NOT gated on `capabilities.email`: the timeline is core (hint deliveries
  // ride it with the email medium off; email entries simply don't exist then).
  // Whether the viewer may READ it is the server's call: 404/403 degrade
  // silently to pure chat.
  const caps = useCapabilities();
  const activityAgentId = isDm && counterpart?.type === 'agent' ? counterpart.id : null;
  const ownsAgent = ws.agents.some(
    (a) => a.agent.id === activityAgentId && a.sharedBy === null,
  );
  const activity = useAgentActivity({ orgId, agentId: activityAgentId, owned: ownsAgent });

  // Agent↔agent DM oversight boxes interleave in a DM pane with an AGENT
  // counterpart — the same rail the email cards ride, per the ambient-oversight
  // design (the box for `vm8 ↔ vm9` shows in the human's DM with vm8 AND with
  // vm9). The server already scopes the list to pairs this human can currently
  // see both of.
  const agentDms = useAgentDmBoxes({ orgId, enabled: activityAgentId !== null });
  const counterpartDmBoxes = activityAgentId
    ? agentDms.boxes.filter((b) => b.agents.some((a) => a.id === activityAgentId))
    : [];

  // Refs so the long-lived stream handler always sees current state.
  const selfRef = useRef<Member | null>(null);
  const roomRef = useRef<RoomResource | null>(null);
  const membersRef = useRef<Member[]>([]);
  const inboxRef = useRef<InboxItem[]>([]);
  const historyRef = useRef<Message[]>([]);
  selfRef.current = self;
  roomRef.current = room;
  membersRef.current = members;
  inboxRef.current = inbox;
  historyRef.current = history;

  // Messages clawed back while this pane has been mounted. A clawed message is
  // DEAD (SPEC "Clawback"), but the server's listing can still hand it back for
  // a moment (our own POST races the write, or a listing was already in flight),
  // and its per-message routes 404 immediately. Remembering the ids lets us
  // ignore it in both directions: never render it again, never ask about it.
  const clawedIdsRef = useRef<Set<string>>(new Set());
  const withoutClawed = useCallback(<T extends { id: string }>(items: T[]): T[] => {
    if (clawedIdsRef.current.size === 0) return items;
    return items.filter((m) => !clawedIdsRef.current.has(m.id));
  }, []);

  // SCREEN-READER ARRIVALS (issue #39). A sighted user sees the bubble land; a
  // screen-reader user in an open conversation got nothing at all. One polite,
  // visually-hidden live region carries the newest genuine arrival. Deliberately
  // narrow about what counts as "arrived": only the live `message.new` path
  // feeds this, and only for ids we had never seen — so the initial history
  // load, a wake/reconnect backfill, and the re-listing after our own send stay
  // silent. Own sends are filtered too: you know what you just typed.
  const [announcement, setAnnouncement] = useState('');
  const announceArrivals = useCallback((known: ReadonlySet<string>, next: Message[]) => {
    const me = selfRef.current;
    const arrivals = next.filter((m) => !known.has(m.id) && m.from.id !== me?.id);
    if (arrivals.length === 0) return;
    const newest = arrivals.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    const preview = announcePreview(newest.body);
    setAnnouncement(
      preview ? `${newest.from.displayName}: ${preview}` : `${newest.from.displayName} sent a message`,
    );
  }, []);

  /**
   * Hand hands-free mode anything in `items` it has not seen, oldest first.
   * Called from EVERY site that writes `historyRef`, because any of them can be
   * the one that first sees a reply. Own messages are never included: hearing
   * your own turn read back is the one thing a voice loop must not do.
   */
  const feedHandsFree = useCallback((items: Message[]) => {
    if (!handsFreeOpenRef.current) return;
    const me = selfRef.current;
    const fresh = items
      .filter((m) => m.from.id !== me?.id && !voiceSeenRef.current.has(m.id))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (fresh.length === 0) return;
    for (const m of fresh) voiceSeenRef.current.add(m.id);
    setVoiceIncoming((cur) => [
      ...cur,
      ...fresh.map((m) => ({ id: m.id, body: m.body, from: m.from.displayName })),
    ]);
  }, []);

  // Read through a ref by the two callers that are stable closures (the stream
  // subscription and `reconcile`), matching how this file reaches `hydrate`.
  const feedHandsFreeRef = useRef(feedHandsFree);
  feedHandsFreeRef.current = feedHandsFree;

  // An expired session is the same everywhere: the whole app is unusable, so
  // both handlers below start here. Returns true when it took the error.
  const handleAuthExpiry = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        auth.sessionExpired();
        navigate('/login');
        return true;
      }
      return false;
    },
    [auth, navigate],
  );

  // ROOM-LEVEL failure: the request that failed was for the room ITSELF — the
  // room resource, its roster, its history/inbox listing. A 403/404 there means
  // the caller is not (or no longer) a member, or the room is gone: resync the
  // sidebar and fall back to the org home, because there is nothing to render.
  const handleRoomError = useCallback(
    (err: unknown) => {
      if (handleAuthExpiry(err)) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        void ws.reloadRooms();
        navigate(orgPath(orgId));
        return;
      }
      console.error(err);
    },
    [handleAuthExpiry, navigate, orgId, ws],
  );

  // INCIDENTAL failure: one message's status/read, a draft, some best-effort
  // side call. A 403/404 here says that ONE thing is gone or not ours — the room
  // is fine and the user must stay in it. This split is the clawback-eject bug
  // (issue #34): pulling a message back made its `GET …/messages/:id/status`
  // 404, the blanket handler read that as "room gone", and the user was thrown
  // to the org home with the just-recovered draft still in the composer.
  const handleBenignError = useCallback(
    (err: unknown) => {
      if (handleAuthExpiry(err)) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return;
      console.error(err);
    },
    [handleAuthExpiry],
  );

  const selected: string | 'all' = isDm
    ? counterpart
      ? findCounterpartMemberId(members, counterpart.id)
      : 'all'
    : 'all';
  const selectedIdRef = useRef<string | 'all'>('all');
  selectedIdRef.current = selected;

  // Advance delivery state for what the pane is showing. Bodies no longer need
  // fetching — the history route already returned full Messages — so this is
  // purely the read/receipt half:
  //   inbound with an OPEN delivery row → read it (peek=false) so the server
  //     emits `message.read` and the sender's receipt advances;
  //   own message → refresh its per-recipient receipt.
  // A message the caller has NO delivery row for (everything sent before they
  // joined) is plain history: it is never read-marked, because listing history
  // is a peek (SPEC "Room history") and there is no delivery state to advance.
  const hydrateThread = useCallback(
    async (hist: Message[], inb: InboxItem[]) => {
      const me = selfRef.current;
      if (!me) return;
      const open = statusById(inb);
      const thread = buildConversation({
        history: hist,
        selfId: me.id,
        selected: isDm ? (selectedIdRef.current ?? 'all') : 'all',
        dmRoom: isDm,
        status: open,
      });
      const jobs: Promise<void>[] = [];
      for (const t of thread) {
        // A message pulled back is gone: asking the server about it is a
        // guaranteed 404, so don't.
        if (clawedIdsRef.current.has(t.id)) continue;
        if (t.direction === 'in') {
          // `unread` and `received` are both still UNREAD: a received message is
          // delivered but not engaged, and must be marked read so the sender's
          // receipt advances delivered → read. Treating `received` as "already
          // engaged" froze it forever.
          if ((open[t.id] ?? 'read') === 'read') continue;
          // PER-MESSAGE, so a failure is narrow by construction: one message
          // being gone/forbidden says nothing about the room, and must never
          // move the user (issue #34).
          jobs.push(
            api
              .readMessage(roomId, t.id, { peek: false })
              .then(() => undefined)
              .catch(handleBenignError),
          );
        } else {
          jobs.push(
            api
              .getMessageStatus(roomId, t.id)
              .then((s) => setReceipts((r) => ({ ...r, [t.id]: s })))
              .catch(handleBenignError),
          );
        }
      }
      await Promise.all(jobs);
      // Marking read changed statuses → refresh the inbox + report unread. This
      // one IS room-level: a 403/404 on the room's own inbox listing means the
      // room is gone or we're no longer in it.
      try {
        const fresh = withoutClawed((await api.listInbox(roomId, { limit: HISTORY_LIMIT })).items);
        inboxRef.current = fresh;
        setInbox(fresh);
        reportBroadcastUnread(roomId, unreadCounts(fresh)['all'] ?? 0);
      } catch (e) {
        handleRoomError(e);
      }
    },
    [handleBenignError, handleRoomError, withoutClawed, isDm, roomId, reportBroadcastUnread],
  );
  const hydrateRef = useRef(hydrateThread);
  hydrateRef.current = hydrateThread;

  // Wake/reconnect reconciliation. Any event missed while a stream was down (a
  // `status.changed → idle`, presence, a new message, a receipt) leaves the UI
  // stale until a reload. On a signal that we may have missed events — the room
  // stream (re)connecting (synthetic `sync`), or the tab regaining
  // visibility/focus/network — reconcile the ACTIVE room against the server:
  //   1. REPLACE the status/presence snapshot (clears anything stale, e.g. a
  //      sticky "working" whose idle event was missed while the laptop slept —
  //      the reported bug; a sticky status carries no TTL so only a replace drops it);
  //   2. refetch the message page and re-hydrate the thread (missed messages
  //      appear, deduped by id — a fresh full listing replaces the local one).
  // Scroll stays anchored to the bottom via the flex-col-reverse feed, matching
  // the existing live-message path — no manual scroll handling is introduced.
  const reconcile = useCallback(async () => {
    if (!roomId) return;
    try {
      // The IDENTITY half (`whoami`, the room resource, the roster) is loaded
      // exactly once, on mount. If that failed — the server was restarting, or
      // the caller's membership in a room created out-of-band had not committed
      // yet (issue #59) — the pane was stranded for the session: no `self`, so
      // the composer stayed DISABLED, and no room, so the header read a generic
      // `#room`, with no way back but a full page reload. A reconcile is exactly
      // the moment to retry it; when both are already loaded this costs nothing.
      if (selfRef.current === null || roomRef.current === null) {
        const [me, rm, mem] = await Promise.all([
          selfRef.current ?? api.whoami(roomId),
          roomRef.current ?? api.getRoom(roomId).catch(() => null),
          api
            .listMembers(roomId, { limit: 100 })
            .then((r) => r.items)
            .catch(() => membersRef.current),
        ]);
        selfRef.current = me;
        setSelf(me);
        if (rm) {
          roomRef.current = rm;
          setRoom(rm);
        }
        membersRef.current = mem;
        setMembers(mem);
      }
      const [hist, inb, sts] = await Promise.all([
        api.listRoomMessages(roomId, { limit: HISTORY_LIMIT }),
        api.listInbox(roomId, { limit: HISTORY_LIMIT }),
        api.listStatuses(roomId).catch(() => ({ items: [], presence: { online: [] } })),
      ]);
      // A reconcile is a BACKFILL, never an arrival: whatever it turns up was
      // already sent, so it must not fire the live-region announcer.
      const items = withoutClawed(hist.items);
      const inbItems = withoutClawed(inb.items);
      historyRef.current = items;
      inboxRef.current = inbItems;
      setHistory(items);
      setInbox(inbItems);
      setStatuses(hydrateStatuses(sts.items));
      setStatusNow(Date.now());
      setOnlineIds(new Set(sts.presence.online));
      setPresenceHydrated(true);
      // A reconcile is a backfill for the ANNOUNCER, but not for hands-free
      // mode: a reply the stream was down for is exactly what it is waiting on.
      feedHandsFreeRef.current(items);
      await hydrateRef.current(items, inbItems);
    } catch (e) {
      handleRoomError(e);
    }
  }, [roomId, handleRoomError, withoutClawed]);

  // Leading-edge throttle so bursty focus/visibility signals collapse to one run.
  const lastReconcileRef = useRef(0);
  const requestReconcile = useCallback(() => {
    const now = Date.now();
    if (now - lastReconcileRef.current < RECONCILE_THROTTLE_MS) return;
    lastReconcileRef.current = now;
    void reconcile();
  }, [reconcile]);
  const requestReconcileRef = useRef(requestReconcile);
  requestReconcileRef.current = requestReconcile;

  // Initial load.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    void (async () => {
      try {
        const me = await api.whoami(roomId);
        if (cancelled) return;
        const [rm, mem, hist, inb, sts] = await Promise.all([
          api.getRoom(roomId).catch(() => null),
          api.listMembers(roomId, { limit: 100 }).then((r) => r.items),
          api.listRoomMessages(roomId, { limit: HISTORY_LIMIT }),
          api.listInbox(roomId, { limit: HISTORY_LIMIT }),
          api.listStatuses(roomId).catch(() => ({ items: [], presence: { online: [] } })),
        ]);
        if (cancelled) return;
        selfRef.current = me;
        setSelf(me);
        setRoom(rm);
        setMembers(mem);
        historyRef.current = hist.items;
        inboxRef.current = inb.items;
        setHistory(hist.items);
        setInbox(inb.items);
        setStatuses(hydrateStatuses(sts.items));
        setOnlineIds(new Set(sts.presence.online));
        setPresenceHydrated(true);
        await hydrateRef.current(hist.items, inb.items);
      } catch (e) {
        handleRoomError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Load this room's drafts (migrating any legacy localStorage queue first).
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    void (async () => {
      // One-time localStorage→server migration; best-effort, never blocks the load.
      try {
        await migrateLocalDrafts(roomId, api);
      } catch {
        /* leave un-migrated drafts for the next mount */
      }
      try {
        const items = await api.listDrafts(roomId);
        if (!cancelled) setDrafts(items);
      } catch (e) {
        // The draft queue is a side feature — never a reason to leave the room.
        handleBenignError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Live "x ago" tick + status expiry backup.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      setStatuses((m) => {
        if (Object.keys(m).length === 0) return m;
        return pruneExpired(m, Date.now());
      });
      setStatusNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Live room feed via the shared stream manager (no second SSE connection).
  useEffect(() => {
    if (!roomId) return;
    return roomStreams.subscribe(roomId, (ev) => {
      switch (ev.type) {
        case 'message.new':
          void (async () => {
            try {
              // What we already knew about, so the announcer can tell a genuine
              // arrival from the rest of the page we just re-listed.
              const known = new Set(historyRef.current.map((m) => m.id));
              const [hist, inb] = await Promise.all([
                api.listRoomMessages(roomId, { limit: HISTORY_LIMIT }),
                api.listInbox(roomId, { limit: HISTORY_LIMIT }),
              ]);
              const items = withoutClawed(hist.items);
              const inbItems = withoutClawed(inb.items);
              historyRef.current = items;
              inboxRef.current = inbItems;
              setHistory(items);
              setInbox(inbItems);
              announceArrivals(known, items);
              feedHandsFreeRef.current(items);
              await hydrateRef.current(items, inbItems);
            } catch (e) {
              handleRoomError(e);
            }
          })();
          break;
        case 'sync':
          // The stream (re)connected: it may have been down (laptop asleep), so
          // fully reconcile — snapshot REPLACE clears stale status/presence that
          // live events alone can't (the reported sticky-"working" bug). Shares
          // the throttle with the visibility/focus/online path.
          requestReconcileRef.current();
          break;
        case 'message.received':
        case 'message.read': {
          // Both delivery signals refresh the same per-message receipt: the
          // status carries three-valued per-recipient state (unread → received
          // → read) that DeliveryReceipt renders as sent / delivered / read.
          const mid = (ev.data as MessageReadEvent | MessageReceivedEvent).messageId;
          void api
            .getMessageStatus(roomId, mid)
            .then((s) => setReceipts((r) => ({ ...r, [mid]: s })))
            .catch(() => {});
          break;
        }
        case 'message.clawback': {
          // The sender pulled a message back: it is dead (SPEC "Clawback").
          // Drop every local copy, and restate the unread this pane reports —
          // a clawed message a viewer had NOT read must not leave a phantom
          // badge. (The sidebar's own copy re-counts inside RoomStreams.)
          const d = ev.data as MessageClawbackEvent;
          purgeMessage(d.messageId);
          reportBroadcastUnread(roomId, unreadCounts(inboxRef.current)['all'] ?? 0);
          break;
        }
        case 'member.joined':
        case 'member.updated':
        case 'member.removed':
          void api
            .listMembers(roomId, { limit: 100 })
            .then((r) => setMembers(r.items))
            .catch(() => {});
          break;
        case 'room.updated': {
          const d = ev.data as RoomUpdatedEvent;
          setRoom((prev) =>
            prev ? { ...prev, name: d.room.name, archivedAt: d.room.archivedAt, settings: d.settings } : prev,
          );
          break;
        }
        case 'status.changed':
          setStatuses((m) => applyStatusEvent(m, ev.data as StatusChangedEvent));
          setStatusNow(Date.now());
          break;
        case 'presence.changed': {
          const d = ev.data as PresenceChangedEvent;
          setOnlineIds((s) => applyPresenceEvent(s, d));
          // Feed the shared principal store too. RoomStreams already does this
          // for payloads carrying `principalId` (apply is idempotent); mapping
          // through the roster also covers pre-fix payloads without one.
          presenceStore.apply(
            d.member.principalId ??
              membersRef.current.find((m) => m.id === d.member.id)?.principalId,
            d.state,
          );
          break;
        }
        default:
          break;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Wake reconcile: when the tab regains visibility/focus or the network comes
  // back, we may have missed events while the stream was down — reconcile the
  // active room (throttled, shared with the stream-reconnect path above).
  useEffect(() => {
    if (!roomId) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') requestReconcileRef.current();
    };
    const onWake = () => requestReconcileRef.current();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [roomId]);

  // ONE presence truth per principal: the DM counterpart's presence renders
  // from the shared store (the same map the sidebar reads), never from a
  // room-local copy — so the header and the leftnav can never disagree. Until
  // the store has learned this principal (the workspace hydrate is in flight
  // for a moment at boot), fall back to this room's member-level snapshot so
  // the dot/notice never flash; the two converge as soon as either source
  // lands. Snapshots deliberately do NOT write into the store from here — a
  // stale in-flight `GET /status` must never clobber a fresher hydrate.
  const presenceMap = usePresence();
  const counterpartOnline = counterpart
    ? (presenceMap.get(counterpart.id) ?? (selected !== 'all' && onlineIds.has(selected)))
    : false;

  const others = useMemo(
    () => members.filter((m) => !self || m.id !== self.id),
    [members, self],
  );

  /**
   * Post a message. Returns the new message's id, or `null` when nothing was
   * sent (empty, in flight, archived) or the send failed — hands-free mode
   * needs the id to know its turn landed, and every other caller only needs
   * the truthiness.
   */
  async function send(
    body?: string,
    reply?: ReplyEcho,
    opts: { origin?: 'voice' } = {},
  ): Promise<string | null> {
    const isChip = body !== undefined;
    const text = (body ?? draft).trim();
    // Staged files ride only on a composed (non-chip) send; a quick chip reply
    // never carries the composer's attachments.
    const staged = isChip ? [] : pending;
    if ((!text && staged.length === 0) || sending || archived) return null;
    setSending(true);
    setSendError(null);
    try {
      const to = isDm ? (selected === 'all' ? 'all' : selected) : 'all';
      // A chip reply is typed provenance. `origin:'voice'` is now declared by the
      // ONE caller that speaks — hands-free mode — rather than inferred from a
      // composer flag: the transcript never passes through the composer at all.
      const voice = opts.origin === 'voice';
      const attachmentInputs =
        staged.length > 0 ? await Promise.all(staged.map((p) => fileToAttachmentInput(p.file))) : [];
      const { message: posted } = await api.sendMessage(roomId, {
        to,
        body: text,
        ...(attachmentInputs.length > 0 ? { attachments: attachmentInputs } : {}),
        ...(reply ? { inReplyTo: reply.inReplyTo, replyValue: reply.replyValue } : {}),
        ...(voice ? { origin: 'voice' } : {}),
      });
      if (!isChip) {
        setDraft('');
        setPending([]);
        setAttachError(null);
      }
      const [hist, inb] = await Promise.all([
        api.listRoomMessages(roomId, { limit: HISTORY_LIMIT }),
        api.listInbox(roomId, { limit: HISTORY_LIMIT }),
      ]);
      const items = withoutClawed(hist.items);
      const inbItems = withoutClawed(inb.items);
      historyRef.current = items;
      inboxRef.current = inbItems;
      setHistory(items);
      setInbox(inbItems);
      // The counterpart may already have answered: this listing, not a later
      // `message.new`, is where that reply first appears.
      feedHandsFree(items);
      await hydrateRef.current(items, inbItems);
      return posted.id;
    } catch (e) {
      setSendError(e instanceof ApiError ? e.message : 'Failed to send. Please try again.');
      // A rejected send IS room-level: 403/404 here means we're no longer in
      // this room (or it's gone), which is exactly the redirect case.
      if (e instanceof ApiError && e.status !== 400 && e.status !== 410) handleRoomError(e);
      return null;
    } finally {
      setSending(false);
    }
  }

  // Drop a clawed-back message from every local copy: the room history the pane
  // renders, the caller's delivery row for it (state + the stream handler's
  // refs), and its receipt row. Shared by the Escape path (own message) and the
  // incoming `message.clawback` path (anyone's).
  const purgeMessage = useCallback((messageId: string) => {
    // Remember it: a listing already in flight (or one the server answers before
    // the retraction is visible) must not resurrect the bubble, and its
    // per-message routes are now permanent 404s we must never call.
    clawedIdsRef.current.add(messageId);
    historyRef.current = historyRef.current.filter((m) => m.id !== messageId);
    inboxRef.current = inboxRef.current.filter((m) => m.id !== messageId);
    setHistory((cur) => cur.filter((m) => m.id !== messageId));
    setInbox((cur) => cur.filter((m) => m.id !== messageId));
    setReceipts((cur) => {
      if (!(messageId in cur)) return cur;
      const next = { ...cur };
      delete next[messageId];
      return next;
    });
  }, []);

  // The transient "Message pulled back" note (no persistent artifact): shown on
  // a successful clawback, gone on its own a moment later.
  const [showPulledNote, setShowPulledNote] = useState(false);
  const pulledNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pulledNoteTimer.current) clearTimeout(pulledNoteTimer.current);
    },
    [],
  );
  const flashPulledNote = useCallback(() => {
    setShowPulledNote(true);
    if (pulledNoteTimer.current) clearTimeout(pulledNoteTimer.current);
    pulledNoteTimer.current = setTimeout(() => setShowPulledNote(false), CLAWBACK_NOTE_MS);
  }, []);

  // Escape → clawback (SPEC "Clawback"): pull back the caller's MOST RECENT own
  // message in this room while it is still unread by everyone. On success the
  // bubble leaves the pane and the returned body is PREPENDED to the composer,
  // preserving any draft-in-progress below it (newline-separated) — so repeated
  // pulls stack with the OLDEST pulled on top, and re-sending restores the
  // original order. A 409 (someone read it / outside the window / already
  // clawed) tries nothing further: a read message stays sent, and the draft is
  // never touched. With nothing eligible, Escape does nothing at all — it must
  // never clear the draft.
  const clawInFlight = useRef(false);
  const clawbackLast = useCallback(async () => {
    if (clawInFlight.current || archived) return;
    const me = selfRef.current;
    if (!me) return;
    const newest = historyRef.current
      .filter((m) => m.from.id === me.id)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id < b.id
            ? 1
            : -1
          : a.createdAt < b.createdAt
            ? 1
            : -1,
      )[0];
    if (!newest) return;
    clawInFlight.current = true;
    try {
      const res = await api.clawbackMessage(roomId, newest.id);
      purgeMessage(newest.id);
      setDraft((cur) => (cur.length > 0 ? `${res.message.body}\n${cur}` : res.message.body));
      flashPulledNote();
    } catch (e) {
      // 409 (read / outside CLAWBACK_WINDOW / already clawed) and 404 (not ours
      // or gone): the message stays sent — silently, per the product call.
      if (!(e instanceof ApiError && (e.status === 409 || e.status === 404))) handleBenignError(e);
    } finally {
      clawInFlight.current = false;
    }
  }, [archived, roomId, purgeMessage, flashPulledNote, handleBenignError]);

  // The Escape binding rides the app's hotkey registry (lib/hotkeys — the seam
  // future GUI hotkeys join). Scope 'composer': it fires only while focus is in
  // the composer, which carries `data-hotkey-scope="composer"`. The handler
  // reads through a ref so the one registration always sees the newest closure.
  const clawbackRef = useRef(clawbackLast);
  clawbackRef.current = clawbackLast;
  useEffect(
    () =>
      registerHotkey({
        key: 'Escape',
        scope: 'composer',
        handler: () => void clawbackRef.current(),
        description: 'Pull back your last message (while unread)',
      }),
    [],
  );

  // Stage newly picked/pasted/dropped files, enforcing the server's size/count
  // limits (rejected files surface an inline error rather than vanishing).
  function addFiles(files: File[]) {
    const { next, error } = stageFiles(pending, files);
    setPending(next);
    setAttachError(error);
  }
  function removeAttachment(id: string) {
    setPending((cur) => cur.filter((p) => p.id !== id));
    setAttachError(null);
  }

  // Enqueue the current composer text as a server draft, then clear the composer.
  // On failure we keep the text in the composer (nothing is lost) and surface the
  // error like a send error.
  async function enqueueDraft() {
    const text = draft.trim();
    if (!text || archived) return;
    setSendError(null);
    try {
      const created = await api.createDraft(roomId, text);
      setDrafts((cur) => [...cur, created]);
      setDraft('');
    } catch (e) {
      setSendError(e instanceof ApiError ? e.message : 'Could not save draft. Please try again.');
    }
  }

  // Pull a draft back into the composer. If the composer already has text we
  // append (newline-separated) rather than silently destroying the in-progress edit.
  function insertDraft(d: Draft) {
    setDraft((cur) => (cur.trim() ? `${cur}\n${d.text}` : d.text));
    setShowDrafts(false);
  }

  // Fire a draft down the existing send path; drop it (server + local) only on a
  // confirmed success. The chip-style body arg leaves the live composer untouched.
  async function sendDraft(d: Draft) {
    if (sending) return;
    const ok = (await send(d.text)) !== null;
    if (!ok) return;
    setDrafts((cur) => cur.filter((x) => x.id !== d.id));
    setShowDrafts(false);
    // The message is already sent; a failed cleanup would just re-list the draft
    // on the next load, so swallow it rather than surfacing a scary error.
    void api.deleteDraft(roomId, d.id).catch(() => {});
  }

  async function deleteDraft(d: Draft) {
    setDrafts((cur) => cur.filter((x) => x.id !== d.id));
    try {
      await api.deleteDraft(roomId, d.id);
    } catch (e) {
      handleBenignError(e);
    }
  }

  // Fold every draft into one composer message (newline-joined, display order)
  // and clear the queue. Composer-append semantics match insertDraft: an
  // in-progress edit is preserved by prepending it, newline-separated. Server
  // cleanup is best-effort — a failed delete just re-lists that draft next load.
  function combineDrafts() {
    if (drafts.length < 2) return;
    const joined = drafts.map((d) => d.text).join('\n');
    setDraft((cur) => (cur.trim() ? `${cur}\n${joined}` : joined));
    const removed = drafts;
    setDrafts([]);
    setShowDrafts(false);
    for (const d of removed) {
      void api.deleteDraft(roomId, d.id).catch(() => {});
    }
  }

  async function restore() {
    if (restoring) return;
    setRestoring(true);
    try {
      const res = await api.updateRoom(roomId, { archived: false });
      setRoom(res);
      void ws.reloadRooms();
    } catch (e) {
      handleRoomError(e);
    } finally {
      setRestoring(false);
    }
  }

  // Every message the pane can render, by id — the history route returns FULL
  // Messages, so bodies, attachments and reply echoes are here the moment the
  // thread is. (This replaced a per-message body backfill: the inbox's 200-char
  // previews were the only reason a bubble could ever render clipped.)
  const fullMessages = useMemo(() => {
    const map: Record<string, Message> = {};
    for (const m of history) map[m.id] = m;
    return map;
  }, [history]);

  const thread = self
    ? buildConversation({
        history,
        selfId: self.id,
        selected,
        dmRoom: isDm,
        status: statusById(inbox),
      })
    : [];


  const partnerStatus =
    self && isDm && selected !== 'all'
      ? statusForPartner(statuses, self.id, selected, statusNow)
      : null;
  const workingIds = useMemo(() => membersWithStatus(statuses, statusNow), [statuses, statusNow]);
  // Bridge per-room member ids → stable principal ids, for seeding message-row
  // avatars off identity even on pre-fix payloads whose MemberRef lacks a principalId.
  const memberToPrincipal = useMemo(
    () => new Map(members.map((m) => [m.id, m.principalId])),
    [members],
  );
  // In a PROJECT room, the composer-area working bubbles: every member the caller
  // can see is working (own excluded), one entry each, live via status.changed +
  // TTL expiry. DMs use `partnerStatus` above instead; this stays empty for them.
  const roomStatuses = useMemo(
    () => (self && !isDm ? activeRoomStatuses(statuses, self.id, statusNow) : []),
    [self, isDm, statuses, statusNow],
  );

  /**
   * Everything hands-free mode (voice v2) needs, rebuilt each render so `onSend`
   * always closes over the CURRENT send path — a memo here would freeze
   * `sending`/`archived` and let the overlay post into a room it has left.
   *
   * `onSend` is that ordinary path with the voice origin declared, so a spoken
   * turn is an ordinary message in every other respect: same route, same
   * receipts, same history refresh, and the composer's draft and staged files
   * are never touched.
   */
  const handsFree = {
    roomId,
    onSend: (text: string) => send(text, undefined, { origin: 'voice' as const }),
    incoming: voiceIncoming,
    // The counterpart's live working note IS the awaiting state's content — the
    // room already streams it, so hands-free mode shows the same truth the
    // composer's working bubble does. A DM has exactly one partner; a project
    // room takes whoever is working (the first of the same list the bubbles
    // render), which for a spoken turn is invariably the agent answering it.
    awaitingNote: (partnerStatus ?? roomStatuses[0])?.note ?? null,
    counterpartName: counterpart?.displayName ?? roomStatuses[0]?.displayName ?? null,
    onOpenChange: (open: boolean) => {
      handsFreeOpenRef.current = open;
      // Each session starts with an empty queue and everything currently on
      // screen already marked seen — opening the mode must not read the room's
      // backlog aloud, only what arrives from here on.
      voiceSeenRef.current = new Set(historyRef.current.map((m) => m.id));
      setVoiceIncoming([]);
    },
  };

  const quoteFor = (id: string): { who: string; body: string } | undefined => {
    const full = fullMessages[id];
    if (full) return { who: self && full.from.id === self.id ? 'You' : full.from.displayName, body: full.body };
    return undefined;
  };

  const newest = thread.length > 0 ? thread[thread.length - 1] : undefined;
  const newestSuggestions =
    newest && newest.direction === 'in' ? (fullMessages[newest.id]?.suggestedReplies ?? []) : [];
  const suggestions =
    newest && newestSuggestions.length > 0
      ? { messageId: newest.id, options: newestSuggestions }
      : null;

  // One time-ordered column of everything that happened with this counterpart.
  // `mergeStream` drops entries of medium `chat` (the room route already supplies
  // those bubbles) and `collapseStream` applies the collapsing rules to what is
  // RENDERED. Collapsing reads each entry's own type, never a live override, so
  // a resolution mutates its card without re-flowing the column. With no entries
  // this is exactly `thread`, row for row.
  const rows = interleaveAgentDms(
    collapseStream(mergeStream(thread, activity.entries)),
    counterpartDmBoxes,
  );

  const canCompose = !archived && self !== null;

  // Ephemeral, client-only notice: this is a DM with an AI agent that is enrolled
  // but not currently online (not tailing its loop — common right after enrollment).
  // Gated on presence hydration so it never flashes; it vanishes live the instant a
  // `presence.changed` event flips the agent online, and returns if it drops offline.
  const showAgentOfflineNotice =
    isDm && counterpart?.type === 'agent' && presenceHydrated && !counterpartOnline;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The conversation's ONE polite announcer (issue #39). Visually hidden and
          outside the feed, so the message list itself carries no live region and
          nothing can be announced twice. Only `announceArrivals` writes here.
          Deliberately NOT `role="status"`: the explicit aria-live/aria-atomic
          pair is the same contract to a screen reader, without adding a second
          "status" to a pane whose working-indicator bubbles already claim it. */}
      <div
        data-testid="message-announcer"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>

      {/* Conversation header. ONE line, on every width (issue #58): it used to
          wrap its name/subtitle pair, and on a phone the header plus that
          subtitle ate roughly 340px before the first message. The name
          truncates instead, the subtitle is desktop-only, and the padding is
          tighter below `sm`. */}
      <div className="border-b border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3 py-1.5 text-sm sm:px-4 sm:py-2.5">
        {isDm ? (
          <span className="flex min-w-0 items-center gap-x-1.5">
            {counterpart && (
              <PresenceAvatar
                kind={counterpart.type}
                id={counterpart.id}
                displayName={counterpart.displayName}
                avatarUrl={readAvatarUrl(counterpart)}
                size={26}
                presence={presenceDot(
                  counterpartOnline,
                  counterpartLastSeen(members, counterpart.id),
                  nowMs,
                )}
                busy={partnerStatus != null}
              />
            )}
            <span className="min-w-0 truncate font-medium">
              {counterpart?.displayName ?? 'Direct message'}
            </span>
            {counterpart && <KindBadge kind={counterpart.type} />}
          </span>
        ) : (
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="flex min-w-0 items-baseline gap-x-2">
              <span className="truncate font-medium">#{room?.name || 'room'}</span>
              {/* The subtitle explains a room the reader is already standing in;
                  at phone widths that explanation costs more than it gives. */}
              <span className="hidden shrink-0 text-xs text-[var(--sparrow-muted)] sm:inline">
                broadcasts to everyone here
              </span>
            </span>
            <span className="flex-1" />
            <MemberStrip members={others} onlineIds={onlineIds} workingIds={workingIds} nowMs={nowMs} />
            {!archived && (
              <>
                <button
                  type="button"
                  onClick={() => setAddPeople(true)}
                  className="shrink-0 rounded-md border border-[var(--sparrow-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
                >
                  Add people
                </button>
                <button
                  type="button"
                  onClick={() => setAddAgent(true)}
                  className="shrink-0 rounded-md border border-[var(--sparrow-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
                >
                  Add agent
                </button>
                {/* Room settings used to be reachable ONLY through a gear that
                    appeared on hover over the sidebar row — invisible to anyone
                    not already hunting for it, and unreachable by touch. It
                    belongs with the other room-level actions. */}
                <Link
                  to={roomSettingsPath(orgId, roomId)}
                  aria-label="Room settings"
                  title="Room settings"
                  className="shrink-0 rounded-md border border-[var(--sparrow-border-strong)] p-1.5 text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
                >
                  <Settings size={14} aria-hidden="true" />
                </Link>
              </>
            )}
          </div>
        )}
      </div>

      {archived && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm"
        >
          <span className="text-[var(--sparrow-muted)]">
            This room is archived — read-only. Messages are preserved.
          </span>
          {!isDm && (
            <button
              onClick={() => void restore()}
              disabled={restoring}
              className="rounded-md border border-[var(--sparrow-accent-2)] bg-[var(--sparrow-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--sparrow-accent)] transition-colors hover:border-[var(--sparrow-accent)] disabled:opacity-50"
            >
              {restoring ? 'Restoring…' : 'Restore'}
            </button>
          )}
        </div>
      )}

      {rows.length === 0 && (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-sm text-[var(--sparrow-faint)]">
            {isDm
              ? 'No messages yet. Say hello.'
              : others.length === 0
                ? 'No one else is here yet. Add someone to start broadcasting.'
                : 'No broadcasts yet. Say something to the whole room.'}
          </p>
        </div>
      )}
      <div className={`flex min-h-0 flex-col-reverse overflow-y-auto px-4 py-3 ${rows.length === 0 ? '' : 'flex-1'}`}>
        <div className="flex flex-col gap-3">
          {rows.map((r, i) => {
            if (r.kind === 'agent-dm') {
              // An interleaved oversight box: this agent's DM with another
              // agent, collapsed, read-only — the DM-pane twin of the org-home
              // "Agent conversations" card.
              return <AgentDmCard key={r.key} orgId={orgId} box={r.box} />;
            }
            if (r.kind !== 'chat') {
              // An interleaved card from another medium. It carries none of
              // chat's conversation behaviors — no receipt, no presence, no
              // working status behind an address.
              return (
                <ActivityRow
                  key={r.key}
                  row={r}
                  orgId={orgId}
                  agentId={activityAgentId ?? ''}
                  dispositionOf={activity.dispositionOf}
                  nowMs={nowMs}
                />
              );
            }
            const t = r.item;
            // Run grouping (common chat convention): the avatar shows on the FIRST
            // message of a consecutive run from the same sender; continuations keep
            // the indent (a same-width spacer) but drop the repeated avatar. The
            // per-message header/timestamp already distinguishes rows, so this only
            // removes avatar repetition, not sender attribution. An interleaved
            // card breaks the run — the visual continuity is broken with it.
            const sender = messageSender(t, memberToPrincipal);
            const prevRow = rows[i - 1];
            const prev = prevRow?.kind === 'chat' ? prevRow.item : undefined;
            const prevSender = prev ? messageSender(prev, memberToPrincipal) : null;
            const runStart =
              !prev || prev.direction !== t.direction || prevSender?.id !== sender.id;
            return (
              <MessageBubble
                key={r.key}
                roomId={roomId}
                direction={t.direction}
                inbox={t.direction === 'in' ? t.inbox : undefined}
                full={fullMessages[t.id]}
                outbox={t.direction === 'out' ? t.outbox : undefined}
                receipt={t.direction === 'out' ? receipts[t.id] : undefined}
                quoteFor={quoteFor}
                sender={sender}
                showAvatar={runStart}
                nowMs={nowMs}
              />
            );
          })}
        </div>
      </div>

      {showAgentOfflineNotice && counterpart && (
        <div className="px-4 pb-1 pt-0.5">
          <AgentOfflineNotice agentName={counterpart.displayName} />
        </div>
      )}

      {/* Transient clawback confirmation — muted, self-dismissing, never a
          persistent artifact in the transcript. */}
      {showPulledNote && (
        <div className="px-4 pb-1 pt-0.5">
          <p role="status" className="text-xs text-[var(--sparrow-muted)]">
            Message pulled back
          </p>
        </div>
      )}

      {/* iMessage-style: the counterpart's working indicator lives at the bottom of the
          message area, pinned just above the composer, appearing/disappearing live with
          status.changed events. The header keeps only the presence dot. */}
      {partnerStatus && (
        <div className="px-4 pb-1 pt-0.5">
          <WorkingBubble note={partnerStatus.note} sinceMs={partnerStatus.sinceAtMs} nowMs={statusNow} />
        </div>
      )}

      {/* PROJECT room: the same pinned-above-composer spot, but a working member
          is not implicit here, so each bubble is labelled with WHO. Up to 3 stack;
          beyond that the first 2 show and the rest collapse to one summary line. */}
      {!isDm && roomStatuses.length > 0 && (
        <div className="flex flex-col gap-1 px-4 pb-1 pt-0.5">
          {(roomStatuses.length > 3 ? roomStatuses.slice(0, 2) : roomStatuses).map((s) => (
            <WorkingBubble key={s.memberId} label={s.displayName} note={s.note} sinceMs={s.sinceAtMs} nowMs={statusNow} />
          ))}
          {roomStatuses.length > 3 && (
            <div role="status" className="pl-1 text-xs text-[var(--sparrow-muted)]">
              {roomStatuses.length - 2} members working…
            </div>
          )}
        </div>
      )}

      <Composer
        value={draft}
        onChange={(v) => {
          setDraft(v);
          if (sendError) setSendError(null);
        }}
        handsFree={handsFree}
        onSend={(body, reply) => void send(body, reply)}
        onDraft={enqueueDraft}
        onOpenDrafts={() => setShowDrafts(true)}
        draftCount={drafts.length}
        attachments={pending}
        onAddFiles={addFiles}
        onRemoveAttachment={removeAttachment}
        attachmentError={attachError}
        canCompose={canCompose}
        // Opening a conversation lands the caret here (issue #47) — Room is
        // keyed by roomId, so this fires once per conversation opened.
        autoFocus
        sending={sending}
        sendError={sendError}
        placeholder={
          archived
            ? 'This room is archived — read-only'
            : isDm
              ? `Message ${counterpart?.displayName ?? ''}… (Enter to send)`
              : 'Broadcast to everyone… (Enter to send)'
        }
        suggestions={suggestions}
      />

      {showDrafts && (
        <DraftsModal
          drafts={drafts}
          sending={sending}
          onInsert={insertDraft}
          onSend={(d) => void sendDraft(d)}
          onDelete={deleteDraft}
          onCombine={combineDrafts}
          onClose={() => setShowDrafts(false)}
        />
      )}

      {addPeople && (
        <AddPeopleModal roomId={roomId} orgId={orgId} onClose={() => setAddPeople(false)} />
      )}
      {addAgent && (
        <AddAgentModal
          roomId={roomId}
          existingMemberPrincipalIds={new Set(members.map((m) => m.principalId))}
          onClose={() => setAddAgent(false)}
          onAdded={() => api.listMembers(roomId, { limit: 100 }).then((r) => setMembers(r.items))}
        />
      )}
    </section>
  );
}

function findCounterpartMemberId(members: Member[], principalId: string): string | 'all' {
  return members.find((m) => m.principalId === principalId)?.id ?? 'all';
}
function counterpartLastSeen(members: Member[], principalId: string): string | null {
  return members.find((m) => m.principalId === principalId)?.lastSeenAt ?? null;
}

/** Identity of a thread item's sender, for the avatar next to its row. */
interface SenderInfo {
  /**
   * `MemberRef.kind`, so it also carries `'unknown'` — a historical sender whose
   * principal can no longer be identified. Only `'agent'` changes the rendering;
   * `'unknown'` draws like a person, which is the right neutral default.
   */
  kind: MemberRefKind;
  /** Stable PRINCIPAL id — seeds the procedural avatar (same bird per identity). */
  id: string;
  displayName: string;
  avatarUrl: string | null;
}
/**
 * `t.*.from` is a `MemberRef` whose `id` is a per-room `mem_…`; seed the avatar
 * off the stable principal instead (via {@link avatarSeed}), bridging through the
 * room roster for pre-fix payloads that predate `MemberRef.principalId`.
 */
export function messageSender(
  t: ThreadItem,
  memberToPrincipal?: ReadonlyMap<string, string>,
): SenderInfo {
  const ref = t.direction === 'in' ? t.inbox.from : t.outbox.from;
  return {
    kind: ref.kind,
    id: avatarSeed(ref, memberToPrincipal),
    displayName: ref.displayName,
    avatarUrl: readAvatarUrl(ref),
  };
}

function MemberStrip({
  members,
  onlineIds,
  workingIds,
  nowMs,
}: {
  members: Member[];
  onlineIds: ReadonlySet<string>;
  workingIds: ReadonlySet<string>;
  nowMs: number;
}) {
  if (members.length === 0) return null;
  const MAX = 5;
  const shown = members.slice(0, MAX);
  const overflow = members.length - shown.length;
  return (
    <div className="flex shrink-0 items-center" aria-label={`${members.length} member${members.length === 1 ? '' : 's'}`}>
      {shown.map((m) => (
        <span
          key={m.id}
          title={m.displayName}
          className={`-ml-1.5 inline-flex h-6 w-6 border border-[var(--sparrow-border)] ring-2 ring-[var(--sparrow-panel)] first:ml-0 ${
            m.kind === 'agent' ? 'rounded-md' : 'rounded-full'
          }`}
        >
          <PresenceAvatar
            kind={m.kind}
            id={m.principalId}
            displayName={m.displayName}
            avatarUrl={readAvatarUrl(m)}
            size={24}
            presence={presenceDot(onlineIds.has(m.id), m.lastSeenAt, nowMs)}
            busy={workingIds.has(m.id)}
            activeAgo={formatRelativeTime(m.lastSeenAt ?? '', nowMs)}
          />
        </span>
      ))}
      {overflow > 0 && <span className="mono ml-1.5 shrink-0 text-xs text-[var(--sparrow-muted)]">+{overflow}</span>}
    </div>
  );
}

function KindBadge({ kind }: { kind: 'human' | 'agent' }) {
  const isAgent = kind === 'agent';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        isAgent
          ? 'bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]'
          : 'bg-[rgba(91,185,139,0.14)] text-[var(--sparrow-good)]'
      }`}
    >
      {kind}
    </span>
  );
}

export function MessageBubble({
  roomId,
  direction,
  inbox,
  full,
  outbox,
  receipt,
  quoteFor,
  sender,
  showAvatar = true,
  nowMs,
}: {
  roomId: string;
  direction: 'in' | 'out';
  inbox?: InboxItem;
  full?: Message;
  outbox?: Message;
  receipt?: MessageStatus;
  quoteFor?: (id: string) => { who: string; body: string } | undefined;
  /** The sender's identity, for the avatar rendered alongside the bubble. */
  sender?: SenderInfo;
  /** First message of a same-sender run shows the avatar; continuations indent. */
  showAvatar?: boolean;
  nowMs: number;
}) {
  const out = direction === 'out';
  const source = out ? outbox : full;
  const body = source?.body ?? inbox?.preview ?? '';
  const createdAt = out ? outbox!.createdAt : (full?.createdAt ?? inbox!.createdAt);
  const fromLabel = out ? 'You' : (inbox?.from.displayName ?? full?.from.displayName ?? 'unknown');
  const attachments = source?.attachments ?? [];
  const kind = out ? outbox!.kind : (inbox?.kind ?? full?.kind);
  const replyTo = source?.inReplyTo ? quoteFor?.(source.inReplyTo) : undefined;
  const isVoice = source?.origin === 'voice';
  const messageId = out ? outbox!.id : (full?.id ?? inbox!.id);
  const caps = useCapabilities();
  // The rendered body, so a copy can also offer text/html for rich editors.
  // Read at click time — never snapshotted — so it always matches what's shown.
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const avatarSlot = sender ? (
    <div className="w-7 shrink-0" aria-hidden={!showAvatar}>
      {showAvatar && (
        <Avatar
          // Avatar draws two shapes; an `unknown` sender takes the person one.
          kind={sender.kind === 'agent' ? 'agent' : 'human'}
          id={sender.id}
          displayName={sender.displayName}
          avatarUrl={sender.avatarUrl}
          size={28}
        />
      )}
    </div>
  ) : null;

  return (
    <div className={`flex items-start gap-2 ${out ? 'justify-end' : 'justify-start'}`}>
      {!out && avatarSlot}
      <div
        className={`group max-w-[75%] rounded-lg border px-3 py-2 ${
          out
            ? 'border-[var(--sparrow-accent-2)] bg-[var(--sparrow-accent-soft)]'
            : 'border-[var(--sparrow-border)] bg-[var(--sparrow-panel)]'
        }`}
      >
        {replyTo && (
          <div className="mb-1 flex min-w-0 items-center gap-1 border-l-2 border-[var(--sparrow-border-strong)] pl-2 text-xs text-[var(--sparrow-muted)]">
            {/* The trailing colon is the SEPARATOR: without it the author ran
                straight into the quoted text ("You hello qa-bot") and the line
                read as one garbled sentence. */}
            <span className="mono flex shrink-0 items-center gap-1">
              <Reply size={12} aria-hidden="true" /> {`${replyTo.who}:`}
            </span>
            <span className="min-w-0 truncate">{replyTo.body}</span>
          </div>
        )}
        <div className="mb-1 flex min-w-0 items-center gap-2 text-xs text-[var(--sparrow-muted)]">
          <span className="mono min-w-0 truncate">{fromLabel}</span>
          {kind === 'broadcast' && <span className="rounded bg-[var(--sparrow-panel-2)] px-1">broadcast</span>}
          {isVoice && (
            <span
              aria-label="Voice message"
              className="inline-flex items-center gap-1 rounded bg-[var(--sparrow-accent-soft)] px-1 text-[var(--sparrow-accent)]"
            >
              <Mic size={12} aria-hidden="true" /> voice
            </span>
          )}
          <span>{formatRelativeTime(createdAt, nowMs)}</span>
          {/* Copy rides in the meta row rather than floating over the text: it
              reserves its own width, so revealing it never reflows the bubble
              and it can never sit on top of a word. */}
          <CopyMessageButton
            className="-my-1 ml-auto"
            text={body}
            getHtml={() => bodyRef.current?.innerHTML ?? null}
          />
        </div>
        {source?.subject != null && source.subject !== '' && (
          <div className="mb-1 text-sm font-medium">{source.subject}</div>
        )}
        {inbox?.subject != null && inbox.subject !== '' && !source && (
          <div className="mb-1 text-sm font-medium">{inbox.subject}</div>
        )}
        {/* MessageBody renders block markdown and handles its own whitespace. */}
        <div ref={bodyRef} className="break-words text-sm">
          <MessageBody text={body} />
        </div>
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {attachments.map((a) => (
              <Attachment key={a.id} roomId={roomId} meta={a} />
            ))}
          </div>
        )}
        {!source && inbox && inbox.attachmentCount > 0 && (
          <div className="mt-2 text-xs text-[var(--sparrow-muted)]">
            {inbox.attachmentCount} attachment{inbox.attachmentCount === 1 ? '' : 's'}
          </div>
        )}
        {/*
          Meta/receipt row. Mobile: stacked (flex-col) — the speaker keeps its
          full 40px prominence on its own line, the receipt right-aligned below,
          exactly as before. Desktop: reflows inline (md:flex-row) with the
          COMPACT speaker as the first, left-aligned element, then the delivery
          label — voice matters less on desktop. `empty:hidden` drops the row's
          margin when neither the speaker nor a receipt marker renders.
        */}
        <div className="mt-2 flex flex-col gap-1 empty:hidden md:mt-1 md:flex-row md:items-center md:gap-2">
          {caps.voice.tts && <SpeakerButton roomId={roomId} messageId={messageId} />}
          {out && <DeliveryReceipt receipt={receipt} nowMs={nowMs} />}
        </div>
      </div>
      {out && avatarSlot}
    </div>
  );
}

/** Per-recipient delivery word: 'read' > 'delivered' > 'sent'. */
function recipientLabel(r: MessageStatus['recipients'][number]): 'read' | 'delivered' | 'sent' {
  if (r.status === 'read') return 'read';
  if (r.status === 'received' || r.receivedAt != null) return 'delivered';
  return 'sent';
}

/**
 * Three-state delivery receipt on own sent messages (SPEC "Delivery receipts"):
 *   sent      — no marker beyond the bubble (nothing rendered);
 *   delivered — subtle, dim glyph once ANY recipient has received it
 *               (the counterpart's client holds it), never the copper accent;
 *   read       — the existing green read indicator once ALL recipients have read.
 * Broadcasts aggregate across recipients; the tooltip carries per-recipient detail.
 */
export function DeliveryReceipt({ receipt, nowMs }: { receipt?: MessageStatus; nowMs: number }) {
  const recipients = receipt?.recipients ?? [];
  const total = recipients.length;
  if (total === 0) return null; // sent — no marker

  const readCount = recipients.filter((r) => r.status === 'read').length;
  const anyReceived = recipients.some((r) => recipientLabel(r) !== 'sent');
  if (!anyReceived) return null; // sent — delivery not yet observed

  // Tooltip: state in words, with per-recipient breakdown on broadcasts.
  const tip =
    total > 1
      ? recipients.map((r) => `${r.displayName}: ${recipientLabel(r)}`).join('\n')
      : recipientLabel(recipients[0]!);

  if (readCount === total) {
    const latest = recipients
      .map((r) => r.readAt)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1);
    return (
      <div className="w-full text-right text-xs text-[var(--sparrow-good)] md:w-auto md:text-left" title={tip}>
        <Check size={12} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline align-[-1px]" />
        read{total > 1 ? ` (${total})` : ''}
        {latest ? ` · ${formatRelativeTime(latest, nowMs)}` : ''}
      </div>
    );
  }

  // Delivered: any received, not yet all read. Dim/hairline — not the accent.
  return (
    <div className="w-full text-right text-xs text-[var(--sparrow-faint)] md:w-auto md:text-left" title={tip}>
      <Check size={12} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline align-[-1px]" />
      delivered{readCount > 0 ? ` · ${readCount}/${total} read` : ''}
    </div>
  );
}

