import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
} from 'react-router-dom';
import { ChevronDown, LogOut, Plus } from 'lucide-react';
import { Logo, Gear } from './Logo.js';
import { RoomBusyGlyph } from './StatusIndicator.js';
import { PresenceAvatar } from './PresenceAvatar.js';
import { NewRoomModal } from './NewRoomModal.js';
import { InviteDialog, type InviteStep } from './InviteDialog.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { SkipLink, MAIN_CONTENT_ID } from './SkipLink.js';
import { useAuth } from '../lib/auth.js';
import { useOrg } from '../lib/org.js';
import { useCapabilities } from '../lib/capabilities.js';
import { useWorkspace } from '../lib/workspace.js';
import { api } from '../lib/client.js';
import { roomStreams } from '../lib/roomStreams.js';
import { usePresence } from '../lib/presenceStore.js';
import {
  orgPath,
  roomPath,
  roomSettingsPath,
  agentProfilePath,
  orgAdminPath,
  activeRoomIdFromPath,
  isScopedMode,
} from '../lib/ids.js';
import {
  buildDmMap,
  humanEntries,
  agentEntries,
  roomEntries,
  unreadTooltip,
  pendingTooltip,
  type PrincipalEntry,
  type AgentEntry,
  type RoomEntry,
} from '../lib/sidebar.js';

/**
 * Live view data the active Room view publishes upward (its authoritative
 * broadcast unread, once the human has it open and messages get marked read).
 */
export interface ShellOutletContext {
  reportBroadcastUnread: (roomId: string, unread: number) => void;
  /**
   * The org policy the shell already resolved, so a page inside the shell can
   * describe only the controls the SHELL actually renders for this caller.
   * `null` until `GET /orgs/:id` lands — treat that as "don't know yet", not
   * "forbidden": a page describing an affordance is guidance, not a control.
   */
  policy: ShellPolicy | null;
}

/** Which policy-gated sidebar affordances this caller can see. */
export interface ShellPolicy {
  canInvite: boolean;
  canCreateRoom: boolean;
}

