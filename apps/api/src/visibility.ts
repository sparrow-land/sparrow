/**
 * Agent visibility — the database half (SPEC "Agent visibility"): tags, the
 * per-agent messaging policy, delegated grants, and the always-on message
 * analytics counters. The authority RULES are pure and live in
 * `visibility-authority.ts`; this module loads the facts they decide over and
 * owns the reads/writes.
 */
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import type {
  AgentAnalyticsResponse,
  AgentAnalyticsWindow,
  AgentMessagingPolicy,
  Grant,
  PrincipalKind,
} from '@sparrow-land/sdk/types';
import type { AppContext, Principal } from './context.js';
import type { DB } from './db/index.js';
import { agents, agentTags, grants, humans, messageStats, orgMemberships, rooms } from './db/schema.js';
import type { AgentRow, GrantRow } from './db/schema.js';
import { membershipOf } from './org-helpers.js';
import { notFound, badRequest } from './errors.js';
import { ALL_TAGS_SCOPE, type ActorFacts, type TargetFacts } from './visibility-authority.js';

/** Anything that can run a drizzle insert/delete: the db handle or a transaction. */
type Writer = Pick<DB, 'insert' | 'delete'>;

/* ------------------------------------------------------------------ *
 * Tags & messaging
 * ------------------------------------------------------------------ */

/** An agent's tags, sorted (the wire order). */
export function agentTagsOf(db: DB, agentId: string): string[] {
  return db
    .select({ tag: agentTags.tag })
    .from(agentTags)
    .where(eq(agentTags.agentId, agentId))
    .orderBy(asc(agentTags.tag))
    .all()
    .map((r) => r.tag);
}

/**
 * Tags for many agents in ONE query (lists), keyed by agent id; an agent with no
 * tags maps to `[]`. Each list is sorted.
 */
export function agentTagsByAgent(db: DB, agentIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(agentIds.map((id) => [id, []]));
  if (agentIds.length === 0) return out;
  const rows = db
    .select({ agentId: agentTags.agentId, tag: agentTags.tag })
    .from(agentTags)
    .where(inArray(agentTags.agentId, [...new Set(agentIds)]))
    .orderBy(asc(agentTags.tag))
    .all();
  for (const r of rows) out.get(r.agentId)?.push(r.tag);
  return out;
}

/** Replace an agent's tag set (atomically). */
export function setAgentTags(db: DB, agentId: string, tags: readonly string[]): void {
  db.transaction((tx) => {
    tx.delete(agentTags).where(eq(agentTags.agentId, agentId)).run();
    for (const tag of new Set(tags)) tx.insert(agentTags).values({ agentId, tag }).run();
  });
}

/** An agent row's messaging policy (the column defaults to `any`). */
export function messagingOf(row: Pick<AgentRow, 'messaging'>): AgentMessagingPolicy {
  const v = row.messaging;
  return v === 'tags' || v === 'none' ? v : 'any';
}

/**
 * The agents whose messaging policy forbids an agent↔agent DM between `a` and
 * `b` (empty = allowed). `any` allows (today's rule, applied elsewhere); `tags`
 * allows only when the pair shares ≥1 tag; `none` never allows. BOTH sides must
 * allow.
 */
export function messagingBlockers(ctx: AppContext, a: AgentRow, b: AgentRow): AgentRow[] {
  const pa = messagingOf(a);
  const pb = messagingOf(b);
  if (pa === 'any' && pb === 'any') return [];
  let shared: boolean | undefined;
  const shareTag = (): boolean => {
    if (shared === undefined) {
      const ta = new Set(agentTagsOf(ctx.db, a.id));
      shared = agentTagsOf(ctx.db, b.id).some((t) => ta.has(t));
    }
    return shared;
  };
  const allows = (p: AgentMessagingPolicy): boolean =>
    p === 'any' || (p === 'tags' && shareTag());
  return [a, b].filter((agent) => !allows(messagingOf(agent)));
}

