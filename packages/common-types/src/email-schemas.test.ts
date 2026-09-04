import { describe, it, expect } from 'vitest';
import {
  MediumSchema,
  PartySchema,
  EmailDirectionSchema,
  EmailDispositionSchema,
  EmailReasonSchema,
  EmailReadStatusSchema,
  ContactTrustSchema,
  EmailAuthResultSchema,
  EmailScanResultSchema,
  EmailVerificationSchema,
  JudgeVerdictSchema,
  EmailJudgeSchema,
  EmailThreadRefSchema,
  EmailThreadSchema,
  EmailSchema,
  EmailPreviewSchema,
  EmailApprovalItemSchema,
  ExternalContactSchema,
  EmailAddressResponseSchema,
  ListEmailThreadsResponseSchema,
  ListEmailThreadsQuerySchema,
  GetEmailThreadResponseSchema,
  GetEmailResponseSchema,
  ReplyEmailRequestSchema,
  SendEmailRequestSchema,
  SendEmailResponseSchema,
  EmailMutationResponseSchema,
  ApproveEmailRequestSchema,
  DenyEmailRequestSchema,
  ListEmailApprovalsQuerySchema,
  ListEmailApprovalsResponseSchema,
  ListContactsQuerySchema,
  ListContactsResponseSchema,
  UpdateContactRequestSchema,
  UpdateContactResponseSchema,
  OrgEmailSettingsSchema,
  OrgSettingsSchema,
  EmailTrustedPatternSchema,
  InboundEmailPayloadSchema,
  InboundEmailResponseSchema,
  InboundStatusSchema,
  InboundDeliveryStatusSchema,
  OutboundEmailWebhookPayloadSchema,
  CapturedEmailSchema,
  AdminEmailOutboxResponseSchema,
  EmailReceivedEventSchema,
  EmailSentEventSchema,
  EmailQuarantinedEventSchema,
  EmailHeldEventSchema,
  EmailRejectedEventSchema,
  EmailResolvedEventSchema,
  EmailResolutionSchema,
  CapabilitiesResponseSchema,
} from './schemas.js';
import {
  EMAIL_SUBJECT_MAX,
  EMAIL_RECIPIENTS_MAX,
  EMAIL_TRUSTED_PATTERNS_MAX,
  EMAIL_JUDGE_PROMPT_MAX,
  EMAIL_REGISTER_NOTE,
  MAX_ATTACHMENTS,
} from './constants.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const party = {
  email: 'dana@partner.example.com',
  name: 'Dana Lee',
  principalId: null,
  contactId: 'ext_9fQ2mK4pLz1v',
};

const verification = {
  spf: 'pass' as const,
  dkim: 'pass' as const,
  dmarc: 'pass' as const,
  spam: 'pass' as const,
  virus: 'pass' as const,
  domain: 'partner.example.com',
};

const threadRef = {
  id: 'eth_R4kD8sW1zQ2m',
  orgId: 'org_V1StGXR8z5jd',
  agentId: 'agt_pQ9rT2vX5mLk',
  subject: 'Q3 rollout',
  trusted: true,
  lastEmailAt: '2026-08-31T12:04:00Z',
  createdAt: '2026-08-31T12:00:00Z',
};

const email = {
  id: 'eml_7bN3xC6vT9pL',
  threadId: 'eth_R4kD8sW1zQ2m',
  direction: 'in' as const,
  from: party,
  to: [party],
  cc: [],
  bcc: [],
  subject: 'Re: Q3 rollout',
  text: 'full plain-text body',
  html: '<p>sanitized</p>',
  attachments: [
    { id: 'att_p2LmV8cX4nRt', filename: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 81234 },
  ],
  rfcMessageId: '<CAF7...@mail.example.net>',
  inReplyTo: '<eml_a1b2c3d4e5f6@acme.example.com>',
  verification,
  disposition: 'delivered' as const,
  reason: null,
  judge: null,
  status: 'unread' as const,
  createdAt: '2026-08-31T12:04:00Z',
  resolvedAt: null,
};

const preview = {
  id: 'eml_7bN3xC6vT9pL',
  threadId: 'eth_R4kD8sW1zQ2m',
  direction: 'in' as const,
  from: party,
  subject: 'Re: Q3 rollout',
  preview: 'first 200 chars of text',
  truncated: true,
  attachmentCount: 1,
  disposition: 'quarantined' as const,
  reason: 'unrecognized-sender' as const,
  status: 'unread' as const,
  createdAt: '2026-08-31T12:04:00Z',
};

/* ------------------------------------------------------------------ *
 * Enums (all CLOSED per spec)
 * ------------------------------------------------------------------ */

