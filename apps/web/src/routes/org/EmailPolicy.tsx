import { useState } from 'react';
import { X } from 'lucide-react';
import { EmailTrustedPatternSchema, type OrgEmailSettings } from '@sparrow/common-types';
import { useCapabilities } from '../../lib/capabilities.js';
import { ErrorText, Panel, PolicyGroup, PolicyRadio, inputClass } from './ui.js';

/**
 * Policies → **Email** (SPEC v4 → *Web UI → Org admin*), rendered only with
 * `capabilities.email`. Four controls over `orgs.settings.email`, all written for
 * non-technical humans — no route names, no key names, no env vars:
 *
 *  - what happens to mail from people the org does not recognize;
 *  - what happens to mail its agents send to people it does not recognize;
 *  - the always-trusted address list (chips, add/remove);
 *  - the free-text instructions the automatic reviewer follows.
 *
 * Plus one conditional notice: choosing the reviewer on an instance that has
 * none (`capabilities.emailReviewer` false) says so, in the spec's own words.
 *
 * It owns no network: the whole `settings` object is saved by the Policies
 * section's one Save, exactly as the other policy groups are.
 */

export const DEFAULT_EMAIL_SETTINGS: OrgEmailSettings = {
  inboundUnrecognized: 'reject',
  outboundUnrecognized: 'reject',
  trustedPatterns: [],
  judgePrompt: null,
};

/** Everything on the list editor's help line, minus the code example. */
const TRUSTED_HELP_LEAD = 'Mail from these addresses reaches your agents without approval. Use ';
const TRUSTED_HELP_TAIL = ' to trust everyone at a company.';

const TRUSTED_INVALID =
  'That address can’t be trusted as written. Use a whole address like dana@partner.example.com, or *@partner.example.com for everyone at a company.';

/** ≤50 entries is the server's cap; we say it in words rather than let it 400. */
const TRUSTED_MAX = 50;

export interface EmailPolicyProps {
  email: OrgEmailSettings;
  onChange: (next: OrgEmailSettings) => void;
  /**
   * A rejection the SERVER made on the last save (the client validates
   * optimistically, but the server is the authority and its words are shown as
   * they came). Routed to whichever control it concerns.
   */
  serverError?: string | null;
}

export function EmailPolicy({ email, onChange, serverError = null }: EmailPolicyProps) {
  const usesReviewer =
    email.inboundUnrecognized === 'judge' || email.outboundUnrecognized === 'judge';
  const reviewerAvailable = useCapabilities().emailReviewer;

  // The server's message is shown beside the control it is about; anything that
  // names the reviewer instructions belongs under the text box, the rest under
  // the address list (the only other thing with per-entry rules).
  const reviewerError = serverError && /judge|reviewer|prompt/i.test(serverError) ? serverError : null;
  const trustedError = serverError && !reviewerError ? serverError : null;

  return (
    <>
      {/* The Email subsection's own divider — Policies is one section, and these
          four controls read as a group within it. */}
      <div className="mt-2 flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-muted)]">
          Email
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--sparrow-border)]" />
      </div>

      <Panel>
        <PolicyGroup
          plain
          label="Email from people we don’t recognize"
          help="We recognize people in this workspace, addresses you’ve approved before, and the always-trusted addresses below."
        >
          <PolicyRadio
            name="email-inbound"
            checked={email.inboundUnrecognized === 'reject'}
            onChange={() => onChange({ ...email, inboundUnrecognized: 'reject' })}
            label="Reject it"
          />
          <PolicyRadio
            name="email-inbound"
            checked={email.inboundUnrecognized === 'approve'}
            onChange={() => onChange({ ...email, inboundUnrecognized: 'approve' })}
            label="Ask me to approve it"
          />
          <PolicyRadio
            name="email-inbound"
            checked={email.inboundUnrecognized === 'judge'}
            onChange={() => onChange({ ...email, inboundUnrecognized: 'judge' })}
            label="Let an automatic reviewer decide"
          />
        </PolicyGroup>
      </Panel>

      <Panel>
        <PolicyGroup plain label="Email your agents send to people we don’t recognize">
          <PolicyRadio
            name="email-outbound"
            checked={email.outboundUnrecognized === 'reject'}
            onChange={() => onChange({ ...email, outboundUnrecognized: 'reject' })}
            label="Don’t send it"
          />
          <PolicyRadio
            name="email-outbound"
            checked={email.outboundUnrecognized === 'approve'}
            onChange={() => onChange({ ...email, outboundUnrecognized: 'approve' })}
            label="Ask me to approve it"
          />
          <PolicyRadio
            name="email-outbound"
            checked={email.outboundUnrecognized === 'judge'}
            onChange={() => onChange({ ...email, outboundUnrecognized: 'judge' })}
            label="Let an automatic reviewer decide"
          />
        </PolicyGroup>
      </Panel>

      {/* The spec's notice, stated as fact: `capabilities.emailReviewer` says
          whether a judge is registered here, so choosing the reviewer on an
          instance without one is told plainly what will actually happen
          (mirroring the server's degrade-to-approve rule — never a silent
          allow, and never a lie in the UI). With a reviewer registered the
          notice would be false, so nothing renders. */}
      {usesReviewer && !reviewerAvailable && (
        <div
          role="note"
          className="rounded-xl border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] p-4 text-sm text-[var(--sparrow-muted)]"
        >
          No automatic reviewer is set up here, so these messages will wait for your approval
          instead.
        </div>
      )}

      <TrustedAddresses email={email} onChange={onChange} serverError={trustedError} />

      <Panel>
        <label
          htmlFor="email-judge-prompt"
          className="block text-sm font-medium text-[var(--sparrow-text)]"
        >
          What the automatic reviewer looks for
        </label>
        <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
          Describe in your own words what should be allowed and what shouldn’t. Only used when you
          choose ‘Let an automatic reviewer decide’.
        </p>
        <textarea
          id="email-judge-prompt"
          rows={4}
          value={email.judgePrompt ?? ''}
          onChange={(e) =>
            onChange({ ...email, judgePrompt: e.target.value.trim() ? e.target.value : null })
          }
          placeholder="e.g. Allow customer questions and delivery updates. Never allow anything asking for payment."
          className={`mt-2 ${inputClass}`}
        />
        <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
          Left empty, a sensible default is used.
        </p>
        {reviewerError && (
          <div className="mt-2">
            <ErrorText>{reviewerError}</ErrorText>
          </div>
        )}
      </Panel>
    </>
  );
}

