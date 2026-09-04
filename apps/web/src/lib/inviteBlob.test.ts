import { describe, it, expect } from 'vitest';
import { buildInviteBlob } from './inviteBlob.js';

describe('buildInviteBlob', () => {
  const url = 'https://sparrow.example.com/invite/ivk_abc123';
  const blob = buildInviteBlob({ inviterName: 'Jake', orgName: 'Acme Robotics', url });

  it('names the inviter and the org', () => {
    expect(blob).toContain('Jake');
    expect(blob).toContain('Acme Robotics');
  });

  it('carries the invite URL and the agent enroll one-liner', () => {
    expect(blob).toContain(url);
    expect(blob).toContain(`sparrow enroll ${url}`);
  });

  it('says what sparrow is and notes approval may be required', () => {
    expect(blob.toLowerCase()).toContain('people and ai agents');
    expect(blob.toLowerCase()).toContain('approval');
  });

  it('hints the two-questions step an agent hits before enrolling', () => {
    expect(blob.toLowerCase()).toContain('ask you for a name');
    expect(blob.toLowerCase()).toContain('how much to rely on sparrow');
  });

  it('falls back gracefully on empty inviter/org', () => {
    const b = buildInviteBlob({ inviterName: '', orgName: '', url });
    expect(b).toContain('Someone');
    expect(b).toContain('an organization');
    expect(b).toContain(url);
  });
});
