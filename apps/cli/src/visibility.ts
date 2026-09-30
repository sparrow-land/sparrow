/**
 * Agent visibility commands — `tags`, `messaging`, `grants`, `stats` (the
 * contract is SPEC.md, *Agent visibility: tags, messaging, grants & analytics*).
 * Tags are org-visible labels on agents; `messaging` is the per-agent policy
 * for agent↔agent DMs; grants delegate authority over tags; stats read the
 * always-on per-agent counters.
 *
 * A selector (name or `agt_` id) resolves to an id through whatever the caller can
 * list (its own `GET /me`, a human's visibility list, the governance list, or an
 * agent's rooms); the agent's CURRENT tags and messaging policy are then read from
 * `GET /orgs/:orgId/agents/:agentId`, which any org member may read.
 */
import type { Command as Cmd } from 'commander';
import type { SparrowClient } from '@sparrow-land/sdk';
import { AGENT_TAGS_MAX } from '@sparrow-land/sdk/types';
import type {
  AgentAnalyticsResponse,
  AgentAnalyticsWindow,
  AgentMessagingPolicy,
  Grant,
  MePrincipal,
} from '@sparrow-land/sdk/types';
import { CliError, resolveHumanId, resolveOrg, resolvePrincipal, table, type Env, type GlobalOpts } from './util.js';

type Opts = GlobalOpts & Record<string, unknown>;
type Handler = (opts: Opts, args: string[]) => Promise<void>;

export interface VisibilityDeps {
  program: Cmd;
  env: Env;
  withOrg: (cmd: Cmd) => Cmd;
  action: (handler: Handler) => (...cbArgs: unknown[]) => Promise<void>;
  print: (data: unknown, human: string) => void;
  buildClient: (opts: GlobalOpts, env: Env) => { client: SparrowClient };
}

/* ------------------------------ agent lookup ----------------------------- */

/** An agent a selector resolved to; `tags`/`messaging` only when a readable list carried them. */
export interface AgentTarget {
  id: string;
  name: string;
  tags?: string[];
  messaging?: AgentMessagingPolicy;
}

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SCOPE_RE = /^(?:tags:\*|tag:[a-z0-9][a-z0-9-]{0,31})$/;
const WINDOWS: AgentAnalyticsWindow[] = ['24h', '7d', '30d', 'all'];
const POLICIES: AgentMessagingPolicy[] = ['any', 'tags', 'none'];

const label = (t: { id: string; name: string }): string => (t.name === t.id ? t.id : `${t.name} (${t.id})`);

/** Every list the caller may be able to read, best-effort; a refusal contributes nothing. */
async function readableAgents(client: SparrowClient, me: MePrincipal, orgId: string): Promise<AgentTarget[]> {
  const out: AgentTarget[] = [];
  if (me.type === 'agent') {
    out.push({ id: me.id, name: me.name, tags: me.tags, messaging: me.messaging });
  } else {
    try {
      for (const v of await client.listAgents({ org: orgId })) {
        out.push({ id: v.agent.id, name: v.agent.name, tags: v.agent.tags, messaging: v.agent.messaging });
      }
    } catch {
      /* not readable — fall through */
    }
  }
  try {
    for (const g of await client.listOrgAgents(orgId)) {
      if (!out.some((a) => a.id === g.agent.id)) {
        out.push({ id: g.agent.id, name: g.agent.name, tags: g.agent.tags, messaging: g.agent.messaging });
      }
    }
  } catch {
    /* governance list is owners/admins only */
  }
  return out;
}

/**
 * Resolve an agent selector (name or `agt_` id; none = yourself) for the
 * visibility commands. `usage` names the command for the "name an agent" error.
 */
