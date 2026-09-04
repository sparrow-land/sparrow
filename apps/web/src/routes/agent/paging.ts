/**
 * Paging for the two newest-first surfaces on the agent page.
 *
 * **The wire descends and its cursor walks BACKWARD.** Both lists behind these
 * tabs — `GET /orgs/:orgId/agents/:agentId/activity` (descending `createdAt`)
 * and `…/email/threads` (descending `lastEmailAt`) — return their NEWEST page
 * first and hand back `nextBefore`, the OLDEST id of that page, which fetches
 * strictly-older rows. That is the SPEC's room-history precedent — "a transcript
 * reads backward from now" — so the first page is already the top of the UI's
 * list and paging only ever appends to its END.
 */

/** The wire's max page size (`limit` default 25 / max 100). */
export const PAGE_LIMIT = 100;
