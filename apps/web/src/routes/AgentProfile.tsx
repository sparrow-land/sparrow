import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  AgentRoomMembership,
  AgentShare,
  AgentSharingMode,
  CreateAgentResponse,
  HumanContact,
} from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { useAuth } from '../lib/auth.js';
import { useOrg } from '../lib/org.js';
import { useCapabilities } from '../lib/capabilities.js';
import { useWorkspace } from '../lib/workspace.js';
import { api } from '../lib/client.js';
import { wire, agentTabPath, orgPath, roomPath, roomSettingsPath } from '../lib/ids.js';
import { presenceDot } from '../lib/presence.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';
import { formatRelativeTime } from '../lib/time.js';
import { PresenceGlyph } from '../components/StatusIndicator.js';
import { CopyButton } from '../components/CopyButton.js';
import { Terminal } from '../components/Terminal.js';
import { ActivityTab } from './agent/ActivityTab.js';
import { EmailTab } from './agent/EmailTab.js';
import { useContactBook } from './agent/contacts.js';

/** The agent page's three sections. Overview is the default and always renders. */
type AgentTab = 'overview' | 'activity' | 'email';

/**
 * Agent profile (`/org/:orgId/agents/:agentId`) — nested under the app shell, so
 * this renders PAGE CONTENT (a scrollable, max-width panel), not a layout.
 *
 * The agent is resolved from the caller's visibility list
 * (`useWorkspace().agents`, backed by `GET /orgs/:orgId/me/agents`): an entry the
 * caller can't see simply isn't there → a "you can't see this agent" panel. The
 * OWNER (visibility `sharedBy === null` and `owner.id === me`) gets the
 * management controls — share, rotate, delete, and a read-only view of the
 * agent's room memberships; a grantee gets name + owner + presence + Message.
 *
 * v4 gives the page a HEADER (name, owner, presence, and — with the email medium
 * on — the agent's copyable address, which is public routing information, not a
 * secret) over three tabs:
 *
 *  - **Overview** — v3's profile contents, for everyone who can see the agent;
 *  - **Activity** — the agent's full cross-medium timeline;
 *  - **Email** — its threads (only with `capabilities.email`).
 *
 * Activity and Email are correspondence, not room data: `canAccessAgent` alone
 * does not admit a reader, so the tabs render for the OWNER or an org
 * owner/admin. The server is the authority (a caller who fails every test gets
 * `404`); this is render gating, and discovery is never gated.
 */
