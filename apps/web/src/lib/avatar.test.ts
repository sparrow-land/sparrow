import { describe, it, expect } from 'vitest';
import {
  agentVisual,
  avatarSeed,
  humanVisual,
  initials,
  readAvatarUrl,
  makeRng,
  contrast,
  HUMAN_INK,
} from './avatar.js';

describe('avatar generators — determinism', () => {
  it('agentVisual returns the identical result for the same id', () => {
    expect(agentVisual('agt_atlas')).toEqual(agentVisual('agt_atlas'));
  });

  it('humanVisual returns the identical result for the same id + name', () => {
    expect(humanVisual('usr_1', 'Jake Quist')).toEqual(humanVisual('usr_1', 'Jake Quist'));
  });

  it('makeRng is a stable stream for a given seed', () => {
    const a = makeRng('seed');
    const b = makeRng('seed');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('avatar generators — distinctness', () => {
  it('two different agent ids get different hues (different stops)', () => {
    expect(agentVisual('agt_atlas').stops).not.toEqual(agentVisual('agt_nova').stops);
  });

  it('two different human ids get different gradients', () => {
    const a = humanVisual('usr_a', 'Same Name');
    const b = humanVisual('usr_b', 'Same Name');
    // Same name → same initials, but the hue (keyed off id) must differ.
    expect(a.initials).toBe(b.initials);
    expect([a.top, a.bottom]).not.toEqual([b.top, b.bottom]);
  });

  it('agents spread across the wheel — a sample of ids yields many distinct hues', () => {
    const tops = new Set(
      Array.from({ length: 24 }, (_, i) => agentVisual(`agt_${i}`).stops[1]),
    );
    // No accidental bucketing: nearly all of the 24 are unique.
    expect(tops.size).toBeGreaterThanOrEqual(22);
  });
});

describe('initials extraction — edge cases', () => {
  it('first + last initial for a multi-word name', () => {
    expect(initials('Jake Quist')).toBe('JQ');
    expect(initials('Mara Ellison')).toBe('ME');
  });

  it('collapses extra whitespace and uses first + last', () => {
    expect(initials('  Ada   Béla  Okoro ')).toBe('AO');
  });

  it('single word → a single upper-cased letter', () => {
    expect(initials('ada')).toBe('A');
  });

  it('empty / whitespace-only → the placeholder', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });

  it('uppercases lowercase names', () => {
    expect(initials('devon park')).toBe('DP');
  });
});

describe('human gradient — AA contrast guarantee', () => {
  it('both stops clear ≥4.6:1 against the ink for a spread of ids', () => {
    for (let i = 0; i < 40; i++) {
      const v = humanVisual(`usr_${i}`, `Person ${i}`);
      expect(contrast(v.top, HUMAN_INK)).toBeGreaterThanOrEqual(4.6);
      expect(contrast(v.bottom, HUMAN_INK)).toBeGreaterThanOrEqual(4.6);
    }
  });
});

describe('avatarSeed — principal-stable seed selection', () => {
  const agentRef = { id: 'mem_room1', kind: 'agent' as const, displayName: 'atlas', principalId: 'agt_atlas' };

  it('prefers the explicit principalId over the per-room member id', () => {
    expect(avatarSeed(agentRef)).toBe('agt_atlas');
  });

  it('is stable across rooms: same principal, different member ids → one seed', () => {
    const inRoom2 = { ...agentRef, id: 'mem_room2' };
    expect(avatarSeed(agentRef)).toBe(avatarSeed(inRoom2));
    // …and thus one bird everywhere.
    expect(agentVisual(avatarSeed(agentRef))).toEqual(agentVisual(avatarSeed(inRoom2)));
  });

  it('falls back to a member→principal bridge when principalId is absent (old payloads)', () => {
    const legacy = { id: 'mem_room1', kind: 'agent' as const, displayName: 'atlas' };
    const bridge = new Map([['mem_room1', 'agt_atlas']]);
    expect(avatarSeed(legacy, bridge)).toBe('agt_atlas');
  });

  it('falls back to the ref id when neither principalId nor a bridge entry exists', () => {
    const legacy = { id: 'mem_orphan', kind: 'agent' as const, displayName: 'ghost' };
    expect(avatarSeed(legacy)).toBe('mem_orphan');
    expect(avatarSeed(legacy, new Map())).toBe('mem_orphan');
  });
});

describe('readAvatarUrl', () => {
  it('returns a non-empty url', () => {
    expect(readAvatarUrl({ avatarUrl: 'https://x/y.png' })).toBe('https://x/y.png');
  });
  it('returns null for null / undefined / missing / empty', () => {
    expect(readAvatarUrl({ avatarUrl: null })).toBeNull();
    expect(readAvatarUrl({ avatarUrl: '' })).toBeNull();
    expect(readAvatarUrl({})).toBeNull();
    expect(readAvatarUrl(null)).toBeNull();
    expect(readAvatarUrl(undefined)).toBeNull();
  });
});
