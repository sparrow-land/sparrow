import { describe, it, expect } from 'vitest';
import { ApiError } from '@sparrow-land/sdk';
import type { Grant } from '@sparrow-land/sdk/types';
import {
  compactNumber,
  forbiddenMessage,
  authorityOver,
  canGrantTo,
  canRevokeGrant,
  grantableScopes,
  grantCoversAgent,
  hasAuthority,
  plural,
  namesList,
  normalizeTag,
  reachability,
  tagSuggestions,
} from './access.js';

function grant(principalId: string, scope: string, id = `grt_${principalId}_${scope}`): Grant {
  return {
    id,
    orgId: 'org_1',
    principalId,
    principalKind: principalId.startsWith('agt_') ? 'agent' : 'human',
    scope,
    grantedBy: 'usr_1',
    createdAt: '2026-09-01T00:00:00Z',
  };
}

describe('compactNumber', () => {
  it('keeps small numbers exact and compacts thousands like the mockup', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(412)).toBe('412');
    expect(compactNumber(1400)).toBe('1.4k');
    expect(compactNumber(8200)).toBe('8.2k');
    expect(compactNumber(2000)).toBe('2k');
    expect(compactNumber(96_000)).toBe('96k');
    expect(compactNumber(96_400)).toBe('96k');
    expect(compactNumber(2_300_000)).toBe('2.3M');
  });

  it('rolls to M at the boundary instead of showing 1000k', () => {
    expect(compactNumber(999_499)).toBe('999k');
    expect(compactNumber(999_500)).toBe('1M');
    expect(compactNumber(999_999)).toBe('1M');
    expect(compactNumber(1_000_000)).toBe('1M');
    expect(compactNumber(9_999)).toBe('10k');
  });
});

describe('grantCoversAgent / hasAuthority', () => {
  it('tags:* covers any agent; tag:x only agents carrying x', () => {
    expect(grantCoversAgent('tags:*', [])).toBe(true);
    expect(grantCoversAgent('tag:cubes', ['cubes', 'builders'])).toBe(true);
    expect(grantCoversAgent('tag:docs', ['cubes'])).toBe(false);
    expect(grantCoversAgent('weird', ['cubes'])).toBe(false);
  });

  it('owner and admins always have authority; members only through a covering grant', () => {
    const base = { meId: 'usr_2', agentId: 'agt_1', agentTags: ['cubes'], grants: [] as Grant[] };
    expect(hasAuthority({ ...base, isOwner: true, isAdmin: false })).toBe(true);
    expect(hasAuthority({ ...base, isOwner: false, isAdmin: true })).toBe(true);
    expect(hasAuthority({ ...base, isOwner: false, isAdmin: false })).toBe(false);
    expect(
      hasAuthority({ ...base, isOwner: false, isAdmin: false, grants: [grant('usr_2', 'tag:cubes')] }),
    ).toBe(true);
    expect(
      hasAuthority({ ...base, isOwner: false, isAdmin: false, grants: [grant('usr_2', 'tag:docs')] }),
    ).toBe(false);
    // Someone ELSE's grant does not count.
    expect(
      hasAuthority({ ...base, isOwner: false, isAdmin: false, grants: [grant('usr_3', 'tags:*')] }),
    ).toBe(false);
    expect(
      hasAuthority({ ...base, isOwner: false, isAdmin: false, grants: [grant('usr_2', 'tags:*')] }),
    ).toBe(true);
  });
});

