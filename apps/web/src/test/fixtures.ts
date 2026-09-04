/**
 * Typed v4 fixtures for the web suite: every builder returns the REAL wire shape
 * from `@sparrow/common-types`, so a fixture that drifts from the contract fails
 * `typecheck` rather than a test three layers up. Tests stub `fetch` with these
 * (JSON-serialized), exactly as the v3 suites do with hand-rolled literals.
 */
import type {
  ActivityEntry,
  ContactTrust,
  Email,
  EmailApprovalItem,
  EmailDisposition,
  EmailJudge,
  EmailPreview,
  EmailReason,
  EmailThread,
  EmailThreadRef,
  EmailVerification,
  ExternalContact,
  Party,
} from '@sparrow/common-types';

export const ORG_ID = 'org_1';
export const AGENT_ID = 'agt_1';
export const THREAD_ID = 'eth_1';

/** A passing edge verification block (SPF/DKIM/DMARC all pass). */
export function verification(overrides: Partial<EmailVerification> = {}): EmailVerification {
  return {
    spf: 'pass',
    dkim: 'pass',
    dmarc: 'pass',
    domain: 'partner.example.com',
    ...overrides,
  };
}

export function party(overrides: Partial<Party> = {}): Party {
  return {
    email: 'dana@partner.example.com',
    name: 'Dana Lee',
    principalId: null,
    contactId: 'ext_dana',
    ...overrides,
  };
}

export function agentParty(overrides: Partial<Party> = {}): Party {
  return {
    email: 'fable@acme.example.com',
    name: 'fable',
    principalId: AGENT_ID,
    contactId: null,
    ...overrides,
  };
}

export function threadRef(overrides: Partial<EmailThreadRef> = {}): EmailThreadRef {
  return {
    id: THREAD_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    subject: 'Q3 rollout',
    trusted: true,
    lastEmailAt: '2026-08-31T12:04:00Z',
    createdAt: '2026-08-30T09:00:00Z',
    ...overrides,
  };
}

/**
 * A FULL thread — what the thread LISTS return (`nextBefore`-paged, newest
 * first). `lastDisposition` is the newest email's, so the default is the happy
 * path: `delivered` badges nothing.
 */
export function thread(overrides: Partial<EmailThread> = {}): EmailThread {
  return {
    ...threadRef(),
    emailCount: 2,
    unreadCount: 0,
    lastDisposition: 'delivered' as EmailDisposition,
    participants: [party(), agentParty()],
    ...overrides,
  };
}

export function judge(overrides: Partial<EmailJudge> = {}): EmailJudge {
  return { verdict: 'allow', reason: 'routine correspondence', provider: 'fake', ...overrides };
}

export function email(overrides: Partial<Email> = {}): Email {
  return {
    id: 'eml_1',
    threadId: THREAD_ID,
    direction: 'in',
    from: party(),
    to: [agentParty()],
    cc: [],
    bcc: [],
    subject: 'Re: Q3 rollout',
    text: 'the plan is attached, let me know what you think',
    html: '<p>the plan is attached</p>',
    attachments: [],
    rfcMessageId: '<CAF7@mail.example.net>',
    inReplyTo: null,
    verification: verification(),
    disposition: 'delivered' as EmailDisposition,
    reason: null as EmailReason | null,
    judge: null,
    status: 'read',
    createdAt: '2026-08-31T12:04:00Z',
    resolvedAt: null,
    ...overrides,
  };
}

export function preview(overrides: Partial<EmailPreview> = {}): EmailPreview {
  return {
    id: 'eml_1',
    threadId: THREAD_ID,
    direction: 'in',
    from: party(),
    subject: 'Re: Q3 rollout',
    preview: 'the plan is attached, let me know what you think',
    truncated: false,
    attachmentCount: 0,
    disposition: 'delivered' as EmailDisposition,
    reason: null as EmailReason | null,
    status: 'read',
    createdAt: '2026-08-31T12:04:00Z',
    ...overrides,
  };
}

export function approvalItem(overrides: Partial<EmailApprovalItem> = {}): EmailApprovalItem {
  return {
    email: preview({ disposition: 'quarantined', reason: 'unrecognized-sender', status: 'unread' }),
    thread: threadRef({ trusted: false, lastEmailAt: null }),
    agent: { id: AGENT_ID, name: 'fable' },
    verification: verification({ spf: 'fail', dkim: 'none', dmarc: 'none' }),
    judge: null,
    ...overrides,
  };
}

export function contact(overrides: Partial<ExternalContact> = {}): ExternalContact {
  return {
    id: 'ext_dana',
    email: 'dana@partner.example.com',
    displayName: 'Dana Lee',
    trust: 'approved' as ContactTrust | null,
    firstSeenAt: '2026-08-01T00:00:00Z',
    resolvedAt: '2026-08-02T00:00:00Z',
    resolvedBy: { id: 'usr_1', displayName: 'Jake' },
    ...overrides,
  };
}

/** An `email.received` timeline entry (the default: an inbound delivered email). */
export function activityEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'act_1',
    orgId: ORG_ID,
    medium: 'email',
    type: 'email.received',
    agent: { id: AGENT_ID, name: 'fable' },
    actor: { kind: 'contact', id: 'ext_dana', displayName: 'Dana Lee' },
    summary: 'Re: Q3 rollout',
    refs: { emailThreadId: THREAD_ID, emailId: 'eml_1' },
    createdAt: '2026-08-31T12:04:00Z',
    ...overrides,
  };
}

/**
 * A `hint.delivered` timeline entry — sparrow taught the agent something.
 * `summary` is the trigger's owner-framed sentence; the verbatim agent-directed
 * text rides the `hint` payload (absent on rows that predate it).
 */
export function hintEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return activityEntry({
    id: 'act_hint',
    medium: 'system',
    type: 'hint.delivered',
    actor: { kind: 'system', id: null, displayName: 'sparrow' },
    summary: 'Sparrow hinted the agent to advertise a working status while it is on a job.',
    hint: {
      id: 'set-a-status',
      text: 'Set a working status so your humans see progress.',
    },
    refs: {},
    ...overrides,
  });
}

/** A `chat.message` timeline entry (ignored by the DM stream, shown on the agent page). */
export function chatEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return activityEntry({
    id: 'act_chat',
    medium: 'chat',
    type: 'chat.message',
    actor: { kind: 'human', id: 'usr_1', displayName: 'Jake' },
    summary: 'ship it',
    refs: { roomId: 'room_1', messageId: 'msg_1' },
    ...overrides,
  });
}
