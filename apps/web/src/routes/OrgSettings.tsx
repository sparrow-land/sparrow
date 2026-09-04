import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  CreateInviteResponse,
  EnrollmentSummary,
  Invite,
  OrgAgentGovernance,
  OrgMembership,
  OrgRole,
  OrgSettings as OrgSettingsShape,
} from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api } from '../lib/client.js';
import { useAuth } from '../lib/auth.js';
import { useOrg } from '../lib/org.js';
import { useCapabilities } from '../lib/capabilities.js';
import { Terminal } from '../components/Terminal.js';
import { InviteByEmail } from '../components/InviteByEmail.js';
import {
  ErrorText,
  Loading,
  Notice,
  Panel,
  PolicyGroup,
  PolicyRadio,
  Saved,
  Section,
  errMsg,
  fmtDate,
  ghostBtn,
  inputClass,
  primaryBtn,
} from './org/ui.js';
import { DEFAULT_EMAIL_SETTINGS, EmailPolicy } from './org/EmailPolicy.js';
import { OrgEmailApprovals } from './org/EmailApprovals.js';
import { ContactsSection } from './org/Contacts.js';
import { RoomsSection } from './org/Rooms.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/**
 * Org admin (`/org/:orgId/admin`, owners/admins) — the org-wide management
 * surface, rendered inside the app shell's main pane. A scrollable, single-column
 * panel with anchored subsections: Org (name/slug), Policies (who can invite / how
 * people and agents join / who can create rooms), People (the member roster with
 * role + remove), Agents (the governance list), Approvals (EVERY pending
 * enrollment, org-wide), and Invites (ALL outstanding links with revoke + a create
 * action). The personal approval view lives separately at `/me/approvals`.
 *
 * All copy is written for non-technical humans — no route names, no env vars.
 */
export function OrgSettings() {
  const { orgId, role, isAdmin, name: orgName } = useOrg();
  const { email: emailOn } = useCapabilities();
  useDocumentTitle(pageTitle('Org admin', orgName));
  /**
   * Bumped whenever an enrollment is resolved. Approving an agent CREATES it, so
   * the Agents list directly above the Approvals block would otherwise sit stale
   * until a manual page reload (the sidebar, fed by `/me/events`, updated live —
   * which made the admin page look broken).
   */
  const [agentsEpoch, setAgentsEpoch] = useState(0);

  if (!isAdmin) {
    return (
      <Scroll>
        <Header />
        <Notice className="mt-6">You don&rsquo;t have access to org admin.</Notice>
      </Scroll>
    );
  }

  return (
    <Scroll>
      <Header />
      <div className="mt-8 flex flex-col gap-10">
        <OrganizationSection orgId={orgId} />
        <PoliciesSection orgId={orgId} emailOn={emailOn} />
        <PeopleSection orgId={orgId} callerRole={role} />
        <RoomsSection orgId={orgId} />
        <AgentsSection orgId={orgId} emailOn={emailOn} reloadKey={agentsEpoch} />
        <ApprovalsSection
          orgId={orgId}
          emailOn={emailOn}
          onResolved={() => setAgentsEpoch((n) => n + 1)}
        />
        {emailOn && <ContactsSection orgId={orgId} />}
        <InvitesSection orgId={orgId} />
      </div>
    </Scroll>
  );
}

/* ========================================================================== *
 * Layout + shared bits
 * ========================================================================== */

function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">{children}</div>
    </div>
  );
}

function Header() {
  const { name } = useOrg();
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Org admin</h1>
      <p className="mt-1 truncate text-sm text-[var(--sparrow-muted)]">
        Org-wide management for {name || 'your organization'}.
      </p>
    </div>
  );
}

function RolePill({ role }: { role: OrgRole }) {
  const styles: Record<OrgRole, string> = {
    owner: 'bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-accent)]',
    admin: 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-text)]',
    member: 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-muted)]',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${styles[role]}`}>
      {role}
    </span>
  );
}

/* ========================================================================== *
 * Organization (name + slug)
 * ========================================================================== */

