import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Agent,
  AgentMessagingPolicy,
  Grant,
  HumanRef,
  OrgMembership,
  VisibilityAgent,
} from '@sparrow-land/sdk/types';
import { api } from '../../lib/client.js';
import {
  forbiddenMessage,
  grantCoversAgent,
  namesList,
  normalizeTag,
  reachability,
  tagSuggestions,
  type PolicyAgent,
} from './access.js';
import { TagChip } from './TagChip.js';

/** At most this many tags per agent (SPEC.md, *Agent visibility*). */
const TAGS_MAX = 10;

/**
 * The agent page's **Access** tab: the agent's tags, its messaging
 * policy with a reachability preview, who may change them, and the grants the
 * agent itself holds (with the grant form for org owners/admins).
 *
 * Rendered only for viewers with authority over the agent (owner, org
 * owners/admins, holders of a grant covering one of its tags). The server
 * enforces every guard rail; a `403` renders inline in plain words.
 */
export function AccessTab({
  orgId,
  agent,
  owner,
  isAdmin,
  grants,
  visibleAgents,
  onAgentChanged,
  onGrantsChanged,
}: {
  orgId: string;
  agent: { id: string; name: string; tags: string[]; messaging: AgentMessagingPolicy };
  owner: HumanRef;
  isAdmin: boolean;
  grants: Grant[];
  /** The caller's visibility list — the org's agents as far as this viewer can see. */
  visibleAgents: VisibilityAgent[];
  /** A PUT returned the updated agent resource. */
  onAgentChanged: (agent: Agent) => void;
  onGrantsChanged: () => void;
}) {
  const roster = useRoster(orgId);
  const orgAgents = useOrgAgents(orgId, isAdmin, visibleAgents);

  const nameOf = useCallback(
    (id: string) =>
      roster.find((m) => m.human.id === id)?.human.displayName ??
      orgAgents.find((a) => a.id === id)?.name ??
      (id === owner.id ? owner.displayName : id),
    [roster, orgAgents, owner],
  );

  const orgTags = useMemo(
    () => [...new Set([...orgAgents.flatMap((a) => a.tags), ...agent.tags])].sort(),
    [orgAgents, agent.tags],
  );

  return (
    <div className="space-y-8">
      <TagsEditor
        orgId={orgId}
        agentId={agent.id}
        tags={agent.tags}
        orgTagSets={orgAgents.map((a) => a.tags)}
        onChanged={onAgentChanged}
      />
      <MessagingControl
        orgId={orgId}
        agent={agent}
        others={orgAgents}
        wholeOrg={isAdmin}
        onChanged={onAgentChanged}
      />
      <WhoCanChange
        orgId={orgId}
        agent={agent}
        owner={owner}
        roster={roster}
        grants={grants}
        isAdmin={isAdmin}
        orgTags={orgTags}
        nameOf={nameOf}
        onGrantsChanged={onGrantsChanged}
      />
    </div>
  );
}

/** The org roster (first page, 100 — enough to name admins and grant holders). */
function useRoster(orgId: string): OrgMembership[] {
  const [roster, setRoster] = useState<OrgMembership[]>([]);
  useEffect(() => {
    let live = true;
    api
      .listOrgHumans(orgId, { limit: 100 })
      .then((res) => {
        if (live) setRoster(res.items);
      })
      .catch(() => {
        if (live) setRoster([]);
      });
    return () => {
      live = false;
    };
  }, [orgId]);
  return roster;
}

/**
 * Every org agent this viewer can know about, with tags and policy: the
 * visibility list, plus (for org owners/admins only — it is an admin route)
 * the governance list of ALL org agents. Used for the reachability preview and
 * tag suggestions; a non-admin's are limited to the agents they can see.
 */