async function resolveTarget(
  client: SparrowClient,
  selector: string | undefined,
  orgId: string,
  usage: string,
): Promise<AgentTarget> {
  const me = await client.me();
  if (selector === undefined) {
    if (me.type !== 'agent') {
      throw new CliError(`Name an agent: \`${usage}\` (you are signed in as a human, and humans carry no tags).`);
    }
    return { id: me.id, name: me.name, tags: me.tags, messaging: me.messaging };
  }
  const known = await readableAgents(client, me, orgId);
  const isId = /^agt_/.test(selector);
  const hits = known.filter((a) => (isId ? a.id === selector : a.name.toLowerCase() === selector.toLowerCase()));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new CliError(
      `Ambiguous agent name "${selector}"; matches ${hits.length}: ${hits.map((h) => h.id).join(', ')}. ` +
        'Pass the agent id instead.',
    );
  }
  if (isId) return { id: selector, name: selector };
  if (me.type === 'agent') {
    const p = await resolvePrincipal(client, selector, orgId);
    if (p.kind !== 'agent') throw new CliError(`${label(p)} is a human; tags and messaging apply to agents only.`);
    return { id: p.id, name: p.name };
  }
  // A human who manages an agent only through a grant may not see it in any list
  // they can read (the governance list is admins-only), but the single-agent read
  // is open to every org member: the id always works.
  throw new CliError(
    `No agent named "${selector}" is visible to you. Run \`sparrow agents\` to list the ones you can see, ` +
      'or pass its agt_ id (an agent you manage through a grant works by id).',
  );
}

/** The agent's CURRENT tags and messaging, read fresh from `GET /orgs/:orgId/agents/:agentId`. */
async function readCurrent(client: SparrowClient, orgId: string, t: AgentTarget): Promise<Required<AgentTarget>> {
  const { agent } = await client.getOrgAgent(orgId, t.id);
  return { id: agent.id, name: agent.name, tags: agent.tags, messaging: agent.messaging };
}

/** Lowercase, validate and dedupe tag arguments. */
function parseTags(raw: string[]): string[] {
  const tags = raw.map((t) => t.trim().toLowerCase());
  const bad = tags.filter((t) => !TAG_RE.test(t));
  if (bad.length > 0) {
    throw new CliError(
      `Invalid tag${bad.length > 1 ? 's' : ''}: ${bad.map((t) => `"${t}"`).join(', ')}. A tag is a lowercase ` +
        'slug: letters, digits and dashes, starting with a letter or digit, at most 32 characters.',
    );
  }
  return [...new Set(tags)];
}

function checkMax(tags: string[]): void {
  if (tags.length > AGENT_TAGS_MAX) {
    throw new CliError(`An agent carries at most ${AGENT_TAGS_MAX} tags (this would be ${tags.length}).`);
  }
}

/* -------------------------------- formatting ----------------------------- */

const POLICY_MEANING: Record<AgentMessagingPolicy, string> = {
  any: 'may DM any agent it has met in a room',
  tags: 'may DM only agents sharing a tag with it',
  none: 'no agent DMs; it can still DM humans and post in rooms',
};

function formatTagList(tags: string[]): string {
  return tags.length > 0 ? [...tags].sort().join(', ') : '(none)';
}

function formatTags(t: AgentTarget): string {
  const lines = [label(t), `tags:      ${formatTagList(t.tags ?? [])}`];
  if (t.messaging) lines.push(`messaging: ${t.messaging}`);
  return lines.join('\n');
}

function formatMessaging(t: AgentTarget, policy: AgentMessagingPolicy, tags: string[] | undefined): string {
  let line = `${label(t)} messaging: ${policy} — ${POLICY_MEANING[policy]}`;
  if (policy === 'tags' && tags) line += ` (${formatTagList(tags)})`;
  return line;
}