function OrganizationSection({ orgId }: { orgId: string }) {
  const { refreshOrgs } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const baseline = useRef<{ name: string; slug: string }>({ name: '', slug: '' });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getOrg(orgId)
      .then((org) => {
        if (cancelled) return;
        baseline.current = { name: org.name, slug: org.slug };
        setName(org.name);
        setSlug(org.slug);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errMsg(err, 'Could not load your organization.'));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const dirty = name.trim() !== baseline.current.name || slug.trim() !== baseline.current.slug;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const patch: { name?: string; slug?: string } = {};
    if (name.trim() !== baseline.current.name) patch.name = name.trim();
    if (slug.trim() !== baseline.current.slug) patch.slug = slug.trim();
    try {
      const org = await api.updateOrg(orgId, patch);
      baseline.current = { name: org.name, slug: org.slug };
      setName(org.name);
      setSlug(org.slug);
      setSaved(true);
      void refreshOrgs();
    } catch (err) {
      setError(errMsg(err, 'Could not save changes.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="organization" title="Organization" lead="Your organization's name and web address.">
      <Panel>
        <form onSubmit={onSubmit}>
          <label htmlFor="org-name" className="block text-xs uppercase tracking-wider text-[var(--sparrow-faint)]">
            Name
          </label>
          <input
            id="org-name"
            value={name}
            disabled={!loaded}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            className={`mt-1.5 ${inputClass}`}
            placeholder="Acme Inc."
          />

          <label
            htmlFor="org-slug"
            className="mt-4 block text-xs uppercase tracking-wider text-[var(--sparrow-faint)]"
          >
            Web address
          </label>
          <input
            id="org-slug"
            value={slug}
            disabled={!loaded}
            onChange={(e) => {
              setSlug(e.target.value);
              setSaved(false);
            }}
            className={`mono mt-1.5 ${inputClass}`}
            placeholder="acme"
          />
          <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
            Lowercase letters, numbers, and hyphens only. Until you set it yourself, the address
            follows the name — renaming the organization updates it. Once you type one, it stays
            put.
          </p>

          <div className="mt-4 flex items-center gap-3">
            <button type="submit" disabled={!dirty || busy || !loaded} className={primaryBtn}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            {saved && !dirty && <Saved />}
            {error && <ErrorText>{error}</ErrorText>}
          </div>
        </form>
      </Panel>
    </Section>
  );
}

/* ========================================================================== *
 * Policies
 * ========================================================================== */

function PoliciesSection({ orgId, emailOn }: { orgId: string; emailOn: boolean }) {
  const [settings, setSettings] = useState<OrgSettingsShape | null>(null);
  const baseline = useRef<OrgSettingsShape | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A `400` from the settings save is never about the radio groups (they cannot
   * hold an invalid value) — it is about one of the email fields, which carry
   * per-entry rules. It is routed to the control it concerns, in the server's
   * own words, rather than shown as a generic failure.
   */
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getOrg(orgId)
      .then((org) => {
        if (cancelled) return;
        baseline.current = org.settings;
        setSettings(org.settings);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errMsg(err, 'Could not load your policies.'));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const dirty = useMemo(() => {
    if (!settings || !baseline.current) return false;
    return JSON.stringify(settings) !== JSON.stringify(baseline.current);
  }, [settings]);

  function edit(mut: (s: OrgSettingsShape) => OrgSettingsShape) {
    setSaved(false);
    setFieldError(null);
    setSettings((s) => (s ? mut(s) : s));
  }

  async function save() {
    if (!settings || !dirty || busy) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    setSaved(false);
    try {
      const org = await api.updateOrg(orgId, { settings });
      baseline.current = org.settings;
      setSettings(org.settings);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setFieldError(err.message);
      else setError(errMsg(err, 'Could not save your policies.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="policies"
      title="Policies"
      lead={
        emailOn
          ? 'Decide who can invite people, how agents join, who can create rooms, and what happens to email from outside. People you invite join as soon as they open their invite link.'
          : 'Decide who can invite people, how agents join, and who can create rooms. People you invite join as soon as they open their invite link.'
      }
    >
      {!settings ? (
        <Panel>
          {error ? <ErrorText>{error}</ErrorText> : <Loading />}
        </Panel>
      ) : (
        <div className="flex flex-col gap-3">
          <Panel>
            <PolicyGroup label="Inviting people">
              <PolicyRadio
                name="invites-who"
                checked={settings.invites.who === 'members'}
                onChange={() => edit((s) => ({ ...s, invites: { ...s.invites, who: 'members' } }))}
                label="Anyone can invite"
              />
              <PolicyRadio
                name="invites-who"
                checked={settings.invites.who === 'admins'}
                onChange={() => edit((s) => ({ ...s, invites: { ...s.invites, who: 'admins' } }))}
                label="Only admins can invite"
              />
            </PolicyGroup>
          </Panel>

          <Panel>
            <PolicyGroup label="When agents join">
              <PolicyRadio
                name="enroll-agents"
                checked={settings.enroll.agents === 'approval'}
                onChange={() =>
                  edit((s) => ({ ...s, enroll: { ...s.enroll, agents: 'approval' } }))
                }
                label="Review each agent"
              />
              <PolicyRadio
                name="enroll-agents"
                checked={settings.enroll.agents === 'open'}
                onChange={() => edit((s) => ({ ...s, enroll: { ...s.enroll, agents: 'open' } }))}
                label="Add agents instantly"
              />
            </PolicyGroup>
          </Panel>

          <Panel>
            <PolicyGroup label="Creating rooms">
              <PolicyRadio
                name="rooms-create"
                checked={settings.rooms.create === 'members'}
                onChange={() => edit((s) => ({ ...s, rooms: { ...s.rooms, create: 'members' } }))}
                label="Anyone can create rooms"
              />
              <PolicyRadio
                name="rooms-create"
                checked={settings.rooms.create === 'admins'}
                onChange={() => edit((s) => ({ ...s, rooms: { ...s.rooms, create: 'admins' } }))}
                label="Only admins can create rooms"
              />
            </PolicyGroup>
          </Panel>

          {emailOn && (
            <EmailPolicy
              email={settings.email ?? DEFAULT_EMAIL_SETTINGS}
              onChange={(email) => edit((s) => ({ ...s, email }))}
              serverError={fieldError}
            />
          )}

          <div className="flex items-center gap-3">
            <button onClick={() => void save()} disabled={!dirty || busy} className={primaryBtn}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            {saved && !dirty && <Saved />}
            {error && <ErrorText>{error}</ErrorText>}
          </div>
        </div>
      )}
    </Section>
  );
}

/* ========================================================================== *
 * People (member roster)
 * ========================================================================== */

function PeopleSection({ orgId, callerRole }: { orgId: string; callerRole: OrgRole }) {
  const [members, setMembers] = useState<OrgMembership[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api
      .listOrgHumans(orgId)
      .then((res) => setMembers(res.items))
      .catch((err: unknown) => setError(errMsg(err, 'Could not load members.')));
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  function setError1(id: string, msg: string | null) {
    setRowError((m) => {
      const next = { ...m };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  }

  async function changeRole(m: OrgMembership, role: OrgRole) {
    setError1(m.human.id, null);
    try {
      await api.setOrgRole(orgId, m.human.id, role);
      load();
    } catch (err) {
      setError1(
        m.human.id,
        err instanceof ApiError && err.status === 409
          ? 'An organization must keep at least one owner.'
          : errMsg(err, 'Could not change this role.'),
      );
    }
  }

  async function remove(m: OrgMembership) {
    setError1(m.human.id, null);
    try {
      await api.removeOrgHuman(orgId, m.human.id);
      load();
    } catch (err) {
      setError1(
        m.human.id,
        err instanceof ApiError && err.status === 409
          ? 'You can’t remove them yet — an organization must keep at least one owner, and people who own agents must have those removed first.'
          : errMsg(err, 'Could not remove this person.'),
      );
    }
  }

  return (
    <Section id="people" title="People" lead="Everyone in your organization.">
      <Panel className="mb-3">
        <InviteByEmail orgId={orgId} onInvited={() => load()} />
      </Panel>
      {!members ? (
        <Panel>{error ? <ErrorText>{error}</ErrorText> : <Loading />}</Panel>
      ) : members.length === 0 ? (
        <Notice>No people yet.</Notice>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--sparrow-border)]">
          {members.map((m, i) => {
            const options = roleOptionsFor(callerRole, m.role);
            return (
              <div
                key={m.human.id}
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 bg-[var(--sparrow-panel)] p-3 ${
                  i > 0 ? 'border-t border-[var(--sparrow-border)]' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--sparrow-text)]">
                      {m.human.displayName}
                    </span>
                    <RolePill role={m.role} />
                  </div>
                  <p className="truncate text-xs text-[var(--sparrow-muted)]">{m.human.email}</p>
                  {rowError[m.human.id] && (
                    <p className="mt-1 text-xs text-[var(--sparrow-danger)]">{rowError[m.human.id]}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {options.length > 1 ? (
                    <select
                      aria-label={`Role for ${m.human.displayName}`}
                      value={m.role}
                      onChange={(e) => void changeRole(m, e.target.value as OrgRole)}
                      className="rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-2 py-1 text-xs text-[var(--sparrow-text)] outline-none focus:border-[var(--sparrow-accent)]"
                    >
                      {options.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {canRemove(callerRole, m.role) && (
                    <button
                      type="button"
                      onClick={() => void remove(m)}
                      className="rounded-md border border-[var(--sparrow-border)] px-2.5 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)]"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/**
 * The role choices this caller may set on a member. Owners may set any role.
 * Admins may only move people between member and admin — never owners, never
 * to/from owner. A single-option result means the control is hidden.
 */
function roleOptionsFor(caller: OrgRole, target: OrgRole): OrgRole[] {
  if (caller === 'owner') return ['owner', 'admin', 'member'];
  if (caller === 'admin' && target !== 'owner') return ['admin', 'member'];
  return [target];
}

function canRemove(caller: OrgRole, target: OrgRole): boolean {
  if (caller === 'owner') return true;
  // Admins can remove members and admins, but not owners.
  return caller === 'admin' && target !== 'owner';
}

/* ========================================================================== *
 * Agents (governance list)
 * ========================================================================== */

function AgentsSection({
  orgId,
  emailOn,
  reloadKey,
}: {
  orgId: string;
  emailOn: boolean;
  /** Any change refetches the list (an approval just created an agent). */
  reloadKey: number;
}) {
  const [agents, setAgents] = useState<OrgAgentGovernance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listOrgAgents(orgId)
      .then((items) => {
        if (!cancelled) setAgents(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errMsg(err, 'Could not load agents.'));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadKey]);

  return (
    <Section id="agents" title="Agents" lead="Every agent in your organization and who owns it.">
      {!agents ? (
        <Panel>{error ? <ErrorText>{error}</ErrorText> : <Loading />}</Panel>
      ) : agents.length === 0 ? (
        <Notice>No agents yet.</Notice>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--sparrow-border)]">
          {agents.map((a, i) => (
            <div
              key={a.agent.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--sparrow-panel)] p-3 ${
                i > 0 ? 'border-t border-[var(--sparrow-border)]' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium text-[var(--sparrow-text)]">
                  {a.agent.name}
                </span>
                {/* The address column. `emailAddress` is null with the medium
                    off — and with the medium off the column does not exist at
                    all, placeholder included. */}
                {emailOn && a.agent.emailAddress && (
                  <p className="mono truncate text-xs text-[var(--sparrow-muted)]">
                    {a.agent.emailAddress}
                  </p>
                )}
                <p className="truncate text-xs text-[var(--sparrow-muted)]">
                  Owned by {a.owner.displayName}
                </p>
              </div>
              <span className="text-xs text-[var(--sparrow-faint)]">Added {fmtDate(a.agent.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ========================================================================== *
 * Approvals (pending enrollments)
 * ========================================================================== */

function ApprovalsSection({
  orgId,
  emailOn,
  onResolved,
}: {
  orgId: string;
  emailOn: boolean;
  /** Fired after an approve/deny lands, so sibling lists can refetch. */
  onResolved: () => void;
}) {
  const [pending, setPending] = useState<EnrollmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Email waiting on this org, counted by the email half of the block. */
  const [emailCount, setEmailCount] = useState(0);

  const load = useCallback(() => {
    api
      .listEnrollments(orgId)
      .then((items) => setPending(items))
      .catch((err: unknown) => setError(errMsg(err, 'Could not load requests.')));
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(e: EnrollmentSummary) {
    if (busyId) return;
    setBusyId(e.id);
    setError(null);
    try {
      await api.approveEnrollment(orgId, e.id);
      load();
      onResolved();
    } catch (err) {
      setError(errMsg(err, 'Could not approve this request.'));
    } finally {
      setBusyId(null);
    }
  }

  async function deny(e: EnrollmentSummary) {
    if (busyId) return;
    setBusyId(e.id);
    setError(null);
    try {
      await api.denyEnrollment(orgId, e.id);
      load();
      onResolved();
    } catch (err) {
      setError(errMsg(err, 'Could not decline this request.'));
    } finally {
      setBusyId(null);
    }
  }

  const enrollmentCount = pending?.length ?? 0;
  const count = enrollmentCount + emailCount;

  return (
    <Section
      id="approvals"
      title="Approvals"
      lead={
        emailOn
          ? 'People and agents waiting to join your organization, and email waiting on a decision — for every agent in the org, not just yours.'
          : 'People and agents waiting to join your organization.'
      }
      aside={
        count > 0 ? (
          <span className="rounded-full bg-[var(--sparrow-accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--sparrow-accent)]">
            {count} waiting
          </span>
        ) : null
      }
    >
      {emailOn && <OrgEmailApprovals orgId={orgId} onCount={setEmailCount} />}

      {!pending ? (
        <Panel className={emailOn ? 'mt-3' : ''}>
          {error ? <ErrorText>{error}</ErrorText> : <Loading />}
        </Panel>
      ) : pending.length === 0 ? (
        emailCount > 0 ? null : (
          <Notice className={emailOn ? 'mt-3' : ''}>Nobody is waiting for approval.</Notice>
        )
      ) : (
        <div className={`flex flex-col gap-3 ${emailOn ? 'mt-3' : ''}`.trim()}>
          {error && <ErrorText>{error}</ErrorText>}
          {pending.map((e) => {
            const who =
              e.kind === 'agent'
                ? e.proposedName || 'New agent'
                : e.displayName || e.email || 'Someone';
            return (
              <Panel key={e.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--sparrow-text)]">{who}</span>
                      <span className="rounded bg-[var(--sparrow-panel-2)] px-1.5 py-0.5 text-[10px] font-medium capitalize text-[var(--sparrow-muted)]">
                        {e.kind === 'agent' ? 'agent' : 'person'}
                      </span>
                    </div>
                    {e.kind === 'agent' && e.email && (
                      <p className="truncate text-xs text-[var(--sparrow-muted)]">{e.email}</p>
                    )}
                    {e.note && <p className="mt-1 text-xs text-[var(--sparrow-muted)]">“{e.note}”</p>}
                    <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
                      Invited by {e.inviter.displayName} · {fmtDate(e.createdAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void approve(e)}
                    disabled={busyId === e.id}
                    className={primaryBtn}
                  >
                    {busyId === e.id ? 'Working…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deny(e)}
                    disabled={busyId === e.id}
                    className="rounded-md border border-[var(--sparrow-border)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
                  >
                    Deny
                  </button>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/* ========================================================================== *
 * Invites
 * ========================================================================== */

function InvitesSection({ orgId }: { orgId: string }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<CreateInviteResponse | null>(null);

  const load = useCallback(() => {
    api
      .listInvites(orgId)
      .then((items) => setInvites(items))
      .catch((err: unknown) => setError(errMsg(err, 'Could not load invites.')));
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.createInvite(orgId, note.trim() ? { note: note.trim() } : undefined);
      setFresh(res);
      setNote('');
      load();
    } catch (err) {
      setError(errMsg(err, 'Could not create an invite.'));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.revokeInvite(orgId, id);
      load();
    } catch (err) {
      setError(errMsg(err, 'Could not revoke this invite.'));
    }
  }

  const active = (invites ?? []).filter((i) => !i.revokedAt);

  return (
    <Section
      id="invites"
      title="Invites"
      lead="Share an invite link so people and agents can join your organization."
    >
      <Panel>
        <label htmlFor="invite-note" className="block text-xs uppercase tracking-wider text-[var(--sparrow-faint)]">
          Note (optional)
        </label>
        <input
          id="invite-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Design team"
          className={`mt-1.5 ${inputClass}`}
        />
        <div className="mt-3 flex items-center gap-3">
          <button type="button" onClick={() => void create()} disabled={creating} className={primaryBtn}>
            {creating ? 'Creating…' : 'Create invite'}
          </button>
          {error && <ErrorText>{error}</ErrorText>}
        </div>

        {fresh && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs text-[var(--sparrow-muted)]">
              Copy this link now — it&rsquo;s shown only once.
            </p>
            <Terminal code={fresh.url} label="invite link" wrap />
          </div>
        )}
      </Panel>

      <div className="mt-3">
        {!invites ? (
          <Panel>{error ? null : <Loading />}</Panel>
        ) : active.length === 0 ? (
          <Notice>No active invites.</Notice>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--sparrow-border)]">
            {active.map((inv, i) => (
              <div
                key={inv.id}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--sparrow-panel)] p-3 ${
                  i > 0 ? 'border-t border-[var(--sparrow-border)]' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <span className="truncate text-sm text-[var(--sparrow-text)]">
                    {inv.note || 'Invite'}
                  </span>
                  <p className="truncate text-xs text-[var(--sparrow-faint)]">
                    From {inv.inviter.displayName} · expires {fmtDate(inv.expiresAt)}
                  </p>
                </div>
                <button type="button" onClick={() => void revoke(inv.id)} className={ghostBtn}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

