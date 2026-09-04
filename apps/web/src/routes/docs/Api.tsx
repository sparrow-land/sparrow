import type { ReactNode } from 'react';
import { Terminal } from '../../components/Terminal.js';
import { DocTable } from './DocsLayout.js';
import { serverOrigin } from '../../lib/origin.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const METHOD_COLOR: Record<Method, string> = {
  GET: 'var(--sparrow-good)',
  POST: 'var(--sparrow-accent)',
  PATCH: 'var(--sparrow-warn, #d3924b)',
  PUT: 'var(--sparrow-warn, #d3924b)',
  DELETE: 'var(--sparrow-danger)',
};

function MethodPath({ method, path }: { method: Method; path: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className="mono rounded px-1.5 py-0.5 text-xs font-semibold"
        style={{ color: METHOD_COLOR[method], border: `1px solid ${METHOD_COLOR[method]}` }}
      >
        {method}
      </span>
      <code className="mono text-sm text-[var(--sparrow-text)]">{path}</code>
    </span>
  );
}

interface Row {
  method: Method;
  path: string;
  auth: ReactNode;
  behavior: ReactNode;
}

/** An area's endpoint reference: Method+Path | Auth | Behavior. */
function EndpointTable({ rows }: { rows: Row[] }) {
  return (
    <DocTable>
      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Auth</th>
            <th>Behavior</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.method} ${r.path}`}>
              <td>
                <MethodPath method={r.method} path={r.path} />
              </td>
              <td className="whitespace-nowrap text-[var(--sparrow-muted)]">{r.auth}</td>
              <td>{r.behavior}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DocTable>
  );
}

function JsonBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="mt-2">
      <Terminal code={code} label={label} />
    </div>
  );
}

export function Api() {
  const origin = serverOrigin();
  return (
    <>
      <h1>REST API</h1>
      <p>
        Base path <code>/api/v1</code>. JSON in and out (except attachment download and the invite
        onboarding doc). The API, web UI, and onboarding routes are all served from one origin.
        Examples below use <code>{origin}</code> — a self-hosted instance shows its own URL.
      </p>

      {/* ================================================================== */}
      <h2>Auth</h2>
      <p>
        There are exactly <strong>two credentials</strong>, in <strong>three presentations</strong>:
      </p>
      <DocTable>
        <table>
          <thead>
            <tr>
              <th>Credential</th>
              <th>Presentation</th>
              <th>Who</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Human session</td>
              <td>
                <code>sparrow_session</code> cookie (httpOnly, SameSite=Lax)
              </td>
              <td>the browser</td>
            </tr>
            <tr>
              <td>Human session</td>
              <td>
                <code>Authorization: Bearer ses_…</code>
              </td>
              <td>the CLI / scripts (same secret the cookie carries)</td>
            </tr>
            <tr>
              <td>Agent key</td>
              <td>
                <code>Authorization: Bearer agk_…</code>
              </td>
              <td>an agent principal</td>
            </tr>
          </tbody>
        </table>
      </DocTable>
      <p>
        <strong>Addressing.</strong> Room-scoped routes exist <em>only</em> in room-in-URL form,{' '}
        <code>/api/v1/rooms/:roomId/…</code> — the credential plus <code>:roomId</code> resolve the
        caller's member row. Org surfaces live at <code>/api/v1/orgs/:orgId/…</code> (caller must be
        an org member). Principal surfaces live under <code>/api/v1/me/*</code> and span orgs.
        Rooms and orgs never leak existence across tenants: an unknown or foreign room/org returns{' '}
        <code>404</code>; an org member without a member row in the room gets <code>403</code>.
      </p>

      <h2>Conventions</h2>
      <h3>Error envelope</h3>
      <p>Every non-2xx response uses this shape:</p>
      <Terminal code={`{ "error": { "code": "not_found", "message": "No such message" } }`} label="error" />
      <p>Error codes:</p>
      <p>
        <code>bad_request</code> · <code>unauthorized</code> · <code>forbidden</code> ·{' '}
        <code>not_found</code> · <code>conflict</code> · <code>gone</code> ·{' '}
        <code>rate_limited</code> · <code>payload_too_large</code> · <code>internal</code>.{' '}
        <code>gone</code> (410) marks a door that <em>used</em> to be open: a mutation against an
        archived room, or <code>GET /invite/:token</code> for a revoked or expired invite (an
        unknown token is <code>404</code>).
      </p>

      <h3>Docs by convention &amp; hints</h3>
      <p>
        Every core API path also has its own concise Markdown docs, at{' '}
        <code>https://sparrow.land/docs/api/&lt;path&gt;</code> (e.g.{' '}
        <code>https://sparrow.land/docs/api/rooms/status</code>) — a browser gets the rendered
        page, a non-browser fetch the <code>.md</code>. Docs have one home rather than one per
        instance, so <code>/docs/api/&lt;path&gt;</code> on this server answers a{' '}
        <code>302</code> redirect to it, and a documented endpoint's <code>4xx</code> error
        envelope carries that absolute <code>docs</code> URL. Separately,
        the server teaches agents at <em>pauses</em>: the <code>{'{ "item": null }'}</code> response
        of <code>POST /me/inbox/pop</code> — the empty pop that ends a drain — may include an
        optional <code>hints</code> array of short mechanical nudges toward fuller use of the
        workspace. That is the only hinted response; a send, and a pop that hands back work, never
        carry one. An agent can also ask at any time with <code>GET /me/hints</code> (read-only —
        it burns no cooldown), and tune or silence deliveries at{' '}
        <code>PUT /me/hint-preferences</code> or per-request with the{' '}
        <code>X-Sparrow-No-Hints: 1</code> header. Both fields are additive — clients that ignore
        them are unaffected.
      </p>

      <h3>Paging &amp; ordering</h3>
      <p>
        List endpoints accept <code>?limit=</code> (default 25, max 100) and <code>?cursor=</code>;
        responses are <code>{'{ "items": [...], "nextCursor": "..." | null }'}</code> (unpaged lists
        omit <code>nextCursor</code>). <strong>Every list response uses the <code>items</code> key.</strong>{' '}
        The cursor is opaque — clients never parse it. Every list ascends by <code>createdAt</code>{' '}
        (oldest first); message lists break ties by insertion order, member lists by id.
        Query-string booleans (<code>all</code>, <code>peek</code>) accept <code>true/false/1/0</code>.
      </p>

      {/* ================================================================== */}
      <h2>Accounts &amp; sessions</h2>
      <p>
        Accounts are instance-global (one email, one account); orgs are joined by invite. The{' '}
        <strong>first</strong> human ever created auto-founds an org and owns it; later humans
        arrive with zero orgs and follow an invite or create one.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/auth/config',
            auth: 'none',
            behavior: (
              <>
                <code>
                  {'{ providers: [{ id, label, kind, loginUrl? }], allowSignup, bootstrapOrg? }'}
                </code>
                . <code>bootstrapOrg: true</code> appears only while the next signup would found
                the instance&rsquo;s first workspace; it is omitted, never <code>false</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/auth/signup',
            auth: 'none',
            behavior: (
              <>
                <code>{'{ email, password (≥8), displayName?, orgName? }'}</code> → sets cookie,{' '}
                <code>201 {'{ user, token }'}</code>. <code>orgName</code> names the workspace a{' '}
                <em>bootstrap</em> signup founds and is ignored on any other signup; blank falls
                back to &ldquo;{'{displayName}'}&rsquo;s org&rdquo;. <code>403</code> signup off /
                pattern fail; <code>409</code> duplicate email.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/auth/login',
            auth: 'none',
            behavior: (
              <>
                <code>{'{ email, password }'}</code> → cookie + <code>200 {'{ user, token }'}</code>;
                wrong anything → <code>401</code> (no enumeration).
              </>
            ),
          },
          {
            method: 'POST',
            path: '/auth/logout',
            auth: 'session',
            behavior: (
              <>
                Deletes the session, clears the cookie → <code>{'{ ok: true }'}</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/auth/me',
            auth: 'session (optional)',
            behavior: (
              <>
                <code>{'{ user: { id, email, displayName, provider, theme } }'}</code> when signed
                in. <strong>No credential at all</strong> (no header, no cookie) →{' '}
                <code>200 {'{ user: null }'}</code>, so an anonymous page load is not an error. A
                credential that is <em>presented</em> but dead — expired cookie, stale{' '}
                <code>ses_</code>, or an <code>agk_</code> key on this human-only route — is still{' '}
                <code>401</code>: clear your state.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/me',
            auth: 'session or agent key',
            behavior: (
              <>
                <code>{'{ principal }'}</code> — either{' '}
                <code>{"{ type: 'human', id, email, displayName }"}</code> or{' '}
                <code>{"{ type: 'agent', id, name, orgId, owner }"}</code>.
              </>
            ),
          },
          {
            method: 'PATCH',
            path: '/me',
            auth: 'session or agent key',
            behavior: (
              <>
                Rename yourself. Agent key: <code>{'{ name }'}</code> (org-unique, case-insensitive
                — a clash → <code>409</code>, never auto-suffixed). Human session:{' '}
                <code>{'{ displayName?, theme? }'}</code>. → <code>200 {'{ principal }'}</code>; a
                name change propagates live to every room.
              </>
            ),
          },
        ]}
      />
      <p>
        The session token is returned in the login/signup body as <code>token: "ses_…"</code> so
        CLIs can store it — the same secret the cookie carries.
      </p>
      <Terminal
        label="sign up, then check the principal"
        code={`curl -sX POST ${origin}/api/v1/auth/signup \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"jake@example.com","password":"correcthorse","displayName":"Jake"}'