/** `30150` → `30.2k`; small numbers verbatim. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  // Decide the unit AFTER rounding, so 999,950 reads `1M`, never `1000k`.
  const k = Number((n / 1000).toFixed(1));
  if (k < 1000) return `${k}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

const WINDOW_LABEL: Record<AgentAnalyticsWindow, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  all: 'all time',
};
const TOP = 10;

export function formatStats(t: { id: string; name: string }, r: AgentAnalyticsResponse): string {
  const day = (iso: string) => iso.slice(0, 10);
  const head = `${label(t)} · ${WINDOW_LABEL[r.window]} (${day(r.from)} → ${day(r.to)})`;
  const total = r.totals.sent + r.totals.received;
  if (total === 0) return `${head}\nNo messages in this window.`;
  const tok = (n: number) => `~${compact(n)}`;
  const summary = table(
    ['', 'MESSAGES', 'TOKENS'],
    [
      ['sent', String(r.totals.sent), tok(r.totals.tokensSent)],
      ['received', String(r.totals.received), tok(r.totals.tokensReceived)],
      ['with agents', String(r.withAgents.messages), tok(r.withAgents.tokens)],
      ['with humans', String(r.withHumans.messages), tok(r.withHumans.tokens)],
      ['in DMs', String(r.inDms.messages), tok(r.inDms.tokens)],
      ['in rooms', String(r.inRooms.messages), tok(r.inRooms.tokens)],
    ],
  );
  const parts = [head, '', summary];
  const more = (n: number) => (n > TOP ? `\n… ${n - TOP} more (-j for all)` : '');
  if (r.counterparts.length > 0) {
    parts.push(
      '',
      'Top DM counterparts',
      table(
        ['NAME', 'KIND', 'ID', 'MESSAGES', 'TOKENS'],
        r.counterparts
          .slice(0, TOP)
          .map((c) => [c.name, c.kind, c.id, String(c.messages), tok(c.tokens)]),
      ) + more(r.counterparts.length),
    );
  }
  if (r.rooms.length > 0) {
    parts.push(
      '',
      'Top rooms',
      table(
        ['ROOM', 'ID', 'MESSAGES', 'TOKENS'],
        r.rooms.slice(0, TOP).map((x) => [x.name, x.roomId, String(x.messages), tok(x.tokens)]),
      ) + more(r.rooms.length),
    );
  }
  parts.push('', 'Tokens are estimated from message text (characters / 4), not model spend.');
  return parts.join('\n');
}

function formatGrants(items: Grant[], names: Map<string, string>): string {
  if (items.length === 0) return 'No grants in this org.';
  const who = (id: string) => (names.has(id) ? `${names.get(id)} (${id})` : id);
  return table(
    ['ID', 'PRINCIPAL', 'KIND', 'SCOPE', 'GRANTED BY', 'CREATED'],
    items.map((g) => [g.id, who(g.principalId), g.principalKind, g.scope, who(g.grantedBy), g.createdAt.slice(0, 10)]),
  );
}

function grantMeaning(scope: string): string {
  if (scope === 'tags:*') return 'add/remove any tag, set messaging on any tagged agent, and grant tag:<slug> to others';
  const tag = scope.slice('tag:'.length);
  return `add/remove the ${tag} tag and set messaging on agents carrying it`;
}

/** Best-effort id → name map for grant listings (agents and humans the caller can read). */
async function principalNames(client: SparrowClient, me: MePrincipal, orgId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  names.set(me.id, me.type === 'agent' ? me.name : me.displayName);
  if (me.type === 'agent') names.set(me.owner.id, me.owner.displayName);
  for (const a of await readableAgents(client, me, orgId)) names.set(a.id, a.name);
  try {
    for (const h of await client.directory(orgId)) names.set(h.id, h.displayName);
  } catch {
    /* directory is best-effort */
  }
  return names;
}

/** A grant principal: an `agt_`/`usr_` id, a human email, an agent name, or a human name. */
async function resolveGrantee(
  client: SparrowClient,
  selector: string,
  orgId: string,
): Promise<{ id: string; name: string }> {
  if (/^(agt_|usr_)/.test(selector)) return { id: selector, name: selector };
  if (selector.includes('@')) return { id: await resolveHumanId(client, orgId, selector), name: selector };
  const me = await client.me();
  const agents = (await readableAgents(client, me, orgId)).filter(
    (a) => a.name.toLowerCase() === selector.toLowerCase(),
  );
  if (agents.length === 1) return agents[0]!;
  if (agents.length > 1) {
    throw new CliError(
      `Ambiguous agent name "${selector}"; matches: ${agents.map((a) => a.id).join(', ')}. Pass the id.`,
    );
  }
  if (me.type === 'agent') return resolvePrincipal(client, selector, orgId);
  let humans: { id: string; displayName: string }[] = [];
  try {
    humans = (await client.directory(orgId, selector)).filter(
      (h) => h.displayName.toLowerCase() === selector.toLowerCase(),
    );
  } catch {
    /* fall through to not-found */
  }
  if (humans.length === 1) return { id: humans[0]!.id, name: humans[0]!.displayName };
  if (humans.length > 1) {
    throw new CliError(
      `Ambiguous name "${selector}"; matches: ${humans.map((h) => h.id).join(', ')}. Pass the usr_ id or email.`,
    );
  }
  throw new CliError(`No agent or human named "${selector}" in this org. Pass an agt_/usr_ id or an email.`);
}