describe('authorityOver: the server rules, for render gating', () => {
  const base = { isOwner: false, isAdmin: false, meId: 'usr_2', agentId: 'agt_1', agentTags: ['cubes', 'docs'] };

  it('owner and admins: implicit, every tag, never outranked', () => {
    for (const who of [{ isOwner: true }, { isAdmin: true }]) {
      const a = authorityOver({ ...base, ...who, grants: [grant('agt_1', 'tags:*')] });
      expect(a).toMatchObject({ implicit: true, manage: true, anyTag: true, outranked: false });
      expect(a.canEditTag('anything')).toBe(true);
    }
  });

  it('a tag:cubes holder manages an agent carrying cubes but edits only the cubes tag', () => {
    const a = authorityOver({ ...base, grants: [grant('usr_2', 'tag:cubes')] });
    expect(a).toMatchObject({ implicit: false, manage: true, anyTag: false, outranked: false });
    expect(a.tags).toEqual(['cubes']);
    expect(a.canEditTag('cubes')).toBe(true);
    expect(a.canEditTag('docs')).toBe(false);
    expect(a.canEditTag('new-one')).toBe(false);
  });

  it('tags:* covers every agent and every tag', () => {
    const a = authorityOver({ ...base, agentTags: [], grants: [grant('usr_2', 'tags:*')] });
    expect(a).toMatchObject({ manage: true, anyTag: true });
    expect(a.canEditTag('docs')).toBe(true);
  });

  it('a grant for a tag the agent does not carry gives nothing', () => {
    const a = authorityOver({ ...base, grants: [grant('usr_2', 'tag:ops')] });
    expect(a.manage).toBe(false);
    expect(a.canEditTag('ops')).toBe(false);
  });

  it('outranked: the agent holds a grant the viewer does not (tags:* covers every tag:x)', () => {
    const out = authorityOver({ ...base, grants: [grant('usr_2', 'tag:cubes'), grant('agt_1', 'tag:ops')] });
    expect(out).toMatchObject({ outranked: true, manage: false });
    expect(out.canEditTag('cubes')).toBe(false);
    const chief = authorityOver({ ...base, grants: [grant('usr_2', 'tags:*'), grant('agt_1', 'tag:ops')] });
    expect(chief).toMatchObject({ outranked: false, manage: true });
    const peer = authorityOver({ ...base, grants: [grant('usr_2', 'tag:cubes'), grant('agt_1', 'tag:cubes')] });
    expect(peer.manage).toBe(true);
  });

  it('never over yourself', () => {
    const a = authorityOver({ ...base, meId: 'agt_1', grants: [grant('agt_1', 'tags:*')] });
    expect(a.manage).toBe(false);
  });

  it('hasAuthority is authorityOver(...).manage', () => {
    expect(hasAuthority({ ...base, grants: [grant('usr_2', 'tag:cubes'), grant('agt_1', 'tags:*')] })).toBe(false);
  });
});

describe('grant create / revoke rules', () => {
  it('grantableScopes: admins any scope, tags:* holders only tag:<slug>, everyone else none', () => {
    expect(grantableScopes({ isAdmin: true, meId: 'usr_1', grants: [] })).toBe('any');
    expect(grantableScopes({ isAdmin: false, meId: 'usr_2', grants: [grant('usr_2', 'tags:*')] })).toBe('tag');
    expect(grantableScopes({ isAdmin: false, meId: 'usr_2', grants: [grant('usr_2', 'tag:cubes')] })).toBe('none');
    expect(grantableScopes({ isAdmin: false, meId: 'usr_2', grants: [grant('usr_3', 'tags:*')] })).toBe('none');
  });

  it('canGrantTo: never yourself; a non-admin never to a principal that outranks them', () => {
    const chief = [grant('usr_2', 'tags:*')];
    expect(canGrantTo({ isAdmin: true, meId: 'usr_1', grants: [], principalId: 'usr_1' })).toBe(false);
    expect(canGrantTo({ isAdmin: true, meId: 'usr_1', grants: [grant('agt_9', 'tags:*')], principalId: 'agt_9' })).toBe(true);
    expect(canGrantTo({ isAdmin: false, meId: 'usr_2', grants: chief, principalId: 'agt_1' })).toBe(true);
    expect(canGrantTo({ isAdmin: false, meId: 'usr_2', grants: chief, principalId: 'usr_2' })).toBe(false);
    expect(
      canGrantTo({ isAdmin: false, meId: 'usr_2', grants: [...chief, grant('usr_2', 'tag:x')], principalId: 'agt_1' }),
    ).toBe(true);
    expect(canGrantTo({ isAdmin: false, meId: 'usr_2', grants: [grant('usr_2', 'tag:cubes')], principalId: 'agt_1' })).toBe(
      false,
    );
  });

  it('canRevokeGrant: admins, the creator (unless outranked by the holder), and the holder', () => {
    const g = { ...grant('agt_1', 'tag:cubes'), grantedBy: 'usr_2' };
    expect(canRevokeGrant({ grant: g, isAdmin: true, meId: 'usr_9', grants: [g] })).toBe(true);
    expect(canRevokeGrant({ grant: g, isAdmin: false, meId: 'usr_2', grants: [g, grant('usr_2', 'tags:*')] })).toBe(true);
    expect(canRevokeGrant({ grant: g, isAdmin: false, meId: 'usr_9', grants: [g] })).toBe(false);
    const mine = grant('usr_4', 'tag:cubes');
    expect(canRevokeGrant({ grant: mine, isAdmin: false, meId: 'usr_4', grants: [mine] })).toBe(true);
    // The creator lost ground: the holder now also holds tag:ops, which the creator lacks.
    const holderMore = [g, grant('agt_1', 'tag:ops'), grant('usr_2', 'tag:cubes')];
    expect(canRevokeGrant({ grant: g, isAdmin: false, meId: 'usr_2', grants: holderMore })).toBe(false);
  });
});

