/**
 * RFC 5322 `msg-id` handling — `Message-ID`, `In-Reply-To`, `References`.
 *
 * A msg-id is OPAQUE: it is compared byte-for-byte, so case is preserved and
 * nothing inside it is rewritten. All this code does is put the angle brackets
 * back when a sloppy sender omitted them and remove the folding whitespace a
 * transport inserted.
 */

/** Join repeated/array header values into one string. */
function flatten(raw: string | string[] | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  return Array.isArray(raw) ? raw.join(' ') : raw;
}

/**
 * Every msg-id in a header value, in order, de-duplicated, each bracketed.
 * Empty (`<>`) and whitespace-only tokens are dropped.
 */
export function parseMessageIdList(raw: string | string[] | undefined | null): string[] {
  const value = flatten(raw).trim();
  if (!value) return [];

  // Strip folding whitespace that landed INSIDE the brackets before matching.
  const unfolded = value.replace(/<[^<>]*>/g, (match) => match.replace(/\s+/g, ''));
  const bracketed = unfolded.match(/<[^<>]*>/g);
  const tokens = bracketed ?? unfolded.split(/\s+/).map((token) => `<${token}>`);

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const id = token.trim();
    if (id.length <= 2) continue; // "<>" or worse
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The first msg-id in a header value, or `null` when it carries none. */
export function normalizeMessageId(raw: string | string[] | undefined | null): string | null {
  return parseMessageIdList(raw)[0] ?? null;
}
