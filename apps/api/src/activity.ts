/**
 * Unified attention (layer 3) — the activity timeline (SPEC v4 "Unified
 * attention → The activity timeline").
 *
 * One append-only journal every medium writes typed entries into, read per agent
 * or per principal. Layer 3 never carries payloads: an entry is a REF (`summary`
 * + the medium's ids), and bodies are fetched from the owning medium's routes.
 *
 * **This module is the seam.** {@link appendActivity} is the ONE writer: a
 * medium calls it with an entry-registry type and its refs, and gets the
 * denormalized owner, the frozen actor label, and the `activity.appended` fan-out
 * to the owning human for free. The chat medium's caller is
 * {@link appendChatMessageActivity}; the email medium's writers
 * (`email.received`, `email.sent`, `email.quarantined`, `email.held`,
 * `email.rejected`, `email.resolved`) call `appendActivity` directly when that
 * wave lands — no change to this file's shape is needed for them.
 */
import { and, eq } from 'drizzle-orm';
import {
  newActivityEntryId,
  ACTIVITY_SUMMARY_MAX,
  type ActivityActorKind,
  type ActivityEntry,
  type ActivityEntryType,
  type ActivityHint,
  type ActivityRefs,
  type Medium,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { activityEntries, agents, humans, members } from './db/schema.js';
import type { ActivityEntryRow, AgentRow, MessageRow, RoomRow } from './db/schema.js';
import { memberById } from './room-helpers.js';
import { humansWhoCanSeeAgent } from './agent-helpers.js';

/** What a medium hands the timeline when something happened. */
export interface ActivityAppendInput {
  orgId: string;
  /** The involved agent (the anchor). `null` for a (future) org-level entry. */
  agentId: string | null;
  medium: Medium;
  type: ActivityEntryType;
  actor: {
    kind: ActivityActorKind;
    /** `usr_`/`agt_` principal id, when the actor is a principal. */
    principalId?: string | null;
    /** `ext_` external contact id, when the actor is an email contact. */
    contactId?: string | null;
    /** The display string to FREEZE on the row (history must survive renames). */
    label: string;
  };
  /** Subject or first line; truncated to {@link ACTIVITY_SUMMARY_MAX}. */
  summary?: string | null;
  /** Only the keys this medium sets (chat: room/message; email: thread/email). */
  refs?: ActivityRefs;
  /**
   * `hint.delivered` only: the inline payload (trigger id + the verbatim text
   * conveyed to the agent). The one exception to entries-are-refs — the
   * `system` medium has no fetch route, so the ≤`HINT_TEXT_MAX` payload rides
   * the entry and the owner's Hint info box reveals it on expand.
   */
  hint?: ActivityHint;
  createdAt?: string;
}

/** Trim a summary to the stored/wire bound (null stays null). */
function clampSummary(summary: string | null | undefined): string | null {
  if (summary === undefined || summary === null) return null;
  const flat = summary.trim();
  if (flat === '') return null;
  return flat.length > ACTIVITY_SUMMARY_MAX ? flat.slice(0, ACTIVITY_SUMMARY_MAX) : flat;
}

/** Project a stored row to the `ActivityEntry` wire shape (refs only, no payload). */
export function toActivityEntry(ctx: AppContext, row: ActivityEntryRow): ActivityEntry {
  let agent: ActivityEntry['agent'] = null;
  if (row.agentId) {
    const found = ctx.db.select().from(agents).where(eq(agents.id, row.agentId)).get();
    // The agent row is the live name; a deleted agent takes its entries with it,
    // so a missing row can only be a torn read — fall back to the id.
    agent = { id: row.agentId, name: found?.name ?? row.agentId };
  }
  const refs: ActivityRefs = {};
  if (row.roomId) refs.roomId = row.roomId;
  if (row.messageId) refs.messageId = row.messageId;
  if (row.emailThreadId) refs.emailThreadId = row.emailThreadId;
  if (row.emailId) refs.emailId = row.emailId;
  const entry: ActivityEntry = {
    id: row.id,
    orgId: row.orgId,
    medium: row.medium as Medium,
    type: row.type as ActivityEntryType,
    agent,
    actor: {
      kind: row.actorKind as ActivityActorKind,
      id: row.actorPrincipalId ?? row.actorContactId ?? null,
      displayName: row.actorLabel,
    },
    summary: row.summary ?? null,
    refs,
    createdAt: row.createdAt,
  };
  // The one inline payload (hint.delivered). Both columns or neither: a row
  // that predates the columns renders from summary alone, not expandable.
  if (row.hintId && row.hintText !== null) {
    entry.hint = { id: row.hintId, text: row.hintText };
  }
  return entry;
}

/**
 * Append ONE typed entry and notify the involved agent's owner.
 *
 * `owner_human_id` is denormalized at append time (a human's timeline is then one
 * indexed read), and `activity.appended` goes to that owner ONLY — the agent
 * already received the underlying event, and fanning it further would turn one
 * message into an unbounded broadcast. A non-owner permitted to read the timeline
 * (an org owner/admin) refetches instead.
 */
export function appendActivity(ctx: AppContext, input: ActivityAppendInput): ActivityEntryRow {
  const agent: AgentRow | undefined = input.agentId
    ? ctx.db.select().from(agents).where(eq(agents.id, input.agentId)).get()
    : undefined;
  const row: ActivityEntryRow = {
    id: newActivityEntryId(),
    orgId: input.orgId,
    agentId: input.agentId,
    ownerHumanId: agent?.ownerHumanId ?? null,
    medium: input.medium,
    type: input.type,
    actorKind: input.actor.kind,
    actorPrincipalId: input.actor.principalId ?? null,
    actorContactId: input.actor.contactId ?? null,
    actorLabel: input.actor.label,
    summary: clampSummary(input.summary),
    roomId: input.refs?.roomId ?? null,
    messageId: input.refs?.messageId ?? null,
    emailThreadId: input.refs?.emailThreadId ?? null,
    emailId: input.refs?.emailId ?? null,
    hintId: input.hint?.id ?? null,
    hintText: input.hint?.text ?? null,
    createdAt: input.createdAt ?? nowIso(),
  };
  ctx.db.insert(activityEntries).values(row).run();
  if (row.ownerHumanId) {
    ctx.bus.publish('human', row.ownerHumanId, 'activity.appended', {
      entry: toActivityEntry(ctx, row),
    });
  }
  return row;
}

/** The first non-empty line of a body, as the fallback entry summary. */
function firstLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/**
 * The chat medium's writer: `chat.message` (SPEC "Entry types registry" —
 * *written when a message is sent in a room with ≥1 agent member; one entry per
 * involved agent (sender or recipient)*).
 *
 * The involved agents are the room's agent members — the sender when it is an
 * agent, plus every agent recipient — so each agent's timeline is complete on its
 * own. A room with no agent member writes nothing: layer 3 journals only what
 * involves an agent, and a human↔human room is not a message log.
 */
export function appendChatMessageActivity(
  ctx: AppContext,
  room: RoomRow,
  message: MessageRow,
): void {
  const agentMemberIds = ctx.db
    .select({ principalId: members.principalId })
    .from(members)
    .where(and(eq(members.roomId, room.id), eq(members.principalType, 'agent')))
    .all()
    .map((m) => m.principalId);
  if (agentMemberIds.length === 0) return;

  const sender = memberById(ctx, message.senderId);
  const actorKind: ActivityActorKind = sender?.principalType === 'agent' ? 'agent' : 'human';
  const actorPrincipalId = sender?.principalId ?? null;
  // Frozen at append time — unlike MemberRef.displayName, which renders live.
  const actorLabel = sender ? senderLabel(ctx, sender.principalType, sender.principalId) : '';
  const summary = message.subject ?? firstLine(message.body);

  const rows = agentMemberIds.map((agentId) =>
    appendActivity(ctx, {
      orgId: room.orgId,
      agentId,
      medium: 'chat',
      type: 'chat.message',
      actor: { kind: actorKind, principalId: actorPrincipalId, label: actorLabel },
      summary,
      refs: { roomId: room.id, messageId: message.id },
      createdAt: message.createdAt,
    }),
  );

  // Human oversight of an agent↔agent DM. The two agents already received the
  // message (normal DM delivery) and their OWNERS the `activity.appended` above;
  // but the ambient oversight box belongs to EVERY human who can currently see
  // both agents, which the owner fan-out does not reach. Nudge those extra
  // viewers with the same event so their box updates live — no new event type,
  // no unread state, purely ambient. (The two owners are already covered by
  // their own entry's fan-out, so they are skipped here to avoid a duplicate.)
  if (room.kind === 'dm' && agentMemberIds.length === 2 && rows.length === 2) {
    const a = ctx.db.select().from(agents).where(eq(agents.id, agentMemberIds[0]!)).get();
    const b = ctx.db.select().from(agents).where(eq(agents.id, agentMemberIds[1]!)).get();
    if (a && b) {
      const owners = new Set([a.ownerHumanId, b.ownerHumanId]);
      const seeA = humansWhoCanSeeAgent(ctx, a);
      const entry = toActivityEntry(ctx, rows[0]!);
      for (const humanId of humansWhoCanSeeAgent(ctx, b)) {
        if (owners.has(humanId) || !seeA.has(humanId)) continue;
        ctx.bus.publish('human', humanId, 'activity.appended', { entry });
      }
    }
  }
}

/** The display string of a principal, resolved once and then frozen on the row. */
function senderLabel(ctx: AppContext, principalType: string, principalId: string): string {
  if (principalType === 'agent') {
    const agent = ctx.db.select().from(agents).where(eq(agents.id, principalId)).get();
    return agent?.name ?? principalId;
  }
  const human = ctx.db.select().from(humans).where(eq(humans.id, principalId)).get();
  return human?.displayName ?? principalId;
}