/** The refusal message naming whose messaging setting blocks the DM. */
export function messagingPolicyMessage(blockers: readonly AgentRow[]): string {
  return blockers
    .map((agent) =>
      messagingOf(agent) === 'none'
        ? `${agent.name}’s messaging setting is \`none\`: it does not take direct messages from other agents`
        : `${agent.name}’s messaging setting is \`tags\`: it only takes direct messages from agents that share one of its tags`,
    )
    .join('; ');
}

/* ------------------------------------------------------------------ *
 * Grants
 * ------------------------------------------------------------------ */

/** The scopes a principal holds in an org. */
export function scopesOf(db: DB, orgId: string, principalId: string): string[] {
  return db
    .select({ scope: grants.scope })
    .from(grants)
    .where(and(eq(grants.orgId, orgId), eq(grants.principalId, principalId)))
    .all()
    .map((r) => r.scope);
}

/** Wire shape of a grant. */
export function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    orgId: row.orgId,
    principalId: row.principalId,
    principalKind: row.principalKind as PrincipalKind,
    scope: row.scope,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
  };
}

/** Everything an org's grants table holds, oldest first. */
export function grantsOfOrg(db: DB, orgId: string): GrantRow[] {
  return db
    .select()
    .from(grants)
    .where(eq(grants.orgId, orgId))
    .orderBy(asc(grants.createdAt), asc(grants.id))
    .all();
}

/** A drizzle handle that can also read: the db or a transaction. */
type Tx = Pick<DB, 'select' | 'selectDistinct' | 'insert' | 'delete'>;

const isAdminRole = (role: string | null | undefined): boolean => role === 'owner' || role === 'admin';

/**
 * Whether a principal can still justify the grants it created in `orgId`: it is
 * an org owner/admin, or it holds `tags:*` (the only delegated scope that may
 * grant).
 */
function justifiesGrants(tx: Tx, orgId: string, principalId: string): boolean {
  const m = tx
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.humanId, principalId)))
    .get();
  if (isAdminRole(m?.role)) return true;
  return (
    tx
      .select({ id: grants.id })
      .from(grants)
      .where(and(eq(grants.orgId, orgId), eq(grants.principalId, principalId), eq(grants.scope, ALL_TAGS_SCOPE)))
      .get() !== undefined
  );
}

/**
 * Delegated grants stand only while their creator can justify them. For each
 * (org, principal) seed that can no longer justify its grants, delete the grants
 * it CREATED in that org, then re-check each of their holders the same way
 * (their authority just shrank), until nothing changes. Run inside the
 * transaction that took the seed's authority away.
 */
export function revokeUnjustifiedGrants(
  tx: Tx,
  seeds: readonly { orgId: string; principalId: string }[],
): void {
  const queue = [...seeds];
  // Terminates: a principal is only re-queued after at least one grant is deleted.
  while (queue.length > 0) {
    const { orgId, principalId } = queue.shift()!;
    if (justifiesGrants(tx, orgId, principalId)) continue;
    const created = tx
      .select({ id: grants.id, principalId: grants.principalId })
      .from(grants)
      .where(and(eq(grants.orgId, orgId), eq(grants.grantedBy, principalId)))
      .all();
    if (created.length === 0) continue;
    tx.delete(grants).where(inArray(grants.id, created.map((g) => g.id))).run();
    for (const g of new Set(created.map((c) => c.principalId))) queue.push({ orgId, principalId: g });
  }
}

/**
 * Remove every visibility row an AGENT leaves behind when it is destroyed: its
 * tags and the grants it holds. Its analytics buckets go too (nothing can read
 * them once the agent is gone). Grants it CREATED go as well (recursively):
 * they were delegated through its `tags:*`, and a deleted agent justifies
 * nothing — the same rule as revoking its `tags:*`.
 */
export function deleteAgentVisibility(tx: Tx, agentIds: readonly string[]): void {
  if (agentIds.length === 0) return;
  const ids = [...agentIds];
  tx.delete(agentTags).where(inArray(agentTags.agentId, ids)).run();
  tx.delete(grants).where(inArray(grants.principalId, ids)).run();
  tx.delete(messageStats).where(inArray(messageStats.agentId, ids)).run();
  const seeds = tx
    .selectDistinct({ orgId: grants.orgId, principalId: grants.grantedBy })
    .from(grants)
    .where(inArray(grants.grantedBy, ids))
    .all();
  revokeUnjustifiedGrants(tx, seeds);
}