/** Who may change tags (mirrors the server's rules; the server is the authority). */
const TAGS_RULES = `
Who may change an agent's tags: its owner and org owners/admins (any tag); a
tags:* holder (any tag); a tag:<slug> holder (only that tag, and only on agents
that already carry a tag it holds). Nobody edits their own tags or an agent that
holds a grant they don't. An agent whose own messaging policy is not "any" may
not add a tag it carries itself to another agent.`;

/* --------------------------------- commands ------------------------------ */

export function registerVisibilityCommands(d: VisibilityDeps): void {
  const { program, env, withOrg, action, print } = d;

  /* ------------------------------- tags ------------------------------- */
  const tagsCmd = withOrg(program.command('tags'))
    .description('show an agent’s tags and messaging policy (default: yourself); see `tags set|add|rm`')
    .argument('[agent]', 'agent name or agt_ id (default: yourself)')
    .action(
      action(async (opts, args) => {
        const { client } = d.buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        const t = await readCurrent(client, orgId, await resolveTarget(client, args[0], orgId, 'sparrow tags <agent>'));
        print({ agentId: t.id, name: t.name, tags: t.tags, messaging: t.messaging }, formatTags(t));
      }),
    );

  const editTags = (verb: 'set' | 'add' | 'rm', description: string) =>
    withOrg(tagsCmd.command(verb))
      .description(description)
      .argument('<agent>', 'agent name or agt_ id')
      .argument('<tag...>', 'tag slugs (lowercase letters, digits, dashes)')
      .addHelpText('after', TAGS_RULES)
      .action(
        action(async (opts, args) => {
          const selector = args[0]!;
          const given = parseTags((args[1] as unknown as string[]) ?? []);
          const { client } = d.buildClient(opts, env);
          const orgId = await resolveOrg(client, opts, env);
          const t = await resolveTarget(client, selector, orgId, `sparrow tags ${verb} <agent> <tag…>`);
          // Always read the CURRENT set (a list may be stale): it decides the no-op,
          // and a no-op still prints the agent resource, so -j has one shape.
          const { agent: current } = await client.getOrgAgent(orgId, t.id);
          const before = current.tags;
          const next =
            verb === 'set'
              ? given
              : verb === 'add'
                ? [...new Set([...before, ...given])]
                : before.filter((x) => !given.includes(x));
          next.sort();
          checkMax(next);
          if (next.join(',') === [...before].sort().join(',')) {
            print(
              { agent: current, changed: false },
              `${label(current)} tags unchanged: ${formatTagList(next)}`,
            );
            return;
          }
          const res = await client.putAgentTags(orgId, t.id, next);
          const after = res.agent.tags;
          const diff: string[] = [];
          const added = after.filter((x) => !before.includes(x));
          const removed = before.filter((x) => !after.includes(x));
          if (added.length) diff.push(`added: ${added.join(', ')}`);
          if (removed.length) diff.push(`removed: ${removed.join(', ')}`);
          print(
            { agent: res.agent, changed: true },
            `${label({ id: res.agent.id, name: res.agent.name })} tags: ${formatTagList(after)}` +
              (diff.length ? ` (${diff.join('; ')})` : ''),
          );
        }),
      );
  editTags('set', 'replace an agent’s tags with exactly these');
  editTags('add', 'add tags to an agent');
  editTags('rm', 'remove tags from an agent');

  /* ----------------------------- messaging ---------------------------- */
  withOrg(program.command('messaging'))
    .description('show or set which agents an agent may DM: any | tags (shares a tag) | none')
    .argument('<agent>', 'agent name or agt_ id')
    .argument('[policy]', 'any | tags | none (omit to show)')
    .action(
      action(async (opts, args) => {
        const [selector, value] = args as [string, string | undefined];
        if (value !== undefined && !POLICIES.includes(value as AgentMessagingPolicy)) {
          throw new CliError(`Messaging must be any, tags or none (got "${value}").`);
        }
        const { client } = d.buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        const t = await resolveTarget(client, selector, orgId, 'sparrow messaging <agent>');
        if (value === undefined) {
          const cur = await readCurrent(client, orgId, t);
          print(
            { agentId: cur.id, name: cur.name, messaging: cur.messaging, tags: cur.tags },
            formatMessaging(cur, cur.messaging, cur.tags),
          );
          return;
        }
        const res = await client.putAgentMessaging(orgId, t.id, value as AgentMessagingPolicy);
        print(
          res,
          formatMessaging({ id: res.agent.id, name: res.agent.name }, res.agent.messaging, res.agent.tags),
        );
      }),
    );

  /* ------------------------------- grants ----------------------------- */
  const listGrants = action(async (opts) => {
    const { client } = d.buildClient(opts, env);
    const orgId = await resolveOrg(client, opts, env);
    const items = await client.listGrants(orgId);
    const names = items.length > 0 ? await principalNames(client, await client.me(), orgId) : new Map<string, string>();
    print({ items }, formatGrants(items, names));
  });
  const grantsCmd = withOrg(program.command('grants'))
    .description('delegated authority over tags: list, add (tags:* | tag:<slug>), rm')
    .action(listGrants);
  withOrg(grantsCmd.command('ls')).description('list the org’s grants').action(listGrants);
  withOrg(grantsCmd.command('add'))
    .description('grant a human or agent authority over one tag (tag:<slug>) or every tag (tags:*)')
    .argument('<principal>', 'agent name, human name or email, or an agt_/usr_ id')
    .argument('<scope>', 'tags:* | tag:<slug>')
    .action(
      action(async (opts, args) => {
        const [selector, scope] = args as [string, string];
        if (!SCOPE_RE.test(scope)) {
          throw new CliError(`Scope must be tags:* or tag:<slug> (got "${scope}").`);
        }
        const { client } = d.buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        const p = await resolveGrantee(client, selector, orgId);
        // The server answers an existing (principal, scope) with that grant (200,
        // not 201); the SDK hides the status, so compare against the list first.
        let known: string[] = [];
        try {
          known = (await client.listGrants(orgId)).map((g) => g.id);
        } catch {
          /* best-effort: without it every add reads as new */
        }
        const grant = await client.createGrant(orgId, { principalId: p.id, scope });
        const created = !known.includes(grant.id);
        print(
          { grant, created },
          created
            ? `Granted ${scope} to ${label(p)} — ${grant.id}.\nIt lets them ${grantMeaning(scope)}.`
            : `Already granted ${scope} to ${label(p)} — ${grant.id}. Nothing changed.`,
        );
      }),
    );
  withOrg(grantsCmd.command('rm'))
    .description('revoke a grant (org owners/admins, its creator, or its holder giving it up)')
    .argument('<grantId>', 'the grt_ id (see `sparrow grants`)')
    .action(
      action(async (opts, args) => {
        const { client } = d.buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        await client.deleteGrant(orgId, args[0]!);
        print({ ok: true, grantId: args[0] }, `Revoked ${args[0]}.`);
      }),
    );

  /* -------------------------------- stats ----------------------------- */
  withOrg(program.command('stats'))
    .description('how much an agent talks and to whom: messages and ~tokens (default: yourself)')
    .argument('[agent]', 'agent name or agt_ id (default: yourself)')
    .option('--window <window>', '24h | 7d | 30d | all', '7d')
    .action(
      action(async (opts, args) => {
        const window = opts.window as AgentAnalyticsWindow;
        if (!WINDOWS.includes(window)) {
          throw new CliError(`--window must be 24h, 7d, 30d or all (got "${String(opts.window)}").`);
        }
        const { client } = d.buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        const t = await resolveTarget(client, args[0], orgId, 'sparrow stats <agent>');
        const report = await client.getAgentAnalytics(orgId, t.id, window);
        print(report, formatStats(t, report));
      }),
    );
}

/* ------------------------------ 403 hints ------------------------------- */

/** One plain hint per refusal reason; `messaging_policy` has none (the server message says it all). */
export const FORBIDDEN_HINTS: Record<string, string> = {
  self: "you can't change your own settings",
  outranked: "that agent holds permissions you don't",
  grant_required: 'you need a grant for that tag — ask an org admin',
};
