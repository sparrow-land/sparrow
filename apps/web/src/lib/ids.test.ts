import { describe, it, expect, afterEach } from 'vitest';
import {
  bare,
  wire,
  orgPath,
  roomPath,
  roomSettingsPath,
  agentProfilePath,
  orgAdminPath,
  setScopedMode,
  isScopedMode,
  activeRoomIdFromPath,
} from './ids.js';

describe('id ⇄ URL boundary', () => {
  it('strips and restores type prefixes', () => {
    expect(bare('org', 'org_aPx7bDQoNrxk')).toBe('aPx7bDQoNrxk');
    expect(bare('room', 'room_V1StGXR8z5jd')).toBe('V1StGXR8z5jd');
    expect(bare('agent', 'agt_pQ9rT2vX5mLk')).toBe('pQ9rT2vX5mLk');
    expect(wire('org', 'aPx7bDQoNrxk')).toBe('org_aPx7bDQoNrxk');
    expect(wire('room', 'V1StGXR8z5jd')).toBe('room_V1StGXR8z5jd');
    expect(wire('agent', 'pQ9rT2vX5mLk')).toBe('agt_pQ9rT2vX5mLk');
  });

  it('round-trips and is idempotent', () => {
    expect(wire('org', bare('org', 'org_abc'))).toBe('org_abc');
    expect(bare('org', bare('org', 'org_abc'))).toBe('abc'); // second strip is a no-op
    expect(wire('org', wire('org', 'abc'))).toBe('org_abc'); // second restore is a no-op
  });

  it('builds bare-id browser paths', () => {
    expect(orgPath('org_aPx7bDQoNrxk')).toBe('/org/aPx7bDQoNrxk');
    expect(roomPath('org_aPx7bDQoNrxk', 'room_V1StGXR8z5jd')).toBe(
      '/org/aPx7bDQoNrxk/rooms/V1StGXR8z5jd',
    );
    expect(roomSettingsPath('org_a', 'room_b')).toBe('/org/a/rooms/b/settings');
    expect(agentProfilePath('org_a', 'agt_b')).toBe('/org/a/agents/b');
    expect(orgAdminPath('org_a')).toBe('/org/a/admin');
  });

  describe('scoped mode', () => {
    afterEach(() => setScopedMode(false));

    it('drops the /org/:orgId segment (basename carries the scope)', () => {
      setScopedMode(true);
      expect(isScopedMode()).toBe(true);
      expect(orgPath('org_a')).toBe('/');
      expect(orgPath('org_a', '/admin')).toBe('/admin');
      expect(roomPath('org_a', 'room_b')).toBe('/rooms/b');
      expect(roomSettingsPath('org_a', 'room_b')).toBe('/rooms/b/settings');
      expect(agentProfilePath('org_a', 'agt_b')).toBe('/agents/b');
      expect(orgAdminPath('org_a')).toBe('/admin');
    });

    it('is off by default (byte-for-byte unscoped paths)', () => {
      expect(isScopedMode()).toBe(false);
      expect(orgPath('org_a')).toBe('/org/a');
      expect(roomPath('org_a', 'room_b')).toBe('/org/a/rooms/b');
    });
  });

  describe('activeRoomIdFromPath', () => {
    it('matches unscoped and scoped room paths', () => {
      expect(activeRoomIdFromPath('/org/a/rooms/b')).toBe('room_b');
      expect(activeRoomIdFromPath('/org/a/rooms/b/settings')).toBe('room_b');
      expect(activeRoomIdFromPath('/rooms/b')).toBe('room_b');
      expect(activeRoomIdFromPath('/rooms/b/settings')).toBe('room_b');
    });

    it('returns null when no room is open', () => {
      expect(activeRoomIdFromPath('/org/a')).toBeNull();
      expect(activeRoomIdFromPath('/')).toBeNull();
      expect(activeRoomIdFromPath('/agents/x')).toBeNull();
    });
  });
});