/**
 * Remove the grants a human held in an org (they left, or were removed). Grants
 * they CREATED follow the justification rule, judged by the role they had: a
 * plain member's were delegated through `tags:*` and go with them (recursively);
 * an org owner/admin's were the org's own decisions and stand (any owner/admin
 * can revoke them).
 */
export function deleteHumanGrants(tx: Tx, orgId: string, humanId: string, role: string): void {
  tx.delete(grants).where(and(eq(grants.orgId, orgId), eq(grants.principalId, humanId))).run();
  if (!isAdminRole(role)) revokeUnjustifiedGrants(tx, [{ orgId, principalId: humanId }]);
}

/* ------------------------------------------------------------------ *
 * Authority facts
 * ------------------------------------------------------------------ */

/**
 * The caller as an authority ACTOR in `orgId`: a human org member (owners/admins
 * flagged) or an agent of the org. Anyone else gets `404 No such org` — orgs
 * never leak their existence to outsiders.
 */
export function actorFacts(ctx: AppContext, orgId: string, principal: Principal): ActorFacts {
  if (principal.type === 'agent') {
    if (principal.agent.orgId !== orgId) throw notFound('No such org');
    return {
      kind: 'agent',
      id: principal.agent.id,
      orgAdmin: false,
      scopes: scopesOf(ctx.db, orgId, principal.agent.id),
      tags: agentTagsOf(ctx.db, principal.agent.id),
      messaging: messagingOf(principal.agent),
    };
  }
  const m = membershipOf(ctx.db, orgId, principal.human.id);
  if (!m) throw notFound('No such org');
  return {
    kind: 'human',
    id: principal.human.id,
    orgAdmin: m.role === 'owner' || m.role === 'admin',
    scopes: scopesOf(ctx.db, orgId, principal.human.id),
  };
}

/** An agent of `orgId`, or `404 No such agent`. */
export function orgAgentOr404(ctx: AppContext, orgId: string, agentId: string): AgentRow {
  const agent = ctx.db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || agent.orgId !== orgId) throw notFound('No such agent');
  return agent;
}

/** An agent as the TARGET of an authority decision. */
export function agentTargetFacts(ctx: AppContext, agent: AgentRow): TargetFacts {
  return {
    kind: 'agent',
    id: agent.id,
    ownerHumanId: agent.ownerHumanId,
    tags: agentTagsOf(ctx.db, agent.id),
    scopes: scopesOf(ctx.db, agent.orgId, agent.id),
  };
}

/**
 * A grant's principal (`usr_` human member or `agt_` agent of the org) as a
 * target. `400` for anything that is not a principal id; `404` for a principal
 * outside the org.
 */
export function principalTargetFacts(ctx: AppContext, orgId: string, principalId: string): TargetFacts {
  if (principalId.startsWith('agt_')) return agentTargetFacts(ctx, orgAgentOr404(ctx, orgId, principalId));
  if (principalId.startsWith('usr_')) {
    if (!membershipOf(ctx.db, orgId, principalId)) throw notFound('No such member');
    return { kind: 'human', id: principalId, tags: [], scopes: scopesOf(ctx.db, orgId, principalId) };
  }
  throw badRequest('principalId must be a human (usr_…) or agent (agt_…) id');
}

/* ------------------------------------------------------------------ *
 * Message analytics — counters
 * ------------------------------------------------------------------ */

/** The token ESTIMATE for a message body: `ceil(characters / 4)`. */
export function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

/** The UTC hour an ISO timestamp falls in, as an ISO timestamp. */
export function hourStartOf(iso: string): string {
  return `${iso.slice(0, 13)}:00:00.000Z`;
}

interface StatParty {
  type: string | null;
  id: string | null;
}

