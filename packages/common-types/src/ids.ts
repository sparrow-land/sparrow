import { customAlphabet } from 'nanoid';

/**
 * Base62 alphabet (0-9, A-Z, a-z) used for all sparrow ids, invite/enrollment
 * tokens, agent keys, and session tokens per SPEC v3. Browser-safe: nanoid is
 * universal, no node imports.
 */
export const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const nano12 = customAlphabet(BASE62_ALPHABET, 12);
const nano32 = customAlphabet(BASE62_ALPHABET, 32);

/* ------------------------------------------------------------------ *
 * Ids — `<prefix>_` + 12-char base62 nanoid. Opaque; clients never parse.
 * ------------------------------------------------------------------ */

/** `org_` + 12-char base62 nanoid. */
export const newOrgId = (): string => `org_${nano12()}`;

/** `usr_` + 12-char base62 nanoid (a human account, instance-global). */
export const newUserId = (): string => `usr_${nano12()}`;

/** `agt_` + 12-char base62 nanoid (an agent principal). */
export const newAgentId = (): string => `agt_${nano12()}`;

/** `mem_` + 12-char base62 nanoid (a principal's presence in one room). */
export const newMemberId = (): string => `mem_${nano12()}`;

/** `room_` + 12-char base62 nanoid. */
export const newRoomId = (): string => `room_${nano12()}`;

/** `msg_` + 12-char base62 nanoid. */
export const newMessageId = (): string => `msg_${nano12()}`;

/** `drf_` + 12-char base62 nanoid (a personal, room-scoped message draft). */
export const newDraftId = (): string => `drf_${nano12()}`;

/** `att_` + 12-char base62 nanoid. */
export const newAttachmentId = (): string => `att_${nano12()}`;

/** `inv_` + 12-char base62 nanoid (an invite row). */
export const newInviteId = (): string => `inv_${nano12()}`;

/** `enl_` + 12-char base62 nanoid (an enrollment row). */
export const newEnrollmentId = (): string => `enl_${nano12()}`;

/** `rin_` + 12-char base62 nanoid (a room invitation). */
export const newRoomInvitationId = (): string => `rin_${nano12()}`;

/** `ses_` + 12-char base62 nanoid (a user-session row id). */
export const newSessionId = (): string => `ses_${nano12()}`;

/**
 * `eth_` + 12-char base62 nanoid (an email thread — the unit of conversation in
 * the email medium, anchored to exactly ONE agent).
 */
export const newEmailThreadId = (): string => `eth_${nano12()}`;

/**
 * `eml_` + 12-char base62 nanoid (one email in a thread, `in` or `out`). Also
 * the local part of the outbound `Message-ID` (`<{emailId}@{address domain}>`),
 * so the reply that comes back resolves in one lookup.
 */
export const newEmailId = (): string => `eml_${nano12()}`;

/**
 * `ext_` + 12-char base62 nanoid (an external contact — an email address, scoped
 * to one org, that belongs to no principal).
 */
export const newExternalContactId = (): string => `ext_${nano12()}`;

/** `act_` + 12-char base62 nanoid (one append-only activity timeline entry). */
export const newActivityEntryId = (): string => `act_${nano12()}`;

/* ------------------------------------------------------------------ *
 * Secrets — `<prefix>_` + 32-char base62 (~190 bits). Stored hashed
 * (sha256); the plaintext is shown exactly once at mint time.
 * ------------------------------------------------------------------ */

/**
 * `ivk_` + 32-char base62 invite token. The secret embedded in an invite URL
 * (`{BASE_URL}/invite/ivk_...`); the only door into an org.
 */
export const newInviteToken = (): string => `ivk_${nano32()}`;

/**
 * `enr_` + 32-char base62 enrollment token. Issued once to an anonymous agent
 * enroller so it (alone) can poll its enrollment's status.
 */
export const newEnrollmentToken = (): string => `enr_${nano32()}`;

/**
 * `agk_` + 32-char base62 agent key. An agent's sole credential; returned once
 * at mint/rotation, then only ever stored hashed.
 */
export const newAgentKey = (): string => `agk_${nano32()}`;

/**
 * `ses_` + 32-char base62 session token. A human's session credential (cookie
 * or `Authorization: Bearer ses_...`). Shares the `ses_` prefix with the
 * session row id but is 32 chars wide.
 */
export const newSessionToken = (): string => `ses_${nano32()}`;
