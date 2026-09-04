import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import type {
  EmailApprovalItem,
  EmailQuarantinedEvent,
  EmailResolvedEvent,
  EnrollmentSummary,
  Invite,
  EnrollmentRequestedEvent,
  VisibilityAgent,
} from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { useAuth } from '../lib/auth.js';
import { useCapabilities } from '../lib/capabilities.js';
import { api } from '../lib/client.js';
import { useMeEventStream } from '../lib/meEvents.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';
import {
  EmailApprovalRow,
  type ExternalResolution,
} from '../components/email/EmailApprovalRow.js';

/**
 * Approvals (`/me/approvals`) — the PERSONAL approval surface, unified across
 * enrollments and email (SPEC v4 → *Web UI → Approvals*). `/me/invites`
 * redirects here. It renders INSIDE the app shell (see `MeLayout` in App.tsx),
 * so this page contributes only its own content column, not any page chrome.
 *
 * Two groups on one page, each with its own count:
 *
 *  - **Enrollments** — unchanged from v3: pending enrollments arriving through
 *    the caller's OWN invites (strictly yes/no Approve — the proposed name is
 *    shown, never editable — and Deny) plus the invites they have sent, each
 *    revocable. Live via `enrollment.requested` / `enrollment.resolved`.
 *  - **Email** — quarantined inbound and held outbound for agents the caller
 *    OWNS, across every org they belong to (one section per org when
 *    multi-org), ordered OLDEST-FIRST: the oldest thing waiting is the thing to
 *    do. Inbound and outbound are visually distinguished but share one list.
 *    Live via `email.quarantined` / `email.held` (insert) and `email.resolved`
 *    (resolve in place, including when someone else acted first).
 *
 * Both halves filter to what is THEIRS client-side: the server scopes a plain
 * member already, but an org owner/admin would otherwise see every coworker's
 * enrollments and every agent's mail. Org-wide review is org admin's job; this
 * page is personal.
 *
 * With `capabilities.email` false there is NO Email group at all — no heading,
 * no fetch — and the page is exactly v3's invites surface under its new name.
 */

/** One pending enrollment, tagged with the org it belongs to. */
interface EnrollmentRow {
  orgId: string;
  orgName: string;
  enrollment: EnrollmentSummary;
}

/** One sent invite, tagged with the org it belongs to. */
interface InviteRow {
  orgId: string;
  orgName: string;
  invite: Invite;
}

/** One pending email, tagged with the org whose queue it came from. */
interface EmailRow {
  orgId: string;
  orgName: string;
  item: EmailApprovalItem;
}

/** The caller owns an agent when they are its owner AND it was not shared to them. */
function ownedAgentIds(agents: VisibilityAgent[], userId: string): Set<string> {
  return new Set(
    agents.filter((a) => a.owner.id === userId && a.sharedBy === null).map((a) => a.agent.id),
  );
}

