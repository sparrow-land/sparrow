/**
 * Server-Sent Event streams (SPEC "Events"). `GET /rooms/:roomId/events` streams
 * one room's events (member-authed, `?token=` accepted since EventSource cannot
 * set headers). `GET /me/events` fans every membership into one stream — room
 * events wrapped `{ room, ...payload }`, memberships joining/leaving live — plus
 * unwrapped principal-level events (enrollment, room invitation, share) drained
 * from the principal EventBus. Heartbeat comment every 25 s.
 *
 * `?quiet=presence,status` (on `/me/events` and its non-streaming twin
 * `/me/events/log`) is a SUBSCRIPTION-TIME opt-out of the two ambient families —
 * the ones that fire on every teammate blinking online, which cost an always-on
 * agent a turn each and teach it nothing. The filter applies at EMISSION TO THAT
 * SUBSCRIBER ONLY: the JOURNAL is untouched, so quieted frames are still recorded
 * for the principal and still consume cursor ids. A client that later reconnects
 * unfiltered sees everything it missed, and cursors never lie.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { sha256Hex } from '@sparrow/common-types/identity';
import {
  STREAM_MAX_LIFETIME_SECONDS,
  quietEventNames,
  type EventRoomRef,
} from '@sparrow/common-types';
import type { AppContext, Principal } from '../context.js';
import { nowIso, principalIdent, resolvePrincipal } from '../context.js';
import { humans, userSessions } from '../db/schema.js';
import { requireRoomMember } from '../room-helpers.js';
import { badRequest, unauthorized } from '../errors.js';

const HEARTBEAT_MS = 25_000;

/** Hard ceiling (and default) for one `/me/events/log` page; `more: true` signals truncation. */
const JOURNAL_LOG_CAP = 500;

/**
 * Resolve the `?limit=` page size for `/me/events/log`: an integer 1–500,
 * defaulting to (and capped at) {@link JOURNAL_LOG_CAP}. A non-numeric or
 * out-of-range value is a hard `400` (the docs promise this bound), rather than
 * being silently clamped.
 */
function parseLogLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return JOURNAL_LOG_CAP;
  if (!/^\d+$/.test(raw)) throw badRequest('limit must be an integer between 1 and 500');
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > JOURNAL_LOG_CAP) throw badRequest('limit must be an integer between 1 and 500');
  return n;
}

/**
 * Resolve the caller of an SSE route. A `?token=` value (session `ses_` or agent
 * `agk_`) authenticates when present since EventSource can't set headers; else
 * the normal header/cookie path runs.
 */
export function resolveStreamPrincipal(
  ctx: AppContext,
  request: FastifyRequest,
  token?: string,
): Principal {
  if (token && token.startsWith('ses_')) {
    const session = ctx.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, sha256Hex(token)))
      .get();
    if (!session || session.expiresAt <= nowIso()) throw unauthorized('Sign-in required');
    const human = ctx.db.select().from(humans).where(eq(humans.id, session.humanId)).get();
    if (!human) throw unauthorized('Sign-in required');
    return { type: 'human', human };
  }
  return resolvePrincipal(ctx, request, token);
}

/**
 * Serialize one SSE frame. An `id:` line (the journal cursor) precedes the event
 * when present. `dataJson` is the already-serialized `data:` payload — passed
 * verbatim so a REPLAYED frame is byte-identical to the live one it reproduces.
 */