function bump(
  tx: Writer,
  agentId: string,
  hourStart: string,
  direction: 'sent' | 'received',
  counterpartKind: 'agent' | 'human' | 'room',
  counterpartId: string,
  tokens: number,
): void {
  tx.insert(messageStats)
    .values({ agentId, hourStart, direction, counterpartKind, counterpartId, messages: 1, tokens })
    .onConflictDoUpdate({
      target: [
        messageStats.agentId,
        messageStats.hourStart,
        messageStats.direction,
        messageStats.counterpartKind,
        messageStats.counterpartId,
      ],
      set: {
        messages: sql`${messageStats.messages} + 1`,
        tokens: sql`${messageStats.tokens} + ${tokens}`,
      },
    })
    .run();
}

/**
 * Record one stored message in the analytics buckets. Called INSIDE the
 * transaction that inserts the message, so a message and its counts land (or
 * roll back) together. The sender, if an agent, records one `sent`; each agent
 * recipient one `received`. In a DM the counterpart is the other member; in a
 * room it is the room.
 */
export function recordMessageStats(
  tx: Writer,
  input: {
    roomId: string;
    isDm: boolean;
    createdAt: string;
    body: string;
    sender: StatParty;
    recipients: readonly StatParty[];
  },
): void {
  const hour = hourStartOf(input.createdAt);
  const tokens = estimateTokens(input.body);
  const asCounterpart = (p: StatParty): ['agent' | 'human', string] | null =>
    (p.type === 'agent' || p.type === 'human') && p.id ? [p.type, p.id] : null;

  if (input.sender.type === 'agent' && input.sender.id) {
    if (!input.isDm) {
      bump(tx, input.sender.id, hour, 'sent', 'room', input.roomId, tokens);
    } else {
      const other = input.recipients.map(asCounterpart).find((c) => c !== null);
      if (other) bump(tx, input.sender.id, hour, 'sent', other[0], other[1], tokens);
    }
  }
  const from = asCounterpart(input.sender);
  for (const r of input.recipients) {
    if (r.type !== 'agent' || !r.id) continue;
    if (!input.isDm) bump(tx, r.id, hour, 'received', 'room', input.roomId, tokens);
    else if (from) bump(tx, r.id, hour, 'received', from[0], from[1], tokens);
  }
}

/* ------------------------------------------------------------------ *
 * Message analytics — the report
 * ------------------------------------------------------------------ */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_MS: Record<Exclude<AgentAnalyticsWindow, 'all'>, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};
const TOP_N = 20;

const floorTo = (ms: number, unit: number): number => Math.floor(ms / unit) * unit;

/**
 * The analytics report for one agent over a window ending `now`. Buckets are
 * hourly, so a window starts at the hour its `from` falls in. The series is
 * DENSE (zero buckets included): hourly for `24h`, daily (UTC) otherwise.
 */