function useOrgAgents(orgId: string, isAdmin: boolean, visible: VisibilityAgent[]): PolicyAgent[] {
  const [governance, setGovernance] = useState<PolicyAgent[]>([]);
  useEffect(() => {
    if (!isAdmin) {
      setGovernance([]);
      return;
    }
    let live = true;
    api
      .listOrgAgents(orgId)
      .then((items) => {
        if (live) {
          setGovernance(
            items.map((i) => ({
              id: i.agent.id,
              name: i.agent.name,
              tags: i.agent.tags,
              messaging: i.agent.messaging,
            })),
          );
        }
      })
      .catch(() => {
        if (live) setGovernance([]);
      });
    return () => {
      live = false;
    };
  }, [orgId, isAdmin]);
  return useMemo(() => {
    const byId = new Map<string, PolicyAgent>();
    for (const g of governance) byId.set(g.id, g);
    for (const v of visible) {
      byId.set(v.agent.id, {
        id: v.agent.id,
        name: v.agent.name,
        tags: v.agent.tags ?? [],
        messaging: v.agent.messaging ?? 'any',
      });
    }
    return [...byId.values()];
  }, [governance, visible]);
}

const inputShell =
  'flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-2 py-1.5 transition-colors focus-within:border-[var(--sparrow-accent)]';