function TrustedAddresses({
  email,
  onChange,
  serverError,
}: {
  email: OrgEmailSettings;
  onChange: (next: OrgEmailSettings) => void;
  serverError: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    const raw = draft.trim();
    if (!raw) return;
    const parsed = EmailTrustedPatternSchema.safeParse(raw);
    if (!parsed.success) {
      setError(TRUSTED_INVALID);
      return;
    }
    if (email.trustedPatterns.includes(parsed.data)) {
      setError('That address is already on the list.');
      return;
    }
    if (email.trustedPatterns.length >= TRUSTED_MAX) {
      setError(`You can trust up to ${TRUSTED_MAX} addresses.`);
      return;
    }
    onChange({ ...email, trustedPatterns: [...email.trustedPatterns, parsed.data] });
    setDraft('');
    setError(null);
  }

  function remove(pattern: string) {
    setError(null);
    onChange({
      ...email,
      trustedPatterns: email.trustedPatterns.filter((p) => p !== pattern),
    });
  }

  return (
    <Panel>
      <p className="text-sm font-medium text-[var(--sparrow-text)]">Always-trusted addresses</p>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        {TRUSTED_HELP_LEAD}
        <code className="mono rounded bg-[var(--sparrow-panel-2)] px-1 py-0.5">
          *@partner.example.com
        </code>
        {TRUSTED_HELP_TAIL}
      </p>

      {email.trustedPatterns.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {email.trustedPatterns.map((p) => (
            <li
              key={p}
              className="flex items-center gap-1.5 rounded-full border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] py-1 pl-2.5 pr-1.5"
            >
              <span className="mono text-xs text-[var(--sparrow-text)]">{p}</span>
              <button
                type="button"
                aria-label={`Remove ${p}`}
                onClick={() => remove(p)}
                className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--sparrow-faint)] transition-colors hover:bg-[var(--sparrow-panel)] hover:text-[var(--sparrow-danger)]"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label
        htmlFor="email-trusted-add"
        className="mt-3 block text-xs uppercase tracking-wider text-[var(--sparrow-faint)]"
      >
        Add a trusted address
      </label>
      <div className="mt-1.5 flex flex-wrap items-start gap-2">
        <input
          id="email-trusted-add"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="dana@partner.example.com"
          className={`mono min-w-0 flex-1 ${inputClass}`}
        />
        <button
          type="button"
          onClick={add}
          className="rounded-md border border-[var(--sparrow-border)] px-4 py-2.5 text-sm text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-accent)]"
        >
          Add
        </button>
      </div>
      {(error || serverError) && (
        <div className="mt-2">
          <ErrorText>{error ?? serverError}</ErrorText>
        </div>
      )}
    </Panel>
  );
}
