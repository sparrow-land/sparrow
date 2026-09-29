import { describe, expect, it } from 'vitest';
import {
  decideAnalyticsRead,
  decideGrantCreate,
  decideGrantDelete,
  decideMessaging,
  decideTags,
  type ActorFacts,
  type TargetFacts,
} from './visibility-authority.js';

/**
 * The agent-visibility authority rules (SPEC.md "Agent visibility: tags,
 * messaging, grants & analytics" → Authority)
 * guard rails) as a truth table over the pure decision functions. Every row is
 * one (actor, target, change) → verdict, so a rule change shows up as a row.
 */

const human = (id: string, over: Partial<ActorFacts> = {}): ActorFacts => ({
  kind: 'human',
  id,
  orgAdmin: false,
  scopes: [],
  ...over,
});
const agentActor = (id: string, scopes: string[] = []): ActorFacts => ({
  kind: 'agent',
  id,
  orgAdmin: false,
  scopes,
});
const agentTarget = (
  id: string,
  over: Partial<TargetFacts> = {},
): TargetFacts => ({ kind: 'agent', id, ownerHumanId: 'usr_owner', tags: [], scopes: [], ...over });
const humanTarget = (id: string, scopes: string[] = []): TargetFacts => ({
  kind: 'human',
  id,
  tags: [],
  scopes,
});

const reasonOf = (v: ReturnType<typeof decideTags>) => (v.ok ? 'ok' : v.reason);

describe('decideTags — per added/removed tag', () => {
  const cubesBot = agentTarget('agt_t', { tags: ['cubes'] });
  const rows: [string, ActorFacts, TargetFacts, string[], string[], string][] = [
    // [label, actor, target, added, removed, expected]
    ['owner adds any tag', human('usr_owner'), cubesBot, ['ops'], [], 'ok'],
    ['org admin adds any tag', human('usr_adm', { orgAdmin: true }), cubesBot, ['ops'], ['cubes'], 'ok'],
    ['plain member with no grant', human('usr_m'), cubesBot, ['ops'], [], 'grant_required'],
    ['plain member, no-op PUT still needs authority', human('usr_m'), cubesBot, [], [], 'grant_required'],
    ['tags:* holder adds any tag', human('usr_cos', { scopes: ['tags:*'] }), cubesBot, ['ops'], ['cubes'], 'ok'],
    ['tag:cubes holder removes cubes', human('usr_m', { scopes: ['tag:cubes'] }), cubesBot, [], ['cubes'], 'ok'],
    ['tag:cubes holder adds cubes', human('usr_m', { scopes: ['tag:cubes'] }), agentTarget('agt_t'), ['cubes'], [], 'ok'],
    ['tag:cubes holder adds ops', human('usr_m', { scopes: ['tag:cubes'] }), cubesBot, ['ops'], [], 'grant_required'],
    ['tag:cubes holder, no-op', human('usr_m', { scopes: ['tag:cubes'] }), cubesBot, [], [], 'ok'],
    ['agent with tags:* acts on another agent', agentActor('agt_cos', ['tags:*']), cubesBot, ['ops'], [], 'ok'],
    ['agent acts on itself (even with tags:*)', agentActor('agt_t', ['tags:*']), cubesBot, ['ops'], [], 'self'],
    ['agent with no grant', agentActor('agt_x'), cubesBot, ['ops'], [], 'grant_required'],
    [
      'tag:cubes manager touches the chief of staff (tags:*)',
      agentActor('agt_mgr', ['tag:cubes']),
      agentTarget('agt_cos', { tags: ['cubes'], scopes: ['tags:*'] }),
      [],
      ['cubes'],
      'outranked',
    ],
    [
      'sub-agent (tag:cubes) edits manager holding tag:cubes + tag:ops',
      agentActor('agt_sub', ['tag:cubes']),
      agentTarget('agt_mgr', { tags: ['cubes'], scopes: ['tag:cubes', 'tag:ops'] }),
      ['x'],
      [],
      'outranked',
    ],
    [
      'peer holding the same grant is not outranking',
      agentActor('agt_a', ['tag:cubes']),
      agentTarget('agt_b', { tags: ['cubes'], scopes: ['tag:cubes'] }),
      [],
      ['cubes'],
      'ok',
    ],
    [
      'tags:* covers a target holding tag:x',
      agentActor('agt_cos', ['tags:*']),
      agentTarget('agt_mgr', { tags: ['cubes'], scopes: ['tag:cubes'] }),
      ['ops'],
      [],
      'ok',
    ],
    [
      'org admin is exempt from outranked',
      human('usr_adm', { orgAdmin: true }),
      agentTarget('agt_cos', { scopes: ['tags:*'] }),
      ['ops'],
      [],
      'ok',
    ],
    [
      "the agent's owner is exempt from outranked",
      human('usr_owner'),
      agentTarget('agt_cos', { scopes: ['tags:*'] }),
      ['ops'],
      [],
      'ok',
    ],
  ];
  for (const [label, actor, target, added, removed, expected] of rows) {
    it(`${label} → ${expected}`, () => {
      expect(reasonOf(decideTags(actor, target, added, removed))).toBe(expected);
    });
  }

  it('a refusal carries a human-readable message', () => {
    const v = decideTags(human('usr_m', { scopes: ['tag:cubes'] }), agentTarget('agt_t'), ['ops'], []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/ops/);
  });
});

