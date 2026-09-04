import { useCallback, useEffect, useState } from 'react';
import type { ContactTrust, ExternalContact } from '@sparrow/common-types';
import { api } from '../../lib/client.js';
import { TrustPill } from '../../components/email/EmailBits.js';
import { ErrorText, Loading, Notice, Panel, Section, errMsg, fmtDate, inputClass } from './ui.js';

/**
 * Org admin → **Contacts** (SPEC v4 → *Web UI → Org admin*, rendered only with
 * `capabilities.email`): every external address the org's agents have ever
 * corresponded with, its durable trust, and who resolved it when — with approve
 * / block / reset-to-unknown actions.
 *
 * Trust here is the same durable state an approval creates; changing it is
 * FORWARD-LOOKING (already-delivered email is never withdrawn) and the copy says
 * so, because "block" reads like "undo" to most people and isn't.
 */

type Filter = 'all' | 'approved' | 'blocked' | 'unknown';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'approved', label: 'Approved' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'unknown', label: 'Unknown' },
];

export function ContactsSection({ orgId }: { orgId: string }) {
  const [contacts, setContacts] = useState<ExternalContact[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [needle, setNeedle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  // Typing searches, but not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setNeedle(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    try {
      const res = await api.listEmailContacts(orgId, {
        trust: filter === 'all' ? undefined : filter,
        q: needle || undefined,
        limit: 100,
      });
      setContacts(res.items);
      setError(null);
    } catch (err) {
      setError(errMsg(err, 'Could not load contacts.'));
      setContacts((prev) => prev ?? []);
    }
  }, [orgId, filter, needle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setTrust(c: ExternalContact, trust: ContactTrust | null) {
    if (busyId) return;
    setBusyId(c.id);
    setRowError((m) => {
      const next = { ...m };
      delete next[c.id];
      return next;
    });
    try {
      const updated = await api.updateEmailContact(orgId, c.id, trust);
      // Replaced in place rather than refetched: a row you just changed should
      // not vanish out from under the pointer because a filter no longer matches.
      setContacts((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      setRowError((m) => ({ ...m, [c.id]: errMsg(err, 'Could not change this contact.') }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section
      id="contacts"
      title="Contacts"
      lead="Every outside address your agents have exchanged email with. Changing trust only affects future email — anything already delivered stays delivered."
    >
      <Panel className="mb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                filter === f.id
                  ? 'border-[var(--sparrow-accent)] text-[var(--sparrow-accent)]'
                  : 'border-[var(--sparrow-border)] text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label
          htmlFor="contacts-search"
          className="mt-3 block text-xs uppercase tracking-wider text-[var(--sparrow-faint)]"
        >
          Search addresses
        </label>
        <input
          id="contacts-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="dana@"
          className={`mono mt-1.5 ${inputClass}`}
        />
      </Panel>

      {!contacts ? (
        <Panel>{error ? <ErrorText>{error}</ErrorText> : <Loading />}</Panel>
      ) : contacts.length === 0 ? (
        <Notice>
          {filter === 'all' && !needle
            ? 'No outside addresses yet.'
            : 'No contacts match that.'}
        </Notice>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--sparrow-border)]">
          {contacts.map((c, i) => (
            <div
              key={c.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 bg-[var(--sparrow-panel)] p-3 ${
                i > 0 ? 'border-t border-[var(--sparrow-border)]' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono truncate text-sm text-[var(--sparrow-text)]">
                    {c.email}
                  </span>
                  <TrustPill trust={c.trust} />
                </div>
                <p className="truncate text-xs text-[var(--sparrow-muted)]">
                  {c.displayName ? `${c.displayName} · ` : ''}
                  {c.trust && c.resolvedBy
                    ? `Set by ${c.resolvedBy.displayName}${
                        c.resolvedAt ? ` · ${fmtDate(c.resolvedAt)}` : ''
                      }`
                    : `First seen ${fmtDate(c.firstSeenAt)}`}
                </p>
                {rowError[c.id] && (
                  <p className="mt-1 text-xs text-[var(--sparrow-danger)]">{rowError[c.id]}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {c.trust !== 'approved' && (
                  <TrustButton
                    label="Approve"
                    aria={`Approve ${c.email}`}
                    busy={busyId === c.id}
                    onClick={() => void setTrust(c, 'approved')}
                  />
                )}
                {c.trust !== 'blocked' && (
                  <TrustButton
                    label="Block"
                    aria={`Block ${c.email}`}
                    danger
                    busy={busyId === c.id}
                    onClick={() => void setTrust(c, 'blocked')}
                  />
                )}
                {c.trust !== null && (
                  <TrustButton
                    label="Reset"
                    aria={`Reset ${c.email} to unknown`}
                    busy={busyId === c.id}
                    onClick={() => void setTrust(c, null)}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function TrustButton({
  label,
  aria,
  onClick,
  busy,
  danger = false,
}: {
  label: string;
  aria: string;
  onClick: () => void;
  busy: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      onClick={onClick}
      disabled={busy}
      className={`rounded-md border border-[var(--sparrow-border)] px-2.5 py-1 text-xs text-[var(--sparrow-muted)] transition-colors disabled:opacity-50 ${
        danger
          ? 'hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)]'
          : 'hover:border-[var(--sparrow-border-strong)] hover:text-[var(--sparrow-text)]'
      }`}
    >
      {label}
    </button>
  );
}