function frameBytes(event: string, dataJson: string, id?: number): string {
  const idLine = id !== undefined ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${dataJson}\n\n`;
}

/** Write a raw (already-serialized) SSE frame; swallow post-disconnect errors. */
function writeFrame(reply: FastifyReply, event: string, dataJson: string, id?: number): void {
  try {
    reply.raw.write(frameBytes(event, dataJson, id));
  } catch {
    /* connection gone — cleanup runs on close */
  }
}

/** Write the SSE preamble and return a framed-write function (`id:` per frame). */
function openStream(reply: FastifyReply): (event: string, data: unknown, id?: number) => void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(': open\n\n');
  return (event, data, id) => writeFrame(reply, event, JSON.stringify(data), id);
}

/**
 * Resolve the resume cursor for `/me/events`: the `?since=` query wins over the
 * `Last-Event-ID` header. Returns undefined (a fresh, non-resuming stream) when
 * neither is a non-negative integer.
 */
function resumeCursor(query: string | undefined, header: string | string[] | undefined): number | undefined {
  const headerVal = Array.isArray(header) ? header[0] : header;
  const raw = query !== undefined && query !== '' ? query : headerVal;
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Wire a live stream's lifecycle: the 25 s heartbeat comment, the max-lifetime
 * force-close, and disconnect cleanup. `unsubscribe` releases the stream's
 * hub/bus registrations — and thus its presence contribution. Called once per
 * stream, after registration.
 *
 * The lifetime cap is the belt-and-suspenders reaper: an intermediary (proxy,
 * tunnel edge) can swallow a client disconnect so `request close` never fires,
 * which would pin the stream — and its presence — online forever. Bounding the
 * lifetime makes the server end the response itself; a well-behaved client
 * reconnects and resumes seamlessly via cursor replay (`?since=`/`Last-Event-ID`).
 * Idempotent: the force-close and the `request close` it induces collapse into a
 * single `release`.
 */
function armStreamLifecycle(
  request: FastifyRequest,
  reply: FastifyReply,
  lifetimeMs: number,
  unsubscribe: () => void,
): void {
  let released = false;
  let lifetime: ReturnType<typeof setTimeout>;
  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    unsubscribe();
  };
  lifetime = setTimeout(() => {
    try {
      reply.raw.end(); // clean server-side end → client sees the stream close
    } catch {
      /* connection already gone */
    }
    release();
  }, lifetimeMs);
  (lifetime as { unref?: () => void }).unref?.();
  request.raw.on('close', release);
}

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  const streamMaxLifetimeMs =
    (ctx.config.streamMaxLifetimeSeconds ?? STREAM_MAX_LIFETIME_SECONDS) * 1000;

  /* ------------------------- GET /rooms/:roomId/events --------------- */
  app.get<{ Params: { roomId: string }; Querystring: { token?: string } }>(
    '/api/v1/rooms/:roomId/events',
    (request, reply) => {
      const principal = resolveStreamPrincipal(ctx, request, request.query.token);
      const ident = principalIdent(principal);
      const caller = requireRoomMember(ctx, request, request.params.roomId, ident);

      const send = openStream(reply);
      const unsub = ctx.rooms.addRoomStream({
        principalType: ident.type,
        principalId: ident.id,
        roomId: caller.room.id,
        memberId: caller.member.id,
        send,
      });
      armStreamLifecycle(request, reply, streamMaxLifetimeMs, unsub);
      reply.hijack();
    },
  );

  /* ---------------------------- GET /me/events/log ------------------- */
  // The NON-streaming counterpart to `/me/events`: a one-shot JSON read of the
  // same per-principal journal. It backs the CLI's reconcile poll — because a
  // plain HTTP request opens a fresh exchange, it punches through a path stall
  // that has wedged the long-lived SSE socket (a black-holed tunnel edge where
  // the stream's TCP connection stays ESTAB but no bytes flow). Same auth as
  // `/me/events` (bearer or `?token=`).
  app.get<{ Querystring: { token?: string; since?: string; limit?: string; quiet?: string } }>(
    '/api/v1/me/events/log',
    (request, reply) => {
      const principal = resolveStreamPrincipal(ctx, request, request.query.token);
      const ident = principalIdent(principal);
      // Same `?quiet=` as the stream — without it a quieting client would get
      // the noise straight back through the reconcile poll. Unknown tokens are
      // ignored (never a 400), like the stream's.
      const quiet = quietEventNames(request.query.quiet);
      // Validate the page size up front so a bad `?limit=` is a clean 400 even on
      // the cursor-less probe (the docs promise the 1–500 bound unconditionally).
      const limit = parseLogLimit(request.query.limit);
      const latest = ctx.journal.latestId(ident.type, ident.id);

      // No cursor → a cheap probe: the caller learns its starting cursor and
      // fetches nothing. (`?since=` wins over `Last-Event-ID`, like the stream.)
      const since = resumeCursor(request.query.since, request.headers['last-event-id']);
      if (since === undefined) {
        return { events: [], latest };
      }

      // Mirror the SSE replay semantics exactly: a `gap` when the cursor predates
      // retention, then the journaled rows after it (room events room-wrapped as
      // the frame stored them). Cap the page at the requested limit (≤ 500) and
      // flag `more` for the client to poll again from the last returned id.
      //
      // `latest`, `gap` and `more` are computed from the UNFILTERED journal
      // exactly as before: the cursor space is SHARED, and only what is handed
      // back is filtered. (Paging first, then quieting, is what keeps a client's
      // "resume from the last id I got" arithmetic identical either way.)
      const gap = ctx.journal.hasGap(ident.type, ident.id, since);
      const rows = ctx.journal.replaySince(ident.type, ident.id, since);
      const page = rows.slice(0, limit);
      const events = page
        .filter((r) => !quiet.has(r.event))
        .map((r) => ({
          id: r.id,
          event: r.event,
          data: JSON.parse(r.data) as unknown,
        }));
      const body: {
        events: typeof events;
        latest: number;
        gap?: true;
        more?: true;
      } = { events, latest };
      if (gap) body.gap = true;
      if (rows.length > limit) body.more = true;
      return body;
    },
  );

  /* ------------------------------- GET /me/events -------------------- */
  app.get<{ Querystring: { token?: string; since?: string; quiet?: string } }>(
    '/api/v1/me/events',
    (request, reply) => {
      const principal = resolveStreamPrincipal(ctx, request, request.query.token);
      const ident = principalIdent(principal);

      // Subscription-time opt-out. Filtering here — in the WRITE closures of
      // this one subscriber — rather than in the hub keeps the fan-out and the
      // journal completely unaware of it: every other subscriber still gets the
      // frame, and the quieted frame is still journaled for THIS principal with
      // its cursor id intact.
      const quiet = quietEventNames(request.query.quiet);
      const write = openStream(reply);
      const send = (event: string, data: unknown, id?: number): void => {
        if (quiet.has(event)) return;
        write(event, data, id);
      };
      const sendRoom = (room: EventRoomRef, event: string, data: unknown, id?: number): void => {
        if (quiet.has(event)) return;
        send(event, { room, ...(data as Record<string, unknown>) }, id);
      };

      // Resume (SSE replay): the `?since=` query wins over the `Last-Event-ID`
      // header. Replay the principal's journaled events AFTER the cursor before
      // going live — emitting a structural `replay.gap` first when the cursor has
      // already been pruned (beyond retention → the client must reconcile via an
      // inbox drain). The handler is synchronous through stream registration, so
      // no concurrent emit can interleave between replay and going live.
      const since = resumeCursor(request.query.since, request.headers['last-event-id']);
      if (since !== undefined) {
        if (ctx.journal.hasGap(ident.type, ident.id, since)) {
          // Carry `latest` so a client resuming from a stale cursor (pruned OR a
          // post-wipe cursor AHEAD of our newest id) can re-seed to the real newest
          // and stop filtering fresh, lower ids as already-seen.
          send('replay.gap', { since, latest: ctx.journal.latestId(ident.type, ident.id) });
        }
        for (const row of ctx.journal.replaySince(ident.type, ident.id, since)) {
          // Replay honors the same `?quiet=` as the live stream, so a resume
          // shows EXACTLY what the client would have seen had it never dropped.
          // The skipped ids stay skipped — the journal keeps them, so the next
          // unfiltered connection can still read them.
          if (quiet.has(row.event)) continue;
          // Verbatim stored JSON → byte-identical to the original live frame.
          writeFrame(reply, row.event, row.data, row.id);
        }
      }

      const unsubHub = ctx.rooms.addMeStream({
        principalType: ident.type,
        principalId: ident.id,
        send,
        sendRoom,
        _presenceRooms: new Set(),
      });
      // Principal-level events (enrollment/share/room invitation/activity, and
      // the email medium's `email.*`) are keyed by (principalType, principalId) —
      // an AGENT is a first-class recipient, not a human-only audience.
      const unsubBus = ctx.bus.subscribe(ident.type, ident.id, (env) =>
        send(env.event, env.data, env.id),
      );

      armStreamLifecycle(request, reply, streamMaxLifetimeMs, () => {
        unsubHub();
        unsubBus();
      });
      reply.hijack();
    },
  );
}