describe('decideMessaging', () => {
  const rows: [string, ActorFacts, TargetFacts, string][] = [
    ['owner', human('usr_owner'), agentTarget('agt_t'), 'ok'],
    ['org admin', human('usr_adm', { orgAdmin: true }), agentTarget('agt_t'), 'ok'],
    ['tags:* holder, untagged target', human('usr_m', { scopes: ['tags:*'] }), agentTarget('agt_t'), 'ok'],
    ['tag:cubes holder, target carries cubes', agentActor('agt_m', ['tag:cubes']), agentTarget('agt_t', { tags: ['cubes', 'ops'] }), 'ok'],
    ['tag:cubes holder, target lacks cubes', agentActor('agt_m', ['tag:cubes']), agentTarget('agt_t', { tags: ['ops'] }), 'grant_required'],
    ['no grant', human('usr_m'), agentTarget('agt_t'), 'grant_required'],
    ['self', agentActor('agt_t', ['tags:*']), agentTarget('agt_t'), 'self'],
    [
      'outranked by the target',
      agentActor('agt_m', ['tag:cubes']),
      agentTarget('agt_t', { tags: ['cubes'], scopes: ['tags:*'] }),
      'outranked',
    ],
  ];
  for (const [label, actor, target, expected] of rows) {
    it(`${label} → ${expected}`, () => {
      expect(reasonOf(decideMessaging(actor, target))).toBe(expected);
    });
  }
});

describe('decideGrantCreate', () => {
  const rows: [string, ActorFacts, TargetFacts, string, string][] = [
    ['org admin grants tags:* to an agent', human('usr_adm', { orgAdmin: true }), agentTarget('agt_t'), 'tags:*', 'ok'],
    ['org admin grants tag:x to a human', human('usr_adm', { orgAdmin: true }), humanTarget('usr_m'), 'tag:x', 'ok'],
    ['org admin grants to themself', human('usr_adm', { orgAdmin: true }), humanTarget('usr_adm'), 'tags:*', 'self'],
    ['tags:* holder grants tag:x', agentActor('agt_cos', ['tags:*']), agentTarget('agt_m'), 'tag:x', 'ok'],
    ['tags:* holder grants tags:*', agentActor('agt_cos', ['tags:*']), agentTarget('agt_m'), 'tags:*', 'grant_required'],
    ['tag:x holder cannot grant tag:x', agentActor('agt_m', ['tag:x']), agentTarget('agt_s'), 'tag:x', 'grant_required'],
    ['plain member', human('usr_m'), agentTarget('agt_s'), 'tag:x', 'grant_required'],
    ["agent owner has no grant authority", human('usr_owner'), agentTarget('agt_t'), 'tag:x', 'grant_required'],
    ['tags:* holder grants to itself', agentActor('agt_cos', ['tags:*']), agentTarget('agt_cos', { scopes: ['tags:*'] }), 'tag:x', 'self'],
    [
      'tags:* holder grants to another tags:* holder (peer)',
      agentActor('agt_cos', ['tags:*']),
      agentTarget('agt_cos2', { scopes: ['tags:*'] }),
      'tag:x',
      'ok',
    ],
  ];
  for (const [label, actor, target, scope, expected] of rows) {
    it(`${label} → ${expected}`, () => {
      expect(reasonOf(decideGrantCreate(actor, target, scope))).toBe(expected);
    });
  }

  it('a tags:* holder is outranked by a holder of a scope it lacks (a future scope kind)', () => {
    expect(
      reasonOf(decideGrantCreate(agentActor('agt_cos', ['tags:*']), agentTarget('agt_m', { scopes: ['admin:*'] }), 'tag:x')),
    ).toBe('outranked');
  });
});