/**
 * The app shell (v3): a slim top bar (logo + active room name; account area with
 * org switcher, settings, approvals badge, sign out) and ONE left sidebar with
 * three FLAT, ROOM-INDEPENDENT sections — HUMANS, AGENTS, ROOMS — fed by
 * org-scoped sources (never the active room). Every joined room holds a live SSE
 * stream via the workspace, so badges update in real time.
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const { orgId, isAdmin, name: orgName } = useOrg();
  const caps = useCapabilities();
  const ws = useWorkspace();

  const activeRoomId = activeRoomIdFromPath(location.pathname);

  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setDrawerOpen(false), [location.pathname, location.search]);

  // Modals. ONE invite dialog for humans AND agents — the entry point only
  // decides which step it opens on (header "Invite" asks who; the section "+"
  // buttons already know).
  const [inviteStep, setInviteStep] = useState<InviteStep | null>(null);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  // Org policy, client-visible: `invites.who` ("members" lets everyone invite,
  // "admins" only org owners/admins) and `rooms.create` (same two values for
  // creating rooms). ONE `getOrg` carries both; every control the policy forbids
  // is hidden rather than left to fail on submit with a server 403.
  const [policy, setPolicy] = useState<{
    invitesWho: 'members' | 'admins';
    roomsCreate: 'members' | 'admins';
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .getOrg(orgId)
      .then((o) => {
        if (!cancelled) {
          setPolicy({ invitesWho: o.settings.invites.who, roomsCreate: o.settings.rooms.create });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);
  const allows = (who: 'members' | 'admins' | undefined) =>
    who === 'members' || (who === 'admins' && isAdmin);
  // Inviting covers BOTH audiences: the invite dialog mints one org invite
  // whether the caller is bringing in a person or an agent, so the AGENTS "+"
  // gates on exactly the same policy as the HUMANS "+" and the header button.
  const canInvite = allows(policy?.invitesWho);
  const canCreateRoom = allows(policy?.roomsCreate);

  const dm = buildDmMap(ws.rooms, ws.badges);
  // One presence truth per principal: the shared store (fed by the multiplexed
  // `/me/events` stream + the wake reconcile) drives the dots here AND in chat
  // headers.
  const presence = usePresence();
  const humans = humanEntries(ws.humans, dm, presence);
  const agents = agentEntries(ws.agents, dm, auth.user?.id ?? null, presence, ws.emailUnread);
  const rooms = roomEntries(ws.rooms, ws.badges);

  // The pending pill: ONE number, ONE destination (`/me/approvals`) — pending
  // enrollments from the caller's own invites PLUS email approvals for agents
  // they own. With the email medium off it is exactly v3's pill, tooltip
  // wording included (SPEC *Web UI → Top-nav pending pill*).
  const pendingEmail = caps.email ? ws.emailApprovals.length : 0;
  const pendingTotal = ws.approvals + pendingEmail;
  const pendingTitle = caps.email
    ? (pendingTooltip(ws.approvals, pendingEmail) ?? '')
    : `${ws.approvals} pending request${ws.approvals === 1 ? '' : 's'} from your invites`;
  const activeRooms = rooms.filter((r) => r.archivedAt === null);
  const archivedRooms = rooms.filter((r) => r.archivedAt !== null);

  const activeRoom = ws.rooms.find((r) => r.room.id === activeRoomId);
  const activeTitle = activeRoom
    ? activeRoom.room.kind === 'dm'
      ? `@${activeRoom.room.counterpart?.displayName ?? 'direct message'}`
      : `#${activeRoom.room.name || 'room'}`
    : '';

  const openPrincipal = useCallback(
    async (entry: PrincipalEntry) => {
      if (entry.dmRoomId) {
        navigate(roomPath(orgId, entry.dmRoomId));
        return;
      }
      try {
        const roomId = await ws.ensureDm(entry.principalId);
        navigate(roomPath(orgId, roomId));
      } catch {
        /* eligibility failure — silently ignore (the row stays put) */
      }
    },
    [navigate, orgId, ws],
  );

  async function signOut() {
    await auth.signOut();
    navigate('/login');
  }

  const reportBroadcastUnread = useCallback((roomId: string, unread: number) => {
    // The Room view marks broadcasts read; hand its authoritative count back to
    // the stream manager so the sidebar room badge never over-counts.
    roomStreams.reportUnread(roomId, unread > 0 ? { all: unread } : {});
  }, []);

  return (
    // `overflow-x-hidden` + `max-w-full` are a FLOOR, not a layout: every row
    // below is individually shrinkable, and this only guarantees that a future
    // one that isn't cannot make the whole document scroll sideways on a phone
    // (measured 413px against a 390px viewport before the header was fixed).
    <div className="relative flex app-height max-w-full flex-col overflow-x-hidden">
      {/* Ahead of the hamburger and the whole sidebar: without it, reaching the
          conversation meant re-tabbing every human, agent and room. */}
      <SkipLink />
      <header className="app-header flex shrink-0 items-center gap-3 border-b border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-4">
        <button
          type="button"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={drawerOpen}
          aria-controls="app-sidebar"
          className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)] md:hidden"
        >
          <Hamburger />
        </button>
        <Link to={orgPath(orgId)} aria-label="sparrow home" className="shrink-0 rounded">
          <Logo size={20} />
        </Link>

        {activeRoom ? (
          // The title takes the remaining space and truncates. It used to
          // reserve a min-width floor as well (issue #58, so the nav could not
          // squeeze the room name to a single-glyph sliver) — but a floor here
          // plus the nav's own floors is precisely what pushed Sign out off a
          // 390px screen. Below `sm` the title is fully shrinkable and the nav
          // gives up its label instead (the icon-only Sign out below); from
          // `sm` up, where there is room for both, the floor comes back.
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:min-w-[7rem] sm:gap-3">
            <span className="h-4 w-px shrink-0 bg-[var(--sparrow-border-strong)]" aria-hidden="true" />
            <span className="min-w-0 truncate text-sm font-semibold">{activeTitle}</span>
            {activeRoom.room.kind !== 'dm' && activeRoom.room.archivedAt !== null && (
              <span className="shrink-0 rounded bg-[var(--sparrow-panel-2)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--sparrow-muted)]">
                archived
              </span>
            )}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* Account actions. On phones the top bar has no room for the full set,
            so the secondary actions (Invite, approvals, Org admin) collapse
            below the `sm` breakpoint — each is reachable elsewhere (the sidebar
            "add" affordances, /me/approvals, direct URL). The nav itself is
            shrinkable (min-w-0, no shrink-0) so the always-present items
            (org switcher, settings, sign out) truncate rather than widen the
            page. Follow-up: a proper mobile account/overflow menu to re-home
            the hidden actions. */}
        <nav className="flex min-w-0 shrink items-center gap-1 text-sm">
          {canInvite && (
            <button
              type="button"
              onClick={() => setInviteStep('who')}
              className="hidden rounded-md border border-[var(--sparrow-border-strong)] px-3 py-1.5 text-xs font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)] sm:inline-flex"
            >
              Invite
            </button>
          )}
          {/* The org identity now lives in the leftnav header (see OrgHeader),
              not here — the top bar keeps only the account affordances. */}
          {pendingTotal > 0 && (
            <Link
              to="/me/approvals"
              className="mono hidden items-center gap-1 rounded-full border border-[var(--sparrow-accent-2)] bg-[var(--sparrow-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--sparrow-accent)] sm:inline-flex"
              title={pendingTitle}
            >
              {pendingTotal} pending
            </Link>
          )}
          {isAdmin && (
            <NavLink
              to={orgAdminPath(orgId)}
              className={({ isActive }) =>
                `hidden rounded-md px-3 py-1.5 transition-colors sm:inline-block ${
                  isActive
                    ? 'text-[var(--sparrow-accent)]'
                    : 'text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
                }`
              }
            >
              Org admin
            </NavLink>
          )}
          <span className="mx-1 h-4 w-px shrink-0 bg-[var(--sparrow-border-strong)]" aria-hidden="true" />
          {/* The two always-present items, sized for a phone (issue #58). The
              name truncates DOWN TO A FLOOR — as a `min-w-0` flex item it was
              free to shrink to a single glyph, which is what the bug report
              showed — and Sign out neither shrinks nor wraps: a two-line
              control in a one-line bar reads as breakage.

              Below `md` the words "Sign out" become the door glyph instead.
              That is ~50px back for the room title on a phone, and the control
              keeps its accessible name either way — it is the label that goes,
              never the affordance. */}
          <Link
            to="/me/settings"
            className="min-w-[3.5rem] max-w-[8rem] truncate rounded px-1 text-xs text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)] sm:max-w-[10rem]"
            title="Your settings"
          >
            {auth.user?.displayName}
          </Link>
          <button
            onClick={() => void signOut()}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-xs text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)] md:px-2.5 md:py-1.5"
          >
            <LogOut size={16} aria-hidden="true" className="md:hidden" />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </nav>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {drawerOpen && (
          <button
            type="button"
            data-testid="drawer-backdrop"
            aria-label="Dismiss navigation menu"
            onClick={() => setDrawerOpen(false)}
            className="top-app-header fixed inset-0 z-30 bg-black/50 md:hidden"
          />
        )}
        <aside
          id="app-sidebar"
          className={`top-app-header fixed bottom-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] transition-transform duration-200 motion-reduce:transition-none md:static md:top-auto md:z-auto md:translate-x-0 md:transition-none ${
            drawerOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          }`}
        >
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {/* Org identity: the workspace header at the TOP of the leftnav. A
                plain label by default; a workspace switcher when the instance
                advertises one; the classic cross-org switcher when unscoped and
                the caller belongs to more than one org on this instance. */}
            <OrgHeader />

            {/* HUMANS */}
            <SidebarSection
              label="Humans"
              onAdd={canInvite ? () => setInviteStep('person') : undefined}
              addLabel="Invite a person"
            >
              {humans.length === 0 ? (
                <Empty>No one yet.</Empty>
              ) : (
                humans.map((h) => (
                  <PrincipalRow
                    key={h.key}
                    entry={h}
                    active={activeRoomId !== null && h.dmRoomId === activeRoomId}
                    onOpen={() => void openPrincipal(h)}
                  />
                ))
              )}
            </SidebarSection>

            {/* AGENTS */}
            <SidebarSection
              label="Agents"
              onAdd={canInvite ? () => setInviteStep('agent') : undefined}
              addLabel="Invite an agent"
            >
              {agents.length === 0 ? (
                <Empty>No agents yet.</Empty>
              ) : (
                agents.map((a) => (
                  <AgentRow
                    key={a.key}
                    entry={a}
                    orgId={orgId}
                    active={activeRoomId !== null && a.dmRoomId === activeRoomId}
                    onOpen={() => void openPrincipal(a)}
                  />
                ))
              )}
            </SidebarSection>

            {/* ROOMS — header carries the create affordance, same anatomy as
                the Humans/Agents section headers. */}
            <div className="mt-1 flex items-center justify-between px-3 pt-3 pb-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
                Rooms
              </span>
              {canCreateRoom && (
                <button
                  type="button"
                  onClick={() => setNewRoomOpen(true)}
                  aria-label="Create a room"
                  title="Create a room"
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--sparrow-faint)] transition-colors hover:bg-[var(--sparrow-panel-2)] hover:text-[var(--sparrow-accent)]"
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            <nav aria-label="Rooms">
              {activeRooms.length === 0 && <Empty>No rooms yet.</Empty>}
              {activeRooms.map((r) => (
                <RoomRow key={r.roomId} entry={r} orgId={orgId} active={r.roomId === activeRoomId} />
              ))}

              {archivedRooms.length > 0 && (
                <div className="mt-2 border-t border-[var(--sparrow-border)] pt-1">
                  <button
                    type="button"
                    onClick={() => setArchivedOpen((v) => !v)}
                    aria-expanded={archivedOpen}
                    className="flex w-full items-center gap-1.5 px-2 py-2.5 text-left text-xs uppercase tracking-wide text-[var(--sparrow-faint)] hover:text-[var(--sparrow-muted)] md:py-2"
                  >
                    <Chevron expanded={archivedOpen} />
                    <span className="flex-1">Archived</span>
                    <span className="mono text-[10px]">{archivedRooms.length}</span>
                  </button>
                  {archivedOpen &&
                    archivedRooms.map((r) => (
                      <RoomRow
                        key={r.roomId}
                        entry={r}
                        orgId={orgId}
                        active={r.roomId === activeRoomId}
                        archived
                      />
                    ))}
                </div>
              )}
            </nav>
          </div>
        </aside>

        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          <Outlet
            context={
              {
                reportBroadcastUnread,
                policy: policy ? { canInvite, canCreateRoom } : null,
              } satisfies ShellOutletContext
            }
          />
        </main>
      </div>

      {inviteStep !== null && (
        <InviteDialog
          orgId={orgId}
          orgName={orgName}
          inviterName={auth.user?.displayName ?? ''}
          canByEmail={isAdmin}
          hasAgents={ws.agents.length > 0}
          initialStep={inviteStep}
          onClose={() => setInviteStep(null)}
          onInvited={() => void ws.reloadHumans()}
        />
      )}
      {newRoomOpen && (
        <NewRoomModal
          orgId={orgId}
          onClose={() => setNewRoomOpen(false)}
          onCreated={(roomId) => {
            setNewRoomOpen(false);
            void ws.reloadRooms();
            navigate(roomPath(orgId, roomId));
          }}
        />
      )}
    </div>
  );
}