function TagsEditor({
  orgId,
  agentId,
  tags,
  orgTagSets,
  onChanged,
}: {
  orgId: string;
  agentId: string;
  tags: string[];
  orgTagSets: readonly (readonly string[])[];
  onChanged: (agent: Agent) => void;
}) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestions = useMemo(
    () => tagSuggestions(orgTagSets, tags, value).slice(0, 8),
    [orgTagSets, tags, value],
  );
  const full = tags.length >= TAGS_MAX;

  async function save(next: string[]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.putAgentTags(orgId, agentId, [...next].sort());
      onChanged(res.agent);
    } catch (err) {
      setError(forbiddenMessage(err, 'Could not update the tags.'));
    } finally {
      setBusy(false);
    }
  }

  function add(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) {
      setError('Tags are lowercase letters, digits and hyphens (up to 32), starting with a letter or digit.');
      return;
    }
    setValue('');
    setOpen(false);
    if (tags.includes(tag)) return;
    void save([...tags, tag]);
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Tags</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        Labels everyone in the org can see. Messaging and grants refer to them.
      </p>
      <div className={`mt-3 ${inputShell}`}>
        {tags.map((t) => (
          <TagChip key={t} tag={t}>
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              disabled={busy}
              onClick={() => void save(tags.filter((x) => x !== t))}
              className="ml-0.5 px-1 font-sans text-[var(--sparrow-faint)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
            >
              ×
            </button>
          </TagChip>
        ))}
        <input
          role="combobox"
          aria-label="Add a tag"
          aria-expanded={open && suggestions.length > 0}
          aria-controls="agent-tag-suggestions"
          aria-autocomplete="list"
          value={value}
          disabled={busy || full}
          placeholder={full ? `At most ${TAGS_MAX} tags` : 'Add a tag…'}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            setError(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (value.trim()) add(value);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-[var(--sparrow-text)] outline-none placeholder:text-[var(--sparrow-faint)]"
        />
      </div>
      {open && suggestions.length > 0 ? (
        <ul
          id="agent-tag-suggestions"
          role="listbox"
          aria-label="Tags used in this org"
          className="mt-2 overflow-hidden rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)]"
        >
          {suggestions.map((s) => (
            <li
              key={s}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(s)}
              className="mono cursor-pointer px-3 py-1.5 text-sm text-[var(--sparrow-text)] hover:bg-[var(--sparrow-panel)]"
            >
              {s}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </section>
  );
}

function policyOptions(name: string, tags: string[]) {
  const tagHint =
    tags.length === 0
      ? 'It has no tags yet, so this blocks every agent DM.'
      : `Agents tagged ${tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(', ')} or ${tags[tags.length - 1]}`}.`;
  return [
    { value: 'any' as const, label: 'Any agent it has met', hint: 'Any agent it has shared a room with.', isDefault: true },
    { value: 'tags' as const, label: 'Only agents that share a tag', hint: tagHint, isDefault: false },
    {
      value: 'none' as const,
      label: 'No agent DMs',
      hint: `${name} can still DM people and post in rooms.`,
      isDefault: false,
    },
  ];
}

function MessagingControl({
  orgId,
  agent,
  others,
  wholeOrg,
  onChanged,
}: {
  orgId: string;
  agent: { id: string; name: string; tags: string[]; messaging: AgentMessagingPolicy };
  others: PolicyAgent[];
  /**
   * `others` is every agent in the org (admins read the governance list). A
   * non-admin only knows the agents they can see, and the preview says so.
   */
  wholeOrg: boolean;
  onChanged: (agent: Agent) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: AgentMessagingPolicy) {
    if (busy || next === agent.messaging) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.putAgentMessaging(orgId, agent.id, next);
      onChanged(res.agent);
    } catch (err) {
      setError(forbiddenMessage(err, 'Could not change messaging.'));
    } finally {
      setBusy(false);
    }
  }

  const preview = reachability(agent, others);
  const count = preview.reachable.length;

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Messaging</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        Which agents {agent.name} may DM. Rooms and messages to people are never restricted.
      </p>
      <fieldset className="mt-3 space-y-2" aria-label="Messaging" disabled={busy}>
        {policyOptions(agent.name, agent.tags).map((opt) => {
          const active = opt.value === agent.messaging;
          return (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                active
                  ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-panel-2)]'
                  : 'border-[var(--sparrow-border)] hover:border-[var(--sparrow-accent-2)]'
              }`}
            >
              <input
                type="radio"
                name="agent-messaging"
                value={opt.value}
                checked={active}
                onChange={() => void choose(opt.value)}
                className="mt-0.5 accent-[var(--sparrow-accent)]"
              />
              <span className="flex flex-col">
                <span className="text-sm text-[var(--sparrow-text)]">
                  {opt.label}
                  {opt.isDefault ? (
                    <span className="ml-1.5 text-[11px] text-[var(--sparrow-faint)]">default</span>
                  ) : null}
                </span>
                <span className="text-xs text-[var(--sparrow-faint)]">{opt.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
      <div
        aria-live="polite"
        className="mt-2.5 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3 py-2.5 text-xs text-[var(--sparrow-muted)]"
      >
        <b className="font-semibold text-[var(--sparrow-text)]">
          {`Can DM ${count} ${count === 1 ? 'agent' : 'agents'}${wholeOrg ? '' : ' among those you can see'}${count > 0 ? ':' : '.'}`}
        </b>
        {count > 0 ? ` ${namesList(preview.reachable)}.` : null}
        {agent.messaging === 'any' && count > 0 ? ' Once they have shared a room.' : null}
        {preview.blocked.length > 0 ? (
          <>
            <br />
            <b className="font-semibold text-[var(--sparrow-text)]">Now blocked:</b>{' '}
            {`${namesList(preview.blocked)}.`}
          </>
        ) : null}{' '}
        Existing threads stay readable. The other agent’s setting must allow it too.
      </div>
    </section>
  );
}

function scopeWhy(scope: string): string {
  if (scope === 'tags:*') return 'Can manage every tag';
  if (scope.startsWith('tag:')) return `Can manage agents tagged ${scope.slice(4)}`;
  return scope;
}

const listClass =
  'mt-2 divide-y divide-[var(--sparrow-border)] overflow-hidden rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)]';

function ScopePill({ scope }: { scope: string }) {
  return (
    <span className="mono shrink-0 rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-1.5 py-px text-xs text-[var(--sparrow-text)]">
      {scope}
    </span>
  );
}

function AgentKind() {
  return (
    <span className="ml-1.5 rounded-full border border-[color-mix(in_srgb,var(--sparrow-type-dm)_35%,transparent)] px-1.5 text-[11px] text-[var(--sparrow-type-dm)]">
      agent
    </span>
  );
}

function WhoCanChange({
  orgId,
  agent,
  owner,
  roster,
  grants,
  isAdmin,
  orgTags,
  nameOf,
  onGrantsChanged,
}: {
  orgId: string;
  agent: { id: string; name: string; tags: string[] };
  owner: HumanRef;
  roster: OrgMembership[];
  /** Every tag this page knows of in the org — what an admin can grant as `tag:<slug>`. */
  orgTags: string[];
  grants: Grant[];
  isAdmin: boolean;
  nameOf: (id: string) => string;
  onGrantsChanged: () => void;
}) {
  const admins = roster.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.human.displayName);
  const covering = grants.filter((g) => g.principalId !== agent.id && grantCoversAgent(g.scope, agent.tags));
  const held = grants.filter((g) => g.principalId === agent.id);

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Who can change this</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        People and agents allowed to edit these tags and this messaging setting.
      </p>
      <ul aria-label="Who can change this" className={listClass}>
        <li className="px-3 py-2.5">
          <span className="block text-sm text-[var(--sparrow-text)]">{owner.displayName}</span>
          <span className="block text-xs text-[var(--sparrow-faint)]">Owner</span>
        </li>
        <li className="px-3 py-2.5">
          <span className="block text-sm text-[var(--sparrow-text)]">Org admins</span>
          {admins.length > 0 ? (
            <span className="block text-xs text-[var(--sparrow-faint)]">{admins.join(', ')}</span>
          ) : null}
        </li>
        {covering.map((g) => (
          <GrantRow key={g.id} orgId={orgId} grant={g} name={nameOf(g.principalId)} canRevoke={isAdmin} onRevoked={onGrantsChanged} />
        ))}
      </ul>

      <h2 className="mt-6 text-sm font-semibold text-[var(--sparrow-text)]">Grants this agent holds</h2>
      {held.length === 0 ? (
        <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
          None. {agent.name} can’t change other agents.
          {isAdmin ? '' : ' Only org owners and admins can grant.'}
        </p>
      ) : (
        <ul aria-label="Grants this agent holds" className={listClass}>
          {held.map((g) => (
            <GrantRow key={g.id} orgId={orgId} grant={g} name={agent.name} canRevoke={isAdmin} onRevoked={onGrantsChanged} held />
          ))}
        </ul>
      )}
      {isAdmin ? (
        <GrantForm orgId={orgId} agent={agent} orgTags={orgTags} onGranted={onGrantsChanged} />
      ) : null}
    </section>
  );
}

