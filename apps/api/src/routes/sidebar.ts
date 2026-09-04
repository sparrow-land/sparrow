/**
 * Sidebar source: `GET /orgs/:orgId/me/humans` (SPEC "Sidebar sources"). EVERY
 * human member of the org except the caller, each with presence + last-seen —
 * so someone just added by email who shares no room yet still shows up. When the
 * caller shares ≥1 room (project or DM) with a member, `lastSeenAt` is the max
 * last-seen across those rooms; a member sharing none has `lastSeenAt: null`.
 * Ordered presence-first: online, then by last-seen (desc, nulls last), then name.
 * Full-org *search* lives behind `directory?q=`, not here. (The agents sidebar
 * source, `GET /orgs/:orgId/me/agents`, lives in routes/agents.)
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { humans, members, orgMemberships, rooms } from '../db/schema.js';
import { requireMembership } from '../org-helpers.js';
import { avatarUrlForHuman } from '../avatar-helpers.js';

export function registerSidebarRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { orgId: string } }>(
    '/api/v1/orgs/:orgId/me/humans',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      requireMembership(ctx.db, request.params.orgId, human.id);

      // Rooms in this org the caller is a member of.
      const myRoomIds = new Set(
        ctx.db
          .select({ roomId: members.roomId, orgId: rooms.orgId })
          .from(members)
          .innerJoin(rooms, eq(rooms.id, members.roomId))
          .where(and(eq(members.principalType, 'human'), eq(members.principalId, human.id)))
          .all()
          .filter((r) => r.orgId === request.params.orgId)
          .map((r) => r.roomId),
      );

      // Max last_seen per other human across the rooms the caller shares with them.
      const lastSeen = new Map<string, string | null>();
      for (const roomId of myRoomIds) {
        const coMembers = ctx.db
          .select()
          .from(members)
          .where(and(eq(members.roomId, roomId), eq(members.principalType, 'human')))
          .all();
        for (const m of coMembers) {
          if (m.principalId === human.id) continue;
          const prev = lastSeen.get(m.principalId) ?? null;
          const next =
            m.lastSeenAt && (!prev || m.lastSeenAt > prev) ? m.lastSeenAt : prev;
          lastSeen.set(m.principalId, next);
        }
      }

      // Every human member of the org except the caller — including members who
      // share no room yet (they get `lastSeenAt: null`). The full human row is
      // selected so the effective avatar can be resolved per member.
      const orgHumans = ctx.db
        .select({ human: humans })
        .from(orgMemberships)
        .innerJoin(humans, eq(humans.id, orgMemberships.humanId))
        .where(eq(orgMemberships.orgId, request.params.orgId))
        .all()
        .map((r) => r.human);

      const items = orgHumans
        .filter((h) => h.id !== human.id)
        .map((h) => ({
          human: { id: h.id, displayName: h.displayName, avatarUrl: avatarUrlForHuman(ctx, h) },
          online: ctx.rooms.isPrincipalOnline('human', h.id),
          lastSeenAt: lastSeen.get(h.id) ?? null,
        }))
        // Presence-first: online, then last-seen (desc, nulls last), then name.
        .sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          if (a.lastSeenAt !== b.lastSeenAt) {
            if (a.lastSeenAt === null) return 1;
            if (b.lastSeenAt === null) return -1;
            return b.lastSeenAt.localeCompare(a.lastSeenAt);
          }
          return a.human.displayName.localeCompare(b.human.displayName);
        });

      return reply.send({ items });
    },
  );
}
