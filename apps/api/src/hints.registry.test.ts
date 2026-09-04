import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_SUMMARY_MAX,
  AGENT_NAME_MAX,
  DISPLAY_NAME_MAX,
  HINT_TEXT_MAX,
  ORG_SLUG_MAX,
} from '@sparrow/common-types';
import { TRIGGERS } from './hints.js';
import { agents, emails, humans, orgs } from './db/schema.js';

/**
 * REGISTRY-WIDE invariants over the trigger table — the tests that make "add a
 * trigger" safe by construction. Per-trigger behavior (when each fires) lives in
 * `hints.test.ts`; this file asserts what must hold for EVERY trigger, present
 * and future:
 *
 *  1. every trigger carries an `ownerLabel` — the third-person sentence the
 *     owner's Hint info box shows ("Sparrow hinted the agent to …") — because a
 *     trigger without one would dump agent-directed text on a human reader;
 *  2. no trigger can build a hint text longer than `HINT_TEXT_MAX`, even with
 *     every interpolated value at its schema maximum — the client REJECTS an
 *     overlong hint, which fails the send/pop that carried it, so an overrun
 *     is an outage, not a cosmetic bug.
 */

/* ------------------------------------------------------------------ *
 * Worst-case rows: every interpolated field at its schema maximum.
 * ------------------------------------------------------------------ */

const AGENT_ROW = {
  id: 'agt_registrytest',
  orgId: 'org_registrytest',
  ownerHumanId: 'usr_registrytest',
  name: 'a'.repeat(AGENT_NAME_MAX),
  roleTitle: 'x',
  roleInstructions: 'y',
  roleUpdatedAt: '2026-09-01T00:00:00Z',
};

const HUMAN_ROW = {
  id: 'usr_registrytest',
  displayName: 'D'.repeat(DISPLAY_NAME_MAX),
};

const ORG_ROW = {
  id: 'org_registrytest',
  slug: 's'.repeat(ORG_SLUG_MAX),
};

/** The most-recently-read inbound mail `email-is-a-different-register` names. */
const EMAIL_ROW = {
  id: 'eml_registrytest0000000000',
  threadId: 'eth_registrytest0000000000',
  agentId: AGENT_ROW.id,
  direction: 'in',
  readAt: '2026-09-01T00:00:00Z',
};

/** A generously long (operator-set, so formally unbounded) org mail suffix. */
const LONG_SUFFIX = '.mail.workspaces.example-corp.com';

/**
 * A structural stand-in for the drizzle handle: `build()` only ever reads one
 * row per table (the agent behind the principal, its owner, its org), so the
 * chain resolves to the worst-case row for whichever table was named.
 */
function rowFor(tbl: unknown): unknown {
  if (tbl === agents) return AGENT_ROW;
  if (tbl === humans) return HUMAN_ROW;
  if (tbl === orgs) return ORG_ROW;
  if (tbl === emails) return EMAIL_ROW;
  return undefined;
}

const fakeDb = {
  select: () => ({
    from: (tbl: unknown) => {
      // `build()` reads one row per table, sometimes through an
      // `.orderBy().limit()` tail (the last read inbound email) — every chain
      // shape resolves to the worst-case row for whichever table was named.
      const terminal = { get: () => rowFor(tbl), all: () => [rowFor(tbl)] };
      const chain: Record<string, unknown> = {
        ...terminal,
        orderBy: () => chain,
        limit: () => chain,
      };
      return { where: () => chain, ...chain };
    },
  }),
};

/** Everything build() can read, with every free variable at a maximum. */
function evalCtx() {
  return {
    ctx: {
      db: fakeDb,
      config: {
        emailOrgSuffix: LONG_SUFFIX,
        clientRecommendedVersion: '10.20.30-beta.11+build.9999',
      },
      email: { provider: {} },
    },
    principal: { type: 'agent', id: AGENT_ROW.id },
    // The request context is now just an origin + a client version: a trigger
    // that could read the request it decorates would be a trigger that fires ON
    // an action, and hints only ever land at the pause or when asked for.
    info: {
      origin: 'https://a-quite-long-workspace-host.example-corp.com',
      clientVersion: '0.0.1-alpha.20260901+sha.deadbeef',
    },
    now: Date.now(),
    memberIds: ['mem_registrytest'],
  };
}

type BuildArg = Parameters<(typeof TRIGGERS)[number]['build']>[0];

describe('the trigger registry (invariants every trigger must hold)', () => {
  it('every trigger has an ownerLabel — third-person, sentence-cased, summary-sized', () => {
    for (const trigger of TRIGGERS) {
      const label = trigger.ownerLabel;
      expect(label, trigger.id).toBeTypeOf('string');
      // The frame is systematic: sparrow speaking ABOUT the agent, to the human.
      expect(label, trigger.id).toMatch(/^Sparrow hinted the agent\b/);
      expect(label, trigger.id).toMatch(/\.$/);
      // It becomes the entry's `summary`, so it must never hit the clamp.
      expect(label.length, trigger.id).toBeLessThanOrEqual(ACTIVITY_SUMMARY_MAX);
    }
  });

  it('ownerLabels are distinct — two triggers must not read as the same lesson', () => {
    const labels = TRIGGERS.map((t) => t.ownerLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it(`no trigger can build text over HINT_TEXT_MAX (${HINT_TEXT_MAX}), even at max interpolations`, () => {
    for (const trigger of TRIGGERS) {
      const { text } = trigger.build(evalCtx() as unknown as BuildArg);
      expect(text.length, `${trigger.id} built ${text.length} chars`).toBeLessThanOrEqual(
        HINT_TEXT_MAX,
      );
    }
  });

  it('trigger ids are distinct and free of `:` (the ledger-key separator)', () => {
    const ids = TRIGGERS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    // `deliveryCount` canonicalizes a ledger key to the part before the first
    // `:`, so an id containing one would silently merge with another hint.
    for (const id of ids) expect(id, id).not.toContain(':');
  });

  it('the meta-hint stays LAST — it teaches control, which presumes the others fired', () => {
    expect(TRIGGERS[TRIGGERS.length - 1]!.id).toBe('control-your-hints');
  });
});
