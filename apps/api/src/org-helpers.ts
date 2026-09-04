/**
 * Org primitives shared by auth bootstrap, the orgs routes, invites, and
 * enrollment: slug generation/validation, org creation (owner membership),
 * membership lookup, and role guards.
 */
import { and, eq } from 'drizzle-orm';
import {
  newOrgId,
  newUserId,
  OrgSettingsSchema,
  ORG_SLUG_MAX,
  RESERVED_SLUGS as RESERVED_SLUG_LIST,
  isReservedSlug as isReservedSlugShared,
  type Org,
  type OrgRole,
  type OrgSettings,
  type OrgSettingsPatch,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import type { DB } from './db/index.js';
import { agents, humans, members, orgs, orgMemberships, rooms } from './db/schema.js';
import type { HumanRow, OrgRow, OrgMembershipRow } from './db/schema.js';
import { conflict, forbidden, notFound } from './errors.js';

/**
 * Slugs the app reserves so an org slug can never shadow a first-party host or
 * route (`<slug>.<host>`, `/orgs/:slug`, …). The canonical list lives in
 * `@sparrow/common-types` (shared with the web SPA's scope detection); re-exported
 * as a Set here for the existing membership-style lookups.
 */
export const RESERVED_SLUGS = new Set(RESERVED_SLUG_LIST);

const now = (): string => new Date().toISOString();

/** True iff `slug` is reserved (a route/host name the app owns). */
export function isReservedSlug(slug: string): boolean {
  return isReservedSlugShared(slug);
}

/**
 * Turn an arbitrary display string into a slug candidate: lowercase, drop
 * apostrophes (so `Owner's` → `owners`, not `owner-s`), non-`[a-z0-9-]` → `-`,
 * collapsed/trimmed hyphens, capped at 40 chars. Empty input (or all-punctuation)
 * yields `'org'`.
 */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    // Elide apostrophes (straight + typographic) so a possessive stays one word.
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, ORG_SLUG_MAX);
  return base.length > 0 ? base : 'org';
}

/**
 * Whether a slug is already taken by some org. `exceptOrgId` excludes ONE org
 * from the check — the org being renamed, whose own current slug must not count
 * as a collision against itself (or `acme` renamed to `ACME!` would bump to
 * `acme-2` for no reason).
 */
function slugTaken(db: DB, slug: string, exceptOrgId?: string): boolean {
  const row = db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, slug)).get();
  return row !== undefined && row.id !== exceptOrgId;
}

/**
 * Pick a free slug from a base: the base itself, else `base-2`, `base-3`, …
 * (staying ≤ 40 chars), skipping reserved and taken slugs. `exceptOrgId` (the
 * org being renamed) is not counted as a collision with itself.
 */
