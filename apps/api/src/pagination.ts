import { and, eq, gt, lt, or, type SQL, type SQLWrapper } from 'drizzle-orm';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@sparrow/common-types';
import type { PagedResponse, TranscriptResponse } from '@sparrow/common-types';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.js';

/** Clamp a requested limit to [1, MAX_PAGE_LIMIT], defaulting when unset. */
export function resolveLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE_LIMIT);
}

/**
 * Build the keyset WHERE fragment for ascending `(created_at, tiebreak)` paging.
 * The tiebreak column may be a real column (agents: `id`) or a SQL fragment
 * (messages: `rowid`); `parseSecond` maps the cursor's opaque second field to the
 * value type that column compares against (identity for text ids, `Number` for
 * numeric rowids — SQLite compares integers and text-bound values differently).
 * Returns undefined when there is no cursor.
 */
export function cursorCondition(
  createdAtCol: SQLWrapper,
  secondCol: SQLWrapper,
  rawCursor?: string,
  parseSecond: (v: string) => unknown = (v) => v,
): SQL | undefined {
  if (!rawCursor) return undefined;
  const c: Cursor = decodeCursor(rawCursor);
  return or(
    gt(createdAtCol, c.createdAt),
    and(eq(createdAtCol, c.createdAt), gt(secondCol, parseSecond(c.id))),
  );
}

/** Combine a base filter with an optional cursor condition. */
export function withCursor(
  base: SQLWrapper | undefined,
  cursor: SQL | undefined,
): SQL | undefined {
  if (!base) return cursor;
  return cursor ? and(base, cursor) : (base as unknown as SQL);
}

/**
 * The keyset WHERE fragment for a DESCENDING transcript page: rows strictly
 * OLDER than an anchor row's `(orderValue, tiebreak)`. The anchor is resolved
 * from the request's `before=<id>` by the calling route, which is what makes the
 * cursor an id rather than an opaque blob (SPEC *HTTP API → Conventions*:
 * "transcripts read backward from now"). Returns undefined with no anchor — the
 * first page is simply the newest rows.
 */
export function beforeCondition(
  orderCol: SQLWrapper,
  tiebreakCol: SQLWrapper,
  anchor: { orderValue: string; tiebreak: unknown } | undefined,
): SQL | undefined {
  if (!anchor) return undefined;
  return or(
    lt(orderCol, anchor.orderValue),
    and(eq(orderCol, anchor.orderValue), lt(tiebreakCol, anchor.tiebreak)),
  );
}

/**
 * Turn `limit + 1` rows fetched in DESCENDING order into a transcript response.
 * `nextBefore` is the id of the OLDEST returned row when more remain, else
 * `null` — feed it back as the next `before`.
 */
export function transcriptResult<Row, Item>(
  rows: Row[],
  limit: number,
  mapItem: (row: Row) => Item,
  getId: (row: Row) => string,
): TranscriptResponse<Item> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(mapItem),
    nextBefore: hasMore && last ? getId(last) : null,
  };
}

/**
 * Turn `limit + 1` fetched rows into a paged response. `rows` must be ordered
 * ascending by (created_at, id) and contain up to `limit + 1` entries.
 */
export function pageResult<Row, Item>(
  rows: Row[],
  limit: number,
  mapItem: (row: Row) => Item,
  getCursor: (row: Row) => Cursor,
): PagedResponse<Item> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(mapItem);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(getCursor(last)) : null;
  return { items, nextCursor };
}
