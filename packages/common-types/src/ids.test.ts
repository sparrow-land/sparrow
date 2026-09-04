import { describe, it, expect } from 'vitest';
import {
  newOrgId,
  newUserId,
  newAgentId,
  newMemberId,
  newRoomId,
  newMessageId,
  newDraftId,
  newAttachmentId,
  newInviteId,
  newEnrollmentId,
  newRoomInvitationId,
  newSessionId,
  newEmailThreadId,
  newEmailId,
  newExternalContactId,
  newActivityEntryId,
  newInviteToken,
  newEnrollmentToken,
  newAgentKey,
  newSessionToken,
  BASE62_ALPHABET,
} from './ids.js';

const base62 = /^[0-9A-Za-z]+$/;

describe('id generators', () => {
  it('BASE62_ALPHABET has exactly 62 unique chars', () => {
    expect(BASE62_ALPHABET).toHaveLength(62);
    expect(new Set(BASE62_ALPHABET).size).toBe(62);
    expect(BASE62_ALPHABET).toMatch(base62);
  });

  it.each([
    ['newOrgId', newOrgId, /^org_[0-9A-Za-z]{12}$/],
    ['newUserId', newUserId, /^usr_[0-9A-Za-z]{12}$/],
    ['newAgentId', newAgentId, /^agt_[0-9A-Za-z]{12}$/],
    ['newMemberId', newMemberId, /^mem_[0-9A-Za-z]{12}$/],
    ['newRoomId', newRoomId, /^room_[0-9A-Za-z]{12}$/],
    ['newMessageId', newMessageId, /^msg_[0-9A-Za-z]{12}$/],
    ['newDraftId', newDraftId, /^drf_[0-9A-Za-z]{12}$/],
    ['newAttachmentId', newAttachmentId, /^att_[0-9A-Za-z]{12}$/],
    ['newInviteId', newInviteId, /^inv_[0-9A-Za-z]{12}$/],
    ['newEnrollmentId', newEnrollmentId, /^enl_[0-9A-Za-z]{12}$/],
    ['newRoomInvitationId', newRoomInvitationId, /^rin_[0-9A-Za-z]{12}$/],
    ['newSessionId', newSessionId, /^ses_[0-9A-Za-z]{12}$/],
    // v4 — the email medium and the activity timeline
    ['newEmailThreadId', newEmailThreadId, /^eth_[0-9A-Za-z]{12}$/],
    ['newEmailId', newEmailId, /^eml_[0-9A-Za-z]{12}$/],
    ['newExternalContactId', newExternalContactId, /^ext_[0-9A-Za-z]{12}$/],
    ['newActivityEntryId', newActivityEntryId, /^act_[0-9A-Za-z]{12}$/],
  ] as const)('%s matches its 12-char prefix', (_name, gen, re) => {
    expect(gen()).toMatch(re);
  });

  it('email attachments reuse the chat att_ prefix and store', () => {
    expect(newAttachmentId()).toMatch(/^att_[0-9A-Za-z]{12}$/);
  });

  it.each([
    ['newInviteToken', newInviteToken, /^ivk_[0-9A-Za-z]{32}$/],
    ['newEnrollmentToken', newEnrollmentToken, /^enr_[0-9A-Za-z]{32}$/],
    ['newAgentKey', newAgentKey, /^agk_[0-9A-Za-z]{32}$/],
    ['newSessionToken', newSessionToken, /^ses_[0-9A-Za-z]{32}$/],
  ] as const)('%s matches its 32-char secret prefix', (_name, gen, re) => {
    expect(gen()).toMatch(re);
  });

  it('session id and session token share the ses_ prefix but differ in width', () => {
    expect(newSessionId()).toMatch(/^ses_[0-9A-Za-z]{12}$/);
    expect(newSessionToken()).toMatch(/^ses_[0-9A-Za-z]{32}$/);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newAgentId()));
    expect(ids.size).toBe(1000);
    const tokens = new Set(Array.from({ length: 1000 }, () => newAgentKey()));
    expect(tokens.size).toBe(1000);
  });
});
