import { describe, it, expect } from 'vitest';
import { ApiError } from '@sparrow-land/sdk';
import type { Grant } from '@sparrow-land/sdk/types';
import {
  compactNumber,
  forbiddenMessage,
  grantCoversAgent,
  hasAuthority,
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
