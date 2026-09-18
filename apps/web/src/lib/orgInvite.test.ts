import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Invite } from '@sparrow-land/sdk/types';
import { api } from './client.js';
import { ensureOrgInvite, isReusableInvite, rememberedInvites } from './orgInvite.js';

const ORG = 'org_1';

function invite(over: Partial<Invite> = {}): Invite {
  return {
    id: 'inv_1',
    inviter: { id: 'usr_1', displayName: 'Jake' },
    note: null,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    revokedAt: null,
    createdAt: new Date().toISOString(),
    useCount: 0,
    ...over,
  };
}

describe('isReusableInvite', () => {
  it('a blank, live, unused invite is reusable', () => {
    expect(isReusableInvite(invite())).toBe(true);
  });

  /**
   * Every one of these is a door the caller deliberately shaped, spent, or shut.
   * Reusing one would hand out a link that means something other than "the
   * generic link I just asked for".
   */
  it('a noted, revoked, expired or already-walked-through invite is not', () => {
    expect(isReusableInvite(invite({ note: 'Design team' }))).toBe(false);
    expect(isReusableInvite(invite({ revokedAt: new Date().toISOString() }))).toBe(false);
    expect(isReusableInvite(invite({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).toBe(
      false,
    );
    expect(isReusableInvite(invite({ useCount: 1 }))).toBe(false);
  });
});

/** Both halves of the reuse check, stubbed: the mint and the list it consults. */
function stubApi() {
  let n = 0;
  return {
    create: vi.spyOn(api, 'createInvite').mockImplementation(async () => {
      n += 1;
      return {
        invite: invite({ id: `inv_${n}` }),
        url: `https://s.example/invite/ivk_token${n}`,
      };
    }),
    list: vi.spyOn(api, 'listInvites').mockResolvedValue([]),
  };
}

describe('ensureOrgInvite', () => {
  let create: ReturnType<typeof stubApi>['create'];
  let list: ReturnType<typeof stubApi>['list'];

  beforeEach(() => {
    localStorage.clear();
    ({ create, list } = stubApi());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints when the caller has no invite to reuse', async () => {
    expect(await ensureOrgInvite(ORG)).toBe('https://s.example/invite/ivk_token1');
    expect(create).toHaveBeenCalledTimes(1);
    expect(rememberedInvites(ORG)).toEqual([
      { id: 'inv_1', url: 'https://s.example/invite/ivk_token1' },
    ]);
  });

  /** Issue #5: five opens of the dialog left five live doors into the org. */
  it('reuses the remembered invite while the server still calls it live and unused', async () => {
    const first = await ensureOrgInvite(ORG);
    list.mockResolvedValue([invite({ id: 'inv_1' })]);

    expect(await ensureOrgInvite(ORG)).toBe(first);
    expect(await ensureOrgInvite(ORG)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('mints again once the remembered invite has been walked through', async () => {
    const first = await ensureOrgInvite(ORG);
    list.mockResolvedValue([invite({ id: 'inv_1', useCount: 1 })]);

    const second = await ensureOrgInvite(ORG);
    expect(second).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
    // The spent invite is forgotten, so it is never offered again.
    expect(rememberedInvites(ORG).map((i) => i.id)).toEqual(['inv_2']);
  });

  it('mints again once the remembered invite has been revoked in org admin', async () => {
    await ensureOrgInvite(ORG);
    list.mockResolvedValue([invite({ id: 'inv_1', revokedAt: new Date().toISOString() })]);
    await ensureOrgInvite(ORG);
    expect(create).toHaveBeenCalledTimes(2);
  });

  /** A remembered invite the server no longer lists (deleted, another account). */
  it('mints again when the remembered invite is not in the caller’s list at all', async () => {
    await ensureOrgInvite(ORG);
    list.mockResolvedValue([invite({ id: 'inv_other' })]);
    await ensureOrgInvite(ORG);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('never reuses another org’s invite', async () => {
    await ensureOrgInvite(ORG);
    list.mockResolvedValue([invite({ id: 'inv_1' })]);
    await ensureOrgInvite('org_2');
    expect(create).toHaveBeenCalledTimes(2);
  });

  /** The list is a nicety; a failing one must never block the door. */
  it('mints when the list call fails', async () => {
    await ensureOrgInvite(ORG);
    list.mockRejectedValue(new Error('offline'));
    await ensureOrgInvite(ORG);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('prefers the most recent reusable invite it remembers', async () => {
    await ensureOrgInvite(ORG);
    // A second live invite appears (minted elsewhere, e.g. org admin is not
    // remembered) — of the ones we DO remember, the newest wins.
    list.mockResolvedValue([invite({ id: 'inv_1', useCount: 1 })]);
    const second = await ensureOrgInvite(ORG);
    list.mockResolvedValue([
      invite({ id: 'inv_1', useCount: 1, createdAt: '2026-09-01T00:00:00Z' }),
      invite({ id: 'inv_2', createdAt: '2026-09-02T00:00:00Z' }),
    ]);
    expect(await ensureOrgInvite(ORG)).toBe(second);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
