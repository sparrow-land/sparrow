import { describe, it, expect } from 'vitest';
import {
  dispositionBadge,
  isPending,
  verificationNote,
  judgeNote,
  partyLabel,
  partyChip,
  headFromEntry,
  headFromPreview,
  headFromEmail,
  sanitizeEmailHtml,
  directionLabel,
  senderLabel,
  untrustedSender,
} from './email.js';
import { activityEntry, email, preview, party, verification } from '../test/fixtures.js';

describe('dispositionBadge — off the happy path only', () => {
  it('renders nothing for delivered/sent', () => {
    expect(dispositionBadge('delivered')).toBeNull();
    expect(dispositionBadge('sent')).toBeNull();
  });

  it('names each non-happy disposition', () => {
    expect(dispositionBadge('quarantined')).toBe('Quarantined');
    expect(dispositionBadge('held')).toBe('Held');
    expect(dispositionBadge('rejected')).toBe('Rejected');
    expect(dispositionBadge('send-failed')).toBe('Send failed');
  });

  it('knows which dispositions are the pending queue', () => {
    expect(isPending('quarantined')).toBe(true);
    expect(isPending('held')).toBe(true);
    expect(isPending('rejected')).toBe(false);
    expect(isPending('delivered')).toBe(false);
  });
});

describe('verificationNote — state in the label, mechanisms in the tooltip', () => {
  it('says nothing about the viewer’s own outbound mail', () => {
    expect(verificationNote({ direction: 'out', verification: null, disposition: 'sent', reason: null })).toBeNull();
  });

  it('marks a fully authenticated sender verified, naming the domain', () => {
    const note = verificationNote({
      direction: 'in',
      verification: verification(),
      disposition: 'delivered',
      reason: null,
    })!;
    expect(note.tone).toBe('good');
    expect(note.label).toBe('Verified — partner.example.com');
    // The per-mechanism detail lives in the tooltip AS TEXT (v3 tooltip rule).
    expect(note.tooltip).toContain('SPF: pass');
    expect(note.tooltip).toContain('DKIM: pass');
    expect(note.tooltip).toContain('DMARC: pass');
  });

  it('flags an unverified sender in amber when a mechanism fails', () => {
    const note = verificationNote({
      direction: 'in',
      verification: verification({ dkim: 'fail', dmarc: 'none' }),
      disposition: 'quarantined',
      reason: 'unrecognized-sender',
    })!;
    expect(note.tone).toBe('warn');
    expect(note.label).toBe('Unverified sender');
    expect(note.tooltip).toContain('DKIM: fail');
    expect(note.tooltip).toContain('DMARC: none');
  });

  it('states a spoof rejection plainly', () => {
    const note = verificationNote({
      direction: 'in',
      verification: verification({ spf: 'fail', dkim: 'fail', dmarc: 'fail' }),
      disposition: 'rejected',
      reason: 'spoof',
    })!;
    expect(note.tone).toBe('bad');
    expect(note.label).toBe('Rejected — the sender could not be verified.');
  });

  it('surfaces the edge’s spam and virus verdicts', () => {
    const spam = verificationNote({
      direction: 'in',
      verification: verification({ spam: 'fail' }),
      disposition: 'quarantined',
      reason: 'spam',
    })!;
    expect(spam.label).toBe('Flagged as spam');
    expect(spam.tooltip).toContain('Spam: fail');

    const virus = verificationNote({
      direction: 'in',
      verification: verification({ virus: 'fail' }),
      disposition: 'rejected',
      reason: 'virus',
    })!;
    expect(virus.label).toBe('Blocked — malware detected');
    expect(virus.tone).toBe('bad');
  });
});

describe('judgeNote — the verdict and its reason, never the provider', () => {
  it('is null when no automatic review ran', () => {
    expect(judgeNote(null)).toBeNull();
  });

  it('reads "Automatic review: allow / deny — reason"', () => {
    expect(judgeNote({ verdict: 'allow', reason: 'routine', provider: 'anthropic' })).toBe(
      'Automatic review: allow — routine',
    );
    expect(judgeNote({ verdict: 'deny', reason: 'asks for credentials', provider: 'openai' })).toBe(
      'Automatic review: deny — asks for credentials',
    );
  });

  it('never names the provider', () => {
    expect(judgeNote({ verdict: 'deny', reason: 'x', provider: 'anthropic' })).not.toContain('anthropic');
  });

  it('reports a degraded (null-verdict) review honestly', () => {
    expect(judgeNote({ verdict: null, reason: 'timed out', provider: 'openai' })).toBe(
      'Automatic review: could not decide — timed out',
    );
  });
});

