import { describe, it, expect } from 'vitest';
import type { MeOrg } from '@sparrow/common-types';
import {
  detectPathScope,
  detectHostScope,
  detectScope,
  activeOrgForScope,
} from './scope.js';

const meteor: MeOrg = { org: { id: 'org_meteor', name: 'Meteor', slug: 'meteor' }, role: 'owner' };
const sightsinging: MeOrg = {
  org: { id: 'org_sing', name: 'Sightsinging', slug: 'sightsinging' },
  role: 'member',
};

describe('scope detection', () => {
  describe('path scope', () => {
    it('detects /orgs/<slug> and nested paths', () => {
      expect(detectPathScope('/orgs/acme')).toEqual({
        slug: 'acme',
        mode: 'path',
        basename: '/orgs/acme',
      });
      expect(detectPathScope('/orgs/acme/rooms/abc')).toEqual({
        slug: 'acme',
        mode: 'path',
        basename: '/orgs/acme',
      });
    });

    it('ignores a bare /orgs, unscoped paths, and the singular /org', () => {
      expect(detectPathScope('/orgs')).toBeNull();
      expect(detectPathScope('/orgs/')).toBeNull();
      expect(detectPathScope('/')).toBeNull();
      expect(detectPathScope('/org/aPx7bDQoNrxk/rooms/x')).toBeNull();
      expect(detectPathScope('/login')).toBeNull();
    });

    it('rejects reserved and malformed slugs', () => {
      expect(detectPathScope('/orgs/api')).toBeNull();
      expect(detectPathScope('/orgs/admin')).toBeNull();
      expect(detectPathScope('/orgs/Not_A_Slug')).toBeNull();
    });
  });

  describe('host scope', () => {
    it('matches <slug><suffix> including port', () => {
      expect(detectHostScope('acme.localhost:8722', '.localhost:8722')).toEqual({
        slug: 'acme',
        mode: 'host',
        basename: '/',
      });
      expect(detectHostScope('acme.example.com', '.example.com')).toEqual({
        slug: 'acme',
        mode: 'host',
        basename: '/',
      });
    });

    it('returns null with no suffix configured', () => {
      expect(detectHostScope('acme.example.com', null)).toBeNull();
      expect(detectHostScope('acme.example.com', undefined)).toBeNull();
      expect(detectHostScope('acme.example.com', '')).toBeNull();
    });

    it('returns null for a non-matching host or a reserved label', () => {
      expect(detectHostScope('example.com', '.example.com')).toBeNull(); // empty slug
      expect(detectHostScope('www.example.com', '.example.com')).toBeNull(); // reserved
      expect(detectHostScope('app.example.com', '.example.com')).toBeNull(); // reserved
      expect(detectHostScope('other.net', '.example.com')).toBeNull();
    });
  });

  describe('combined', () => {
    it('path scope wins over host scope', () => {
      const s = detectScope(
        { pathname: '/orgs/acme/rooms/x', host: 'beta.example.com' },
        '.example.com',
      );
      expect(s).toMatchObject({ slug: 'acme', mode: 'path' });
    });

    it('falls back to host scope, then to null (unscoped)', () => {
      expect(
        detectScope({ pathname: '/rooms/x', host: 'beta.example.com' }, '.example.com'),
      ).toMatchObject({ slug: 'beta', mode: 'host' });
      expect(detectScope({ pathname: '/', host: 'app.example.com' }, null)).toBeNull();
    });
  });

  // Regression for the multi-org host bug: on an org-scoped host the displayed
  // (active) org must follow the host, not the caller's first/last membership.
  describe('activeOrgForScope', () => {
    const orgs = [meteor, sightsinging];

    it('on host sightsinging.<suffix>, the active org is sightsinging (not the first membership)', () => {
      const scope = detectHostScope('sightsinging.example.com', '.example.com');
      // Even with last-active = Meteor, the host wins.
      expect(activeOrgForScope(orgs, scope, meteor.org.id)).toBe(sightsinging);
    });

    it('on a non-org host (unscoped), keeps the existing last-active/first selection', () => {
      // No scope → last-active wins.
      expect(activeOrgForScope(orgs, null, sightsinging.org.id)).toBe(sightsinging);
      // No scope, no last-active → the first membership.
      expect(activeOrgForScope(orgs, null, null)).toBe(meteor);
    });

    it('a scoped host whose slug matches no membership falls back sensibly (no crash)', () => {
      const scope = detectHostScope('someoneelse.example.com', '.example.com');
      expect(scope).not.toBeNull();
      // Falls back to last-active…
      expect(activeOrgForScope(orgs, scope, sightsinging.org.id)).toBe(sightsinging);
      // …else the first membership.
      expect(activeOrgForScope(orgs, scope, null)).toBe(meteor);
    });

    it('returns null when the caller belongs to no org', () => {
      const scope = detectHostScope('sightsinging.example.com', '.example.com');
      expect(activeOrgForScope([], scope, null)).toBeNull();
    });
  });
});