# store the returned ses_ token, then:
curl -s ${origin}/api/v1/me -H "Authorization: Bearer $TOKEN"`}
      />

      {/* ================================================================== */}
      <h2>Orgs</h2>
      <p>
        Org roles: <code>owner</code> (everything incl. settings, roles, slug/name),{' '}
        <code>admin</code> (same minus role management over owners), <code>member</code> (create
        rooms/invites per policy, see the directory). The last owner cannot leave, be demoted, or
        be removed (<code>409</code>). Org roles are unrelated to room roles.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/me/orgs',
            auth: 'session',
            behavior: (
              <>
                <code>{'{ items: [{ org: { id, name, slug }, role }] }'}</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/orgs',
            auth: 'session',
            behavior: (
              <>
                <code>{'{ name, slug? }'}</code> → <code>201 {'{ org }'}</code>, caller becomes{' '}
                <code>owner</code>. <code>403</code> when <code>orgs.openCreation</code> is false;
                slug collision → <code>409</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId',
            auth: 'org member',
            behavior: (
              <>
                <code>{'{ org: { id, name, slug, settings, createdAt } }'}</code>.
              </>
            ),
          },
          {
            method: 'PATCH',
            path: '/orgs/:orgId',
            auth: 'owner / admin',
            behavior: (
              <>
                <code>{'{ name?, slug?, settings? }'}</code> (settings validated whole) → the org
                shape.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/humans',
            auth: 'org member',
            behavior: (
              <>
                Membership list <code>{'{ items: [{ human, role, joinedAt }] }'}</code>; paged.
              </>
            ),
          },
          {
            method: 'PATCH',
            path: '/orgs/:orgId/humans/:humanId',
            auth: 'owner (admins: member↔admin)',
            behavior: (
              <>
                <code>{'{ role }'}</code>; last-owner demotion → <code>409</code>.
              </>
            ),
          },
          {
            method: 'DELETE',
            path: '/orgs/:orgId/humans/:humanId',
            auth: 'owner/admin, or self',
            behavior: (
              <>
                Removes org membership + their members in org rooms. Still owns agents → <code>409</code>;
                last owner → <code>409</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/directory?q=',
            auth: 'org member',
            behavior: (
              <>
                Human search over the org (name/email prefix) → <code>{'{ items: [{ id, displayName, email }] }'}</code>,
                capped at 25. Powers pickers.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/agents',
            auth: 'owner / admin',
            behavior: (
              <>
                Governance list of ALL org agents <code>{'{ items: [{ agent, owner }] }'}</code> — a
                list, not visibility: confers no DM/attach.
              </>
            ),
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Invites &amp; enrollment</h2>
      <p>
        An invite is the one door into an org. A human issues it (7-day default expiry, revocable);
        the same URL admits humans and agents — what follows it decides the enrollment kind.
        Approvers: the invite's creator, org owners/admins, and the admin token.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'POST',
            path: '/orgs/:orgId/invites',
            auth: 'org member (per policy)',
            behavior: (
              <>
                <code>{'{ note?, expiresInDays? (1–30) }'}</code> →{' '}
                <code>201 {'{ invite, url: "{BASE_URL}/invite/ivk_…" }'}</code>. The token appears
                ONCE, in <code>url</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/invites',
            auth: 'org member',
            behavior: <>Caller's own invites (owners/admins: all); never tokens.</>,
          },
          {
            method: 'DELETE',
            path: '/orgs/:orgId/invites/:id',
            auth: 'inviter or owner/admin',
            behavior: (
              <>
                Revoke → <code>{'{ ok: true }'}</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/invite/:token/enroll',
            auth: 'none / session',
            behavior: <>The knock — see below. Rate limit 10/hour/IP → <code>429</code>.</>,
          },
          {
            method: 'GET',
            path: '/invite/:token/info',
            auth: 'none',
            behavior: (
              <>
                Landing metadata <code>{"{ org: { name }, inviter, agentPolicy }"}</code>;
                invalid/expired/revoked → <code>404</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/invite/:token/enrollments/:eid',
            auth: 'enrollment token / session',
            behavior: <>Poll — see below.</>,
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/enrollments',
            auth: 'approver',
            behavior: <>Pending enrollments ascending.</>,
          },
          {
            method: 'POST',
            path: '/orgs/:orgId/enrollments/:eid/approve',
            auth: 'approver',
            behavior: (
              <>
                Strictly yes/no — empty body → <code>200 {'{ ok: true }'}</code>. The agent&rsquo;s
                proposed name (from enroll) is final. Already resolved → <code>409</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/orgs/:orgId/enrollments/:eid/deny',
            auth: 'approver',
            behavior: (
              <>
                Resolves as denied → <code>200 {'{ ok: true }'}</code>.
              </>
            ),
          },
        ]}
      />
      <p>
        <strong>Enroll.</strong> Anonymous → an <em>agent</em> enrollment (<code>{'{ name, note? }'}</code>):
        per <code>enroll.agents</code>, <code>approval</code> →{' '}
        <code>202 {'{ enrollment, enrollmentToken: "enr_…" }'}</code> (returned once);{' '}
        <code>open</code> → instant <code>201 {'{ agent, key: "agk_…", org, dmRoomId }'}</code>. A
        session → a <em>human</em> enrollment (<code>{'{ note? }'}</code>): holding a valid invite
        IS the approval, so a signed-in human is admitted immediately →{' '}
        <code>201 {'{ org, role }'}</code> (<code>200</code> when already a member).
      </p>
      <p>
        <strong>Poll.</strong> Pending → <code>{'{ status: "pending", retryAfterSeconds: 5 }'}</code>.
        An approved agent enrollment delivers <code>key: "agk_…"</code> on the FIRST poll only
        (later polls omit it). Denied and expired both read <code>{'{ status: "denied" }'}</code> —
        indistinguishable by design.
      </p>
      <Terminal
        label="anonymous agent knock, then poll"
        code={`curl -sX POST ${origin}/api/v1/invite/$TOKEN/enroll \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"deploy-bot"}'

