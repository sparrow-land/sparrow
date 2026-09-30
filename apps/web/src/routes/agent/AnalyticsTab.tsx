import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AgentAnalyticsPoint,
  AgentAnalyticsResponse,
  AgentAnalyticsWindow,
} from '@sparrow-land/sdk/types';
import { api } from '../../lib/client.js';
import { agentTabPath } from '../../lib/ids.js';
import { compactNumber, forbiddenMessage } from './access.js';

/**
 * The agent page's **Analytics** tab, and the one-line card that opens it from
 * Overview. Counters are always on and informational only (SPEC.md, *Agent
 * visibility*): messages
 * and tokens estimated from message text, by window. Rendered only for viewers
 * with authority over the agent; the server is the authority on reads.
 */

const WINDOWS: { id: AgentAnalyticsWindow; label: string; heading: string }[] = [
  { id: '24h', label: '24h', heading: 'Last 24 hours' },
  { id: '7d', label: '7d', heading: 'Last 7 days' },
  { id: '30d', label: '30d', heading: 'Last 30 days' },
  { id: 'all', label: 'All', heading: 'All time' },
];

/** Fetch one window of an agent's analytics; `error` carries plain wording. */
function useAnalytics(orgId: string, agentId: string, window: AgentAnalyticsWindow) {
  const [state, setState] = useState<{
    key: string;
    data: AgentAnalyticsResponse | null;
    error: string | null;
  }>({ key: '', data: null, error: null });
  const key = `${orgId}/${agentId}/${window}`;
  useEffect(() => {
    let live = true;
    api
      .getAgentAnalytics(orgId, agentId, window)
      .then((data) => {
        if (live) setState({ key, data, error: null });
      })
      .catch((err: unknown) => {
        if (live) setState({ key, data: null, error: forbiddenMessage(err, 'Could not load analytics.') });
      });
    return () => {
      live = false;
    };
  }, [orgId, agentId, window, key]);
  return state.key === key ? state : { key, data: null, error: null };
}

function totalMessages(a: AgentAnalyticsResponse): number {
  return a.totals.sent + a.totals.received;
}
function totalTokens(a: AgentAnalyticsResponse): number {
  return a.totals.tokensSent + a.totals.tokensReceived;
}
/**
 * "Agent-to-agent": the share of DM traffic that is with agents (rooms are
 * excluded — a room has no single counterpart). Null when there were no DMs.
 * The Overview card and the Analytics tab both use this one definition.
 */
function agentShareOfDms(a: AgentAnalyticsResponse): number | null {
  const dms = a.withAgents.messages + a.withHumans.messages;
  return dms > 0 ? Math.round((a.withAgents.messages / dms) * 100) : null;
}

function byMessages<T extends { messages: number }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => y.messages - x.messages);
}

/**
 * Overview's one-line card: "412 messages · ~96k tokens this week", who it
 * talks with most, and a link into the Analytics tab. Hidden (not an error)
 * when the window cannot be read — Overview never breaks over counters.
 */
export function AnalyticsCard({ orgId, agentId }: { orgId: string; agentId: string }) {
  const { data } = useAnalytics(orgId, agentId, '7d');
  if (!data) return null;
  const messages = totalMessages(data);
  const top = byMessages(data.counterparts)[0];
  const topRoom = byMessages(data.rooms)[0];
  const agentShare = agentShareOfDms(data);
  // Where it talks most: the top DM counterpart, unless the top room outweighs it.
  const where =
    top && (!topRoom || top.messages >= topRoom.messages)
      ? { prefix: 'mostly with ', name: top.name }
      : topRoom
        ? { prefix: 'mostly in ', name: `# ${topRoom.name}` }
        : null;
  return (
    <div className="mb-6 flex items-center gap-4 rounded-lg border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3.5 py-3">
      <Sparkline series={data.series} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--sparrow-text)]">
          {messages === 0
            ? 'No messages this week'
            : `${messages.toLocaleString()} messages · ~${compactNumber(totalTokens(data))} tokens this week`}
        </div>
        {messages > 0 && where ? (
          <div className="mt-px truncate text-xs text-[var(--sparrow-faint)]">
            {where.prefix}
            <span className="mono text-[var(--sparrow-muted)]">{where.name}</span>
            {agentShare !== null ? ` · ${agentShare}% agent-to-agent` : null}
          </div>
        ) : null}
      </div>
      <Link
        to={agentTabPath(orgId, agentId, 'analytics')}
        className="shrink-0 text-sm text-[var(--sparrow-accent)] hover:underline"
      >
        View analytics ›
      </Link>
    </div>
  );
}

