import type { InboundParty } from '@sparrow/common-types';
import type { AddressObject, EmailAddress } from 'mailparser';

/**
 * Normalize one address to the form the core stores and compares.
 *
 * The domain is lower-cased (domains are case-insensitive); the local part is
 * left exactly as the sender wrote it (RFC 5321 §2.3.11: only the receiving
 * host may interpret it). Surrounding whitespace and stray angle brackets go.
 * Returns `null` when there is no address left to speak of.
 */
export function normalizeAddress(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return value;
  return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
}

/**
 * Flatten a parsed address header (`From`, `To`, `Cc`) into `Party` inputs:
 * groups are expanded to their members, empty display names become `null`, and
 * an address repeated in one header appears once, keeping the first display
 * name it arrived with.
 */
export function partiesFromHeader(
  header: AddressObject | AddressObject[] | undefined | null,
): InboundParty[] {
  if (!header) return [];
  const objects = Array.isArray(header) ? header : [header];
  const parties: InboundParty[] = [];
  const seen = new Set<string>();

  const push = (entry: EmailAddress): void => {
    if (entry.group) {
      for (const member of entry.group) push(member);
      return;
    }
    const email = normalizeAddress(entry.address);
    if (!email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const name = entry.name?.trim();
    parties.push({ email, name: name ? name : null });
  };

  for (const object of objects) {
    for (const entry of object?.value ?? []) push(entry);
  }
  return parties;
}