/** Hook for views rendered inside the shell to publish/report their view data. */
export function useShell(): ShellOutletContext {
  return useOutletContext<ShellOutletContext>();
}

/**
 * The shell's resolved org policy, for pages that DESCRIBE the sidebar's
 * affordances. Returns `null` outside the shell (or before the policy loads);
 * callers show their full copy then, because guidance that names one control
 * too many is a smaller failure than guidance that omits the one that works.
 */
export function useShellPolicy(): ShellPolicy | null {
  return useOutletContext<ShellOutletContext | null>()?.policy ?? null;
}

/* -------------------------------------------------------------------------- */

/**
 * The org identity block at the top of the leftnav. Its variant is decided by
 * instance capability and scope:
 *  - a cloud-advertised {@link WorkspaceSwitcher} (config-driven) wins;
 *  - otherwise, an UNSCOPED caller with >1 org on this instance gets the classic
 *    cross-org {@link OrgSwitcher};
 *  - otherwise a plain, non-interactive label (the self-hosted default).
 */
function OrgHeader() {
  const caps = useCapabilities();
  const auth = useAuth();
  const { name: orgName } = useOrg();

  let inner: ReactNode;
  if (caps.workspaceSwitcher) {
    inner = <WorkspaceSwitcher orgName={orgName} config={caps.workspaceSwitcher} />;
  } else if (!isScopedMode() && auth.orgs.length > 1) {
    inner = <OrgSwitcher />;
  } else if (orgName) {
    inner = (
      <div
        className="truncate px-2 py-1.5 text-sm font-semibold text-[var(--sparrow-text)]"
        title={orgName}
      >
        {orgName}
      </div>
    );
  } else {
    return null;
  }
  return <div className="border-b border-[var(--sparrow-border)] px-2 py-2">{inner}</div>;
}