describe('plural', () => {
  it('says 1 message, 2 messages, 0 messages', () => {
    expect(plural(1, 'message')).toBe('1 message');
    expect(plural(2, 'message')).toBe('2 messages');
    expect(plural(0, 'message')).toBe('0 messages');
    expect(plural(12345, 'message')).toBe('12,345 messages');
  });
});

describe('reachability', () => {
  const me = { id: 'agt_1', name: 'cubes-builder', tags: ['cubes', 'builders'] };
  const others = [
    { id: 'agt_1', name: 'cubes-builder', tags: ['cubes'], messaging: 'any' as const },
    { id: 'agt_2', name: 'vm7-cubes-reviewer', tags: ['cubes'], messaging: 'any' as const },
    { id: 'agt_3', name: 'cubes-tester', tags: ['cubes'], messaging: 'tags' as const },
    { id: 'agt_4', name: 'docs-writer', tags: ['docs'], messaging: 'any' as const },
    { id: 'agt_5', name: 'hermit', tags: ['cubes'], messaging: 'none' as const },
    { id: 'agt_6', name: 'vm3-builder', tags: ['builders'], messaging: 'any' as const },
  ];

  it('any: everyone whose own setting allows it; never itself', () => {
    const r = reachability({ ...me, messaging: 'any' }, others);
    expect(r.reachable).toEqual(['cubes-tester', 'docs-writer', 'vm3-builder', 'vm7-cubes-reviewer']);
    expect(r.blocked).toEqual(['hermit']);
  });

  it('tags: only agents sharing a tag, and whose setting allows it', () => {
    const r = reachability({ ...me, messaging: 'tags' }, others);
    expect(r.reachable).toEqual(['cubes-tester', 'vm3-builder', 'vm7-cubes-reviewer']);
    expect(r.blocked).toEqual(['docs-writer', 'hermit']);
  });

  it('a tags-policy peer refuses an agent that shares no tag with it', () => {
    const r = reachability({ id: 'agt_9', name: 'x', tags: ['docs'], messaging: 'any' }, others);
    expect(r.blocked).toContain('cubes-tester');
    expect(r.reachable).toContain('docs-writer');
  });

  it('none: nobody', () => {
    const r = reachability({ ...me, messaging: 'none' }, others);
    expect(r.reachable).toEqual([]);
    expect(r.blocked).toHaveLength(5);
  });
});

describe('tags', () => {
  it('normalizes input into a slug or rejects it', () => {
    expect(normalizeTag('  Cubes ')).toBe('cubes');
    expect(normalizeTag('#reviewers')).toBe('reviewers');
    expect(normalizeTag('two words')).toBe('two-words');
    expect(normalizeTag('-bad')).toBeNull();
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('a'.repeat(33))).toBeNull();
    expect(normalizeTag('ok_no')).toBeNull();
  });

  it('suggests org tags not already on the agent, prefix matches first', () => {
    const org = [['cubes', 'builders'], ['docs'], ['reviewers', 'cubes'], ['subcubes']];
    expect(tagSuggestions(org, ['cubes'], '')).toEqual(['builders', 'docs', 'reviewers', 'subcubes']);
    expect(tagSuggestions(org, [], 'cub')).toEqual(['cubes', 'subcubes']);
    expect(tagSuggestions(org, ['cubes'], 'cub')).toEqual(['subcubes']);
  });
});

describe('namesList', () => {
  it('joins up to a cap and summarizes the rest', () => {
    expect(namesList(['a', 'b'])).toBe('a, b');
    expect(namesList(['a', 'b', 'c', 'd'], 2)).toBe('a, b and 2 more');
  });
});

describe('forbiddenMessage', () => {
  function forbidden(reason?: string, message = 'server words') {
    return new ApiError({ code: 'forbidden', status: 403, message, reason });
  }
  it('maps each 403 reason to plain wording', () => {
    expect(forbiddenMessage(forbidden('self'), 'x')).toMatch(/own/i);
    expect(forbiddenMessage(forbidden('outranked'), 'x')).toMatch(/access you don.t have/i);
    expect(forbiddenMessage(forbidden('grant_required'), 'x')).toMatch(/admin/i);
    // The server's message names which side's setting blocks the DM — keep it.
    expect(forbiddenMessage(forbidden('messaging_policy', 'docs-writer only DMs tagged agents'), 'x')).toBe(
      'docs-writer only DMs tagged agents',
    );
  });
  it('falls back to the server message, then the fallback', () => {
    expect(forbiddenMessage(forbidden(undefined, 'nope'), 'x')).toBe('nope');
    expect(forbiddenMessage(new Error('boom'), 'Could not save.')).toBe('Could not save.');
  });
});