describe('decideGrantDelete', () => {
  const rows: [string, ActorFacts, TargetFacts, string, string][] = [
    // [label, actor, grant holder, grantedBy, expected]
    ['org admin deletes any grant', human('usr_adm', { orgAdmin: true }), agentTarget('agt_t', { scopes: ['tags:*'] }), 'usr_other', 'ok'],
    ['creator deletes their grant', agentActor('agt_cos', ['tags:*']), agentTarget('agt_m', { scopes: ['tag:x'] }), 'agt_cos', 'ok'],
    ['non-creator grant holder', agentActor('agt_cos2', ['tags:*']), agentTarget('agt_m', { scopes: ['tag:x'] }), 'agt_cos', 'grant_required'],
    // Giving up your own authority is always safe: `self` never blocks revoking a grant you hold.
    ['holder revokes its own grant', agentActor('agt_m', ['tag:x']), agentTarget('agt_m', { scopes: ['tag:x'] }), 'usr_adm', 'ok'],
    ['holder of tags:* revokes its own', agentActor('agt_cos', ['tags:*']), agentTarget('agt_cos', { scopes: ['tags:*'] }), 'usr_adm', 'ok'],
    ['admin revokes a grant they hold themself', human('usr_adm', { orgAdmin: true, scopes: ['tag:x'] }), humanTarget('usr_adm', ['tag:x']), 'usr_adm2', 'ok'],
    [
      'creator now outranked by the holder',
      agentActor('agt_cos', ['tags:*']),
      agentTarget('agt_m', { scopes: ['tag:x', 'admin:*'] }),
      'agt_cos',
      'outranked',
    ],
  ];
  for (const [label, actor, holder, grantedBy, expected] of rows) {
    it(`${label} → ${expected}`, () => {
      expect(reasonOf(decideGrantDelete(actor, holder, grantedBy))).toBe(expected);
    });
  }
});

describe('decideAnalyticsRead', () => {
  const rows: [string, ActorFacts, TargetFacts, string][] = [
    ['owner', human('usr_owner'), agentTarget('agt_t'), 'ok'],
    ['org admin', human('usr_adm', { orgAdmin: true }), agentTarget('agt_t'), 'ok'],
    ['the agent itself', agentActor('agt_t'), agentTarget('agt_t'), 'ok'],
    ['tag:cubes holder, agent carries cubes', agentActor('agt_m', ['tag:cubes']), agentTarget('agt_t', { tags: ['cubes'] }), 'ok'],
    ['tag:cubes holder, agent lacks cubes', agentActor('agt_m', ['tag:cubes']), agentTarget('agt_t', { tags: ['ops'] }), 'grant_required'],
    ['tags:* holder', human('usr_m', { scopes: ['tags:*'] }), agentTarget('agt_t'), 'ok'],
    ['plain member', human('usr_m'), agentTarget('agt_t'), 'grant_required'],
  ];
  for (const [label, actor, target, expected] of rows) {
    it(`${label} → ${expected}`, () => {
      expect(reasonOf(decideAnalyticsRead(actor, target))).toBe(expected);
    });
  }
});