function OrgSwitcher() {
  const auth = useAuth();
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const current = auth.orgs.find((o) => o.org.id === orgId);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-[var(--sparrow-text)] transition-colors hover:bg-[var(--sparrow-panel-2)]"
      >
        <span className="min-w-0 flex-1 truncate">{current?.org.name ?? 'Org'}</span>
        <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-[var(--sparrow-muted)]" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-2 right-2 z-50 mt-1 rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel)] py-1 shadow-lg"
        >
          {auth.orgs.map((o) => (
            <button
              key={o.org.id}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate(orgPath(o.org.id));
              }}
              className={`block w-full truncate px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--sparrow-panel-2)] ${
                o.org.id === orgId ? 'text-[var(--sparrow-accent)]' : 'text-[var(--sparrow-muted)]'
              }`}
            >
              {o.org.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarSection({
  label,
  onAdd,
  addLabel,
  children,
}: {
  label: string;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-[var(--sparrow-border)] pb-1">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
          {label}
        </span>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel}
            title={addLabel}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--sparrow-faint)] transition-colors hover:bg-[var(--sparrow-panel-2)] hover:text-[var(--sparrow-accent)]"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <nav aria-label={label}>{children}</nav>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-1.5 text-xs text-[var(--sparrow-faint)]">{children}</p>;
}

const ROW_CLASS =
  'flex min-h-[40px] w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors md:min-h-0 md:py-2';

function PrincipalRow({
  entry,
  active,
  onOpen,
}: {
  entry: PrincipalEntry;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      data-never-seen={entry.neverSeen ? '' : undefined}
      className={`${ROW_CLASS} ${
        active
          ? 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-text)]'
          : `text-[var(--sparrow-muted)] hover:bg-[var(--sparrow-panel-2)] hover:text-[var(--sparrow-text)] ${
              entry.neverSeen ? 'opacity-60 hover:opacity-100' : ''
            }`
      }`}
    >
      <PresenceAvatar
        kind="human"
        id={entry.principalId}
        displayName={entry.displayName}
        avatarUrl={entry.avatarUrl}
        presence={entry.online ? 'online' : 'offline'}
        busy={entry.busy}
      />
      {/* Same unread-bolding convention as the agent rows. */}
      <span
        className={`min-w-0 flex-1 truncate ${
          entry.unread > 0 ? 'font-semibold text-[var(--sparrow-text)]' : ''
        }`}
      >
        {entry.displayName}
      </span>
      {entry.unread > 0 && <CountBadge count={entry.unread} />}
    </button>
  );
}

/**
 * The AGENTS row tooltip: ownership (yours / shared by whom), with the agent's
 * org-visible role title folded in when it has one (`Your agent · Support triage`).
 */
function agentRowTooltip(entry: AgentEntry): string {
  const base = entry.owned ? 'Your agent' : `Shared by ${entry.ownerName}`;
  return entry.roleTitle ? `${base} · ${entry.roleTitle}` : base;
}

function AgentRow({
  entry,
  orgId,
  active,
  onOpen,
}: {
  entry: AgentEntry;
  orgId: string;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={`group flex w-full items-center gap-1.5 pr-1.5 hover:bg-[var(--sparrow-panel-2)] ${
        active
          ? 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-text)]'
          : 'text-[var(--sparrow-muted)]'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={`${ROW_CLASS} min-w-0 flex-1`}
        title={agentRowTooltip(entry)}
      >
        <PresenceAvatar
          kind="agent"
          id={entry.agentId}
          displayName={entry.displayName}
          presence={entry.online ? 'online' : 'offline'}
          busy={entry.busy}
        />
        {/* Unread bolds the NAME too — the count badge alone was easy to miss. */}
        <span
          className={`min-w-0 flex-1 truncate ${
            entry.unread > 0 ? 'font-semibold text-[var(--sparrow-text)]' : ''
          }`}
        >
          {entry.displayName}
        </span>
        {/* ONE number per agent: unread chat + unread email. The breakdown lives
            in the tooltip AS TEXT; approvals never count here (they belong to
            the top-nav pending pill). */}
        {entry.unread > 0 && (
          <CountBadge
            count={entry.unread}
            title={unreadTooltip(entry.chatUnread, entry.emailUnread)}
          />
        )}
      </button>
      <Link
        to={agentProfilePath(orgId, entry.agentId)}
        aria-label={`Profile for ${entry.displayName}`}
        title="Agent profile"
        // Always visible (muted): the old `md:opacity-0` hover trick made the
        // gear undiscoverable with a pointer and a coin flip on touch.
        className="shrink-0 rounded p-2 text-[var(--sparrow-faint)] transition-colors hover:text-[var(--sparrow-accent)] md:p-1"
      >
        <Gear size={14} />
      </Link>
    </div>
  );
}

function RoomRow({
  entry,
  orgId,
  active,
  archived = false,
}: {
  entry: RoomEntry;
  orgId: string;
  active: boolean;
  archived?: boolean;
}) {
  return (
    <div
      className={`group flex w-full items-center gap-1.5 pr-1.5 hover:bg-[var(--sparrow-panel-2)] ${
        archived ? 'pl-4 opacity-60 hover:opacity-100' : ''
      } ${
        active
          ? 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-text)] opacity-100'
          : 'text-[var(--sparrow-muted)]'
      }`}
    >
      <Link
        to={roomPath(orgId, entry.roomId)}
        aria-current={active ? 'page' : undefined}
        className="flex min-h-[40px] min-w-0 flex-1 items-center gap-1.5 px-3 py-2.5 text-left text-sm md:min-h-0 md:py-2"
      >
        <span
          className={`min-w-0 flex-1 truncate ${
            entry.unread > 0 ? 'font-semibold text-[var(--sparrow-text)]' : 'font-medium'
          }`}
        >
          #{entry.name || entry.roomId}
        </span>
        {entry.busy && <RoomBusyGlyph />}
        {entry.unread > 0 && <CountBadge count={entry.unread} />}
      </Link>
      <Link
        to={roomSettingsPath(orgId, entry.roomId)}
        aria-label={`Settings for ${entry.name || entry.roomId}`}
        title="Room settings"
        // Always visible (muted) — see the agent row gear above.
        className="shrink-0 rounded p-2 text-[var(--sparrow-faint)] transition-colors hover:text-[var(--sparrow-accent)] md:p-1"
      >
        <Gear size={14} />
      </Link>
    </div>
  );
}

function CountBadge({ count, title }: { count: number; title?: string | null }) {
  return (
    <span
      title={title ?? undefined}
      className="mono inline-flex min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-[var(--sparrow-accent)] px-1 text-[10px] font-semibold leading-4 text-black"
    >
      {count}
    </span>
  );
}

function Hamburger() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 8 8"
      className={`h-2 w-2 shrink-0 text-[var(--sparrow-faint)] transition-transform motion-reduce:transition-none ${
        expanded ? 'rotate-90' : ''
      }`}
      fill="currentColor"
    >
      <path d="M2 0l4 4-4 4z" />
    </svg>
  );
}