export function availableSlug(db: DB, base: string, exceptOrgId?: string): string {
  const root = slugify(base);
  const clean = isReservedSlug(root) ? `${root}-org` : root;
  if (!isReservedSlug(clean) && !slugTaken(db, clean, exceptOrgId)) return clean;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${clean.slice(0, ORG_SLUG_MAX - suffix.length)}${suffix}`;
    if (!isReservedSlug(candidate) && !slugTaken(db, candidate, exceptOrgId)) return candidate;
  }
  // Astronomically unlikely; fall back to an id-derived slug.
  return `org-${newOrgId().slice(4, 12).toLowerCase()}`;
}

/**
 * Was this org's slug chosen by a person? `slug_custom` is `1` chosen / `0`
 * derived / `null` unknown (a row older than the column) — and unknown reads as
 * CHOSEN, because silently moving a published address is worse than leaving an
 * ugly one alone. Only a DERIVED slug is regenerated on rename.
 */
export function slugIsCustom(org: Pick<OrgRow, 'slugCustom'>): boolean {
  return org.slugCustom !== 0;
}

/**
 * The slug an org should carry after being renamed to `name`, or `undefined`
 * when nothing should change.
 *
 * Regenerates only for an org whose slug was DERIVED (see {@link slugIsCustom}),
 * and reuses {@link availableSlug} so the result obeys exactly the reservation
 * and uniqueness rules creation obeys — including "the org's own current slug is
 * not a collision", so a cosmetic rename (`Acme` → `ACME!`) is a no-op rather
 * than a gratuitous `-2`.
 */
export function regeneratedSlug(db: DB, org: OrgRow, name: string): string | undefined {
  if (slugIsCustom(org)) return undefined;
  const next = availableSlug(db, name, org.id);
  return next === org.slug ? undefined : next;
}

/**
 * Resolve the slug for a new org: a supplied slug is used verbatim (reserved or
 * already-taken → `409 conflict`); otherwise one is generated from the name.
 */
function resolveNewSlug(db: DB, input: { name: string; slug?: string }): string {
  if (input.slug !== undefined) {
    if (isReservedSlug(input.slug)) throw conflict('That workspace address is reserved');
    if (slugTaken(db, input.slug)) throw conflict('That workspace address is taken');
    return input.slug;
  }
  return availableSlug(db, input.name);
}

/**
 * Insert an org row with NO memberships (an **owner-pending** org). Used by admin
 * provisioning, which hands out an owner invite instead of an inline owner; the
 * redeemer becomes the first owner. Same slug rules as {@link createOrg}.
 */
export function createOwnerlessOrg(db: DB, input: { name: string; slug?: string }): OrgRow {
  const slug = resolveNewSlug(db, input);
  const org: OrgRow = {
    id: newOrgId(),
    name: input.name,
    slug,
    slugCustom: input.slug !== undefined ? 1 : 0,
    settings: '{}',
    createdAt: now(),
  };
  db.insert(orgs).values(org).run();
  return org;
}

/**
 * Create an org and its owner membership in one transaction. `slug` is used
 * verbatim when supplied (reserved or already-taken → `409 conflict`); otherwise
 * one is generated from the name. Returns the new org row.
 */
export function createOrg(
  db: DB,
  input: { name: string; slug?: string; ownerHumanId: string },
): OrgRow {
  const slug = resolveNewSlug(db, input);
  const ts = now();
  const org: OrgRow = {
    id: newOrgId(),
    name: input.name,
    slug,
    // A slug the caller SUPPLIED is chosen and permanent; one we derived from the
    // name is regenerated if the org is ever renamed (see `regeneratedSlug`).
    slugCustom: input.slug !== undefined ? 1 : 0,
    settings: '{}',
    createdAt: ts,
  };
  db.transaction((tx) => {
    tx.insert(orgs).values(org).run();
    tx.insert(orgMemberships)
      .values({ orgId: org.id, humanId: input.ownerHumanId, role: 'owner', createdAt: ts })
      .run();
  });
  return org;
}

/**
 * Parse an org's stored `settings` JSON into the complete, defaults-merged
 * object. Corrupt/absent JSON falls back to full defaults so reads never error.
 *
 * The write path (`OrgSettingsSchema`) is strict, but stored settings may still
 * carry the retired `enroll.humans` / `enroll.autoApproveEmailPatterns` knobs
 * (humans holding a valid invite are now always admitted immediately — approval
 * governs agents only). Strip those legacy keys on read so an org that also set
 * `invites`/`rooms` policies doesn't get silently reset to defaults by a strict
 * parse failure.
 */
export function parseOrgSettings(raw: string | null | undefined): OrgSettings {
  try {
    const obj = raw ? JSON.parse(raw) : {};
    if (obj && typeof obj === 'object' && obj.enroll && typeof obj.enroll === 'object') {
      delete (obj.enroll as Record<string, unknown>).humans;
      delete (obj.enroll as Record<string, unknown>).autoApproveEmailPatterns;
    }
    return OrgSettingsSchema.parse(obj);
  } catch {
    return OrgSettingsSchema.parse({});
  }
}

/**
 * Apply a merge-patch to an org's settings (SPEC "Orgs → Settings"). `stored` is
 * the complete defaults-merged policy; `patch` names only what changes. A group
 * named in the patch is merged key-by-key into the stored group (so setting
 * `email.judgePrompt` keeps `email.trustedPatterns`); a group absent from the
 * patch is copied through untouched. Leaves — including arrays — replace
 * wholesale; there is no append and no null-means-delete.
 *
 * The result is a COMPLETE settings object, so what gets persisted is exactly
 * what the response returns and what the next read parses.
 */
export function mergeOrgSettings(stored: OrgSettings, patch: OrgSettingsPatch): OrgSettings {
  return {
    invites: { ...stored.invites, ...patch.invites },
    enroll: { ...stored.enroll, ...patch.enroll },
    rooms: { ...stored.rooms, ...patch.rooms },
    email: { ...stored.email, ...patch.email },
  };
}

/** Build the GetOrg wire resource (settings merged with defaults). */
export function toOrg(row: OrgRow): Org {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    settings: parseOrgSettings(row.settings),
    createdAt: row.createdAt,
  };
}

/**
 * The FIRST human ever created auto-gets an org.
 *
 * `orgName` is what the founder typed in the sign-up form's "Workspace name"
 * field; blank or absent falls back to the possessive default. Either way the
 * slug is DERIVED, so a workspace that started life as `Alice's org` can still
 * shed `alices-org` by being renamed (SPEC → *Orgs → Slugs*).
 */
export function bootstrapOrgForHuman(
  db: DB,
  human: { id: string; displayName: string },
  orgName?: string,
): OrgRow {
  const name = orgName?.trim() || `${human.displayName}'s org`;
  return createOrg(db, { name, ownerHumanId: human.id });
}

/** The caller's membership row in an org, or undefined. */
export function membershipOf(
  db: DB,
  orgId: string,
  humanId: string,
): OrgMembershipRow | undefined {
  return db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.humanId, humanId)))
    .get();
}