function GrantRow({
  orgId,
  grant,
  name,
  canRevoke,
  onRevoked,
  held = false,
}: {
  orgId: string;
  grant: Grant;
  name: string;
  canRevoke: boolean;
  onRevoked: () => void;
  held?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteGrant(orgId, grant.id);
      onRevoked();
    } catch (err) {
      setError(forbiddenMessage(err, 'Could not revoke.'));
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-[var(--sparrow-text)]">
          {held ? scopeWhy(grant.scope) : name}
          {!held && grant.principalKind === 'agent' ? <AgentKind /> : null}
        </span>
        {!held ? <span className="block text-xs text-[var(--sparrow-faint)]">{scopeWhy(grant.scope)}</span> : null}
        {error ? <span className="block text-xs text-[var(--sparrow-danger)]">{error}</span> : null}
      </span>
      <ScopePill scope={grant.scope} />
      {canRevoke ? (
        <button
          type="button"
          onClick={() => void revoke()}
          disabled={busy}
          aria-label={`Revoke ${grant.scope} from ${name}`}
          className="shrink-0 rounded border border-[var(--sparrow-border-strong)] px-2 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
        >
          {busy ? 'Revoking…' : 'Revoke'}
        </button>
      ) : null}
    </li>
  );
}

/**
 * Org owners/admins grant this agent `tag:<slug>` or `tags:*`. Agents start with
 * no grants; the form says in one line what `tags:*` lets the agent do.
 */