describe('party rendering', () => {
  it('prefers the display name, falling back to the bare address', () => {
    expect(partyLabel(party())).toBe('Dana Lee');
    expect(partyLabel(party({ name: null }))).toBe('dana@partner.example.com');
  });

  it('chips carry name + address, and copy the address', () => {
    expect(partyChip(party())).toEqual({ label: 'Dana Lee', address: 'dana@partner.example.com' });
    expect(partyChip(party({ name: null })).label).toBe('dana@partner.example.com');
  });

  it('names the direction in text, never by glyph alone', () => {
    expect(directionLabel('in')).toBe('Received');
    expect(directionLabel('out')).toBe('Sent');
  });

  // Jake's ruling (2026-09-02): an UNTRUSTED sender — quarantined, or
  // inbound-rejected — renders as its raw ADDRESS everywhere. The display name
  // is attacker-controlled ("Jake Quist" from foo@sus.com must read as
  // foo@sus.com).
  it('an untrusted sender renders the address, never the self-chosen name', () => {
    expect(untrustedSender('in', 'quarantined')).toBe(true);
    expect(untrustedSender('in', 'rejected')).toBe(true);
    expect(untrustedSender('out', 'rejected')).toBe(false); // the agent's own denied send
    expect(untrustedSender('in', null)).toBe(false);
    expect(senderLabel(party({ name: 'Jake Quist' }), 'in', 'quarantined')).toBe(
      'dana@partner.example.com',
    );
    expect(senderLabel(party({ name: 'Jake Quist' }), 'in', null)).toBe('Jake Quist');
  });
});

describe('card heads — one shape from an entry, a preview, or a full email', () => {
  it('derives direction + disposition from the entry type (no body, no fetch)', () => {
    const head = headFromEntry(activityEntry());
    expect(head).toMatchObject({
      emailId: 'eml_1',
      threadId: 'eth_1',
      direction: 'in',
      subject: 'Re: Q3 rollout',
      disposition: 'delivered',
      snippet: null,
    });
    // An entry carries no address — only the frozen actor label.
    expect(head.counterpart).toBeNull();
    expect(head.counterpartLabel).toBe('Dana Lee');

    expect(headFromEntry(activityEntry({ type: 'email.sent' })).direction).toBe('out');
    expect(headFromEntry(activityEntry({ type: 'email.quarantined' })).disposition).toBe('quarantined');
    expect(headFromEntry(activityEntry({ type: 'email.held' })).direction).toBe('out');
    expect(headFromEntry(activityEntry({ type: 'email.held' })).disposition).toBe('held');
    expect(headFromEntry(activityEntry({ type: 'email.rejected' })).disposition).toBe('rejected');
    // A resolved entry cannot know the outcome without a fetch — it stays unknown.
    expect(headFromEntry(activityEntry({ type: 'email.resolved' })).disposition).toBeNull();
  });

  it('takes the snippet and the disposition verbatim from a preview', () => {
    const head = headFromPreview(preview({ disposition: 'held', reason: 'unrecognized-recipient', direction: 'out' }));
    expect(head.snippet).toBe('the plan is attached, let me know what you think');
    expect(head.disposition).toBe('held');
    expect(head.reason).toBe('unrecognized-recipient');
    expect(head.direction).toBe('out');
  });

  it('takes a one-line snippet from a full email’s text body', () => {
    const head = headFromEmail(email({ text: 'first line\nsecond line' }));
    expect(head.snippet).toBe('first line second line');
    expect(head.subject).toBe('Re: Q3 rollout');
  });
});

describe('sanitizeEmailHtml — the client refuses whatever survived the server', () => {
  it('drops scripts, style blocks, and event handlers', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="steal()">hi</p><script>evil()</script><style>body{display:none}</style>',
    );
    expect(out).toContain('hi');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('display:none');
  });

  it('loads no remote content (images, iframes, webfonts)', () => {
    const out = sanitizeEmailHtml(
      '<img src="https://tracker.example.com/pixel.gif"><iframe src="https://x"></iframe><link rel="stylesheet" href="https://f">',
    );
    expect(out).not.toContain('tracker.example.com');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('stylesheet');
  });

  it('keeps links but opens them in a new tab, never following them', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com/doc">doc</a>');
    expect(out).toContain('href="https://example.com/doc"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('neutralizes javascript: and data: hrefs', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a><a href="data:text/html,<b>">y</a>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text/html');
  });
});
