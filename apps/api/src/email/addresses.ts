/**
 * Address derivation + resolution for the email medium (SPEC v4 "The email
 * medium → Concepts").
 *
 * An agent's mailbox is DERIVED, never stored:
 * `<agent-name>@<org-slug><EMAIL_ORG_SUFFIX>`. Because the address is a view, a
 * rename MOVES the mailbox — the new name routes immediately, the old address
 * stops resolving and is **not** aliased.
 */
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agents, orgs } from '../db/schema.js';
import type { AgentRow, OrgRow } from '../db/schema.js';

/**
 * Whether the email medium is ON for this instance: `EMAIL_ORG_SUFFIX` set AND
 * an email provider registered (`fake`, or `webhook` with a resolved
 * `email.webhookUrl`). Off = every `/me/email/*` and `/orgs/:orgId/email/*`
 * route `404`s, no address derives, and `GET /capabilities` reports
 * `email: false` — the self-hosted invariant.
 */
export function emailMediumOn(ctx: AppContext): boolean {
  return !!ctx.config.emailOrgSuffix && ctx.email.provider !== null;
}

/**
 * The configured outbound-mail webhook (`email.webhookUrl`), trimmed, or `''`
 * when there is none. Read at CALL time — the value is admin-settable at
 * runtime through `PUT /config`, so nothing may cache it.
 */
export function outboundWebhookUrl(ctx: AppContext): string {
  return String(ctx.configStore.get('email.webhookUrl') ?? '').trim();
}

/**
 * Whether this instance can SEND mail at all: a webhook is configured.
 *
 * Deliberately NOT {@link emailMediumOn}. The medium is agent mailboxes, which
 * also need `EMAIL_ORG_SUFFIX` and a registered provider; relaying one message
 * out needs only the webhook. They come apart in both directions — `fake` runs
 * the medium with nothing to relay through, and a webhook with no suffix relays
 * mail with the medium off — so a client that gated "invite by email" on the
 * medium would offer to email on an instance that cannot, and hide the offer on
 * one that can. This is the exact condition `POST /orgs/:orgId/members` checks
 * before it tries to send, and `GET /capabilities` advertises it as
 * `emailOutbound`.
 */
export function outboundMailOn(ctx: AppContext): boolean {
  return outboundWebhookUrl(ctx) !== '';
}

/** The mail domain of an org: `<slug><EMAIL_ORG_SUFFIX>`, or null with the medium off. */
export function orgMailDomain(ctx: AppContext, org: Pick<OrgRow, 'slug'>): string | null {
  if (!emailMediumOn(ctx)) return null;
  return `${org.slug}${ctx.config.emailOrgSuffix}`.toLowerCase();
}

/** An org row by id (address derivation needs its slug). */
export function orgById(ctx: AppContext, orgId: string): OrgRow | undefined {
  return ctx.db.select().from(orgs).where(eq(orgs.id, orgId)).get();
}

/**
 * The DERIVED address of an agent, or null when the medium is off (or the org
 * row is gone). Never stored: rename/slug changes move it immediately.
 */
export function agentAddress(ctx: AppContext, agent: AgentRow): string | null {
  const domain = agentAddressDomain(ctx, agent);
  return domain ? `${agent.name.toLowerCase()}@${domain}` : null;
}

/** The domain half of an agent's address (`<org-slug><EMAIL_ORG_SUFFIX>`). */
export function agentAddressDomain(ctx: AppContext, agent: AgentRow): string | null {
  if (!emailMediumOn(ctx)) return null;
  const org = orgById(ctx, agent.orgId);
  return org ? orgMailDomain(ctx, org) : null;
}

/**
 * Normalize an inbound recipient: lowercase, and discard everything from the
 * FIRST `+` in the local part (plus-addressing — `fable+gh@…` reaches `fable`).
 * Returns `{ local, domain }`, or undefined when the address has no single `@`.
 */
export function normalizeAddress(raw: string): { local: string; domain: string } | undefined {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  const localRaw = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = localRaw.indexOf('+');
  const local = plus >= 0 ? localRaw.slice(0, plus) : localRaw;
  if (local === '') return undefined;
  return { local, domain };
}

/** Lowercase an address for comparison, keeping plus-addressing intact. */
export function canonicalAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Resolve an inbound recipient to an agent in THIS instance: the domain minus
 * `EMAIL_ORG_SUFFIX` is an org slug, the local part is an agent name matched
 * case-insensitively within that org. Undefined when nothing resolves (a deleted
 * or renamed agent leaves no trace — the caller answers `unknown-recipient`).
 */
export function resolveAgentAddress(
  ctx: AppContext,
  raw: string,
): { agent: AgentRow; org: OrgRow } | undefined {
  const suffix = ctx.config.emailOrgSuffix;
  if (!suffix) return undefined;
  const parts = normalizeAddress(raw);
  if (!parts) return undefined;
  const suffixLower = suffix.toLowerCase();
  if (!parts.domain.endsWith(suffixLower)) return undefined;
  const slug = parts.domain.slice(0, parts.domain.length - suffixLower.length);
  if (!slug || slug.includes('.')) return undefined;
  const org = ctx.db.select().from(orgs).where(eq(orgs.slug, slug)).get();
  if (!org) return undefined;
  const agent = ctx.db
    .select()
    .from(agents)
    .where(eq(agents.orgId, org.id))
    .all()
    .find((a) => a.name.toLowerCase() === parts.local);
  return agent ? { agent, org } : undefined;
}

/** Every agent address in an org, lowercased (trust-set rung 2). */
export function orgAgentAddresses(ctx: AppContext, org: OrgRow): Set<string> {
  const domain = orgMailDomain(ctx, org);
  const out = new Set<string>();
  if (!domain) return out;
  for (const a of ctx.db.select().from(agents).where(eq(agents.orgId, org.id)).all()) {
    out.add(`${a.name.toLowerCase()}@${domain}`);
  }
  return out;
}