export function MyApprovals() {
  useDocumentTitle(pageTitle('Approvals'));
  const auth = useAuth();
  const caps = useCapabilities();
  const emailOn = caps.email;
  const userId = auth.user?.id ?? null;
  const orgs = auth.orgs;
  const multiOrg = orgs.length > 1;

  const [enrollments, setEnrollments] = useState<EnrollmentRow[] | null>(null);
  const [invites, setInvites] = useState<InviteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The email queue is two sources that must not clobber each other: what the
  // per-org fetch returned, and rows a live `email.quarantined`/`email.held`
  // pushed in. Keeping them apart means a refetch landing after an event never
  // drops the row the event just inserted.
  const [emailFetched, setEmailFetched] = useState<EmailRow[] | null>(null);
  const [emailLive, setEmailLive] = useState<EmailRow[]>([]);
  /** emailId → the resolution that arrived on `/me/events` (someone else acted). */
  const [resolutions, setResolutions] = useState<Record<string, ExternalResolution>>({});
  /** emailIds this page itself resolved — settled, so no longer "waiting". */
  const [settled, setSettled] = useState<Set<string>>(() => new Set());

  /* ---- sources ------------------------------------------------------- */

  /** Rebuild the enrollment aggregate across all orgs, keeping only my rows. */
  const loadEnrollments = useCallback(async () => {
    if (!userId) return;
    try {
      const perOrg = await Promise.all(
        orgs.map(async (o) => {
          const [invs, enrs] = await Promise.all([
            api.listInvites(o.org.id).catch(() => [] as Invite[]),
            api.listEnrollments(o.org.id).catch(() => [] as EnrollmentSummary[]),
          ]);
          return { org: o.org, invs, enrs };
        }),
      );
      const invRows: InviteRow[] = [];
      const enrRows: EnrollmentRow[] = [];
      for (const r of perOrg) {
        for (const invite of r.invs) {
          if (invite.inviter.id === userId) {
            invRows.push({ orgId: r.org.id, orgName: r.org.name, invite });
          }
        }
        for (const enrollment of r.enrs) {
          if (enrollment.inviter.id === userId) {
            enrRows.push({ orgId: r.org.id, orgName: r.org.name, enrollment });
          }
        }
      }
      setInvites(invRows);
      setEnrollments(enrRows);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setInvites((prev) => prev ?? []);
      setEnrollments((prev) => prev ?? []);
    }
  }, [userId, orgs]);

  // orgId → the agents the caller owns there. `GET /orgs/:orgId/email/approvals`
  // hands an org owner/admin EVERY agent's queue, so this filter is what makes
  // the surface personal. It is STATE, not a ref, and the filter is applied when
  // rendering rather than when inserting: a live event that lands before the
  // visibility list has loaded is then filtered correctly instead of dropped.
  const [ownedByOrg, setOwnedByOrg] = useState<Record<string, Set<string>>>({});
  const orgNamesRef = useRef<Map<string, string>>(new Map());
  orgNamesRef.current = new Map(orgs.map((o) => [o.org.id, o.org.name]));

  /** Rebuild the email queue across all orgs, filtered to agents I own. */
  const loadEmail = useCallback(async () => {
    // Render is gated on the capability and so is DISCOVERY: with the medium
    // off the routes 404, and a client must never learn about a medium by
    // taking a 404.
    if (!emailOn || !userId) {
      setEmailFetched(emailOn ? null : []);
      return;
    }
    const perOrg = await Promise.all(
      orgs.map(async (o) => {
        const [queue, agents] = await Promise.all([
          api.listEmailApprovals(o.org.id).catch(() => null),
          api.orgMeAgents(o.org.id).catch(() => [] as VisibilityAgent[]),
        ]);
        return {
          org: o.org,
          owned: ownedAgentIds(agents, userId),
          rows: (queue?.items ?? []).map(
            (item): EmailRow => ({ orgId: o.org.id, orgName: o.org.name, item }),
          ),
        };
      }),
    );
    setOwnedByOrg(Object.fromEntries(perOrg.map((r) => [r.org.id, r.owned])));
    setEmailFetched(perOrg.flatMap((r) => r.rows));
  }, [emailOn, userId, orgs]);

  useEffect(() => {
    void loadEnrollments();
  }, [loadEnrollments]);
  useEffect(() => {
    void loadEmail();
  }, [loadEmail]);

  /* ---- live (`GET /me/events`) --------------------------------------- */

  // Reload the enrollment aggregate on a new request through MY invite, or on
  // any resolution (the resolved event can't reveal the inviter, so we always
  // refetch). Email approvals insert and resolve in place — no refetch, so two
  // approvers watching one row never fight over it. The connection is the app's
  // shared one (lib/meEvents); a reconnect may have missed frames, so reconcile.
  const loadRef = useRef(loadEnrollments);
  loadRef.current = loadEnrollments;
  const emailOnRef = useRef(emailOn);
  emailOnRef.current = emailOn;
  useMeEventStream({
    enabled: Boolean(userId),
    onReconnect: () => void loadRef.current(),
    onEvent: (ev) => {
      if (ev.type === 'enrollment.requested') {
        const data = ev.data as EnrollmentRequestedEvent;
        if (data.enrollment.inviter.id === userId) void loadRef.current();
      } else if (ev.type === 'enrollment.resolved') {
        void loadRef.current();
      } else if (ev.type === 'email.quarantined' || ev.type === 'email.held') {
        if (!emailOnRef.current) return;
        const data = ev.data as EmailQuarantinedEvent;
        const orgId = data.thread?.orgId;
        // An org this page is not showing → not this surface's business. (The
        // owned-agent filter — the event also fans out to org owners/admins —
        // is applied when rendering, so it holds even for an event that beats
        // the visibility list.)
        const orgName = orgId ? orgNamesRef.current.get(orgId) : undefined;
        if (!orgId || orgName === undefined) return;
        setEmailLive((prev) =>
          prev.some((r) => r.item.email.id === data.email.id)
            ? prev
            : [
                ...prev,
                {
                  orgId,
                  orgName,
                  // The stream nudges, the client fetches: the event carries a
                  // preview, so verification/judge fill in when the row is
                  // expanded (the card fetches the full email then).
                  item: {
                    email: data.email,
                    thread: data.thread,
                    agent: data.agent,
                    verification: null,
                    judge: null,
                  },
                },
              ],
        );
      } else if (ev.type === 'email.resolved') {
        if (!emailOnRef.current) return;
        const data = ev.data as EmailResolvedEvent;
        setResolutions((prev) =>
          prev[data.email.id]
            ? prev
            : { ...prev, [data.email.id]: { resolution: data.resolution, by: data.by } },
        );
      }
      // Anything else on this stream is not this page's business — ignored
      // silently, never logged (the forward-compat rule).
    },
  });

  /* ---- derived ------------------------------------------------------- */

  /**
   * One list per org, OLDEST-FIRST: the oldest thing waiting is the thing to do.
   * Fetched and live rows merge by email id (the live row wins — it is newer),
   * so a refetch landing mid-stream never duplicates or drops one.
   */
  const emailGroups = useMemo(() => {
    const byId = new Map<string, EmailRow>();
    for (const row of [...(emailFetched ?? []), ...emailLive]) {
      if (!ownedByOrg[row.orgId]?.has(row.item.agent.id)) continue;
      byId.set(row.item.email.id, row);
    }
    const rows = [...byId.values()].sort((a, b) =>
      a.item.email.createdAt.localeCompare(b.item.email.createdAt),
    );
    return orgs
      .map((o) => ({
        orgId: o.org.id,
        orgName: o.org.name,
        rows: rows.filter((r) => r.orgId === o.org.id),
      }))
      .filter((g) => g.rows.length > 0);
  }, [emailFetched, emailLive, ownedByOrg, orgs]);

  const emailWaiting = emailGroups
    .flatMap((g) => g.rows)
    .filter((r) => !settled.has(r.item.email.id) && !resolutions[r.item.email.id]).length;

  /* ---- actions ------------------------------------------------------- */

  async function approve(row: EnrollmentRow) {
    const e = row.enrollment;
    if (busyId) return;
    setBusyId(e.id);
    setError(null);
    try {
      await api.approveEnrollment(row.orgId, e.id);
      await loadEnrollments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not approve this request.');
    } finally {
      setBusyId(null);
    }
  }

  async function deny(row: EnrollmentRow) {
    const e = row.enrollment;
    if (busyId) return;
    setBusyId(e.id);
    setError(null);
    try {
      await api.denyEnrollment(row.orgId, e.id);
      await loadEnrollments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not decline this request.');
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(row: InviteRow) {
    const id = row.invite.id;
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await api.revokeInvite(row.orgId, id);
      await loadEnrollments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke this invite.');
    } finally {
      setBusyId(null);
    }
  }

  /* ---- guards -------------------------------------------------------- */

  if (auth.booting) {
    return (
      <Frame>
        <Loading />
      </Frame>
    );
  }

  if (!auth.user) {
    return (
      <Frame>
        <Panel>
          <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">
            Sign in to see your approvals
          </h2>
          <p className="mt-1 text-sm text-[var(--sparrow-muted)]">
            Requests waiting on you — and the invites you&rsquo;ve sent — live here once you sign
            in.
          </p>
          <Link
            to="/login?next=/me/approvals"
            className="mt-4 inline-flex min-h-[40px] items-center rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
          >
            Sign in
          </Link>
        </Panel>
      </Frame>
    );
  }

  const loading = enrollments === null || invites === null;

  return (
    <Frame>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="mt-1.5 text-sm text-[var(--sparrow-muted)]">
          Everything waiting on you personally — enrollments through your invites
          {emailOn ? ', and email for your agents' : ''}.
        </p>
      </div>

      {error && (
        <p className="mb-4 text-sm text-[var(--sparrow-danger)]" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-10">
          {/* ---- Enrollments ------------------------------------------- */}
          <Group title="Enrollments" count={enrollments.length}>
            <div className="flex flex-col gap-8">
              <Section title="Pending requests" lead="People and agents waiting on your invites.">
                {enrollments.length === 0 ? (
                  <Notice>No pending requests.</Notice>
                ) : (
                  <div className="flex flex-col gap-3">
                    {enrollments.map((row) => {
                      const e = row.enrollment;
                      const who =
                        e.kind === 'agent'
                          ? e.proposedName || 'New agent'
                          : e.displayName || e.email || 'Someone';
                      return (
                        <Panel key={e.id}>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-[var(--sparrow-text)]">
                                {who}
                              </span>
                              <span className="rounded bg-[var(--sparrow-panel-2)] px-1.5 py-0.5 text-[10px] font-medium capitalize text-[var(--sparrow-muted)]">
                                {e.kind === 'agent' ? 'agent' : 'person'}
                              </span>
                              {multiOrg && <OrgTag name={row.orgName} />}
                            </div>
                            {e.kind === 'human' && e.email && (
                              <p className="truncate text-xs text-[var(--sparrow-muted)]">
                                {e.email}
                              </p>
                            )}
                            {e.note && (
                              <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
                                &ldquo;{e.note}&rdquo;
                              </p>
                            )}
                            <p className="mt-1 text-xs text-[var(--sparrow-faint)]">
                              Requested {fmtDate(e.createdAt)}
                            </p>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void approve(row)}
                              disabled={busyId === e.id}
                              className={primaryBtn}
                            >
                              {busyId === e.id ? 'Working…' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void deny(row)}
                              disabled={busyId === e.id}
                              className={dangerGhostBtn}
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

              <Section
                title="Invites you’ve sent"
                lead="Invite links you created to bring people and agents in."
              >
                {invites.length === 0 ? (
                  <Notice>You haven&rsquo;t sent any invites.</Notice>
                ) : (
                  <div className="flex flex-col gap-3">
                    {invites.map((row) => {
                      const inv = row.invite;
                      const revoked = inv.revokedAt !== null;
                      return (
                        <Panel key={inv.id}>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm text-[var(--sparrow-text)]">
                                  {inv.note || 'No note'}
                                </span>
                                {multiOrg && <OrgTag name={row.orgName} />}
                                {revoked && (
                                  <span className="rounded bg-[var(--sparrow-panel-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--sparrow-faint)]">
                                    revoked
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-xs text-[var(--sparrow-faint)]">
                                Created {fmtDate(inv.createdAt)} · expires {fmtDate(inv.expiresAt)}
                              </p>
                            </div>
                            {!revoked && (
                              <button
                                type="button"
                                onClick={() => void revoke(row)}
                                disabled={busyId === inv.id}
                                className={dangerGhostBtn}
                              >
                                {busyId === inv.id ? 'Working…' : 'Revoke'}
                              </button>
                            )}
                          </div>
                        </Panel>
                      );
                    })}
                  </div>
                )}
              </Section>
            </div>
          </Group>

          {/* ---- Email (only with the medium on) ------------------------ */}
          {emailOn && (
            <Group title="Email" count={emailWaiting}>
              <p className="mb-3 text-sm text-[var(--sparrow-muted)]">
                Mail held for your agents — oldest first.
              </p>
              {emailGroups.length === 0 ? (
                <Notice>No email is waiting for you.</Notice>
              ) : (
                <div className="flex flex-col gap-6">
                  {emailGroups.map((group) => (
                    <div key={group.orgId}>
                      {multiOrg && (
                        <h3 className="mb-2 text-sm font-semibold text-[var(--sparrow-muted)]">
                          {group.orgName}
                        </h3>
                      )}
                      <div className="flex flex-col gap-3">
                        {group.rows.map((row) => (
                          <EmailApprovalRow
                            key={row.item.email.id}
                            orgId={row.orgId}
                            item={row.item}
                            resolution={resolutions[row.item.email.id] ?? null}
                            onResolved={(emailId) =>
                              setSettled((prev) => new Set(prev).add(emailId))
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Group>
          )}
        </div>
      )}
    </Frame>
  );
}

/* -------------------------------------------------------------------------- */
/* Chrome + shared bits                                                       */
/* -------------------------------------------------------------------------- */

const primaryBtn =
  'inline-flex min-h-[40px] items-center rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50';

const dangerGhostBtn =
  'inline-flex min-h-[40px] items-center rounded-md border border-[var(--sparrow-border)] px-4 py-2.5 text-sm text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50';

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">{children}</div>
    </div>
  );
}

/** One of the page's two groups: a heading that CARRIES ITS OWN COUNT. */
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold tracking-tight">
        {title}
        <span className="mono rounded-full bg-[var(--sparrow-panel-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--sparrow-muted)]">
          {count}
        </span>
      </h2>
      {children}
    </section>
  );
}

function Section({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-0.5 mb-3 text-sm text-[var(--sparrow-muted)]">{lead}</p>
      {children}
    </section>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-4">
      {children}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
      <p className="text-sm text-[var(--sparrow-muted)]">{children}</p>
    </div>
  );
}

function OrgTag({ name }: { name: string }) {
  return (
    <span className="rounded bg-[var(--sparrow-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--sparrow-accent)]">
      {name}
    </span>
  );
}

function Loading() {
  return <p className="text-sm text-[var(--sparrow-faint)]">Loading…</p>;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