/** A tiny single-colour trend of the window's series (decorative; the card's text carries the numbers). */
function Sparkline({ series }: { series: AgentAnalyticsPoint[] }) {
  if (series.length < 2) return null;
  const w = 112;
  const h = 32;
  const max = Math.max(1, ...series.map((p) => p.messages));
  const pts = series.map((p, i) => {
    const x = 2 + (i * (w - 4)) / (series.length - 1);
    const y = h - 2 - (p.messages / max) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="hidden shrink-0 sm:block">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="var(--sparrow-accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AnalyticsTab({ orgId, agentId }: { orgId: string; agentId: string }) {
  const [window, setWindow] = useState<AgentAnalyticsWindow>('7d');
  const { data, error } = useAnalytics(orgId, agentId, window);
  const current = WINDOWS.find((w) => w.id === window)!;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--sparrow-text)]">{current.heading}</h2>
        <div
          role="group"
          aria-label="Window"
          className="inline-flex rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-0.5"
        >
          {WINDOWS.map((w) => {
            const on = w.id === window;
            return (
              <button
                key={w.id}
                type="button"
                aria-pressed={on}
                onClick={() => setWindow(w.id)}
                className={`rounded px-3 py-0.5 text-xs transition-colors ${
                  on
                    ? 'bg-[var(--sparrow-panel-2)] text-[var(--sparrow-text)] shadow-[inset_0_0_0_1px_var(--sparrow-border-strong)]'
                    : 'text-[var(--sparrow-muted)] hover:text-[var(--sparrow-text)]'
                }`}
              >
                {w.label}
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-[var(--sparrow-danger)]">{error}</p>
      ) : !data ? (
        <p className="mt-4 text-sm text-[var(--sparrow-faint)]">Loading…</p>
      ) : (
        <AnalyticsBody data={data} />
      )}
    </div>
  );
}

function AnalyticsBody({ data }: { data: AgentAnalyticsResponse }) {
  const messages = totalMessages(data);
  const tokens = totalTokens(data);
  const agentPct = agentShareOfDms(data);
  const agents = byMessages(data.counterparts.filter((c) => c.kind === 'agent'));
  const people = byMessages(data.counterparts.filter((c) => c.kind === 'human'));
  const rooms = byMessages(data.rooms);
  const shownAgents = agents.slice(0, 5);
  const restAgents = agents.slice(5);
  const maxAgent = Math.max(1, ...shownAgents.map((a) => a.messages));

  return (
    <>
      <div className="mt-3.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Tile label="Messages" value={messages.toLocaleString()}>
          {`${data.totals.sent.toLocaleString()} sent · ${data.totals.received.toLocaleString()} received`}
        </Tile>
        <Tile label="Work" value={`~${compactNumber(tokens)}`} unit="tokens">
          {messages > 0 ? `≈ ${Math.round(tokens / messages).toLocaleString()} per message` : 'No messages yet'}
        </Tile>
        <Tile label="Talking to" value={agentPct === null ? '—' : `${agentPct}%`} unit="agents">
          {agentPct !== null ? (
            <span className="mb-1 mt-1.5 flex h-1.5 gap-0.5 overflow-hidden rounded-sm" aria-hidden="true">
              <i className="block rounded-sm bg-[var(--sparrow-accent)]" style={{ flex: agentPct }} />
              <i className="block rounded-sm bg-[var(--sparrow-border-strong)]" style={{ flex: 100 - agentPct }} />
            </span>
          ) : null}
          <span className="block">
            {`${data.withAgents.messages.toLocaleString()} agent · ${data.withHumans.messages.toLocaleString()} human`}
          </span>
        </Tile>
      </div>

      <Bars series={data.series} hourly={data.window === '24h'} />

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">
        Agents it talks to
      </h3>
      <div className="mt-2 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] py-1">
        {shownAgents.length === 0 ? (
          <p className="px-3.5 py-2 text-sm text-[var(--sparrow-muted)]">No agent DMs in this window.</p>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="grid grid-cols-[minmax(0,1fr)_64px_64px] items-center gap-3 px-3.5 pb-0.5 pt-1.5 text-[11px] text-[var(--sparrow-faint)] sm:grid-cols-[minmax(0,190px)_1fr_64px_64px]"
            >
              <span>Agent</span>
              <span className="hidden sm:block" />
              <span className="text-right">msgs</span>
              <span className="text-right">~tokens</span>
            </div>
            <ul aria-label="Agents it talks to">
              {shownAgents.map((a) => (
                <li
                  key={a.id}
                  className="grid grid-cols-[minmax(0,1fr)_64px_64px] items-center gap-3 px-3.5 py-1.5 text-sm sm:grid-cols-[minmax(0,190px)_1fr_64px_64px]"
                >
                  <span data-name className="truncate text-[var(--sparrow-text)]">
                    {a.name}
                  </span>
                  <span className="hidden h-1.5 rounded-sm bg-[var(--sparrow-panel-2)] sm:block" aria-hidden="true">
                    <i
                      className="block h-full rounded-sm bg-[var(--sparrow-accent)]"
                      style={{ width: `${Math.max(2, Math.round((a.messages / maxAgent) * 100))}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-[var(--sparrow-text)]">
                    {a.messages.toLocaleString()}
                  </span>
                  <span className="text-right text-[13px] tabular-nums text-[var(--sparrow-faint)]">
                    {compactNumber(a.tokens)}
                  </span>
                </li>
              ))}
            </ul>
            {restAgents.length > 0 ? (
              <p className="px-3.5 pb-2 pt-1.5 text-xs text-[var(--sparrow-faint)]">
                {`+ ${restAgents.length} more ${restAgents.length === 1 ? 'agent' : 'agents'} · ${restAgents
                  .reduce((n, a) => n + a.messages, 0)
                  .toLocaleString()} msgs`}
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SmallRank
          title="People"
          empty="No DMs with people in this window."
          rows={people.slice(0, 5).map((p) => ({ key: p.id, name: p.name, messages: p.messages, tokens: p.tokens }))}
        />
        <SmallRank
          title="Rooms"
          empty="No room posts in this window."
          rows={rooms
            .slice(0, 5)
            .map((r) => ({ key: r.roomId, name: `# ${r.name}`, messages: r.messages, tokens: r.tokens }))}
        />
      </div>

      <p className="mt-5 text-xs text-[var(--sparrow-faint)]">
        {`${data.inRooms.messages.toLocaleString()} messages in rooms, ${data.inDms.messages.toLocaleString()} in DMs. `}
        Tokens are estimated from message text (characters ÷ 4): the size of the conversation, not
        model spend.
      </p>
    </>
  );
}

function Tile({
  label,
  value,
  unit,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3.5 py-3">
      <div className="text-xs text-[var(--sparrow-muted)]">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold leading-tight tracking-tight tabular-nums text-[var(--sparrow-text)]">
        <span>{value}</span>
        {unit ? <small className="ml-1 text-[13px] font-normal tracking-normal text-[var(--sparrow-faint)]">{unit}</small> : null}
      </div>
      <div className="mt-0.5 text-xs text-[var(--sparrow-faint)]">{children}</div>
    </div>
  );
}

function SmallRank({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: { key: string; name: string; messages: number; tokens: number }[];
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-faint)]">{title}</h3>
      <div className="mt-2 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] py-1">
        {rows.length === 0 ? (
          <p className="px-3.5 py-2 text-sm text-[var(--sparrow-muted)]">{empty}</p>
        ) : (
          <ul aria-label={title}>
            {rows.map((r) => (
              <li
                key={r.key}
                className="grid grid-cols-[minmax(0,1fr)_60px_44px] items-center gap-3 px-3.5 py-1.5 text-sm"
              >
                <span data-name className="truncate text-[var(--sparrow-text)]">
                  {r.name}
                </span>
                <span className="text-right tabular-nums text-[var(--sparrow-text)]">
                  {r.messages.toLocaleString()}
                </span>
                <span className="text-right text-[13px] tabular-nums text-[var(--sparrow-faint)]">
                  {compactNumber(r.tokens)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Axis label for one bucket: hour for 24h, weekday for a week, a date otherwise. */
function bucketLabel(start: string, hourly: boolean, dense: boolean): string {
  const d = new Date(start);
  if (hourly) return d.toLocaleTimeString(undefined, { hour: 'numeric' });
  if (!dense) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The window's series as single-colour bars (hourly for 24h, daily otherwise).
 * The last bucket is still filling, so it renders lighter. Values sit on the
 * bars when there are few enough to read; every bar carries a tooltip.
 */
function Bars({ series, hourly }: { series: AgentAnalyticsPoint[]; hourly: boolean }) {
  if (series.length === 0) return null;
  const max = Math.max(1, ...series.map((p) => p.messages));
  const dense = series.length > 8;
  const labelEvery = dense ? Math.ceil(series.length / 6) : 1;
  const last = series.length - 1;
  const label = (p: AgentAnalyticsPoint, i: number) =>
    i === last ? (hourly ? 'Now' : 'Today') : bucketLabel(p.start, hourly, dense);
  return (
    <div
      role="img"
      aria-label={hourly ? 'Messages per hour' : 'Messages per day'}
      className="mt-2 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-3.5 pb-2 pt-3.5"
    >
      <div
        className={`flex h-24 items-end border-b border-[var(--sparrow-border)] ${dense ? 'gap-0.5' : 'gap-2.5'}`}
      >
        {series.map((p, i) => (
          <div
            key={p.start}
            title={`${label(p, i)}: ${p.messages.toLocaleString()}`}
            className="flex h-full flex-1 flex-col items-center justify-end"
          >
            {!dense ? (
              <span className="mb-0.5 text-[11px] tabular-nums text-[var(--sparrow-faint)]">
                {p.messages.toLocaleString()}
              </span>
            ) : null}
            <i
              className={`block w-full max-w-[44px] rounded-t bg-[var(--sparrow-accent)] ${i === last ? 'opacity-40' : 'opacity-85'}`}
              style={{ height: `${Math.max(p.messages > 0 ? 2 : 0, (p.messages / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className={`mt-1.5 flex text-[11px] text-[var(--sparrow-faint)] ${dense ? 'gap-0.5' : 'gap-2.5'}`}>
        {series.map((p, i) => (
          <span key={p.start} className="flex-1 overflow-visible whitespace-nowrap text-center">
            {i % labelEvery === 0 || i === last ? label(p, i) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