export function AgentProfile() {
  const { agentId: bareAgentId = '' } = useParams<{ agentId: string }>();
  const agentId = wire('agent', bareAgentId);
  const { orgId, isAdmin } = useOrg();
  const caps = useCapabilities();
  const auth = useAuth();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Tick for relative times (kept cheap: once every 30s).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const entry = ws.agents.find((a) => a.agent.id === agentId);
  // Named by the agent once the visibility list resolves; a bare product title
  // while it loads (never a flash of "not found" in the tab).
  useDocumentTitle(pageTitle(entry ? `@${entry.agent.name}` : null));
  const isOwner = !!entry && entry.sharedBy === null && entry.owner.id === auth.user?.id;
  const canReadActivity = isOwner || isAdmin;

  // Tabs are a `?tab=` VIEW PREFERENCE on the one agent route. A tab the caller
  // may not read (or a medium that is off) falls back to Overview rather than
  // rendering an "unavailable" placeholder.
  const requested = searchParams.get('tab');
  const tab: AgentTab =
    requested === 'activity' && canReadActivity
      ? 'activity'
      : requested === 'email' && canReadActivity && caps.email
        ? 'email'
        : 'overview';

  // Trust pills come from the admin-only contacts route; a non-admin owner gets
  // no pill rather than a 404 (see `agent/contacts.ts`).
  const contacts = useContactBook(orgId, caps.email && isAdmin && tab !== 'overview');

  if (!entry) {
    // Still loading the visibility list — hold the layout, don't flash not-found.
    if (ws.loading) {
      return (
        <Panel>
          <p className="text-sm text-[var(--sparrow-faint)]">Loading…</p>
        </Panel>
      );
    }
    return (
      <Panel>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--sparrow-text)]">
          You can’t see this agent
        </h1>
        <p className="mt-2 text-sm text-[var(--sparrow-muted)]">
          It may have been deleted, or its owner hasn’t shared it with you. Agents are private
          until someone grants you visibility.
        </p>
        <Link
          to={orgPath(orgId)}
          className="mt-5 inline-flex items-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)]"
        >
          Back to workspace
        </Link>
      </Panel>
    );
  }

  const { agent, owner, sharedBy, rooms, sharedWith, roleInstructions } = entry;
  const presence = presenceDot(agent.online, agent.lastSeenAt, nowMs);

  return (
    <Panel>
      {/* Header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <PresenceGlyph presence={presence} busy={false} />
        <h1 className="text-lg font-semibold tracking-tight text-[var(--sparrow-text)]">{agent.name}</h1>
        {isOwner ? (
          <span className="rounded-full border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-2 py-0.5 text-[11px] text-[var(--sparrow-muted)]">
            yours
          </span>
        ) : null}
        {/* The role TITLE is org-visible — a small badge everyone who can see the
            agent gets (the private instructions never appear here). */}
        {agent.roleTitle ? (
          <span className="rounded-full border border-[var(--sparrow-accent-2)] bg-[var(--sparrow-panel-2)] px-2 py-0.5 text-[11px] text-[var(--sparrow-muted)]">
            {agent.roleTitle}
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-sm text-[var(--sparrow-muted)]">
        {isOwner
          ? 'Owned by you'
          : sharedBy
            ? `Owned by ${owner.displayName} · shared by ${sharedBy.displayName}`
            : `Owned by ${owner.displayName}`}
      </p>
      <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
        {presence === 'online'
          ? 'Online now'
          : agent.lastSeenAt
            ? `Last seen ${formatRelativeTime(agent.lastSeenAt, nowMs)}`
            : 'Never seen'}
      </p>

      {caps.email && agent.emailAddress ? <AddressRow address={agent.emailAddress} /> : null}

      {canReadActivity ? (
        <TabBar orgId={orgId} agentId={agent.id} active={tab} email={caps.email} />
      ) : null}

      <div
        role={canReadActivity ? 'tabpanel' : undefined}
        aria-labelledby={canReadActivity ? `agent-tab-${tab}` : undefined}
        className="mt-6"
      >
        {tab === 'activity' ? (
          <ActivityTab
            orgId={orgId}
            agentId={agent.id}
            agentName={agent.name}
            emailEnabled={caps.email}
            owned={isOwner}
            contacts={contacts}
            nowMs={nowMs}
          />
        ) : tab === 'email' ? (
          <EmailTab
            orgId={orgId}
            agentId={agent.id}
            address={agent.emailAddress}
            owned={isOwner}
            contacts={contacts}
            nowMs={nowMs}
          />
        ) : (
          <>
            <MessageButton agentId={agent.id} orgId={orgId} />
            {isOwner ? (
              <OwnerControls
                agentId={agent.id}
                orgId={orgId}
                name={agent.name}
                sharing={agent.sharing}
                roleTitle={agent.roleTitle}
                roleInstructions={roleInstructions ?? null}
                rooms={rooms ?? []}
                sharedWith={sharedWith ?? []}
                onChanged={() => void ws.reloadAgents()}
                onDeleted={() => navigate(orgPath(orgId))}
              />
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * The agent's derived address as a copyable row — the same click-to-copy
 * confirmation the invite blob uses. Shown to anyone who can see the agent: an
 * address is how the outside world reaches it, not a secret. Rendered only when
 * `capabilities.email` AND the agent actually has one (a rename moves it; there
 * is never an empty address row).
 */
function AddressRow({ address }: { address: string }) {
  return (
    <div className="mt-4 flex items-center gap-2 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-3 py-2">
      <span className="mono min-w-0 flex-1 truncate text-sm text-[var(--sparrow-text)]">
        {address}
      </span>
      <CopyButton value={address} label="Copy email address" />
    </div>
  );
}

/**
 * Overview / Activity / Email. Each tab is a LINK to the same route with a
 * different `?tab=`, so a tab is bookmarkable, back/forward works, and an email
 * card's "Open thread" can deep-link into `?tab=email&thread=…`.
 */
function TabBar({
  orgId,
  agentId,
  active,
  email,
}: {
  orgId: string;
  agentId: string;
  active: AgentTab;
  /** `capabilities.email`: no medium, no tab — never a disabled placeholder. */
  email: boolean;
}) {
  const tabs: { id: AgentTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    ...(email ? [{ id: 'email' as const, label: 'Email' }] : []),
  ];
  return (
    <div
      role="tablist"
      aria-label="Agent sections"
      className="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--sparrow-border)]"
    >
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <Link
            key={t.id}
            id={`agent-tab-${t.id}`}
            to={agentTabPath(orgId, agentId, t.id)}
            role="tab"
            aria-selected={selected}
            className={`-mb-px inline-flex min-h-[40px] shrink-0 items-center border-b-2 px-3 text-sm transition-colors ${
              selected
                ? 'border-[var(--sparrow-accent)] text-[var(--sparrow-text)]'
                : 'border-transparent text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

/** The shared page container: a scrollable, centered, max-width column. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">{children}</div>
    </div>
  );
}

/** "Message" → ensure (or reuse) the DM room, then navigate into it. */
function MessageButton({ agentId, orgId }: { agentId: string; orgId: string }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function message() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const roomId = await ws.ensureDm(agentId);
      navigate(roomPath(orgId, roomId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that conversation.');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void message()}
        disabled={busy}
        className="inline-flex min-h-[40px] items-center rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Opening…' : 'Message'}
      </button>
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </div>
  );
}

/** Owner-only management: rename, role, sharing mode, explicit grants, rooms, rotate, delete. */
function OwnerControls({
  agentId,
  orgId,
  name,
  sharing,
  roleTitle,
  roleInstructions,
  rooms,
  sharedWith,
  onChanged,
  onDeleted,
}: {
  agentId: string;
  orgId: string;
  name: string;
  sharing: AgentSharingMode;
  roleTitle: string | null;
  roleInstructions: string | null;
  rooms: AgentRoomMembership[];
  sharedWith: AgentShare[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  return (
    <div className="mt-8 space-y-8">
      <RenameControl agentId={agentId} name={name} onChanged={onChanged} />
      <RoleControl
        agentId={agentId}
        roleTitle={roleTitle}
        roleInstructions={roleInstructions}
        onChanged={onChanged}
      />
      <SharingControl agentId={agentId} sharing={sharing} onChanged={onChanged} />
      <ShareControl agentId={agentId} orgId={orgId} sharedWith={sharedWith} onChanged={onChanged} />
      <RoomMemberships rooms={rooms} orgId={orgId} onChanged={onChanged} />
      <RotateControl agentId={agentId} />
      <DeleteControl agentId={agentId} onDeleted={onDeleted} />
    </div>
  );
}

/**
 * Owner-only role editor. A role is a persistent job description: a `roleTitle`
 * that the whole workspace can see (a small header badge) and `roleInstructions`
 * that only the owner and the agent itself may read. Either half is a string to
 * set or empty to clear (sent as `null`), and any change nudges the agent to
 * re-read its role. Save is disabled until something actually differs.
 */
function RoleControl({
  agentId,
  roleTitle,
  roleInstructions,
  onChanged,
}: {
  agentId: string;
  roleTitle: string | null;
  roleInstructions: string | null;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(roleTitle ?? '');
  const [instructions, setInstructions] = useState(roleInstructions ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // Track external changes (e.g. an agent self-set arriving via reload).
  useEffect(() => {
    setTitle(roleTitle ?? '');
    setInstructions(roleInstructions ?? '');
  }, [roleTitle, roleInstructions]);

  const currentTitle = roleTitle ?? '';
  const currentInstructions = roleInstructions ?? '';
  const dirty = title.trim() !== currentTitle.trim() || instructions !== currentInstructions;

  const save = useCallback(async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      // An empty field CLEARS the half (server treats null as "no role"); a
      // non-empty title is trimmed to match the org-visible label.
      await api.setAgentRole(agentId, {
        roleTitle: title.trim() === '' ? null : title.trim(),
        roleInstructions: instructions === '' ? null : instructions,
      });
      setOk(true);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the role.');
    } finally {
      setBusy(false);
    }
  }, [agentId, busy, dirty, title, instructions, onChanged]);

  const inputClass =
    'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Role</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        A persistent job description. The <strong>title</strong> is visible to the whole workspace;
        the <strong>instructions</strong> are private to you and this agent. Changing either nudges
        the agent to re-read it.
      </p>
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setOk(false);
            setError(null);
          }}
          placeholder="Title (e.g. Support triage)"
          aria-label="Role title"
          maxLength={60}
          className={inputClass}
        />
        <textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setOk(false);
            setError(null);
          }}
          placeholder="Instructions (markdown; private to you and this agent)"
          aria-label="Role instructions"
          maxLength={16384}
          rows={5}
          className={`${inputClass} resize-y`}
        />
        <button
          type="submit"
          disabled={busy || !dirty}
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save role'}
        </button>
      </form>
      {ok ? <p className="mt-2 text-sm text-[var(--sparrow-good)]">Role updated.</p> : null}
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </section>
  );
}

/**
 * Owner-only rename. The agent's `agt_` id is permanent; the name is the display
 * layer and propagates live to every room. The name must be unique in the org
 * (case-insensitive) — a collision `409`s and is surfaced inline. Submitting the
 * current name is a no-op.
 */
function RenameControl({
  agentId,
  name,
  onChanged,
}: {
  agentId: string;
  name: string;
  onChanged: () => void;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okName, setOkName] = useState<string | null>(null);

  // Track external renames (e.g. an agent self-rename arriving via reload).
  useEffect(() => {
    setValue(name);
  }, [name]);

  const trimmed = value.trim();
  const dirty = trimmed.length > 0 && trimmed !== name;

  const save = useCallback(async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setOkName(null);
    try {
      const res = await api.renameAgent(agentId, trimmed);
      setOkName(res.agent.name);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename the agent.');
    } finally {
      setBusy(false);
    }
  }, [agentId, busy, dirty, trimmed, onChanged]);

  const inputClass =
    'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Name</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        The agent&rsquo;s display name. Renaming updates it everywhere live; its identity is
        unchanged. Must be unique in this org.
      </p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOkName(null);
            setError(null);
          }}
          aria-label="Agent name"
          maxLength={60}
          className={inputClass}
        />
        <button
          type="submit"
          disabled={busy || !dirty}
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      {okName ? <p className="mt-2 text-sm text-[var(--sparrow-good)]">Renamed to {okName}.</p> : null}
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </section>
  );
}

/** The three sharing modes, each with a one-line explanation for the radio group. */
const SHARING_OPTIONS: { value: AgentSharingMode; label: string; hint: string }[] = [
  { value: 'selected', label: 'Only people you choose', hint: 'Just the teammates you grant below.' },
  {
    value: 'room-members',
    label: 'Anyone in a room with this agent',
    hint: 'Everyone who currently shares a room with it can see and message it.',
  },
  { value: 'org', label: 'Everyone in the organization', hint: 'Every member of this org can see and message it.' },
];

/**
 * Owner-only sharing-mode selector. Changing the mode PATCHes the agent and
 * reloads the visibility list. The explicit grant list below stays meaningful in
 * every mode (extra people, beyond whatever the mode already admits).
 */
function SharingControl({
  agentId,
  sharing,
  onChanged,
}: {
  agentId: string;
  sharing: AgentSharingMode;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(
    async (next: AgentSharingMode) => {
      if (busy || next === sharing) return;
      setBusy(true);
      setError(null);
      try {
        await api.setAgentSharing(agentId, next);
        onChanged();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not change sharing.');
      } finally {
        setBusy(false);
      }
    },
    [agentId, busy, sharing, onChanged],
  );

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Sharing</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        Choose who can see and message this agent. You can always grant extra people below.
      </p>
      <fieldset className="mt-3 space-y-2" aria-label="Sharing mode" disabled={busy}>
        {SHARING_OPTIONS.map((opt) => {
          const active = opt.value === sharing;
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
                name="agent-sharing"
                value={opt.value}
                checked={active}
                onChange={() => void choose(opt.value)}
                className="mt-0.5 accent-[var(--sparrow-accent)]"
              />
              <span className="flex flex-col">
                <span className="text-sm text-[var(--sparrow-text)]">{opt.label}</span>
                <span className="text-xs text-[var(--sparrow-faint)]">{opt.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </section>
  );
}

/**
 * Share the agent with a human, and manage who it's already shared with. Name a
 * grantee by typing an email or `usr_` id, or by searching the org directory. The
 * visibility entry's `sharedWith` enumerates current grantees, each revocable
 * (`DELETE /me/agents/:id/share/:humanId`); the owner's own row is irrevocable
 * and never appears here.
 */
function ShareControl({
  agentId,
  orgId,
  sharedWith,
  onChanged,
}: {
  agentId: string;
  orgId: string;
  sharedWith: AgentShare[];
  onChanged: () => void;
}) {
  const [value, setValue] = useState('');
  const [results, setResults] = useState<HumanContact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okName, setOkName] = useState<string | null>(null);
  const seq = useRef(0);

  // Directory search as the caller types (prefix match; capped server-side).
  useEffect(() => {
    const q = value.trim();
    if (q.length === 0) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    const t = setTimeout(() => {
      void api
        .directory(orgId, q)
        .then((items) => {
          if (seq.current === id) setResults(items);
        })
        .catch(() => {
          if (seq.current === id) setResults([]);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [value, orgId]);

  const share = useCallback(
    async (human: string, label?: string) => {
      if (busy || !human.trim()) return;
      setBusy(true);
      setError(null);
      setOkName(null);
      try {
        await api.shareAgent(agentId, human.trim());
        setOkName(label ?? human.trim());
        setValue('');
        setResults([]);
        onChanged();
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.code === 'not_found' || err.code === 'bad_request'
              ? 'No org member matches that email or id.'
              : err.message
            : 'Could not share the agent.',
        );
      } finally {
        setBusy(false);
      }
    },
    [agentId, busy, onChanged],
  );

  const inputClass =
    'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Share</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        Grant specific teammates visibility, on top of the sharing mode above, so they can message
        this agent and add it to rooms. Only you, the owner, can share.
      </p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void share(value);
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="email or usr_ id"
          aria-label="Share with (email or user id)"
          className={inputClass}
        />
        <button
          type="submit"
          disabled={busy || value.trim().length === 0}
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
        >
          {busy ? 'Sharing…' : 'Share'}
        </button>
      </form>

      {results.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Directory matches"
          className="mt-2 overflow-hidden rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)]"
        >
          {results.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => void share(h.id, h.displayName)}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-[var(--sparrow-panel)]"
              >
                <span className="text-sm text-[var(--sparrow-text)]">{h.displayName}</span>
                <span className="text-xs text-[var(--sparrow-faint)]">{h.email}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {okName ? (
        <p className="mt-2 text-sm text-[var(--sparrow-good)]">Shared with {okName}.</p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}

      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
          Shared with
        </h3>
        {sharedWith.length === 0 ? (
          <p className="mt-1 text-sm text-[var(--sparrow-muted)]">
            Not shared with anyone yet. Only you can see this agent.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--sparrow-border)] overflow-hidden rounded-md border border-[var(--sparrow-border)]">
            {sharedWith.map((s) => (
              <SharedWithRow key={s.id} share={s} agentId={agentId} onRevoked={onChanged} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** One grantee row with a Revoke action (revocation is forward-looking). */
function SharedWithRow({
  share,
  agentId,
  onRevoked,
}: {
  share: AgentShare;
  agentId: string;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.unshareAgent(agentId, share.id);
      onRevoked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke.');
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5">
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--sparrow-text)]">
        {share.displayName}
      </span>
      {error ? <span className="shrink-0 text-xs text-[var(--sparrow-danger)]">{error}</span> : null}
      <button
        type="button"
        onClick={() => void revoke()}
        disabled={busy}
        className="shrink-0 rounded border border-[var(--sparrow-border-strong)] px-2 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
      >
        {busy ? 'Revoking…' : 'Revoke'}
      </button>
    </li>
  );
}

/**
 * The agent's room memberships (from the visibility entry's `rooms`). Each row
 * carries the agent's `memberId` in that room, so the owner can Detach it inline
 * (`DELETE /rooms/:roomId/members/:memberId`) — or open the room to manage it.
 */
function RoomMemberships({
  rooms,
  orgId,
  onChanged,
}: {
  rooms: AgentRoomMembership[];
  orgId: string;
  onChanged: () => void;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Rooms</h2>
      {rooms.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--sparrow-muted)]">This agent isn’t in any rooms yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--sparrow-border)] overflow-hidden rounded-md border border-[var(--sparrow-border)]">
          {rooms.map((r) => (
            <RoomMembershipRow key={r.id} room={r} orgId={orgId} onDetached={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One room row: link into the room, plus an inline Detach. */
function RoomMembershipRow({
  room,
  orgId,
  onDetached,
}: {
  room: AgentRoomMembership;
  orgId: string;
  onDetached: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function detach() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeMember(room.id, room.memberId);
      onDetached();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not detach.');
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5">
      <Link
        to={roomPath(orgId, room.id)}
        className="min-w-0 flex-1 truncate text-sm text-[var(--sparrow-text)] hover:text-[var(--sparrow-accent)]"
      >
        {room.name}
      </Link>
      {error ? <span className="shrink-0 text-xs text-[var(--sparrow-danger)]">{error}</span> : null}
      <Link
        to={roomSettingsPath(orgId, room.id)}
        className="shrink-0 text-xs text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]"
      >
        Manage
      </Link>
      <button
        type="button"
        onClick={() => void detach()}
        disabled={busy}
        className="shrink-0 rounded border border-[var(--sparrow-border-strong)] px-2 py-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
      >
        {busy ? 'Detaching…' : 'Detach'}
      </button>
    </li>
  );
}

/** Rotate the agent's key. The new key is shown ONCE, then it's gone. */
function RotateControl({ agentId }: { agentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<CreateAgentResponse | null>(null);

  async function rotate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.rotateAgent(agentId);
      setMinted(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rotate the key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">Agent key</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        Rotating issues a new key and immediately kills the old one — any process using it will
        need the new key.
      </p>
      {minted ? (
        <div className="mt-3">
          <Terminal code={minted.key} label="new agent key" />
          <p className="mt-2 text-sm text-[var(--sparrow-accent)]">
            Copy this now — you won’t see it again.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void rotate()}
          disabled={busy}
          className="mt-3 inline-flex min-h-[40px] items-center rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)] disabled:opacity-50"
        >
          {busy ? 'Rotating…' : 'Rotate key'}
        </button>
      )}
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </section>
  );
}

/** Delete the agent (with a confirm), then leave the profile. */
function DeleteControl({ agentId, onDeleted }: { agentId: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function del() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(agentId);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the agent.');
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md border border-[var(--sparrow-border-strong)] p-4">
      <h2 className="text-sm font-semibold text-[var(--sparrow-danger)]">Delete agent</h2>
      <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
        Permanently deletes the agent, removes it from every room, and kills its key. This can’t
        be undone.
      </p>
      {confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-[var(--sparrow-text)]">Are you sure?</span>
          <button
            type="button"
            onClick={() => void del()}
            disabled={busy}
            className="inline-flex min-h-[40px] items-center rounded-md bg-[var(--sparrow-danger)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="inline-flex min-h-[40px] items-center rounded-md border border-[var(--sparrow-border)] px-4 py-2 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 inline-flex min-h-[40px] items-center rounded-md border border-[var(--sparrow-danger)] px-4 py-2 text-sm text-[var(--sparrow-danger)] transition-colors hover:bg-[var(--sparrow-danger)] hover:text-black"
        >
          Delete agent
        </button>
      )}
      {error ? <p className="mt-2 text-sm text-[var(--sparrow-danger)]">{error}</p> : null}
    </section>
  );
}
