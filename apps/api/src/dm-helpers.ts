/**
 * DM ensure that also fires the membership-gain SSE guarantee (SPEC "GET
 * /me/events"): when a DM room is created (or a departed member re-added), the
 * newly-added principals must have the room attach to any open `/me/events`
 * stream AND receive the room's wrapped `member.joined` — so a fresh DM shows up
 * in the counterpart's UI without a reload. Wraps the `ensureDmRoom` seam.
 */
import { eq } from 'drizzle-orm';
import type { PrincipalKind } from '@sparrow-land/sdk/types';
import type { AppContext } from './context.js';
import { rooms } from './db/schema.js';
import { dmKey, ensureDmRoom } from './agent-helpers.js';
import { memberOf, toMember } from './room-helpers.js';
import { emitMemberJoined } from './room-events.js';

interface DmPrincipal {
  type: PrincipalKind;
  id: string;
}

/**
 * Ensure the DM room for a principal pair, emitting `member.joined` for every
 * member row created by this call and recomputing presence for both principals'
 * open streams. Returns the room id and whether the room was freshly created.
 */
export function ensureDmRoomWithEvents(
  ctx: AppContext,
  orgId: string,
  a: DmPrincipal,
  b: DmPrincipal,
): { roomId: string; created: boolean } {
  const key = dmKey(orgId, a.id, b.id);
  const before = ctx.db.select().from(rooms).where(eq(rooms.dmKey, key)).get();
  const existedBefore = new Map<string, boolean>([
    [`${a.type}:${a.id}`, !!(before && memberOf(ctx, before.id, a.type, a.id))],
    [`${b.type}:${b.id}`, !!(before && memberOf(ctx, before.id, b.type, b.id))],
  ]);

  const roomId = ensureDmRoom(ctx, orgId, a, b);

  // member.joined for each newly-added member — reaches the gaining principal
  // itself (audience 'all', delivered wrapped on its /me/events). Emitted BEFORE
  // the presence pass below so a client learns the member before its dot.
  for (const p of [a, b]) {
    if (existedBefore.get(`${p.type}:${p.id}`)) continue;
    const member = memberOf(ctx, roomId, p.type, p.id);
    if (member) emitMemberJoined(ctx, roomId, toMember(ctx, member));
  }

  // Presence for any open /me/events streams of either principal; a principal
  // that JUST joined also gets its current presence announced in the new room
  // (it may have been online before the membership existed — see `onMemberJoined`).
  for (const p of [a, b]) {
    if (existedBefore.get(`${p.type}:${p.id}`)) ctx.rooms.onMembershipChanged(p.type, p.id);
    else ctx.rooms.onMemberJoined(roomId, p.type, p.id);
  }

  return { roomId, created: !before };
}
