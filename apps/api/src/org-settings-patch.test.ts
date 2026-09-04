import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { openDb } from './db/index.js';
import { orgs } from './db/schema.js';
import { parseOrgSettings } from './org-helpers.js';
import type { OrgSettings } from '@sparrow/common-types';

/**
 * PATCH /orgs/:orgId `settings` is a MERGE-PATCH (QA I-5).
 *
 * The regression: `settings` parsed through the full `OrgSettingsSchema`, whose
 * every key carries a `.default()`. A body naming one group therefore arrived as
 * a COMPLETE object with the other groups filled in at their defaults, and that
 * whole object was written over the stored JSON. Untouched-but-configured policy
 * (`email` above all) was silently reset. It read as "deep merge" whenever the
 * absent keys happened to already sit at their defaults, and as a wipe otherwise
 * — the two contradictory QA repros were the same bug seen from both sides.
 *
 * The contract: keys present in the body replace the stored value AT THAT KEY'S
 * level, keys absent are untouched, unknown keys (at any level) are `400`, and
 * the response body always equals the newly persisted state.
 */
describe('PATCH /orgs/:orgId settings — merge-patch semantics', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;

  const DEFAULTS = {
    invites: { who: 'members' },
    enroll: { agents: 'approval' },
    rooms: { create: 'members' },
    email: {
      inboundUnrecognized: 'reject',
      outboundUnrecognized: 'reject',
      trustedPatterns: [],
      judgePrompt: null,
    },
  };

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  /** The raw `settings` JSON text on the org row. */
  function rawStored(): string {
    const handle = openDb(ts.dataDir);
    try {
      return handle.db.select().from(orgs).where(eq(orgs.id, orgId)).get()!.settings;
    } finally {
      handle.sqlite.close();
    }
  }

  /** The persisted policy as every read path resolves it. */
  function persisted(): OrgSettings {
    return parseOrgSettings(rawStored());
  }

  async function patch(body: Record<string, unknown>) {
    return ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: body,
    });
  }

  /** PATCH settings, assert 200, assert response === persisted, return settings. */
  async function patchSettings(settings: unknown): Promise<OrgSettings> {
    const res = await patch({ settings });
    expect(res.statusCode, res.body).toBe(200);
    const fromResponse = res.json().org.settings as OrgSettings;
    expect(fromResponse).toEqual(persisted());
    return fromResponse;
  }

  it('a fresh org reads full defaults', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    expect(res.json().org.settings).toEqual(DEFAULTS);
  });

  it('a partial group patch leaves the other groups untouched', async () => {
    await patchSettings({ email: { inboundUnrecognized: 'judge' } });
    const after = await patchSettings({ enroll: { agents: 'open' } });
    expect(after).toEqual({
      ...DEFAULTS,
      enroll: { agents: 'open' },
      email: { ...DEFAULTS.email, inboundUnrecognized: 'judge' },
    });
    // Literally persisted, not merely defaults-filled on the way out: the row
    // holds the complete policy, so response === stored byte for byte.
    expect(JSON.parse(rawStored())).toEqual(after);
  });

  it("the docs page's own {invites, enroll, rooms} body no longer wipes a configured email policy", async () => {
    await patchSettings({
      email: { inboundUnrecognized: 'judge', trustedPatterns: ['*@partner.example.com'] },
    });
    const after = await patchSettings({
      invites: { who: 'admins' },
      enroll: { agents: 'open' },
      rooms: { create: 'admins' },
    });
    expect(after).toEqual({
      invites: { who: 'admins' },
      enroll: { agents: 'open' },
      rooms: { create: 'admins' },
      email: {
        inboundUnrecognized: 'judge',
        outboundUnrecognized: 'reject',
        trustedPatterns: ['*@partner.example.com'],
        judgePrompt: null,
      },
    });
  });

  it('merges INSIDE a group: naming one email key keeps that group\'s other keys', async () => {
    await patchSettings({
      email: { inboundUnrecognized: 'judge', trustedPatterns: ['*@partner.example.com'] },
    });
    const after = await patchSettings({ email: { judgePrompt: 'be strict' } });
    expect(after.email).toEqual({
      inboundUnrecognized: 'judge',
      outboundUnrecognized: 'reject',
      trustedPatterns: ['*@partner.example.com'],
      judgePrompt: 'be strict',
    });
  });

  it('a named leaf REPLACES wholesale — arrays are not appended, null clears', async () => {
    await patchSettings({
      email: { trustedPatterns: ['*@a.example.com', '*@b.example.com'], judgePrompt: 'x' },
    });
    const after = await patchSettings({ email: { trustedPatterns: ['*@c.example.com'], judgePrompt: null } });
    expect(after.email).toEqual({
      inboundUnrecognized: 'reject',
      outboundUnrecognized: 'reject',
      trustedPatterns: ['*@c.example.com'],
      judgePrompt: null,
    });
    const cleared = await patchSettings({ email: { trustedPatterns: [] } });
    expect((cleared.email as { trustedPatterns: string[] }).trustedPatterns).toEqual([]);
  });

  it('an empty settings object is a no-op that preserves everything', async () => {
    const configured = await patchSettings({
      invites: { who: 'admins' },
      email: { inboundUnrecognized: 'approve' },
    });
    expect(await patchSettings({})).toEqual(configured);
  });

  it('patching name/slug alone never touches settings', async () => {
    const configured = await patchSettings({ email: { inboundUnrecognized: 'approve' } });
    const res = await patch({ name: 'Renamed Org' });
    expect(res.statusCode).toBe(200);
    expect(res.json().org.settings).toEqual(configured);
    expect(persisted()).toEqual(configured);
  });

  it('unknown keys still 400 — top level and nested', async () => {
    expect((await patch({ settings: { nope: true } })).statusCode).toBe(400);
    expect((await patch({ settings: { email: { nope: true } } })).statusCode).toBe(400);
    expect((await patch({ settings: { enroll: { humans: 'auto-email' } } })).statusCode).toBe(400);
    // A rejected patch must not have partially applied.
    expect(persisted()).toEqual(DEFAULTS);
  });

  // The BODY ROOT was permissive while `settings` was strict inside, so
  // `{"nme":"Typo"}` (or `{"name":"Acme","setings":{…}}`) was accepted, applied
  // nothing the caller meant, and returned 200 — a silent no-op on a rename or a
  // whole misspelled settings block.
  it('unknown keys at the BODY ROOT are 400 naming the key, not a silent no-op', async () => {
    const res = await patch({ nme: 'Typo' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('nme');

    // A misspelled settings block never passes as "nothing to do" either.
    const misspelled = await patch({
      name: 'Acme',
      setings: { enroll: { agents: 'open' } },
    });
    expect(misspelled.statusCode).toBe(400);
    expect(misspelled.json().error.message).toContain('setings');
    expect(persisted()).toEqual(DEFAULTS);
  });

  it('an empty body is still the "at least one field" 400', async () => {
    const res = await patch({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('At least one field');
  });

  it('invalid values still 400 and leave the stored policy alone', async () => {
    const configured = await patchSettings({ email: { inboundUnrecognized: 'judge' } });
    expect((await patch({ settings: { enroll: { agents: 'sometimes' } } })).statusCode).toBe(400);
    expect((await patch({ settings: { email: { trustedPatterns: ['*@*'] } } })).statusCode).toBe(400);
    expect(persisted()).toEqual(configured);
  });

  it('repeated identical patches are idempotent', async () => {
    const once = await patchSettings({ rooms: { create: 'admins' } });
    expect(await patchSettings({ rooms: { create: 'admins' } })).toEqual(once);
  });
});
