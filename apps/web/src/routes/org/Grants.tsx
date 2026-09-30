import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Grant } from '@sparrow-land/sdk/types';
import { api } from '../../lib/client.js';
import { useAuth } from '../../lib/auth.js';
import { canGrantTo, canRevokeGrant, forbiddenMessage, grantableScopes, normalizeTag } from '../agent/access.js';
import { ErrorText, Loading, Notice, Panel, Section, fmtDate, ghostBtn, inputClass, primaryBtn } from './ui.js';

/**
 * Org admin → **Grants** (SPEC.md, *Agent visibility*): every delegated grant in
 * the org. Any member may read the list, so it also renders for non-admins.
 * Revoke shows where the viewer may: org owners/admins, the grant's creator, or
 * the holder giving up their own. The form grants `tags:*` or `tag:<slug>` to a
 * human or an agent — org owners/admins any scope, `tags:*` holders `tag:<slug>`
 * only — never to yourself. The server enforces every rule; a `403` renders
 * inline.
 */

interface Principal {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

function scopeWhy(scope: string): string {
  if (scope === 'tags:*') return 'Can manage every tag, and grant one-tag access';
  if (scope.startsWith('tag:')) return `Can manage agents tagged ${scope.slice(4)}`;
  return scope;
}

/** Humans (roster) and agents (governance list for admins, else the visibility list), best-effort. */
function usePrincipals(orgId: string, isAdmin: boolean): Principal[] {
  const [humans, setHumans] = useState<Principal[]>([]);
  const [agents, setAgents] = useState<Principal[]>([]);
  useEffect(() => {
    let live = true;
    api
      .listOrgHumans(orgId, { limit: 100 })
      .then((res) => {
        if (live) setHumans(res.items.map((m) => ({ id: m.human.id, name: m.human.displayName, kind: 'human' })));
      })
      .catch(() => {});
    const agentList = isAdmin
      ? api.listOrgAgents(orgId).then((items) => items.map((i) => i.agent))
      : api.orgMeAgents(orgId).then((items) => items.map((i) => i.agent));
    agentList
      .then((items) => {
        if (live) setAgents(items.map((a) => ({ id: a.id, name: a.name, kind: 'agent' })));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [orgId, isAdmin]);
  return [...humans, ...agents];
}

export function GrantsSection({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const meId = useAuth().user?.id;
  const principals = usePrincipals(orgId, isAdmin);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .listGrants(orgId)
      .then((items) => {
        setGrants(items);
        setError(null);
      })
      .catch(() => setError('Couldn’t load the grants.'));
  }, [orgId]);
  useEffect(() => reload(), [reload]);

  const nameOf = (id: string) => principals.find((p) => p.id === id)?.name ?? id;
  const can = grants ? grantableScopes({ isAdmin, meId, grants }) : 'none';

  return (
    <Section
      id="grants"
      title="Grants"
      lead={
        <>
          Delegated authority over agents’ tags and messaging. <span className="mono">tag:&lt;slug&gt;</span>{' '}
          covers agents carrying that tag; <span className="mono">tags:*</span> covers every tag and can grant
          one-tag access to others. Nobody changes themselves.
        </>
      }
    >
      {!grants ? (
        <Panel>{error ? <ErrorText>{error}</ErrorText> : <Loading />}</Panel>
      ) : (
        <>
          {error ? <ErrorText>{error}</ErrorText> : null}
          {grants.length === 0 ? (
            <Notice>No grants yet. Only the agent’s owner and org admins can change its tags.</Notice>
          ) : (
            <ul aria-label="Grants" className="overflow-hidden rounded-xl border border-[var(--sparrow-border)]">
              {grants.map((g, i) => (
                <GrantItem
                  key={g.id}
                  orgId={orgId}
                  grant={g}
                  first={i === 0}
                  name={nameOf(g.principalId)}
                  grantedBy={nameOf(g.grantedBy)}
                  own={g.principalId === meId}
                  canRevoke={canRevokeGrant({ grant: g, isAdmin, meId, grants })}
                  onRevoked={reload}
                />
              ))}
            </ul>
          )}
          {can !== 'none' ? (
            <GrantForm
              orgId={orgId}
              scopes={can}
              existing={grants}
              principals={principals.filter((p) => canGrantTo({ isAdmin, meId, grants, principalId: p.id }))}
              onGranted={reload}
            />
          ) : null}
        </>
      )}
    </Section>
  );
}

function GrantItem({
  orgId,
  grant,
  first,
  name,
  grantedBy,
  own,
  canRevoke,
  onRevoked,
}: {
  orgId: string;
  grant: Grant;
  first: boolean;
  name: string;
  grantedBy: string;
  own: boolean;
  canRevoke: boolean;
  onRevoked: () => void;
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
      setError(forbiddenMessage(err, own ? 'Could not give it up.' : 'Could not revoke.'));
      setBusy(false);
    }
  }

  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--sparrow-panel)] p-3 ${
        first ? '' : 'border-t border-[var(--sparrow-border)]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--sparrow-text)]">
          <span>{name}</span>
          {own ? <span className="ml-1 text-xs font-normal text-[var(--sparrow-faint)]">(you)</span> : null}
          {grant.principalKind === 'agent' ? (
            <span className="ml-1.5 rounded-full border border-[color-mix(in_srgb,var(--sparrow-type-dm)_35%,transparent)] px-1.5 text-[11px] font-normal text-[var(--sparrow-type-dm)]">
              agent
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-[var(--sparrow-muted)]">
          {scopeWhy(grant.scope)} · granted by {grantedBy} · {fmtDate(grant.createdAt)}
        </p>
        {error ? <p className="text-xs text-[var(--sparrow-danger)]">{error}</p> : null}
      </div>
      <span className="mono shrink-0 rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-1.5 py-px text-xs text-[var(--sparrow-text)]">
        {grant.scope}
      </span>
      {canRevoke ? (
        <button
          type="button"
          className={ghostBtn}
          disabled={busy}
          onClick={() => void revoke()}
          aria-label={own ? `Give up ${grant.scope}` : `Revoke ${grant.scope} from ${name}`}
        >
          {busy ? (own ? 'Giving up…' : 'Revoking…') : own ? 'Give up' : 'Revoke'}
        </button>
      ) : null}
    </li>
  );
}

function GrantForm({
  orgId,
  scopes,
  existing,
  principals,
  onGranted,
}: {
  orgId: string;
  scopes: 'any' | 'tag';
  existing: Grant[];
  principals: Principal[];
  onGranted: () => void;
}) {
  const [who, setWho] = useState('');
  const [kind, setKind] = useState<'one' | 'all'>('one');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const all = scopes === 'any' && kind === 'all';
  const people = principals.filter((p) => p.kind === 'human');
  const agents = principals.filter((p) => p.kind === 'agent');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setDone(null);
    const target = principals.find((p) => p.id === who);
    if (!target) {
      setError('Choose who to grant it to.');
      return;
    }
    let scope = 'tags:*';
    if (!all) {
      const slug = normalizeTag(tag);
      if (!slug) {
        setError('Tags are lowercase letters, digits and hyphens (up to 32), starting with a letter or digit.');
        return;
      }
      scope = `tag:${slug}`;
    }
    setBusy(true);
    try {
      const g = await api.createGrant(orgId, { principalId: target.id, scope });
      const already = existing.some((x) => x.id === g.id);
      setDone(already ? `${target.name} already holds ${scope}.` : `Granted ${scope} to ${target.name}.`);
      setTag('');
      onGranted();
    } catch (err) {
      setError(forbiddenMessage(err, 'Could not grant access.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Grant access" onSubmit={(e) => void submit(e)} className="mt-3">
      <Panel>
        <p className="text-sm font-medium text-[var(--sparrow-text)]">Grant access</p>
        <p className="mt-0.5 text-xs text-[var(--sparrow-muted)]">
          {scopes === 'any'
            ? 'To a person or an agent. Agents start with none.'
            : 'You can grant one tag; only org owners and admins can grant tags:*.'}
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--sparrow-muted)]">
            Who
            <select
              aria-label="Who"
              value={who}
              onChange={(e) => setWho(e.target.value)}
              disabled={busy}
              className={inputClass}
            >
              <option value="">Choose…</option>
              {people.length > 0 ? (
                <optgroup label="People">
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {agents.length > 0 ? (
                <optgroup label="Agents">
                  {agents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.name} (agent)`}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          {scopes === 'any' ? (
            <div role="radiogroup" aria-label="Scope" className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--sparrow-text)]">
                <input
                  type="radio"
                  name="org-grant-kind"
                  checked={kind === 'one'}
                  onChange={() => setKind('one')}
                  className="mt-0.5 accent-[var(--sparrow-accent)]"
                />
                <span>
                  One tag
                  <span className="mt-0.5 block text-xs text-[var(--sparrow-faint)]">
                    Tag and untag agents with it, and set messaging on agents carrying it.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--sparrow-text)]">
                <input
                  type="radio"
                  name="org-grant-kind"
                  checked={kind === 'all'}
                  onChange={() => setKind('all')}
                  className="mt-0.5 accent-[var(--sparrow-accent)]"
                />
                <span>
                  Every tag <span className="mono text-xs">tags:*</span>
                  <span className="mt-0.5 block text-xs text-[var(--sparrow-faint)]">
                    Re-tag and silence any agent in the org, and grant one-tag access to others.
                  </span>
                </span>
              </label>
            </div>
          ) : null}
          {!all ? (
            <label className="flex flex-col gap-1 text-xs text-[var(--sparrow-muted)]">
              Tag
              <input
                type="text"
                aria-label="Tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                disabled={busy}
                placeholder="e.g. cubes"
                className={`${inputClass} mono`}
              />
            </label>
          ) : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
          {done ? (
            <p role="status" className="text-sm text-[var(--sparrow-good)]">
              {done}
            </p>
          ) : null}
          <div>
            <button type="submit" className={primaryBtn} disabled={busy}>
              {busy ? 'Granting…' : 'Grant'}
            </button>
          </div>
        </div>
      </Panel>
    </form>
  );
}