describe('email enums', () => {
  it('MediumSchema is chat|email|voice', () => {
    for (const m of ['chat', 'email', 'voice']) expect(MediumSchema.parse(m)).toBe(m);
    expect(MediumSchema.safeParse('sms').success).toBe(false);
  });

  it('EmailDirectionSchema is in|out', () => {
    expect(EmailDirectionSchema.parse('in')).toBe('in');
    expect(EmailDirectionSchema.parse('out')).toBe('out');
    expect(EmailDirectionSchema.safeParse('inbound').success).toBe(false);
  });

  it('EmailDispositionSchema covers both pipelines and nothing else', () => {
    for (const d of ['delivered', 'quarantined', 'rejected', 'held', 'sent', 'send-failed']) {
      expect(EmailDispositionSchema.parse(d)).toBe(d);
    }
    expect(EmailDispositionSchema.safeParse('pending').success).toBe(false);
    expect(EmailDispositionSchema.safeParse('bounced').success).toBe(false);
  });

  it('EmailReasonSchema is the ONE reason vocabulary (SPEC → Reasons)', () => {
    for (const r of [
      'virus',
      'blocked',
      'spoof',
      'auth-failed',
      'spam',
      'unrecognized-sender',
      'unrecognized-recipient',
      'judge-deny',
      'judge-unavailable',
      'denied',
      'relay-error',
    ]) {
      expect(EmailReasonSchema.parse(r)).toBe(r);
    }
    expect(EmailReasonSchema.options).toHaveLength(11);
    expect(EmailReasonSchema.safeParse('rejected').success).toBe(false);
    expect(EmailReasonSchema.safeParse('unknown-sender').success).toBe(false);
  });

  it('EmailReadStatusSchema is two-valued (no `received` for email)', () => {
    expect(EmailReadStatusSchema.parse('unread')).toBe('unread');
    expect(EmailReadStatusSchema.parse('read')).toBe('read');
    expect(EmailReadStatusSchema.safeParse('received').success).toBe(false);
  });

  it('ContactTrustSchema is approved|blocked (null = unknown, carried by the field)', () => {
    expect(ContactTrustSchema.parse('approved')).toBe('approved');
    expect(ContactTrustSchema.parse('blocked')).toBe('blocked');
    expect(ContactTrustSchema.safeParse('unknown').success).toBe(false);
    expect(ContactTrustSchema.safeParse(null).success).toBe(false);
  });

  it('verification verdict enums', () => {
    for (const v of ['pass', 'fail', 'none']) expect(EmailAuthResultSchema.parse(v)).toBe(v);
    expect(EmailAuthResultSchema.safeParse('softfail').success).toBe(false);
    for (const v of ['pass', 'fail']) expect(EmailScanResultSchema.parse(v)).toBe(v);
    expect(EmailScanResultSchema.safeParse('none').success).toBe(false);
  });

  it('JudgeVerdictSchema is allow|deny', () => {
    expect(JudgeVerdictSchema.parse('allow')).toBe('allow');
    expect(JudgeVerdictSchema.safeParse('maybe').success).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

describe('Party', () => {
  it('requires an email; name/principalId/contactId are optional and nullable', () => {
    expect(PartySchema.parse(party)).toMatchObject({ email: party.email, contactId: party.contactId });
    expect(PartySchema.parse({ email: 'a@b.com' }).email).toBe('a@b.com');
    expect(PartySchema.parse({ email: 'a@b.com', name: null, principalId: null, contactId: null }).name).toBeNull();
    expect(PartySchema.parse({ email: 'a@b.com', principalId: 'agt_x' }).principalId).toBe('agt_x');
    expect(PartySchema.safeParse({ name: 'Dana' }).success).toBe(false);
    expect(PartySchema.safeParse({ email: '' }).success).toBe(false);
  });
});

describe('EmailVerification', () => {
  it('spf/dkim/dmarc + domain required; spam/virus optional', () => {
    expect(EmailVerificationSchema.parse(verification).dmarc).toBe('pass');
    const minimal = { spf: 'none', dkim: 'fail', dmarc: 'none', domain: 'x.example' };
    const parsed = EmailVerificationSchema.parse(minimal);
    expect(parsed.spam).toBeUndefined();
    expect(parsed.virus).toBeUndefined();
    expect(EmailVerificationSchema.safeParse({ ...minimal, spf: 'softfail' }).success).toBe(false);
    expect(EmailVerificationSchema.safeParse({ ...minimal, spam: 'none' }).success).toBe(false);
    const { domain: _d, ...noDomain } = minimal;
    expect(EmailVerificationSchema.safeParse(noDomain).success).toBe(false);
  });
});

describe('EmailJudge', () => {
  it('verdict is allow|deny|null (null = a configured judge that could not answer)', () => {
    expect(EmailJudgeSchema.parse({ verdict: 'deny', reason: 'nope', provider: 'anthropic' }).verdict).toBe('deny');
    const degraded = EmailJudgeSchema.parse({ verdict: null, reason: 'judge unavailable', provider: 'openai' });
    expect(degraded.verdict).toBeNull();
    expect(EmailJudgeSchema.safeParse({ verdict: 'allow', provider: 'fake' }).success).toBe(false);
    expect(EmailJudgeSchema.safeParse({ verdict: 'allow', reason: 'x'.repeat(241), provider: 'fake' }).success).toBe(false);
  });
});

describe('EmailThreadRef / EmailThread', () => {
  it('EmailThreadRef is id/orgId/agentId/subject/trusted/lastEmailAt/createdAt', () => {
    expect(EmailThreadRefSchema.parse(threadRef)).toEqual(threadRef);
    // lastEmailAt is null until a delivered/sent email bumps it (an all-quarantined
    // thread stays invisible in listings).
    expect(EmailThreadRefSchema.parse({ ...threadRef, lastEmailAt: null }).lastEmailAt).toBeNull();
    const { trusted: _t, ...noTrusted } = threadRef;
    expect(EmailThreadRefSchema.safeParse(noTrusted).success).toBe(false);
  });

  it('EmailThread = EmailThreadRef + counts, cast, and the newest disposition', () => {
    const thread = {
      ...threadRef, emailCount: 7, unreadCount: 1, lastDisposition: 'delivered', participants: [party],
    };
    expect(EmailThreadSchema.parse(thread).emailCount).toBe(7);
    expect(EmailThreadSchema.parse(thread).participants[0]!.email).toBe(party.email);
    expect(EmailThreadSchema.parse(thread).lastDisposition).toBe('delivered');
    // null on a thread with no email at all; an unknown disposition is a violation
    expect(EmailThreadSchema.parse({ ...thread, lastDisposition: null }).lastDisposition).toBeNull();
    expect(EmailThreadSchema.safeParse({ ...thread, lastDisposition: 'shrug' }).success).toBe(false);
    expect(EmailThreadSchema.safeParse({ ...thread, unreadCount: -1 }).success).toBe(false);
    expect(EmailThreadSchema.safeParse(threadRef).success).toBe(false);
  });
});

describe('Email', () => {
  it('parses the full spec example', () => {
    expect(EmailSchema.parse(email)).toEqual(email);
  });

  it('bcc is present for shape stability and always [] in v4', () => {
    expect(EmailSchema.parse(email).bcc).toEqual([]);
    // The field is required — every Email carries it, in both directions.
    const { bcc: _b, ...noBcc } = email;
    expect(EmailSchema.safeParse(noBcc).success).toBe(false);
  });

  it('verification is null on outbound; judge is null when none ran', () => {
    const out = {
      ...email,
      direction: 'out' as const,
      verification: null,
      disposition: 'sent' as const,
      status: 'read' as const,
    };
    expect(EmailSchema.parse(out).verification).toBeNull();
    expect(EmailSchema.parse(out).judge).toBeNull();
  });

  it('html and inReplyTo are nullable; reason/resolvedAt nullable', () => {
    const bare = { ...email, html: null, inReplyTo: null, reason: null, resolvedAt: null };
    expect(EmailSchema.parse(bare).html).toBeNull();
    expect(EmailSchema.parse({ ...email, reason: 'spoof', resolvedAt: '2026-08-31T13:00:00Z' }).reason).toBe('spoof');
    expect(EmailSchema.safeParse({ ...email, reason: 'nope' }).success).toBe(false);
  });

  it('status is unread|read only', () => {
    expect(EmailSchema.safeParse({ ...email, status: 'received' }).success).toBe(false);
  });

  it('judge rides on the email when one ran', () => {
    const judged = { ...email, judge: { verdict: 'deny', reason: 'looks phishy', provider: 'anthropic' } };
    expect(EmailSchema.parse(judged).judge?.verdict).toBe('deny');
  });
});

describe('EmailPreview', () => {
  it('is THE preview shape (approvals, events, inbox all carry it)', () => {
    expect(EmailPreviewSchema.parse(preview)).toEqual(preview);
    expect(EmailPreviewSchema.parse({ ...preview, reason: null }).reason).toBeNull();
    // no body ever rides on a preview
    expect('text' in EmailPreviewSchema.parse({ ...preview, text: 'leak' })).toBe(false);
    expect('html' in EmailPreviewSchema.parse({ ...preview, html: '<p>leak</p>' })).toBe(false);
    expect(EmailPreviewSchema.safeParse({ ...preview, attachmentCount: -1 }).success).toBe(false);
  });
});

describe('EmailApprovalItem', () => {
  it('is preview + thread + agent + verification + judge', () => {
    const item = {
      email: preview,
      thread: threadRef,
      agent: { id: 'agt_pQ9rT2vX5mLk', name: 'fable' },
      verification: { spf: 'fail', dkim: 'none', dmarc: 'none', spam: 'fail', virus: 'pass', domain: 'partner.example.com' },
      judge: { verdict: 'deny', reason: 'suspicious', provider: 'anthropic' },
    };
    expect(EmailApprovalItemSchema.parse(item).agent.name).toBe('fable');
    // outbound holds have no verification and often no judge
    expect(EmailApprovalItemSchema.parse({ ...item, verification: null, judge: null }).judge).toBeNull();
    expect(ListEmailApprovalsResponseSchema.parse({ items: [item], nextCursor: null }).items).toHaveLength(1);
  });

  it('the approvals query filters by agent and direction', () => {
    expect(ListEmailApprovalsQuerySchema.parse({ agent: 'agt_a', direction: 'in' }).direction).toBe('in');
    expect(ListEmailApprovalsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(ListEmailApprovalsQuerySchema.safeParse({ direction: 'both' }).success).toBe(false);
  });
});

describe('ExternalContact', () => {
  const contact = {
    id: 'ext_Y2hJ5nQ8dF4r',
    email: 'dana@partner.example.com',
    displayName: 'Dana Lee',
    trust: 'approved' as const,
    firstSeenAt: '2026-08-01T00:00:00Z',
    resolvedAt: '2026-08-02T00:00:00Z',
    resolvedBy: { id: 'usr_dK3fA9qL2mNp', displayName: 'Jake' },
  };
  it('trust is approved|blocked|null (unknown); displayName/resolved* nullable', () => {
    expect(ExternalContactSchema.parse(contact).trust).toBe('approved');
    const unknown = { ...contact, trust: null, displayName: null, resolvedAt: null, resolvedBy: null };
    expect(ExternalContactSchema.parse(unknown).trust).toBeNull();
    expect(ExternalContactSchema.safeParse({ ...contact, trust: 'unknown' }).success).toBe(false);
    expect(ListContactsResponseSchema.parse({ items: [contact], nextCursor: null }).items).toHaveLength(1);
  });
  it('the contacts query filters by trust (incl. `unknown`) and address prefix', () => {
    expect(ListContactsQuerySchema.parse({ trust: 'unknown', q: 'dan' }).trust).toBe('unknown');
    expect(ListContactsQuerySchema.parse({ trust: 'blocked' }).trust).toBe('blocked');
    expect(ListContactsQuerySchema.safeParse({ trust: 'nope' }).success).toBe(false);
  });
  it('PATCH contact accepts approved|blocked|null and wraps the contact back', () => {
    expect(UpdateContactRequestSchema.parse({ trust: null }).trust).toBeNull();
    expect(UpdateContactRequestSchema.parse({ trust: 'blocked' }).trust).toBe('blocked');
    expect(UpdateContactRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateContactResponseSchema.parse({ contact }).contact.id).toBe(contact.id);
  });
});

/* ------------------------------------------------------------------ *
 * Agent surfaces
 * ------------------------------------------------------------------ */

describe('agent email surfaces', () => {
  it('GET /me/email/address is { address, domain, orgId, agentId }', () => {
    const addr = {
      address: 'fable@acme.example.com',
      domain: 'acme.example.com',
      orgId: 'org_V1StGXR8z5jd',
      agentId: 'agt_pQ9rT2vX5mLk',
    };
    expect(EmailAddressResponseSchema.parse(addr)).toEqual(addr);
    expect(EmailAddressResponseSchema.safeParse({ address: 'x' }).success).toBe(false);
  });

  it('thread list is a newest-first page of FULL threads; thread read is { thread, items, nextCursor }', () => {
    const thread = {
      ...threadRef, emailCount: 1, unreadCount: 0, lastDisposition: 'delivered', participants: [party],
    };
    // The list is a transcript: full threads, `nextBefore`, never `nextCursor`.
    expect(ListEmailThreadsResponseSchema.parse({ items: [thread], nextBefore: null }).items).toHaveLength(1);
    expect(ListEmailThreadsResponseSchema.parse({ items: [], nextBefore: 'eth_a' }).nextBefore).toBe('eth_a');
    expect(ListEmailThreadsResponseSchema.safeParse({ items: [threadRef], nextBefore: null }).success).toBe(false);
    expect(ListEmailThreadsResponseSchema.safeParse({ items: [thread], nextCursor: null }).success).toBe(false);
    expect(ListEmailThreadsQuerySchema.parse({ before: 'eth_a', limit: '10' })).toEqual({ before: 'eth_a', limit: 10 });
    expect('cursor' in ListEmailThreadsQuerySchema.parse({ cursor: 'opaque' })).toBe(false);
    // A thread reads FORWARD — its own email list keeps the ascending cursor.
    const full = GetEmailThreadResponseSchema.parse({ thread, items: [email], nextCursor: null });
    expect(full.thread.emailCount).toBe(1);
    expect(full.items[0]!.id).toBe(email.id);
  });

  it('single-email read wraps { email }', () => {
    expect(GetEmailResponseSchema.parse({ email }).email.id).toBe(email.id);
  });

  it('reply body is { text, cc?, attachments? }', () => {
    expect(ReplyEmailRequestSchema.parse({ text: 'sure' }).text).toBe('sure');
    expect(ReplyEmailRequestSchema.parse({ text: 'x', cc: ['a@b.com'] }).cc).toEqual(['a@b.com']);
    expect(ReplyEmailRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(ReplyEmailRequestSchema.safeParse({ text: 'x', cc: ['not-an-email'] }).success).toBe(false);
    expect(
      ReplyEmailRequestSchema.safeParse({
        text: 'x',
        attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({
          filename: 'a', contentType: 'text/plain', dataBase64: 'aGk=',
        })),
      }).success,
    ).toBe(false);
  });

  it('send body is { to, cc?, subject, text, attachments? } with the spec’s caps', () => {
    const body = { to: ['dana@partner.example.com'], subject: 'Hello', text: 'hi' };
    expect(SendEmailRequestSchema.parse(body).to).toEqual(['dana@partner.example.com']);
    // subject is trimmed and capped at the RFC line limit
    expect(SendEmailRequestSchema.parse({ ...body, subject: '  Hello  ' }).subject).toBe('Hello');
    expect(SendEmailRequestSchema.safeParse({ ...body, subject: 'x'.repeat(EMAIL_SUBJECT_MAX + 1) }).success).toBe(false);
    // at least one recipient
    expect(SendEmailRequestSchema.safeParse({ ...body, to: [] }).success).toBe(false);
    // to + cc together are capped at 20
    const many = Array.from({ length: EMAIL_RECIPIENTS_MAX }, (_, i) => `p${i}@x.example`);
    expect(SendEmailRequestSchema.safeParse({ ...body, to: many }).success).toBe(true);
    expect(SendEmailRequestSchema.safeParse({ ...body, to: many, cc: ['one@more.example'] }).success).toBe(false);
    expect(SendEmailRequestSchema.safeParse({ ...body, to: ['nope'] }).success).toBe(false);
    // there is no bcc field in v4 — a stray one is stripped, never sent
    expect('bcc' in SendEmailRequestSchema.parse({ ...body, bcc: ['x@y.example'] })).toBe(false);
  });

  it('send responds { email, thread }; reply/retry respond { email }', () => {
    expect(SendEmailResponseSchema.parse({ email, thread: threadRef }).thread.id).toBe(threadRef.id);
    expect(EmailMutationResponseSchema.parse({ email }).email.id).toBe(email.id);
  });
});

/* ------------------------------------------------------------------ *
 * Approvals verbs
 * ------------------------------------------------------------------ */

describe('approve / deny', () => {
  it('approve defaults trustSender to true (approving is durable)', () => {
    expect(ApproveEmailRequestSchema.parse({}).trustSender).toBe(true);
    expect(ApproveEmailRequestSchema.parse({ trustSender: false }).trustSender).toBe(false);
    expect(ApproveEmailRequestSchema.safeParse({ trustSender: 'yes' }).success).toBe(false);
  });
  it('deny defaults blockSender to false (blocking is opt-in)', () => {
    expect(DenyEmailRequestSchema.parse({}).blockSender).toBe(false);
    expect(DenyEmailRequestSchema.parse({ blockSender: true }).blockSender).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Org policy
 * ------------------------------------------------------------------ */

describe('org email policy', () => {
  it('defaults are reject / reject / [] / null', () => {
    expect(OrgEmailSettingsSchema.parse({})).toEqual({
      inboundUnrecognized: 'reject',
      outboundUnrecognized: 'reject',
      trustedPatterns: [],
      judgePrompt: null,
    });
  });

  it('policies are reject|approve|judge and strict about unknown keys', () => {
    expect(OrgEmailSettingsSchema.parse({ inboundUnrecognized: 'judge' }).inboundUnrecognized).toBe('judge');
    expect(OrgEmailSettingsSchema.safeParse({ inboundUnrecognized: 'allow' }).success).toBe(false);
    expect(OrgEmailSettingsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('OrgSettings gains the email block, merged with defaults', () => {
    expect(OrgSettingsSchema.parse({})).toEqual({
      invites: { who: 'members' },
      enroll: { agents: 'approval' },
      rooms: { create: 'members' },
      email: {
        inboundUnrecognized: 'reject',
        outboundUnrecognized: 'reject',
        trustedPatterns: [],
        judgePrompt: null,
      },
    });
    expect(OrgSettingsSchema.parse({ email: { outboundUnrecognized: 'approve' } }).email.outboundUnrecognized)
      .toBe('approve');
    expect(OrgSettingsSchema.safeParse({ email: { inboundUnrecognized: 'nope' } }).success).toBe(false);
  });

  it('trustedPatterns: lowercased, one @, no catch-alls, 3–200 chars', () => {
    // the spec's canonical "trust everyone at a company" pattern
    expect(EmailTrustedPatternSchema.parse('  *@Partner.Example.com ')).toBe('*@partner.example.com');
    expect(EmailTrustedPatternSchema.parse('dana@partner.example.com')).toBe('dana@partner.example.com');
    expect(EmailTrustedPatternSchema.parse('dana?@partner.example.com')).toBe('dana?@partner.example.com');
    // exactly one @
    expect(EmailTrustedPatternSchema.safeParse('a@b@c.com').success).toBe(false);
    expect(EmailTrustedPatternSchema.safeParse('nope').success).toBe(false);
    // no catch-alls: every DOMAIN label needs a real name
    expect(EmailTrustedPatternSchema.safeParse('*').success).toBe(false);
    expect(EmailTrustedPatternSchema.safeParse('*@*').success).toBe(false);
    expect(EmailTrustedPatternSchema.safeParse('*@*.com').success).toBe(false);
    expect(EmailTrustedPatternSchema.safeParse('*@*.example.com').success).toBe(false);
    expect(EmailTrustedPatternSchema.safeParse('?@?').success).toBe(false);
    // charset + length
    expect(EmailTrustedPatternSchema.safeParse('a b@c.com').success).toBe(false);
    expect(EmailTrustedPatternSchema.safeParse('a@b').success).toBe(true);
    expect(EmailTrustedPatternSchema.safeParse('a@').success).toBe(false);
    expect(EmailTrustedPatternSchema.safeParse('a'.repeat(200) + '@b.com').success).toBe(false);
  });

  it('trustedPatterns is capped at 50 and de-duplicated on write', () => {
    const parsed = OrgEmailSettingsSchema.parse({
      trustedPatterns: ['*@Partner.example.com', '*@partner.example.com', 'dana@x.example'],
    });
    expect(parsed.trustedPatterns).toEqual(['*@partner.example.com', 'dana@x.example']);
    const tooMany = Array.from({ length: EMAIL_TRUSTED_PATTERNS_MAX + 1 }, (_, i) => `p${i}@x.example`);
    expect(OrgEmailSettingsSchema.safeParse({ trustedPatterns: tooMany }).success).toBe(false);
  });

  it('judgePrompt is trimmed 1..4000 or null', () => {
    expect(OrgEmailSettingsSchema.parse({ judgePrompt: '  be strict  ' }).judgePrompt).toBe('be strict');
    expect(OrgEmailSettingsSchema.parse({ judgePrompt: null }).judgePrompt).toBeNull();
    expect(OrgEmailSettingsSchema.safeParse({ judgePrompt: '   ' }).success).toBe(false);
    expect(OrgEmailSettingsSchema.safeParse({ judgePrompt: 'x'.repeat(EMAIL_JUDGE_PROMPT_MAX + 1) }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The inbound seam
 * ------------------------------------------------------------------ */

describe('POST /email/inbound payload', () => {
  const payload = {
    rfcMessageId: '<CAF7...@mail.example.net>',
    inReplyTo: '<eml_a1b2c3d4e5f6@acme.example.com>',
    references: ['<eml_a1b2c3d4e5f6@acme.example.com>'],
    date: '2026-08-31T12:03:58Z',
    from: { email: 'dana@partner.example.com', name: 'Dana Lee' },
    to: [{ email: 'fable@acme.example.com', name: 'fable' }],
    cc: [],
    subject: 'Re: Q3 rollout',
    text: 'plain-text body',
    html: '<p>raw html</p>',
    attachments: [{ filename: 'plan.pdf', contentType: 'application/pdf', dataBase64: 'aGk=' }],
    verification,
    envelope: { mailFrom: 'bounces@partner.example.com', rcptTo: ['fable@acme.example.com'] },
  };

  it('parses the spec example', () => {
    expect(InboundEmailPayloadSchema.parse(payload).from.email).toBe('dana@partner.example.com');
  });

  it('requires rfcMessageId, from.email, ≥1 to, subject, text, verification', () => {
    for (const key of ['rfcMessageId', 'to', 'subject', 'text', 'verification'] as const) {
      const { [key]: _drop, ...rest } = payload;
      expect(InboundEmailPayloadSchema.safeParse(rest).success).toBe(false);
    }
    expect(InboundEmailPayloadSchema.safeParse({ ...payload, to: [] }).success).toBe(false);
    expect(InboundEmailPayloadSchema.safeParse({ ...payload, from: { name: 'Dana' } }).success).toBe(false);
    // subject may be ""
    expect(InboundEmailPayloadSchema.parse({ ...payload, subject: '' }).subject).toBe('');
  });

  it('references/attachments/cc default []; inReplyTo/html/envelope/date default null', () => {
    const minimal = {
      rfcMessageId: '<a@b>',
      from: { email: 'dana@partner.example.com' },
      to: [{ email: 'fable@acme.example.com' }],
      subject: '',
      text: 'hi',
      verification: { spf: 'none', dkim: 'none', dmarc: 'none', domain: 'partner.example.com' },
    };
    const parsed = InboundEmailPayloadSchema.parse(minimal);
    expect(parsed.references).toEqual([]);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.cc).toEqual([]);
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.html).toBeNull();
    expect(parsed.envelope).toBeNull();
    expect(parsed.date).toBeNull();
  });

  it('REJECTS any bcc key — Bcc must not reach the core', () => {
    expect(InboundEmailPayloadSchema.safeParse({ ...payload, bcc: [] }).success).toBe(false);
    expect(InboundEmailPayloadSchema.safeParse({ ...payload, bcc: [{ email: 'x@y.example' }] }).success).toBe(false);
  });

  it('rejects verification verdicts outside the enums', () => {
    expect(InboundEmailPayloadSchema.safeParse({ ...payload, verification: { ...verification, dmarc: 'softfail' } }).success)
      .toBe(false);
    expect(InboundEmailPayloadSchema.safeParse({ ...payload, verification: { ...verification, virus: 'none' } }).success)
      .toBe(false);
  });

  it('caps subject and attachment count', () => {
    expect(InboundEmailPayloadSchema.safeParse({ ...payload, subject: 'x'.repeat(EMAIL_SUBJECT_MAX + 1) }).success).toBe(false);
    expect(
      InboundEmailPayloadSchema.safeParse({
        ...payload,
        attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({
          filename: 'a', contentType: 'text/plain', dataBase64: 'aGk=',
        })),
      }).success,
    ).toBe(false);
  });
});

describe('POST /email/inbound response', () => {
  it('status summarizes the deliveries; unknown-recipient is top-level only', () => {
    for (const s of ['delivered', 'quarantined', 'rejected', 'unknown-recipient', 'duplicate']) {
      expect(InboundStatusSchema.parse(s)).toBe(s);
    }
    expect(InboundStatusSchema.safeParse('held').success).toBe(false);
    for (const s of ['delivered', 'quarantined', 'rejected', 'duplicate']) {
      expect(InboundDeliveryStatusSchema.parse(s)).toBe(s);
    }
    expect(InboundDeliveryStatusSchema.safeParse('unknown-recipient').success).toBe(false);
  });

  it('carries per-anchor deliveries and mirrors the first in `email`', () => {
    const res = {
      status: 'delivered',
      reason: null,
      email: { id: 'eml_a', threadId: 'eth_a' },
      deliveries: [{ agentId: 'agt_a', emailId: 'eml_a', threadId: 'eth_a', status: 'delivered', reason: null }],
    };
    expect(InboundEmailResponseSchema.parse(res).deliveries).toHaveLength(1);
    const none = { status: 'unknown-recipient', reason: null, email: null, deliveries: [] };
    expect(InboundEmailResponseSchema.parse(none).email).toBeNull();
    const spoofed = { status: 'rejected', reason: 'spoof', email: null, deliveries: [] };
    expect(InboundEmailResponseSchema.parse(spoofed).reason).toBe('spoof');
    expect(InboundEmailResponseSchema.safeParse({ ...res, reason: 'nope' }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Outbound webhook + the fake provider's captured mail
 * ------------------------------------------------------------------ */

describe('outbound webhook envelope (v4 break: `to` is an array + `headers`)', () => {
  const body = {
    from: 'fable@acme.example.com',
    to: ['dana@partner.example.com'],
    cc: [],
    bcc: [],
    subject: 'Re: Q3 rollout',
    text: '...',
    html: null,
    headers: {
      messageId: '<eml_7bN3xC6vT9pL@acme.example.com>',
      inReplyTo: '<CAF7...@mail.example.net>',
      references: '<a> <b>',
    },
    attachments: [{ filename: 'plan.pdf', contentType: 'application/pdf', dataBase64: 'aGk=' }],
  };
  it('parses the spec example', () => {
    expect(OutboundEmailWebhookPayloadSchema.parse(body).to).toEqual(['dana@partner.example.com']);
  });
  it('requires from/to/subject/text/headers.messageId; cc/bcc/html/attachments optional', () => {
    const minimal = {
      from: 'fable@acme.example.com',
      to: ['dana@partner.example.com'],
      subject: 'hi',
      text: 'body',
      headers: { messageId: '<eml_x@acme.example.com>' },
    };
    const parsed = OutboundEmailWebhookPayloadSchema.parse(minimal);
    expect(parsed.headers.inReplyTo).toBeUndefined();
    expect(parsed.cc).toBeUndefined();
    // `to` is ALWAYS an array — v3's bare string is gone
    expect(OutboundEmailWebhookPayloadSchema.safeParse({ ...minimal, to: 'dana@partner.example.com' }).success).toBe(false);
    expect(OutboundEmailWebhookPayloadSchema.safeParse({ ...minimal, headers: {} }).success).toBe(false);
  });
});

describe('CapturedEmail (EMAIL_PROVIDER=fake outbox)', () => {
  it('is { email, headers, to, raw }', () => {
    const captured = {
      email,
      headers: { messageId: '<eml_x@acme.example.com>', inReplyTo: null, references: null },
      to: ['dana@partner.example.com'],
      raw: { subject: 'Re: Q3 rollout', text: '...', html: null },
    };
    expect(CapturedEmailSchema.parse(captured).to).toHaveLength(1);
    expect(AdminEmailOutboxResponseSchema.parse({ items: [captured] }).items).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * The six email SSE events
 * ------------------------------------------------------------------ */

describe('email SSE event payloads', () => {
  it('email.received / email.sent carry { email: EmailPreview, thread: EmailThreadRef }', () => {
    const p = { email: preview, thread: threadRef };
    expect(EmailReceivedEventSchema.parse(p).email.id).toBe(preview.id);
    expect(EmailSentEventSchema.parse(p).thread.id).toBe(threadRef.id);
    // never a body
    expect('text' in EmailReceivedEventSchema.parse(p).email).toBe(false);
  });

  it('email.quarantined / email.held add the agent and the reason', () => {
    const p = { email: preview, thread: threadRef, agent: { id: 'agt_a', name: 'fable' }, reason: 'unrecognized-sender' };
    expect(EmailQuarantinedEventSchema.parse(p).agent.name).toBe('fable');
    expect(EmailHeldEventSchema.parse({ ...p, reason: 'unrecognized-recipient' }).reason).toBe('unrecognized-recipient');
    expect(EmailQuarantinedEventSchema.safeParse({ ...p, reason: 'nope' }).success).toBe(false);
  });

  it('email.rejected is a security record: no preview, no body', () => {
    const p = { agentId: 'agt_a', from: party, direction: 'in', reason: 'spoof' };
    const parsed = EmailRejectedEventSchema.parse(p);
    expect(parsed.reason).toBe('spoof');
    expect(parsed.from.email).toBe(party.email);
    expect('email' in parsed).toBe(false);
    expect(EmailRejectedEventSchema.safeParse({ ...p, direction: 'inbound' }).success).toBe(false);
  });

  it('email.resolved carries the resolution and who did it (null for judge/send-failure)', () => {
    for (const r of ['approved', 'denied', 'send-failed']) expect(EmailResolutionSchema.parse(r)).toBe(r);
    expect(EmailResolutionSchema.safeParse('rejected').success).toBe(false);
    const p = {
      email: preview,
      thread: threadRef,
      resolution: 'approved',
      by: { id: 'usr_a', displayName: 'Jake' },
    };
    expect(EmailResolvedEventSchema.parse(p).by?.displayName).toBe('Jake');
    expect(EmailResolvedEventSchema.parse({ ...p, resolution: 'send-failed', by: null }).by).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Capabilities + the canonical register paragraph
 * ------------------------------------------------------------------ */

describe('capabilities gains email', () => {
  it('reports the medium on/off', () => {
    const caps = CapabilitiesResponseSchema.parse({ voice: { stt: true, tts: false }, email: true });
    expect(caps.email).toBe(true);
    // defaulted so a pre-email server still parses
    expect(CapabilitiesResponseSchema.parse({ voice: { stt: false, tts: false } }).email).toBe(false);
    expect(CapabilitiesResponseSchema.safeParse({ voice: { stt: true, tts: true }, email: 'yes' }).success).toBe(false);
  });

  it('reports whether an automatic reviewer is registered', () => {
    const caps = CapabilitiesResponseSchema.parse({
      voice: { stt: false, tts: false }, email: true, emailReviewer: true,
    });
    expect(caps.emailReviewer).toBe(true);
    // The medium can be on with no judge — that is the degrade-to-approve case.
    expect(CapabilitiesResponseSchema.parse({ voice: { stt: false, tts: false }, email: true }).emailReviewer)
      .toBe(false);
  });
});

describe('EMAIL_REGISTER_NOTE', () => {
  it('is written once here and reused by MCP, the onboarding doc, and the hint', () => {
    expect(EMAIL_REGISTER_NOTE).toContain('Email is a different register from chat.');
    expect(EMAIL_REGISTER_NOTE).toContain('a document that will be read once');
    expect(EMAIL_REGISTER_NOTE).toContain('There are no suggested replies and no chips in email');
  });
});
