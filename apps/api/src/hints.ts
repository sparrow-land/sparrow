/**
 * The mechanical hint engine (no LLM). Zero-install agents that talk plain HTTPS
 * tend to underuse the product — they forget to advertise a status, never drain
 * their inbox, never open an events stream, send walls of unformatted text. The
 * engine teaches them THROUGH the API, from server-observable state (db +
 * presence).
 *
 * THE PRINCIPLE: **the right time to teach an agent is BETWEEN tasks, and the
 * right channel is one the agent CHOSE.** Hints must never interrupt work in
 * flight. So there are exactly two hinted surfaces, and both are moments the
 * agent is not carrying anything:
 *
 *   - the PAUSE — {@link computeHints} decorates the `{ item: null }` response of
 *     `POST /me/inbox/pop`, i.e. the instant the queue came back empty. Sends and
 *     work-bearing pops carry NOTHING: a hint stapled to the message an agent is
 *     about to act on is noise competing with the job.
 *   - the ASK — {@link previewHints} answers `GET /me/hints` (`sparrow tips`),
 *     where the agent asked the question itself.
 *
 * Hints exist to help the agent serve ITS HUMAN — a silent, formless agent reads
 * as broken. Every `docs` URL points at the canonical documentation home (SPEC
 * "Canonical public homes" — one page per endpoint, whichever instance taught the
 * lesson), and delivery is cooldown-gated (a hint
 * re-fires at most once per {@link HINT_COOLDOWN_MS}, or {@link
 * HINT_COOLDOWN_AGGRESSIVE_MS} for an agent that opted into aggressive coaching),
 * and opt-out-able (the `HINTS_ENABLED` env kill-switch, the per-request
 * `X-Sparrow-No-Hints: 1` header, and the persistent per-principal `off` level).
 * Agents only — humans use the web and are never hinted in v1.
 *
 * Because a trigger no longer sees the request that provoked it, every condition
 * is derived from the DATABASE, with recency (`RECENT_ACTIVITY_MS`) standing in
 * for "just now". That is what makes the pause a legitimate teaching moment: the
 * lesson still has a referent the agent remembers.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  HINT_COOLDOWN_MS,
  HINT_COOLDOWN_AGGRESSIVE_MS,
  HINT_META_THRESHOLD,
  parseClientIdent,
  clientVersionBelow,
  type Hint,
  type HintAction,
  type HintLevel,
  type HintPreferenceChoice,
} from '@sparrow/common-types';
import type { AppContext, PrincipalIdent } from './context.js';
import { nowIso } from './context.js';
import { apiDocMarkdownUrl, docsHome, installArtifactUrl, installHome } from './public-homes.js';
import {
  agents,
  emails,
  hintDeliveries,
  hintPreferences,
  humans,
  members,
  messages,
  messageRecipients,
} from './db/schema.js';
import type { AgentRow, EmailRow } from './db/schema.js';
import { agentAddress, emailMediumOn } from './email/addresses.js';
import { appendActivity } from './activity.js';

/** Unread-inbox size at which `drain-your-inbox` fires. */
const DRAIN_UNREAD_THRESHOLD = 5;
/** How long an outbound email must sit `held` before `email-is-held` fires. */
const HELD_EMAIL_AGE_MS = 10 * 60 * 1000;
/** Per-message length (chars) above which unformatted text triggers `markdown-renders`. */
const LONG_MESSAGE_CHARS = 300;
/** How many recent long, formatting-free messages (incl. current) trigger `markdown-renders`. */
const MARKDOWN_STREAK = 3;
/** Cheap "has any markdown token" heuristic: `* _ # \` [text](` all count as formatting. */
const MARKDOWN_TOKEN = /[*_#`]|\[.+\]\(/;
/**
 * How recently a db-observable act (a send, a read) must have happened for a
 * trigger to treat it as "just now". Hints fire at the PAUSE rather than on the
 * act itself, so recency is what keeps a lesson attached to something the agent
 * still remembers doing — without the engine keeping any state of its own.
 */
const RECENT_ACTIVITY_MS = 30 * 60 * 1000;

/** The default hint level for a principal with no stored preference. */
export const DEFAULT_HINT_LEVEL: HintLevel = 'normal';

/**
 * The selectable hint levels, with the copy the GET endpoint surfaces. Framed in
 * the owner's spirit: hints exist so the agent can help its human, and going dark
 * has a cost the human pays.
 */
export const HINT_LEVEL_CHOICES: HintPreferenceChoice[] = [
  {
    level: 'off',
    summary:
      "No hints, ever. Trade-off: your human may think you're broken or unhelpful — they can't see what you never surface.",
  },
  {
    level: 'normal',
    summary:
      'Hints only when the system thinks it can help you help your human. Each hint repeats at most once a day.',
  },
  {
    level: 'aggressive',
    summary:
      'Coach me aggressively so I use this workspace to the fullest — hints repeat about hourly instead of daily.',
  },
];

/**
 * The request context a trigger evaluates against. Deliberately TINY: a trigger
 * that could see the request it decorates would be a trigger that fires ON an
 * action, and hints never interrupt an action. Everything else a trigger needs it
 * reads from the db.
 */
export interface HintRequestInfo {
  /**
   * The requesting client's self-reported version, parsed from `X-Sparrow-Client`
   * (absent for web / third-party / header-less callers). Drives `upgrade-your-cli`.
   */
  clientVersion?: string;
}

/** Everything a trigger's `applies`/`build` needs, computed once per response. */
interface HintEvalCtx {
  ctx: AppContext;
  principal: PrincipalIdent;
  info: HintRequestInfo;
  now: number;
  /** Every member id of this principal, across all rooms. */
  memberIds: string[];
}

export interface Trigger {
  id: string;
  /** Docs segment this hint links to, resolved to `DOCS_URL/api/<segment>.md`. */
  docs: string;
  /**
   * The OWNER'S framing of this hint — a third-person sentence for the human
   * reading the agent's timeline ("Sparrow hinted the agent to …"). It becomes
   * the `hint.delivered` entry's `summary`, so the Hint info box never dumps
   * agent-directed imperatives on a human reader; the verbatim `build()` text
   * rides the entry's `hint` payload for the expand-to-reveal view. Registry
   * invariants (present on every trigger, third-person stem, ≤ summary max,
   * distinct) are pinned in `hints.registry.test.ts`.
   */
  ownerLabel: string;
  /**
   * Fire ONCE ever — the cooldown is effectively permanent (a delivered row is
   * never eligible again). Used by the `control-your-hints` meta-hint.
   */
  permanent?: boolean;
  /**
   * The COOLDOWN-LEDGER key for this trigger, when it must differ from the public
   * hint `id`. Defaults to `id` (one ledger row per hint, the classic cooldown).
   * `refresh-your-role` returns `refresh-your-role:<roleUpdatedAt>` so that,
   * combined with `permanent`, it fires exactly once per role version and RE-ARMS
   * when the role changes again — independent of the daily cooldown. The public
   * hint id on the wire stays clean (`refresh-your-role`); only the ledger key
   * carries the suffix, and `deliveryCount` canonicalizes it back for the
   * meta-hint tally.
   */
  ledgerKey?(h: HintEvalCtx): string;
  applies(h: HintEvalCtx): boolean;
  build(h: HintEvalCtx): { text: string; action?: HintAction };
}

/** Count of the principal's unread received messages across all memberships. */
function unreadInboxCount(h: HintEvalCtx): number {
  if (h.memberIds.length === 0) return 0;
  return h.ctx.db
    .select({ messageId: messageRecipients.messageId })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .where(
      and(
        inArray(messageRecipients.recipientId, h.memberIds),
        isNull(messageRecipients.readAt),
        // Clawed-back messages are dead — they must not trigger drain-your-inbox.
        isNull(messages.clawedBackAt),
      ),
    )
    .all().length;
}

/** One of the principal's recent sends, as `markdown-renders` judges it. */
interface SentBody {
  body: string;
  createdAt: string;
}

/**
 * The principal's most recent `limit` sends across all rooms, newest first —
 * body AND `createdAt`, because the trigger now fires at the pause and must check
 * that the streak is still fresh rather than a relic from last week.
 */
function recentSentBodies(h: HintEvalCtx, limit: number): SentBody[] {
  if (h.memberIds.length === 0) return [];
  // Clawed-back sends don't count: the message is dead, so it neither teaches
  // nor triggers markdown-renders.
  return h.ctx.db
    .select({ body: messages.body, createdAt: messages.createdAt, id: messages.id })
    .from(messages)
    .where(and(inArray(messages.senderId, h.memberIds), isNull(messages.clawedBackAt)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit)
    .all()
    .map((r) => ({ body: r.body, createdAt: r.createdAt }));
}

/**
 * Whether the principal did anything OBSERVABLE in the last
 * {@link RECENT_ACTIVITY_MS}: sent a message, or read one. Pure db derivation —
 * the engine keeps no state of its own — and the stand-in for "you were just
 * working" now that no trigger sees the action that provoked it.
 */
function recentlyActive(h: HintEvalCtx): boolean {
  if (h.memberIds.length === 0) return false;
  const cutoff = new Date(h.now - RECENT_ACTIVITY_MS).toISOString();
  const sent = h.ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(inArray(messages.senderId, h.memberIds), gte(messages.createdAt, cutoff)))
    .limit(1)
    .get();
  if (sent) return true;
  const read = h.ctx.db
    .select({ messageId: messageRecipients.messageId })
    .from(messageRecipients)
    .where(
      and(
        inArray(messageRecipients.recipientId, h.memberIds),
        isNotNull(messageRecipients.readAt),
        gte(messageRecipients.readAt, cutoff),
      ),
    )
    .limit(1)
    .get();
  return read !== undefined;
}

/**
 * The agent row behind an agent principal — the three email triggers are dormant
 * for a human caller and for an instance with the medium off, because neither
 * has an address to nudge about.
 */
function emailAgent(h: HintEvalCtx): AgentRow | undefined {
  if (h.principal.type !== 'agent') return undefined;
  if (!emailMediumOn(h.ctx)) return undefined;
  const agent = h.ctx.db.select().from(agents).where(eq(agents.id, h.principal.id)).get();
  return agent && agentAddress(h.ctx, agent) ? agent : undefined;
}

/** Every email row anchored to an agent (small per-agent set; one indexed scan). */
function agentEmails(h: HintEvalCtx, agentId: string): EmailRow[] {
  return h.ctx.db.select().from(emails).where(eq(emails.agentId, agentId)).all();
}

/**
 * The agent's most recently READ inbound email — the db trace of "a pop just
 * handed you mail" (popping IS reading: `read_at` is set atomically with the
 * return). `email-is-a-different-register` reads it at the pause instead of
 * riding the mail itself.
 */
function lastReadInboundEmail(h: HintEvalCtx, agentId: string): EmailRow | undefined {
  return h.ctx.db
    .select()
    .from(emails)
    .where(
      and(eq(emails.agentId, agentId), eq(emails.direction, 'in'), isNotNull(emails.readAt)),
    )
    .orderBy(desc(emails.readAt))
    .limit(1)
    .get();
}

/** The agent row behind an agent principal — undefined for a human caller. */
function roleAgent(h: HintEvalCtx): AgentRow | undefined {
  if (h.principal.type !== 'agent') return undefined;
  return h.ctx.db.select().from(agents).where(eq(agents.id, h.principal.id)).get();
}

/** The owner's display name, for the copy that asks the agent to go ask them. */
function ownerOf(h: HintEvalCtx, agent: AgentRow): { id: string; displayName: string } {
  const human = h.ctx.db.select().from(humans).where(eq(humans.id, agent.ownerHumanId)).get();
  return { id: agent.ownerHumanId, displayName: human?.displayName ?? 'your owner' };
}

/**
 * A display name bounded for INTERPOLATION into hint copy. Display names run to
 * 80 chars and `email-is-held` interpolates one twice — at full length that
 * overruns {@link HINT_TEXT_MAX}, and the client REJECTS an overlong hint,
 * failing the send/pop that carried it. The registry-wide bound test builds
 * every trigger at max interpolations to keep this true forever.
 */
const INTERPOLATED_NAME_MAX = 40;
function shortName(name: string): string {
  if (name.length <= INTERPOLATED_NAME_MAX) return name;
  return `${name.slice(0, INTERPOLATED_NAME_MAX - 1)}…`;
}

/**
 * The trigger table, in PRIORITY ORDER (at most one hint per DELIVERY — the first
 * eligible-and-applying trigger wins; the read-only tips view returns them all).
 * Cheapest checks first; the meta-hint is always LAST.
 *
 * Every `applies` here is evaluated at the PAUSE (or when the agent asks), so
 * none of them may reference the request being decorated — see the module doc.
 */
export const TRIGGERS: Trigger[] = [
  {
    // The agent holds no open events stream and no live presence mark, so it is
    // effectively offline — it won't see replies in real time and reads as away.
    // FIRST: reachability is the most fundamental miss, and every other habit
    // (statuses included) only matters once the agent is actually present.
    // Unchanged by the move to the pause: it never depended on the surface. An
    // agent that has just emptied its queue and holds neither stream nor mark is
    // exactly the agent about to go dark.
    id: 'start-listening',
    docs: 'me/events',
    ownerLabel: 'Sparrow hinted the agent to open an events stream so it stays reachable.',
    applies(h) {
      return !h.ctx.rooms.isPrincipalOnline(h.principal.type, h.principal.id);
    },
    build() {
      return {
        // Must stay within HINT_TEXT_MAX (300) — the client rejects a longer hint,
        // which fails the SEND that carried it, not just the nudge.
        text:
          'You look offline — you hold no open events stream. Always-running? Open `GET /me/events` (`sparrow watch`). Turn-based (you think only when invoked)? A listener makes you online, not attentive — run `sparrow await`: same stream, but it EXITS when work waits. Then drain `pop` and re-arm it.',
        action: { method: 'GET', path: '/api/v1/me/events' },
      };
    },
  },
  {
    // REHOMED to the pause. It used to fire on any statusless send or un-acked
    // pop — both send-context reads. The derived replacement: the agent is
    // ONLINE, advertises no working status anywhere, and was RECENTLY ACTIVE
    // (sent or read a message within RECENT_ACTIVITY_MS, straight from the db).
    // That triple is the same miss the old form caught — an agent visibly on a
    // job whose human can't tell — with no request coupling.
    //
    // The old "un-acked pop" check is SUBSUMED, not lost: `ack: true` SETS a
    // status, so "no status advertised" already means the ack switch was not
    // used. Checking the flag again would only re-derive what the status table
    // already says.
    //
    // Offline agents stay exempt: start-listening is their lesson, and a status
    // for an absent agent is noise. The per-level COOLDOWN (daily/hourly), not a
    // burst threshold, bounds the nagging.
    id: 'set-a-status',
    docs: 'rooms/status',
    ownerLabel: 'Sparrow hinted the agent to advertise a working status while it is on a job.',
    applies(h) {
      if (!h.ctx.rooms.isPrincipalOnline(h.principal.type, h.principal.id)) return false;
      if (h.ctx.statuses.anyForMembers(h.memberIds)) return false;
      return recentlyActive(h);
    },
    build() {
      return {
        text:
          'You just worked through your queue with no working status advertised. Pop with `{"ack": true}` to auto-set one scoped to the sender — or set a sticky status for longer work — so your human can see you\'re on it.',
        action: {
          method: 'POST',
          path: '/api/v1/me/inbox/pop',
          exampleBody: { ack: true, note: 'working on your request' },
        },
      };
    },
  },
  {
    // The agent's own inbox is piling up — messages meant for it (often from its
    // human) are going unread. Point at the drain loop.
    //
    // KEPT, with its `endpoint !== 'send'` guard DROPPED so the trigger is
    // surface-independent. The honest consequence: at an EMPTY pop the unread
    // count is 0 by construction, so this can now only fire through
    // `GET /me/hints` (`sparrow tips`) — which is exactly the idle-and-curious
    // moment its lesson serves. (An agent with a backlog reaches the pause only
    // after draining it, at which point the nudge would be a lie.)
    id: 'drain-your-inbox',
    docs: 'me/inbox',
    ownerLabel: 'Sparrow hinted the agent to drain its unread inbox.',
    applies(h) {
      return unreadInboxCount(h) >= DRAIN_UNREAD_THRESHOLD;
    },
    build() {
      return {
        text:
          "You have 5+ unread messages waiting — some may be your human asking for something. Drain your inbox with a pop loop (`sparrow inbox`) so nothing sits unseen.",
        action: { method: 'POST', path: '/api/v1/me/inbox/pop' },
      };
    },
  },
  {
    // The agent's ROLE changed (set by it or its owner) and it hasn't re-read the
    // new version yet. Re-arms per `roleUpdatedAt` — the ledger key carries the
    // timestamp and the trigger is `permanent`, so it fires exactly once per role
    // version, then again only when the role changes. Priority: after
    // drain-your-inbox/start-listening (being reachable comes first), before the
    // room-etiquette nudges (role freshness beats etiquette). Unchanged by the
    // move to the pause — it reads only the agent row and its own ledger key.
    id: 'refresh-your-role',
    docs: 'me',
    ownerLabel: 'Sparrow hinted the agent to re-read its updated role.',
    permanent: true,
    ledgerKey(h) {
      const agent = roleAgent(h);
      return `refresh-your-role:${agent?.roleUpdatedAt ?? 'none'}`;
    },
    applies(h) {
      const agent = roleAgent(h);
      return !!agent && (agent.roleTitle !== null || agent.roleInstructions !== null);
    },
    build() {
      return {
        text:
          'Your role was updated. Re-read it now with `GET /api/v1/me` (your `roleTitle` and `roleInstructions`) so you act on the current job description your owner set — then keep it in mind until the next `role.updated`.',
        action: { method: 'GET', path: '/api/v1/me' },
      };
    },
  },
  {
    // REHOMED to the pause. It used to fire on the pop that RETURNED an email —
    // the most literal case of a hint competing with the work it rides on: the
    // agent is holding a message it must now answer, and the server staples a
    // lecture to it. The derived replacement: the agent has an address, and its
    // most recently read INBOUND email was read within RECENT_ACTIVITY_MS.
    // Popping IS reading, so that row is exactly the mail a just-finished drain
    // handed over. The lesson now lands in the pause right after the drain that
    // included mail, instead of on top of the mail itself — and `build()` still
    // names that email's thread, so the reply action stays concrete.
    //
    // Stays `permanent` (once ever): the register lesson only needs teaching the
    // first time an agent meets the medium.
    id: 'email-is-a-different-register',
    docs: 'me/email/threads',
    ownerLabel: 'Sparrow hinted the agent to write email for an outside reader, not like chat.',
    permanent: true,
    applies(h) {
      const agent = emailAgent(h);
      if (!agent) return false;
      const last = lastReadInboundEmail(h, agent.id);
      if (!last?.readAt) return false;
      return Date.parse(last.readAt) >= h.now - RECENT_ACTIVITY_MS;
    },
    build(h) {
      const agent = emailAgent(h);
      const threadId = (agent && lastReadInboundEmail(h, agent.id)?.threadId) ?? ':threadId';
      return {
        text:
          'That was email, not chat. Your reader is outside this room — maybe outside this org — and will read it once, later, with none of your context. Reply in full paragraphs, restate the background, keep the subject, and skip suggested replies; there are no chips in a mail client.',
        action: {
          method: 'POST',
          path: `/api/v1/me/email/threads/${threadId}/reply`,
          exampleBody: { text: '…' },
        },
      };
    },
  },
  {
    // The agent HAS a mailbox and has never opened it: nothing it anchors has
    // ever been read, and it has never written from the address either. (A bare
    // thread listing leaves no server-side trace, so a read or a send is the
    // honest signal that the agent has met its mailbox.) Unchanged by the move
    // to the pause — already a pure db state check, and "you have never looked"
    // is a standing fact, not a moment.
    id: 'you-have-email',
    docs: 'me/email/threads',
    ownerLabel: 'Sparrow hinted the agent to check the email inbox it has never opened.',
    applies(h) {
      const agent = emailAgent(h);
      if (!agent) return false;
      return agentEmails(h, agent.id).every((e) => e.direction === 'in' && e.readAt === null);
    },
    build(h) {
      const agent = emailAgent(h)!;
      // Careful copy (Jake, 2026-09-02): teach the TRUST MODEL, not an open
      // door. Only human-approved senders reach an agent's inbox — a stranger's
      // mail waits for the human — so the miss being nudged is TRUSTED mail
      // sitting unanswered, never "anyone can email you".
      return {
        text: `Your inbox (${agentAddress(h.ctx, agent)}) has never been opened. Only senders your human approved reach it — strangers wait for their OK — so trusted mail may sit unanswered. Check your threads.`,
        action: { method: 'GET', path: '/api/v1/me/email/threads' },
      };
    },
  },
  {
    // An outbound email has been waiting on a human for ~10 minutes. Don't
    // resend — go ask, in a DM, and watch for `email.resolved`. Unchanged by the
    // move to the pause: an aged hold is a db fact, and the pause is a better
    // moment to act on it than mid-send anyway.
    id: 'email-is-held',
    docs: 'orgs/email/approvals',
    ownerLabel:
      'Sparrow hinted the agent that its outbound email awaits approval, and to ask rather than resend.',
    applies(h) {
      const agent = emailAgent(h);
      if (!agent) return false;
      const cutoff = new Date(h.now - HELD_EMAIL_AGE_MS).toISOString();
      return agentEmails(h, agent.id).some(
        (e) => e.direction === 'out' && e.disposition === 'held' && e.createdAt < cutoff,
      );
    },
    build(h) {
      const owner = ownerOf(h, emailAgent(h)!);
      const name = shortName(owner.displayName);
      return {
        text: `An email you sent is held for ${name} to approve — a recipient your org doesn't recognize yet. Don't resend it; tell ${name} in a DM why it matters, and watch for \`email.resolved\`.`,
        action: {
          method: 'POST',
          path: '/api/v1/me/dms',
          exampleBody: { principal: owner.id },
        },
      };
    },
  },
  /*
   * `rooms-are-broadcast` was DELETED here, not deferred to the pause.
   *
   * It taught: naming `to` inside a non-DM room does nothing, because rooms
   * broadcast. The misuse is INVISIBLE in server state — `to` is
   * accepted-and-ignored on a room send and never persisted, so a room send with
   * `to` and one without produce byte-identical rows. There is nothing at the
   * pause to derive it from.
   *
   * Deferring it would mean the SEND path keeping a side-channel observation
   * (a "this agent used `to` in a room" crumb) purely so the pause could read it
   * back — reintroducing exactly the send-time coupling this design removes, for
   * the weakest lesson in the table. Dropped.
   */
  {
    // REHOMED to the pause. It used to prepend the JUST-SENT body to the streak,
    // which is a send-context read. The derived replacement: the last
    // MARKDOWN_STREAK sends already in the db are all long and formatting-free,
    // AND the newest of them is within RECENT_ACTIVITY_MS. Fully derivable — the
    // streak the old form assembled from `current + previous two` is the same
    // streak, one message later. The recency bound keeps the pause honest: an
    // agent whose plain-text spree was last Tuesday is not mid-lesson.
    id: 'markdown-renders',
    docs: 'rooms/messages',
    ownerLabel: 'Sparrow hinted the agent to format long messages with Markdown.',
    applies(h) {
      const sends = recentSentBodies(h, MARKDOWN_STREAK);
      if (sends.length < MARKDOWN_STREAK) return false;
      const newest = sends[0]!;
      if (Date.parse(newest.createdAt) < h.now - RECENT_ACTIVITY_MS) return false;
      return sends.every(
        (s) => s.body.length >= LONG_MESSAGE_CHARS && !MARKDOWN_TOKEN.test(s.body),
      );
    },
    build() {
      return {
        text:
          'Your long messages are plain text — this workspace renders Markdown. Use headings, `**bold**`, lists, and `code` so your human can skim what you send.',
      };
    },
  },
  {
    // The requesting client identified itself (X-Sparrow-Client) and parses BELOW
    // the instance's recommended version — nudge it to upgrade. Soft tier: purely
    // advisory (the hard tier is a 426). Off unless the operator set a recommended
    // version; unknown/header-less callers never match.
    id: 'upgrade-your-cli',
    docs: 'versioning',
    ownerLabel: 'Sparrow hinted the agent to upgrade its sparrow CLI.',
    applies(h) {
      const recommended = h.ctx.config.clientRecommendedVersion;
      const current = h.info.clientVersion;
      if (!recommended || !current) return false;
      return clientVersionBelow(current, recommended);
    },
    build(h) {
      const recommended = h.ctx.config.clientRecommendedVersion;
      return {
        text:
          `Your Sparrow client (${h.info.clientVersion}) is behind the recommended ${recommended}. ` +
          'Upgrade with `sparrow upgrade`, or re-run `curl -fsSL ' +
          `${installArtifactUrl(installHome(h.ctx.config), 'install.sh')} | sh\`.`,
        action: {
          method: 'GET',
          path: installArtifactUrl(installHome(h.ctx.config), 'install.sh'),
        },
      };
    },
  },
  {
    // Meta-hint (LAST): once a principal has been coached ≥3 times, teach it it
    // can dial hints up or down. Fires exactly once, ever.
    id: 'control-your-hints',
    docs: 'me/hint-preferences',
    ownerLabel: 'Sparrow hinted the agent that it can tune how often it is hinted.',
    permanent: true,
    applies(h) {
      return deliveryCount(h.ctx, h.principal) >= HINT_META_THRESHOLD;
    },
    build() {
      return {
        text:
          "These nudges help you serve your human. Tune them any time at PUT /me/hint-preferences: `off` (silent — risky), `normal` (daily), or `aggressive` (hourly coaching).",
        action: { method: 'PUT', path: '/api/v1/me/hint-preferences', exampleBody: { level: 'normal' } },
      };
    },
  },
];

/* ------------------------------------------------------------------ *
 * Preference + delivery-ledger helpers
 * ------------------------------------------------------------------ */

/** The principal's stored hint level, or the default when none is set. */
export function getHintLevel(ctx: AppContext, principal: PrincipalIdent): HintLevel {
  const row = ctx.db
    .select()
    .from(hintPreferences)
    .where(
      and(
        eq(hintPreferences.principalType, principal.type),
        eq(hintPreferences.principalId, principal.id),
      ),
    )
    .get();
  return (row?.level as HintLevel | undefined) ?? DEFAULT_HINT_LEVEL;
}

/** Persist a principal's hint level (upsert). */
export function setHintLevel(ctx: AppContext, principal: PrincipalIdent, level: HintLevel): void {
  ctx.db
    .insert(hintPreferences)
    .values({ principalType: principal.type, principalId: principal.id, level })
    .onConflictDoUpdate({
      target: [hintPreferences.principalType, hintPreferences.principalId],
      set: { level },
    })
    .run();
}

/**
 * How many distinct hints this principal has ever been delivered. Ledger keys are
 * canonicalized to the part before the first `:` so a re-arming hint's per-version
 * rows (`refresh-your-role:<ts₁>`, `refresh-your-role:<ts₂>`, …) collapse to ONE
 * hint for the meta-hint tally — role churn never inflates the count that trips
 * `control-your-hints`. Hint ids themselves never contain a `:`.
 */
export function deliveryCount(ctx: AppContext, principal: PrincipalIdent): number {
  const rows = ctx.db
    .select({ hintId: hintDeliveries.hintId })
    .from(hintDeliveries)
    .where(
      and(
        eq(hintDeliveries.principalType, principal.type),
        eq(hintDeliveries.principalId, principal.id),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.hintId.split(':')[0])).size;
}

/** The last delivery time (ISO) of `hintId` to `principal`, or undefined if never. */
function lastDeliveredAt(
  ctx: AppContext,
  principal: PrincipalIdent,
  hintId: string,
): string | undefined {
  return ctx.db
    .select({ deliveredAt: hintDeliveries.deliveredAt })
    .from(hintDeliveries)
    .where(
      and(
        eq(hintDeliveries.principalType, principal.type),
        eq(hintDeliveries.principalId, principal.id),
        eq(hintDeliveries.hintId, hintId),
      ),
    )
    .get()?.deliveredAt;
}

/** Record (or refresh) a hint delivery for the cooldown ledger. */
function recordDelivery(ctx: AppContext, principal: PrincipalIdent, hintId: string): void {
  const at = nowIso();
  ctx.db
    .insert(hintDeliveries)
    .values({ principalType: principal.type, principalId: principal.id, hintId, deliveredAt: at })
    .onConflictDoUpdate({
      target: [hintDeliveries.principalType, hintDeliveries.principalId, hintDeliveries.hintId],
      set: { deliveredAt: at },
    })
    .run();
}

/**
 * Whether this trigger is off cooldown for the principal (eligible to re-fire).
 * `ledgerKey` is the cooldown-ledger identity — usually the trigger id, but a
 * per-version key for a re-arming hint (see {@link Trigger.ledgerKey}). A
 * `permanent` trigger fires once per DISTINCT key: never again for the same key,
 * but a fresh key (e.g. a new `roleUpdatedAt`) is "never delivered" and so fires.
 */
function offCooldown(
  ctx: AppContext,
  principal: PrincipalIdent,
  trigger: Trigger,
  ledgerKey: string,
  windowMs: number,
  now: number,
): boolean {
  const last = lastDeliveredAt(ctx, principal, ledgerKey);
  if (last === undefined) return true; // never delivered (this key)
  if (trigger.permanent) return false; // fire once per key
  return now - Date.parse(last) >= windowMs;
}

/** Every member id belonging to a principal, across all rooms. */
function principalMemberIds(ctx: AppContext, principal: PrincipalIdent): string[] {
  return ctx.db
    .select({ id: members.id })
    .from(members)
    .where(
      and(eq(members.principalType, principal.type), eq(members.principalId, principal.id)),
    )
    .all()
    .map((r) => r.id);
}

/**
 * The requesting client's self-reported version, parsed from `X-Sparrow-Client`
 * (`<product>/<version>`), or undefined when absent/unparseable. Fed into
 * {@link HintRequestInfo.clientVersion} so the `upgrade-your-cli` trigger can
 * compare it to the recommended floor.
 */
export function clientVersionOf(request: FastifyRequest): string | undefined {
  const raw = request.headers['x-sparrow-client'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return parseClientIdent(header)?.version;
}

/** Whether the request opted out of hints via the `X-Sparrow-No-Hints: 1` header. */
export function requestOptedOut(request: FastifyRequest): boolean {
  const raw = request.headers['x-sparrow-no-hints'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === '1';
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Everything both entry points need, built once. Factored so the DELIVERY path
 * and the read-only PREVIEW path evaluate triggers against an identical world —
 * a trigger must never behave differently depending on who asked.
 */
function makeEvalCtx(
  ctx: AppContext,
  principal: PrincipalIdent,
  info: HintRequestInfo,
): HintEvalCtx {
  return {
    ctx,
    principal,
    info,
    now: Date.now(),
    memberIds: principalMemberIds(ctx, principal),
  };
}

/** Assemble the wire {@link Hint} from a trigger and what its `build()` returned. */
function toHint(
  trigger: Trigger,
  built: { text: string; action?: HintAction },
  ctx: AppContext,
): Hint {
  const hint: Hint = { id: trigger.id, text: built.text };
  if (built.action) hint.action = built.action;
  // The canonical docs home, never the request origin: one page per endpoint,
  // the same document whichever instance taught the lesson.
  hint.docs = apiDocMarkdownUrl(docsHome(ctx.config), trigger.docs);
  return hint;
}

/**
 * THE DELIVERY PATH — the PAUSE. Evaluate the trigger table for the `{ item:
 * null }` response of `POST /me/inbox/pop` and return the (at most one) hint to
 * attach, or `undefined` when nothing fires: the caller then omits `hints`
 * entirely (never an empty array), keeping quiet responses byte-identical for old
 * clients. Records the delivery in the cooldown ledger and journals a
 * `hint.delivered` activity entry when a hint fires.
 *
 * The caller must only reach this on the EMPTY branch. A hint attached to work
 * the agent is about to do would be teaching that interrupts — see the module
 * doc.
 *
 * Suppression precedence: `HINTS_ENABLED=false` (env kill-switch) → humans (never
 * hinted) → `X-Sparrow-No-Hints: 1` request header → the principal's `off` level.
 */
export function computeHints(
  ctx: AppContext,
  principal: PrincipalIdent,
  info: HintRequestInfo,
  request: FastifyRequest,
): Hint[] | undefined {
  if (ctx.config.hintsEnabled === false) return undefined;
  if (principal.type !== 'agent') return undefined; // agents only in v1
  if (requestOptedOut(request)) return undefined;
  const level = getHintLevel(ctx, principal);
  if (level === 'off') return undefined;
  const windowMs = level === 'aggressive' ? HINT_COOLDOWN_AGGRESSIVE_MS : HINT_COOLDOWN_MS;

  const evalCtx = makeEvalCtx(ctx, principal, info);

  for (const trigger of TRIGGERS) {
    const ledgerKey = trigger.ledgerKey ? trigger.ledgerKey(evalCtx) : trigger.id;
    if (!offCooldown(ctx, principal, trigger, ledgerKey, windowMs, evalCtx.now)) continue;
    if (!trigger.applies(evalCtx)) continue;
    const { text, action } = trigger.build(evalCtx);
    // The ledger records the per-version key; the public hint id stays clean.
    recordDelivery(ctx, principal, ledgerKey);
    // The owner's window onto what the system taught their agent: every real
    // delivery is journaled on the agent's timeline (medium `system`, actor
    // sparrow itself), so it surfaces as a Hint info box in the owner's DM pane.
    // `summary` is the trigger's ownerLabel — the human-framed sentence — and
    // the verbatim agent-directed text rides the `hint` payload, revealed only
    // when the box is expanded. Deliveries are cooldown-bounded, so the volume
    // is a trickle by design.
    const agent = ctx.db.select().from(agents).where(eq(agents.id, principal.id)).get();
    if (agent) {
      appendActivity(ctx, {
        orgId: agent.orgId,
        agentId: agent.id,
        medium: 'system',
        type: 'hint.delivered',
        actor: { kind: 'system', label: 'sparrow' },
        summary: trigger.ownerLabel,
        hint: { id: trigger.id, text },
      });
    }
    return [toHint(trigger, { text, action }, ctx)];
  }
  return undefined;
}

/**
 * THE ASK — a READ-ONLY evaluation for `GET /me/hints` (`sparrow tips`). The
 * agent is ASKING, and an explicit question is not an interruption, so this path
 * deliberately IGNORES every suppression that exists to protect work in flight:
 * the cooldown ledger, `permanent`, the per-principal `off` level, and the
 * `X-Sparrow-No-Hints` header. Only the instance kill-switch
 * (`HINTS_ENABLED=false`) and agents-only still apply — the operator's switch is
 * not the agent's to override, and humans have the web.
 *
 * It returns EVERY trigger whose `applies` is true, in priority order (not just
 * the first), because a tips view is a list, not a nudge.
 *
 * **It records NOTHING**: no cooldown-ledger row, no `hint.delivered` activity
 * entry. Consequences, both intended: viewing tips NEVER suppresses a future real
 * delivery (an agent can read the whole table at any time without spending the
 * lesson it would otherwise be taught at its next pause), and nothing the owner
 * sees on the timeline claims sparrow taught the agent something it merely
 * browsed. Never call this from a response-decorating path.
 */
export function previewHints(
  ctx: AppContext,
  principal: PrincipalIdent,
  info: HintRequestInfo,
): Hint[] {
  if (ctx.config.hintsEnabled === false) return [];
  if (principal.type !== 'agent') return []; // agents only in v1
  const evalCtx = makeEvalCtx(ctx, principal, info);
  const hints: Hint[] = [];
  for (const trigger of TRIGGERS) {
    if (!trigger.applies(evalCtx)) continue;
    hints.push(toHint(trigger, trigger.build(evalCtx), ctx));
  }
  return hints;
}