/**
 * Add a person to an org directly by email: resolve the human by normalized
 * (trim+lowercase) email, or provision an externally-minted account (no
 * password, provider `admin`); then insert the membership at `role`. Already a
 * member → 409. Shared by the session add-by-email route and the admin
 * (control-plane) add — the sole difference is that the session route
 * additionally mints/sends an invite around this core.
 */
export function addMemberByEmail(
  ctx: AppContext,
  orgId: string,
  input: { email: string; role: OrgRole },
): { human: HumanRow; role: OrgRole } {
  const email = input.email.trim().toLowerCase();
  let human = ctx.auth.humanByEmail(email);
  if (!human) {
    human = {
      id: newUserId(),
      email,
      displayName: email,
      passwordHash: null,
      provider: 'admin',
      avatarAttachment: null,
      providerAvatarUrl: null,
      theme: null,
      createdAt: now(),
    };
    ctx.db.insert(humans).values(human).run();
  }
  if (membershipOf(ctx.db, orgId, human.id)) {
    throw conflict('That person is already a member of this org');
  }
  ctx.db
    .insert(orgMemberships)
    .values({ orgId, humanId: human.id, role: input.role, createdAt: now() })
    .run();
  return { human, role: input.role };
}

/**
 * Remove a human's org membership after enforcing the data invariants that
 * outlive any particular caller: a human still OWNING agents in the org → 409,
 * and the LAST owner cannot be removed → 409. Also clears their member rows in
 * the org's rooms. Shared by the session removal route (which layers
 * caller-permission checks on top) and the admin (control-plane) removal, so
 * neither path can corrupt these invariants.
 */
export function removeOrgMembership(
  ctx: AppContext,
  orgId: string,
  targetId: string,
  targetRole: OrgRole,
): void {
  // Owns agents in this org → refused (transfer/delete first).
  const ownsAgent = ctx.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.ownerHumanId, targetId)))
    .get();
  if (ownsAgent) {
    throw conflict('This person still owns agents in this org — delete or re-own them first');
  }
  // Last owner cannot be removed / leave.
  if (targetRole === 'owner' && ownerCount(ctx.db, orgId) === 1) {
    throw conflict('The last owner cannot leave — transfer ownership first');
  }
  // Remove the org membership + their member rows in this org's rooms.
  const orgRoomIds = ctx.db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.orgId, orgId))
    .all()
    .map((r) => r.id);
  ctx.db.transaction((tx) => {
    tx.delete(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.humanId, targetId)))
      .run();
    for (const roomId of orgRoomIds) {
      tx.delete(members)
        .where(
          and(
            eq(members.roomId, roomId),
            eq(members.principalType, 'human'),
            eq(members.principalId, targetId),
          ),
        )
        .run();
    }
  });
}

/** How many owners an org currently has (last-owner guard). */
export function ownerCount(db: DB, orgId: string): number {
  return db
    .select({ humanId: orgMemberships.humanId })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'owner')))
    .all().length;
}

/** Rank org roles so `has >= need` comparisons are simple. */
const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/** Whether `role` meets or exceeds `need`. */
export function roleAtLeast(role: OrgRole, need: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[need];
}

/**
 * Require an org membership of at least `need`. A non-member gets `404` (orgs
 * never leak their existence to outsiders); an insufficient role gets `403`.
 * Returns the membership row.
 */
export function requireMembership(
  db: DB,
  orgId: string,
  humanId: string,
  need: OrgRole = 'member',
): OrgMembershipRow {
  const m = membershipOf(db, orgId, humanId);
  if (!m) throw notFound('No such org');
  if (!roleAtLeast(m.role as OrgRole, need)) {
    throw forbidden('You do not have permission to do that in this org');
  }
  return m;
}