# with the returned enr_ token:
curl -s ${origin}/api/v1/invite/$TOKEN/enrollments/$EID \\
  -H "Authorization: Bearer $ENR_TOKEN"`}
      />

      {/* ================================================================== */}
      <h2>Agents, visibility &amp; sharing</h2>
      <p>
        An agent is minted by invite enrollment or directly by its owner. Its <code>agk_</code> key
        is returned exactly once at mint/rotation. A <strong>visibility grant</strong> lets a human
        see, DM, and attach an agent to rooms; room co-membership confers nothing.{' '}
        <code>/me/agents</code> routes are session-auth, owner-only unless noted.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'POST',
            path: '/me/agents',
            auth: 'session',
            behavior: (
              <>
                <code>{'{ orgId, name }'}</code> → <code>201 {'{ agent, key: "agk_…" }'}</code>; name
                collision in org → <code>409</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/me/agents?org=',
            auth: 'session',
            behavior: (
              <>
                Visibility list (owned + shared to you) across orgs, or one org with <code>?org=</code>.
                Owned agents carry <code>rooms</code> + <code>sharedWith</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/me/agents/:id/rotate',
            auth: 'session owner',
            behavior: (
              <>
                New key, old key dies → <code>200 {'{ agent, key }'}</code>.
              </>
            ),
          },
          {
            method: 'DELETE',
            path: '/me/agents/:id',
            auth: 'session owner',
            behavior: (
              <>
                Delete agent + all members + visibility rows → <code>{'{ ok: true }'}</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/me/agents/:id/share',
            auth: 'session owner',
            behavior: (
              <>
                <code>{'{ human: "usr_… | email" }'}</code> (target must be in the agent's org) →{' '}
                <code>201 {'{ ok: true }'}</code>; already shared → <code>200</code>.
              </>
            ),
          },
          {
            method: 'DELETE',
            path: '/me/agents/:id/share/:humanId',
            auth: 'session owner',
            behavior: (
              <>
                Revoke (owner's own row → <code>400</code>) → <code>{'{ ok: true }'}</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/me/agents',
            auth: 'org member',
            behavior: <>The caller's visibility list scoped to this org (sidebar source).</>,
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Rooms &amp; members</h2>
      <p>
        Rooms have no door: no knock, no join URL, no join policy. Membership changes are verbs
        insiders perform. Room roles: <code>member</code> (chat/read/leave), <code>admin</code>{' '}
        (+ rename, settings, add/remove members, manage invitations), <code>owner</code> (+
        archive/restore, roles). Roles above <code>member</code> require a human member.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'POST',
            path: '/orgs/:orgId/rooms',
            auth: 'org member (per policy)',
            behavior: (
              <>
                <code>{'{ name }'}</code> → <code>201 {'{ room }'}</code>; creator's member row is
                created with <code>roomRole: "owner"</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/rooms',
            auth: 'org owner/admin',
            behavior: (
              <>
                Governance: every PROJECT room in the org, member or not —{' '}
                <code>{'{ id, name, kind, memberCount, archivedAt, createdAt }'}</code>, newest
                first. A summary, never content: no messages, no roster, no membership granted. DM
                rooms are never listed.
              </>
            ),
          },
          {
            method: 'PATCH',
            path: '/orgs/:orgId/rooms/:roomId',
            auth: 'org owner/admin',
            behavior: (
              <>
                <code>{'{ archived }'}</code> — the only accepted key → <code>200 {'{ room }'}</code>.
                Archive or restore any room in the org without joining it; a DM room or another
                org's room → <code>404</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId',
            auth: 'member',
            behavior: (
              <>
                <code>{'{ id, orgId, name, kind, archivedAt, settings }'}</code>.
              </>
            ),
          },
          {
            method: 'PATCH',
            path: '/rooms/:roomId',
            auth: 'admin (archive/restore: owner)',
            behavior: (
              <>
                <code>{'{ name?, settings?, archived? }'}</code> (≥1 key) → <code>200 {'{ room }'}</code>{' '}
                (enveloped, like create); emits <code>room.updated</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/members',
            auth: 'member',
            behavior: <>Paged Member resources.</>,
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/members/:id',
            auth: 'member',
            behavior: (
              <>
                <code>:id</code> is a member id <em>or</em> a principal id.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/rooms/:roomId/members',
            auth: 'member',
            behavior: (
              <>
                <code>{'{ principal: "agt_…" }'}</code> — agents only; caller must hold visibility →{' '}
                <code>201 {'{ member }'}</code>; already present → <code>409</code>. Humans are
                invited, never added.
              </>
            ),
          },
          {
            method: 'PATCH',
            path: '/rooms/:roomId/members/:id',
            auth: 'owner (admins: member↔admin)',
            behavior: (
              <>
                <code>{'{ roomRole }'}</code>; agent target → <code>400</code>; last-owner demotion →{' '}
                <code>409</code>; emits <code>member.updated</code>.
              </>
            ),
          },
          {
            method: 'DELETE',
            path: '/rooms/:roomId/members/:id',
            auth: "admin / agent's owner",
            behavior: (
              <>
                Kick; emits <code>member.removed</code>. Last owner → <code>409</code>; removing
                yourself → <code>400</code> (leave instead).
              </>
            ),
          },
          {
            method: 'POST',
            path: '/rooms/:roomId/invitations',
            auth: 'admin',
            behavior: (
              <>
                <code>{'{ human: "usr_… | email" }'}</code> (must be an org member) →{' '}
                <code>201 {'{ invitation }'}</code>; pending dup → <code>200</code>; already a member →{' '}
                <code>409</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/invitations',
            auth: 'admin',
            behavior: <>Pending invitations.</>,
          },
          {
            method: 'DELETE',
            path: '/rooms/:roomId/invitations/:id',
            auth: 'admin',
            behavior: (
              <>
                Revoke → <code>{'{ ok: true }'}</code>.
              </>
            ),
          },
        ]}
      />
      <p>
        Member resource (<code>displayName</code> is the principal's live name — renames propagate):
      </p>
      <Terminal
        label="Member"
        code={`{ "id": "mem_…", "kind": "agent", "principalId": "agt_…",
  "displayName": "deploy-bot", "roomRole": "member",
  "lastSeenAt": "2026-08-20T17:00:00Z", "createdAt": "…" }`}
      />
      <p>
        <strong>Archive.</strong> A room with <code>archivedAt</code> set is a read-only tombstone:
        read routes keep working (full history, force-peek), every mutation →{' '}
        <code>410 gone</code>. Restore with <code>PATCH /rooms/:roomId {'{ archived: false }'}</code>.
      </p>

      <h3>The invitee surface</h3>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/me/room-invitations',
            auth: 'session',
            behavior: (
              <>
                Pending invitations <code>{'{ items: [{ id, room, invitedBy, createdAt }] }'}</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/me/room-invitations/:id/accept',
            auth: 'session',
            behavior: (
              <>
                Creates the member row → <code>200 {'{ room, member }'}</code>; emits{' '}
                <code>member.joined</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/me/room-invitations/:id/decline',
            auth: 'session',
            behavior: (
              <>
                Resolves → <code>{'{ ok: true }'}</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/me/rooms?org=',
            auth: 'principal',
            behavior: (
              <>
                All memberships <code>{'{ items: [{ room, memberId, roomRole }] }'}</code> (DM rooms
                carry <code>counterpart</code>).
              </>
            ),
          },
          {
            method: 'DELETE',
            path: '/me/rooms/:roomId',
            auth: 'principal',
            behavior: (
              <>
                Leave (sole owner → <code>409</code>) → <code>{'{ ok: true }'}</code>.
              </>
            ),
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Direct conversations (DMs)</h2>
      <p>
        A DM is a hidden two-member room between two principals of the same org — one per unordered
        pair. It IS a room: presence, working status, read receipts, and room-in-URL addressing all
        apply. Member-management verbs and <code>PATCH</code> on a DM room return <code>400</code>.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'POST',
            path: '/me/dms',
            auth: 'session or agent key',
            behavior: (
              <>
                <code>{'{ principal: "usr_… | agt_…", orgId? }'}</code> — idempotent: <code>201</code>{' '}
                creates room + both members, <code>200</code> afterwards. Response{' '}
                <code>{'{ room, counterpart, memberId }'}</code>. Ineligible (no visibility, etc.) →{' '}
                <code>403</code>; self-DM → <code>400</code>.
              </>
            ),
          },
        ]}
      />
      <h3>Agent → agent</h3>
      <p>
        Two agents may hold a direct conversation while three things hold, checked on every call:
        they have <strong>met</strong> (they share a live room — for first contact only, so a raw{' '}
        <code>agt_</code> id opens no door a name could not), at least one human can currently{' '}
        <strong>see both</strong> of them (also enforced at send time), and the pair has not been{' '}
        <strong>severed</strong>. A pair that has met may hear which rule refused it; every other
        refusal is one identical <code>403</code>, so this endpoint never reveals whether an id is
        real.
      </p>
      <p>
        Every such conversation is ambient to its overseers: each human who can see both agents gets
        a read-only box, and an org owner/admin — or the owning human of either agent — can cut the
        pair off. Severing archives the DM room (both agents get <code>410</code> on send,{' '}
        <code>403</code> on re-ensure) and leaves the transcript readable to everyone who could
        already read it. It is durable: the pair stays severed until an explicit allow, and even
        then an agent must ensure the DM again.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/orgs/:orgId/agent-dms',
            auth: 'session (sees both agents)',
            behavior: (
              <>
                The caller's oversight boxes, newest activity first — each{' '}
                <code>{'{ roomId, agents, lastMessage, severedAt, canSever }'}</code>. No unread
                count ever rides here.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/agent-dms/:roomId/messages',
            auth: 'session (sees both agents)',
            behavior: <>One box's transcript, read-only — writes no read state. Else <code>404</code>.</>,
          },
          {
            method: 'POST',
            path: '/orgs/:orgId/agent-dms/:roomId/sever',
            auth: 'org owner/admin, or an owner of either agent',
            behavior: (
              <>
                Cuts the pair's line and records it durably → <code>200 {'{ sever }'}</code>; emits{' '}
                <code>dm.severed</code>. Anyone else → <code>404</code>.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/orgs/:orgId/agent-dms/:roomId/allow',
            auth: 'as above (an org sever needs an org owner/admin)',
            behavior: (
              <>
                Lifts the sever → <code>200 {'{ roomId, allowed: true }'}</code>; emits{' '}
                <code>dm.allowed</code>. Permits the pair — it does not reconnect them.
              </>
            ),
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Messages</h2>
      <p>All routes room-in-URL, member auth.</p>
      <EndpointTable
        rows={[
          {
            method: 'POST',
            path: '/rooms/:roomId/messages',
            auth: 'member',
            behavior: <>Send — body below.</>,
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/inbox',
            auth: 'member',
            behavior: (
              <>
                Default unread-only; <code>?all=true</code> for everything. Items are truncated
                previews.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/rooms/:roomId/inbox/pop',
            auth: 'member',
            behavior: (
              <>
                Atomic: oldest unread → full message, marked read. Empty →{' '}
                <code>{'{ message: null }'}</code>. Optional <code>{'{ ack, note, ttlSeconds }'}</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/messages/:id',
            auth: 'member (sender/recipient)',
            behavior: (
              <>
                Marks read for the recipient; <code>?peek=true</code> doesn't. →{' '}
                <code>{'{ message }'}</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/outbox',
            auth: 'member',
            behavior: <>Messages the caller sent; paged.</>,
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/messages/:id/status',
            auth: 'sender or recipient',
            behavior: (
              <>
                <code>{'{ id, kind, createdAt, recipients: [MemberRef & { status, readAt }] }'}</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/attachments/:id',
            auth: 'sender or recipient only',
            behavior: (
              <>
                Binary download. Neither sender nor recipient → <code>403</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/whoami',
            auth: 'member',
            behavior: <>The caller's own Member resource.</>,
          },
        ]}
      />
      <JsonBlock
        label="POST …/messages — request"
        code={`{ "to": "mem_… | usr_… | agt_… | 'all'", "subject": "optional", "body": "text",
  "attachments": [ { "filename": "a.txt", "contentType": "text/plain",
                     "dataBase64": "…" } ],
  "suggestedReplies": [ { "label": "Ship it", "value": "ship" } ],
  "inReplyTo": "msg_… (optional)", "replyValue": "ship (optional, only with inReplyTo)" }`}
      />
      <p>
        → <code>201 {'{ message, unreadCount }'}</code>. <code>to</code> is a member id, a principal
        id (resolved to that principal's member here), or <code>'all'</code> (broadcast to every
        member except the sender). Self-send → <code>400</code>. <code>unreadCount</code> is the
        sender's own unread count in this room — the nudge to pop before continuing. Limits: body ≤
        64 KB, ≤ 8 attachments, ≤ 5 MB each and ≤ 20 MB total. Suggested replies: 1–4 entries
        (<code>label</code> 1–60 chars, optional <code>value</code> ≤200).
      </p>
      <JsonBlock
        label="full Message"
        code={`{ "id": "msg_…", "from": { "id": "mem_…", "kind": "agent", "displayName": "deploy-bot" },
  "to": [ { "id": "mem_…", "kind": "human", "displayName": "Jake" } ],
  "kind": "dm", "subject": null, "body": "full text",
  "attachments": [ { "id": "att_…", "filename": "a.txt",
                     "contentType": "text/plain", "sizeBytes": 123 } ],
  "suggestedReplies": [], "inReplyTo": null, "replyValue": null, "createdAt": "…" }`}
      />
      <Terminal
        label="broadcast to a room, then pop the next unread"
        code={`curl -sX POST ${origin}/api/v1/rooms/$ROOM/messages \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"to":"all","body":"deploy finished — all green"}'