function GrantForm({
  orgId,
  agent,
  orgTags,
  onGranted,
}: {
  orgId: string;
  agent: { id: string; name: string };
  orgTags: string[];
  onGranted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'one' | 'all'>('one');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenTag = orgTags.includes(tag) ? tag : (orgTags[0] ?? '');
  const scope = kind === 'all' ? 'tags:*' : chosenTag ? `tag:${chosenTag}` : null;

  async function grant() {
    if (busy || !scope) return;
    setBusy(true);
    setError(null);
    try {
      await api.createGrant(orgId, { principalId: agent.id, scope });
      setOpen(false);
      setKind('one');
      onGranted();
    } catch (err) {
      setError(forbiddenMessage(err, 'Could not grant access.'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
        className="mt-3 inline-flex min-h-[40px] items-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)]"
      >
        Grant access…
      </button>
    );
  }

  const card = (active: boolean) =>
    `flex items-start gap-3 rounded-md border px-3 py-2.5 transition-colors ${
      active
        ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-panel-2)]'
        : 'border-[var(--sparrow-border)] hover:border-[var(--sparrow-accent-2)]'
    }`;

  return (
    <div className="mt-3 rounded-lg border border-[var(--sparrow-accent)] bg-[var(--sparrow-panel)] p-4">
      <div className="text-sm font-semibold text-[var(--sparrow-text)]">Grant {agent.name} access to…</div>
      <p className="mt-0.5 text-xs text-[var(--sparrow-muted)]">Agents start with none. Only org owners and admins can grant.</p>
      <fieldset className="mt-2.5 space-y-2" aria-label="Grant scope" disabled={busy}>
        <div className={card(kind === 'one')}>
          <label className="flex flex-1 cursor-pointer items-start gap-3">
            <input
              type="radio"
              name="grant-kind"
              checked={kind === 'one'}
              onChange={() => setKind('one')}
              disabled={orgTags.length === 0}
              className="mt-0.5 accent-[var(--sparrow-accent)]"
            />
            <span className="flex flex-col">
              <span className="text-sm text-[var(--sparrow-text)]">One tag</span>
              <span className="text-xs text-[var(--sparrow-faint)]">
                {orgTags.length === 0
                  ? 'No agent in the org has a tag yet.'
                  : 'Tag and untag agents with it, and set their messaging.'}
              </span>
            </span>
          </label>
          {orgTags.length > 0 ? (
            <select
              aria-label="Tag to grant"
              value={chosenTag}
              onChange={(e) => {
                setTag(e.target.value);
                setKind('one');
              }}
              className="mono shrink-0 rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-1.5 py-0.5 text-xs text-[var(--sparrow-text)]"
            >
              {orgTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <label className={`${card(kind === 'all')} cursor-pointer`}>
          <input
            type="radio"
            name="grant-kind"
            checked={kind === 'all'}
            onChange={() => setKind('all')}
            className="mt-0.5 accent-[var(--sparrow-accent)]"
          />
          <span className="flex flex-col">
            <span className="text-sm text-[var(--sparrow-text)]">
              Every tag <ScopePill scope="tags:*" />
            </span>
            <span className="text-xs text-[var(--sparrow-faint)]">
              The same for all tags, and it can give one-tag access to others.
            </span>
          </span>
        </label>
      </fieldset>
      {kind === 'all' ? (
        <div className="mt-3 flex gap-2 rounded-md bg-[var(--sparrow-accent-soft)] px-3 py-2 text-sm text-[var(--sparrow-accent-2)]">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="mt-[3px] shrink-0">
            <path d="M8 1.8 15 14H1z" strokeLinejoin="round" />
            <path d="M8 6.5v3.5M8 11.8v.4" strokeLinecap="round" />
          </svg>
          <span>{agent.name} will be able to re-tag and silence any agent in the org. It can never change itself.</span>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void grant()}
          disabled={busy || !scope}
          className="inline-flex min-h-[40px] items-center rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Granting…' : scope ? `Grant ${scope}` : 'Grant'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="inline-flex min-h-[40px] items-center rounded-md border border-[var(--sparrow-border)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
