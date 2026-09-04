import { describe, it, expect } from 'vitest';
import {
  AgentNameSchema,
  CreateAgentRequestSchema,
  EnrollAgentRequestSchema,
  UpdateAgentRequestSchema,
  UpdateMeAgentRequestSchema,
} from './schemas.js';
import {
  AGENT_NAME_MAX,
  AGENT_NAME_REGEX,
  RESERVED_AGENT_NAMES,
  isReservedAgentName,
} from './constants.js';
import { deriveDefaultAgentName, slugifyAgentName } from './identity.js';

/**
 * SPEC v4 — Identity & addressing → Agent names & addresses.
 *
 * A name is lowercase and matches /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, is 1–60
 * characters, and additionally contains no `..` anywhere. Reserved local parts are
 * a SEPARATE outcome (`409 conflict`) from a malformed name (`400 bad_request`),
 * so the shape validator does not reject them — `isReservedAgentName` does.
 */
describe('AgentNameSchema (v4 email-safe rule)', () => {
  it('accepts lowercase alphanumeric names', () => {
    for (const ok of ['fable', 'a', '0', 'deploy-bot', 'deploy.bot', 'deploy_bot', 'a1.b2_c3-d4']) {
      expect(AgentNameSchema.parse(ok)).toBe(ok);
    }
  });

  it('trims before validating', () => {
    expect(AgentNameSchema.parse('  deploy-bot  ')).toBe('deploy-bot');
  });

  it('rejects uppercase (names are lowercase end to end)', () => {
    for (const bad of ['Fable', 'deploy-Bot', 'ABC']) {
      expect(AgentNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a leading or trailing dot, hyphen, or underscore', () => {
    for (const bad of ['.fable', 'fable.', '-fable', 'fable-', '_fable', 'fable_']) {
      expect(AgentNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects `..` anywhere (the rule the regex does not express)', () => {
    for (const bad of ['a..b', 'a...b', 'ops..deploy.bot', 'a.b..c']) {
      expect(AgentNameSchema.safeParse(bad).success).toBe(false);
    }
    // a single dot run is fine, including several of them
    expect(AgentNameSchema.parse('a.b.c')).toBe('a.b.c');
  });

  it('rejects characters that are not email-safe local parts', () => {
    for (const bad of [
      'deploy bot', // space
      'host:folder', // v3's colon form
      'a/b', // slash
      'a@b', // at
      'a+b', // plus (plus-addressing is stripped at resolution, never a name)
      'a!b',
      'café',
      'a\tb',
    ]) {
      expect(AgentNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('bounds length 1..60 after trim', () => {
    expect(AgentNameSchema.safeParse('').success).toBe(false);
    expect(AgentNameSchema.safeParse('   ').success).toBe(false);
    expect(AgentNameSchema.parse('a'.repeat(AGENT_NAME_MAX))).toHaveLength(AGENT_NAME_MAX);
    expect(AgentNameSchema.safeParse('a'.repeat(AGENT_NAME_MAX + 1)).success).toBe(false);
  });

  it('names the rule in its error message (the 400 tells the caller what is legal)', () => {
    const r = AgentNameSchema.safeParse('Deploy Bot');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(' ')).toMatch(/lowercase/i);
    }
  });

  it('exports the canonical regex', () => {
    expect(AGENT_NAME_REGEX.source).toBe('^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$');
    expect(AGENT_NAME_REGEX.test('fable')).toBe(true);
    expect(AGENT_NAME_REGEX.test('.fable')).toBe(false);
  });
});

describe('reserved agent local parts', () => {
  it('lists exactly the spec’s reserved mailboxes', () => {
    expect([...RESERVED_AGENT_NAMES].sort()).toEqual(
      [
        'postmaster',
        'abuse',
        'admin',
        'administrator',
        'hostmaster',
        'webmaster',
        'root',
        'security',
        'noreply',
        'no-reply',
        'mailer-daemon',
      ].sort(),
    );
  });

  it('isReservedAgentName is case-insensitive and trims', () => {
    expect(isReservedAgentName('postmaster')).toBe(true);
    expect(isReservedAgentName('  Postmaster ')).toBe(true);
    expect(isReservedAgentName('no-reply')).toBe(true);
    expect(isReservedAgentName('fable')).toBe(false);
    expect(isReservedAgentName('postmaster2')).toBe(false);
  });

  it('reserved names still pass the SHAPE validator (they are a 409, not a 400)', () => {
    // Malformed → 400 bad_request; reserved → 409 conflict. Two different outcomes,
    // so the shape schema must not swallow the reserved case.
    for (const reserved of RESERVED_AGENT_NAMES) {
      expect(AgentNameSchema.safeParse(reserved).success).toBe(true);
    }
  });
});

describe('the rule is enforced at all four entry points', () => {
  it('POST /me/agents', () => {
    expect(CreateAgentRequestSchema.parse({ orgId: 'org_a', name: ' fable ' }).name).toBe('fable');
    expect(CreateAgentRequestSchema.safeParse({ orgId: 'org_a', name: 'Fable' }).success).toBe(false);
    expect(CreateAgentRequestSchema.safeParse({ orgId: 'org_a', name: 'a..b' }).success).toBe(false);
  });
  it('POST /invite/:token/enroll (the proposedName, validated at the knock)', () => {
    expect(EnrollAgentRequestSchema.parse({ name: 'fable' }).name).toBe('fable');
    expect(EnrollAgentRequestSchema.safeParse({ name: 'host:folder' }).success).toBe(false);
    expect(EnrollAgentRequestSchema.safeParse({ name: 'fable.' }).success).toBe(false);
  });
  it('PATCH /me (agent self-rename)', () => {
    expect(UpdateMeAgentRequestSchema.parse({ name: 'fable' }).name).toBe('fable');
    expect(UpdateMeAgentRequestSchema.safeParse({ name: 'FABLE' }).success).toBe(false);
  });
  it('PATCH /me/agents/:id (owner rename)', () => {
    expect(UpdateAgentRequestSchema.parse({ name: 'fable' }).name).toBe('fable');
    expect(UpdateAgentRequestSchema.safeParse({ name: '-fable' }).success).toBe(false);
  });
});

describe('slugifyAgentName / deriveDefaultAgentName (SPEC "Default agent name")', () => {
  it('slugifies to a name that is valid by construction', () => {
    expect(slugifyAgentName('Demo1-Projects/Foo')).toBe('demo1-projects-foo');
    expect(slugifyAgentName('a  b')).toBe('a-b');
    expect(slugifyAgentName('--a--b--')).toBe('a-b');
    expect(slugifyAgentName('..a..b..')).toBe('a.b');
    expect(slugifyAgentName('!!!')).toBe('agent');
    expect(slugifyAgentName('')).toBe('agent');
    expect(AgentNameSchema.safeParse(slugifyAgentName('x'.repeat(200))).success).toBe(true);
  });

  it('proposes a slugified {host}-{folder}, never v3’s {host}:{folder}', () => {
    const name = deriveDefaultAgentName('/home/jake/projects/foo', '/home/jake');
    expect(name).not.toContain(':');
    expect(name.endsWith('-projects-foo')).toBe(true);
    expect(AgentNameSchema.safeParse(name).success).toBe(true);
  });

  it('proposes {host}-home for $HOME itself', () => {
    const name = deriveDefaultAgentName('/home/jake', '/home/jake');
    expect(name.endsWith('-home')).toBe(true);
    expect(AgentNameSchema.safeParse(name).success).toBe(true);
  });

  it('slugifies an absolute path outside home', () => {
    const name = deriveDefaultAgentName('/opt/foo', '/home/jake');
    expect(name.endsWith('-opt-foo')).toBe(true);
    expect(AgentNameSchema.safeParse(name).success).toBe(true);
  });

  it('is always valid against the agent name rule, however ugly the cwd', () => {
    for (const cwd of [
      '/home/jake/My Projects/Sparrow (v4)!',
      '/home/jake/' + 'deep/'.repeat(40) + 'leaf',
      '/home/jake/a..b',
      '/home/jake/.hidden.',
    ]) {
      const name = deriveDefaultAgentName(cwd, '/home/jake');
      expect(AgentNameSchema.safeParse(name).success).toBe(true);
    }
  });
});