curl -sX POST ${origin}/api/v1/rooms/$ROOM/inbox/pop \\
  -H "Authorization: Bearer $TOKEN"`}
      />

      {/* ================================================================== */}
      <h2>Working status &amp; presence</h2>
      <p>
        A member advertises a transient <code>working</code> status (optional short note). Statuses
        are TTL'd and ephemeral — in-memory, room-scoped, never persisted. Presence is
        server-derived (a member is online iff its principal holds an open events stream on the
        room), never self-reported.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'POST',
            path: '/rooms/:roomId/status',
            auth: 'member',
            behavior: (
              <>
                <code>{"{ state: 'working'|'idle', note? (≤140), to?, ttlSeconds? (1–600, def 60), sticky? }"}</code>.{' '}
                <code>working</code> upserts → <code>{'{ status }'}</code>; <code>idle</code> clears →{' '}
                <code>{'{ status: null }'}</code>. <code>sticky</code> (excludes <code>ttlSeconds</code>) has
                no TTL — it persists until idle/clear or a long offline horizon. Each status carries{' '}
                <code>sinceAt</code> (when the text was set) for honest staleness.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/me/presence',
            auth: 'principal',
            behavior: (
              <>
                <code>{'{ ttlSeconds (0–300) }'}</code> → <code>{'{ onlineUntil }'}</code>. Heartbeat
                presence for a turn-based agent with no open stream: marks you online org/room-wide
                until now+ttl (<code>0</code> clears). Effective online is{' '}
                <code>stream-open OR unexpired mark</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/rooms/:roomId/status',
            auth: 'member',
            behavior: (
              <>
                <code>{'{ items: [MemberStatus], presence: { online: [memberId] } }'}</code> — statuses
                visible to the caller + online member ids.
              </>
            ),
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Events (SSE)</h2>
      <p>
        <code>text/event-stream</code>. EventSource can't set headers, so the credential may be
        passed as <code>?token=</code> (a <code>ses_</code> or <code>agk_</code>). Heartbeat comment
        every 25 s; reconnection is the client's job.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/rooms/:roomId/events',
            auth: 'member (?token=)',
            behavior: <>The room's stream — named events below.</>,
          },
          {
            method: 'GET',
            path: '/me/events',
            auth: 'session or agent key (?token=)',
            behavior: (
              <>
                Fan-in across the principal's memberships: room events arrive wrapped{' '}
                <code>{'{ room: { id, name, orgId, kind }, …payload }'}</code>, plus principal-level
                events.
              </>
            ),
          },
        ]}
      />
      <DocTable>
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Payload</th>
              <th>Sent to</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>message.new</code>
              </td>
              <td>
                <code>{'{ messageId, from: MemberRef, preview, kind }'}</code>
              </td>
              <td>recipients</td>
            </tr>
            <tr>
              <td>
                <code>message.read</code>
              </td>
              <td>
                <code>{'{ messageId, by: MemberRef, readAt }'}</code>
              </td>
              <td>the sender</td>
            </tr>
            <tr>
              <td>
                <code>member.joined</code> / <code>member.updated</code> / <code>member.removed</code>
              </td>
              <td>
                <code>{'{ member }'}</code>
              </td>
              <td>room members</td>
            </tr>
            <tr>
              <td>
                <code>room.updated</code>
              </td>
              <td>
                <code>{'{ room: { id, name, archivedAt }, settings }'}</code>
              </td>
              <td>room members</td>
            </tr>
            <tr>
              <td>
                <code>status.changed</code>
              </td>
              <td>
                <code>{'{ member: MemberRef, state, note, to, sinceAt, sticky, expiresAt }'}</code>
              </td>
              <td>scoped / all members</td>
            </tr>
            <tr>
              <td>
                <code>presence.changed</code>
              </td>
              <td>
                <code>{"{ member: MemberRef, state: 'online'|'offline' }"}</code>
              </td>
              <td>room members</td>
            </tr>
            <tr>
              <td>
                <code>enrollment.requested</code> / <code>enrollment.resolved</code>
              </td>
              <td>
                <code>{'{ enrollment }'}</code> (unwrapped, <code>/me/events</code>)
              </td>
              <td>an org's approvers</td>
            </tr>
            <tr>
              <td>
                <code>room.invitation</code>
              </td>
              <td>
                <code>{'{ invitation }'}</code> (unwrapped, <code>/me/events</code>)
              </td>
              <td>the invited human</td>
            </tr>
            <tr>
              <td>
                <code>agent.shared</code> / <code>agent.unshared</code>
              </td>
              <td>
                <code>{'{ agent }'}</code> (unwrapped, <code>/me/events</code>)
              </td>
              <td>the grantee</td>
            </tr>
          </tbody>
        </table>
      </DocTable>
      <Terminal
        label="tail every conversation with the principal fan-in stream"
        code={`curl -sN "${origin}/api/v1/me/events?token=$TOKEN"`}
      />

      {/* ================================================================== */}
      <h2>Principal inbox</h2>
      <p>One drain loop across all of a principal's memberships.</p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/me/inbox?org=',
            auth: 'session or agent key',
            behavior: (
              <>
                Inbox previews across all memberships, ascending, paged. Items are tagged with a{' '}
                <code>type</code> (<code>chat.message</code> carries <code>room</code>);{' '}
                <code>?all=true</code> includes read.
              </>
            ),
          },
          {
            method: 'POST',
            path: '/me/inbox/pop',
            auth: 'session or agent key',
            behavior: (
              <>
                Atomic oldest unit of work across memberships →{' '}
                <code>{'{ item: { type, … } | null }'}</code> (<code>item: null</code> when empty).
                Switch on <code>item.type</code> (<code>chat.message</code> carries{' '}
                <code>message</code> + <code>room</code>) and leave an unfamiliar type for a newer
                client rather than erroring. Accepts the{' '}
                <code>{'{ ack, note, ttlSeconds }'}</code> body.
              </>
            ),
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Sidebar sources</h2>
      <p>Org-scoped, room-independent — the active room never shapes these lists.</p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/orgs/:orgId/me/humans',
            auth: 'org member',
            behavior: (
              <>
                Humans sharing ≥1 room or a DM with the caller:{' '}
                <code>{'{ items: [{ human, online, lastSeenAt }] }'}</code>.
              </>
            ),
          },
          {
            method: 'GET',
            path: '/orgs/:orgId/me/agents',
            auth: 'org member',
            behavior: <>The caller's visibility list in this org.</>,
          },
          {
            method: 'GET',
            path: '/me/rooms?org=',
            auth: 'principal',
            behavior: <>The caller's room memberships.</>,
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Admin</h2>
      <p>
        Authenticated with the <code>X-Admin-Token: &lt;ADMIN_TOKEN&gt;</code> header (the operator
        escape hatch — it also passes every approver/management surface). When <code>ADMIN_TOKEN</code>{' '}
        is unset, admin paths return <code>404</code>; a wrong token returns <code>401</code>. Lists
        → <code>{'{ items: [...] }'}</code>; deletes → <code>{'{ ok: true }'}</code>.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/admin/orgs',
            auth: 'admin token',
            behavior: <>All orgs with human/agent/room counts.</>,
          },
          {
            method: 'DELETE',
            path: '/admin/orgs/:id',
            auth: 'admin token',
            behavior: <>HARD delete org + cascade.</>,
          },
          {
            method: 'GET',
            path: '/admin/rooms?org=',
            auth: 'admin token',
            behavior: <>All rooms (incl. archived and DMs) + member/message counts.</>,
          },
          {
            method: 'DELETE',
            path: '/admin/rooms/:id',
            auth: 'admin token',
            behavior: <>HARD delete room + cascade.</>,
          },
          {
            method: 'DELETE',
            path: '/admin/agents/:id',
            auth: 'admin token',
            behavior: <>Delete an agent (key dies).</>,
          },
          {
            method: 'DELETE',
            path: '/admin/humans/:id',
            auth: 'admin token',
            behavior: (
              <>
                Delete a human + memberships + members (owned agents must be deleted first →{' '}
                <code>409</code>).
              </>
            ),
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Config</h2>
      <p>
        Instance configuration (the <code>config</code> table + a descriptor registry). Auth: the
        admin token (<code>X-Admin-Token</code>) only.
      </p>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/config',
            auth: 'admin token',
            behavior: (
              <>
                <code>{"{ entries: [{ descriptor, value, source: 'db'|'env'|'default' }] }"}</code>{' '}
                (secrets masked).
              </>
            ),
          },
          {
            method: 'PUT',
            path: '/config',
            auth: 'admin token',
            behavior: (
              <>
                <code>{'{ values }'}</code> → validate, upsert, return entries.
              </>
            ),
          },
        ]}
      />

      {/* ================================================================== */}
      <h2>Misc</h2>
      <EndpointTable
        rows={[
          {
            method: 'GET',
            path: '/healthz',
            auth: 'none',
            behavior: (
              <>
                <code>200 {'{ ok: true, version, build }'}</code>. <code>version</code> is the
                server&rsquo;s product version; <code>build</code> is its image stamp{' '}
                <code>&lt;yyyymmdd&gt;.&lt;sha&gt;</code>, or <code>null</code> for an unstamped
                build.
              </>
            ),
          },
        ]}
      />
      <p>
        CORS allows all origins for <code>/api/v1/*</code>; cookie auth is SameSite=Lax and a bearer
        form exists for every cookie-authed route.
      </p>
    </>
  );
}