export function agentAnalytics(
  ctx: AppContext,
  agent: AgentRow,
  window: AgentAnalyticsWindow,
  now: Date = new Date(),
): AgentAnalyticsResponse {
  const to = now.toISOString();
  const fromMs = window === 'all' ? Date.parse(agent.createdAt) : now.getTime() - WINDOW_MS[window];
  const from = new Date(fromMs).toISOString();
  const since = hourStartOf(from);
  const inWindow = and(eq(messageStats.agentId, agent.id), gte(messageStats.hourStart, since));

  const groups = ctx.db
    .select({
      direction: messageStats.direction,
      kind: messageStats.counterpartKind,
      id: messageStats.counterpartId,
      messages: sql<number>`sum(${messageStats.messages})`,
      tokens: sql<number>`sum(${messageStats.tokens})`,
    })
    .from(messageStats)
    .where(inWindow)
    .groupBy(messageStats.direction, messageStats.counterpartKind, messageStats.counterpartId)
    .all();

  const totals = { sent: 0, received: 0, tokensSent: 0, tokensReceived: 0 };
  const withAgents = { messages: 0, tokens: 0 };
  const withHumans = { messages: 0, tokens: 0 };
  const inRooms = { messages: 0, tokens: 0 };
  const byCounterpart = new Map<string, { kind: 'agent' | 'human' | 'room'; id: string; messages: number; tokens: number }>();
  for (const g of groups) {
    const messages = Number(g.messages);
    const tokens = Number(g.tokens);
    if (g.direction === 'sent') {
      totals.sent += messages;
      totals.tokensSent += tokens;
    } else {
      totals.received += messages;
      totals.tokensReceived += tokens;
    }
    const slice = g.kind === 'agent' ? withAgents : g.kind === 'human' ? withHumans : inRooms;
    slice.messages += messages;
    slice.tokens += tokens;
    const key = `${g.kind}:${g.id}`;
    const acc = byCounterpart.get(key) ?? {
      kind: g.kind as 'agent' | 'human' | 'room',
      id: g.id,
      messages: 0,
      tokens: 0,
    };
    acc.messages += messages;
    acc.tokens += tokens;
    byCounterpart.set(key, acc);
  }
  const rank = <T extends { messages: number; tokens: number; id: string }>(xs: T[]): T[] =>
    xs
      .sort((a, b) => b.messages - a.messages || b.tokens - a.tokens || a.id.localeCompare(b.id))
      .slice(0, TOP_N);

  const all = [...byCounterpart.values()];
  const topPeople = rank(all.filter((c) => c.kind !== 'room'));
  const topRooms = rank(all.filter((c) => c.kind === 'room'));
  const names = namesFor(ctx, topPeople, topRooms.map((r) => r.id));

  const daily = window !== '24h';
  const unit = daily ? DAY_MS : HOUR_MS;
  const seriesRows = ctx.db
    .select({
      bucket: daily ? sql<string>`substr(${messageStats.hourStart}, 1, 10)` : messageStats.hourStart,
      messages: sql<number>`sum(${messageStats.messages})`,
      tokens: sql<number>`sum(${messageStats.tokens})`,
    })
    .from(messageStats)
    .where(inWindow)
    .groupBy(daily ? sql`substr(${messageStats.hourStart}, 1, 10)` : messageStats.hourStart)
    .all();
  const byBucket = new Map<number, { messages: number; tokens: number }>();
  for (const r of seriesRows) {
    const start = daily ? Date.parse(`${r.bucket}T00:00:00.000Z`) : Date.parse(r.bucket);
    byBucket.set(start, { messages: Number(r.messages), tokens: Number(r.tokens) });
  }
  const series: AgentAnalyticsResponse['series'] = [];
  for (let t = floorTo(Date.parse(since), unit); t <= now.getTime(); t += unit) {
    const v = byBucket.get(t) ?? { messages: 0, tokens: 0 };
    series.push({ start: new Date(t).toISOString(), ...v });
  }

  return {
    window,
    from,
    to,
    totals,
    withAgents,
    withHumans,
    inDms: {
      messages: withAgents.messages + withHumans.messages,
      tokens: withAgents.tokens + withHumans.tokens,
    },
    inRooms,
    counterparts: topPeople.map((c) => ({
      kind: c.kind as PrincipalKind,
      id: c.id,
      name: names.get(c.id) ?? c.id,
      messages: c.messages,
      tokens: c.tokens,
    })),
    rooms: topRooms.map((r) => ({
      roomId: r.id,
      name: names.get(r.id) ?? r.id,
      messages: r.messages,
      tokens: r.tokens,
    })),
    series,
  };
}

/** Display names for the report's counterparts and rooms (one query per kind). */
function namesFor(
  ctx: AppContext,
  people: readonly { kind: string; id: string }[],
  roomIds: readonly string[],
): Map<string, string> {
  const names = new Map<string, string>();
  const agentIds = people.filter((p) => p.kind === 'agent').map((p) => p.id);
  const humanIds = people.filter((p) => p.kind === 'human').map((p) => p.id);
  if (agentIds.length > 0) {
    for (const r of ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)).all()) {
      names.set(r.id, r.name);
    }
  }
  if (humanIds.length > 0) {
    for (const r of ctx.db
      .select({ id: humans.id, name: humans.displayName })
      .from(humans)
      .where(inArray(humans.id, humanIds))
      .all()) {
      names.set(r.id, r.name);
    }
  }
  if (roomIds.length > 0) {
    for (const r of ctx.db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(inArray(rooms.id, [...roomIds])).all()) {
      names.set(r.id, r.name);
    }
  }
  return names;
}
