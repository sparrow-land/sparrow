/**
 * The `sparrow harness` timeline.
 *
 * The harness is a process a human LEAVES RUNNING and glances at, so its output
 * is a log with a shape: a banner that answers "which agent, where, running
 * what", then exactly one line per thing that happened, each stamped and led by
 * a colored glyph you can scan for. Failures are red and say what to expect
 * next; nothing is ever a wall of JSON unless `-j` asked for one.
 *
 * Rendering is pure (a clock and a color switch are injected), so every line in
 * the product is a unit test rather than a screenshot. Colors go through
 * picocolors' `createColors`, which means `NO_COLOR`/`FORCE_COLOR` and a piped
 * stdout are all honored by construction.
 */
// picocolors is CJS: `isColorSupported` lives on the created colors object, so
// only the DEFAULT import sees it (a named ESM import of it fails at runtime).
import pc from 'picocolors';

/** One thing worth a line. Also the exact `-j` wire shape (one JSON object per line). */
export type HarnessEvent =
  | { type: 'harness.enroll.waiting'; name: string }
  | { type: 'harness.enroll.done'; agent: string; org: string; profile: string }
  | { type: 'harness.enroll.reused'; agent: string; profile: string }
  | { type: 'harness.online'; agent: string; org: string; server: string }
  | { type: 'harness.reconnected' }
  | { type: 'harness.work'; group: string; from?: string; preview?: string; count: number }
  | { type: 'harness.run.start'; runner: string; group: string; items: number }
  | {
      type: 'harness.run.done';
      group: string;
      seconds: number;
      chars: number;
      replied: boolean;
    }
  | {
      type: 'harness.run.failed';
      runner: string;
      group: string;
      code: number | null;
      seconds: number;
      retryInSeconds?: number;
      timedOut?: boolean;
      gaveUp?: boolean;
    }
  | { type: 'harness.reply'; group: string; chars: number; seconds: number; truncated?: boolean }
  | { type: 'harness.ack'; group: string; ids: string[] }
  | { type: 'harness.note'; message: string }
  | { type: 'harness.error'; message: string }
  | { type: 'harness.stopped'; reason: string };

export interface RenderOptions {
  /** Force colors on/off. Default: picocolors' own detection. */
  colors?: boolean;
  /** Injected clock (tests). */
  clock?: () => Date;
  /** IANA zone for the timestamp (tests pin `UTC`). */
  tz?: string;
}

export interface BannerInfo {
  agent: string;
  org: string;
  /**
   * The credential profile in use. Named on the banner because one machine
   * routinely holds several enrolled agents in one credentials.json, and
   * "which one am I running?" is the first question a stopped harness raises.
   * Absent for a bare `SPARROW_TOKEN`, which has no profile.
   */
  profile?: string;
  server: string;
  runner: string;
  model?: string;
  permissionMode: string;
  cwd: string;
  /** `--once`: the banner promises one pass, not a held stream. */
  once?: boolean;
}

function colors(opts?: RenderOptions): ReturnType<typeof pc.createColors> {
  return pc.createColors(opts?.colors ?? pc.isColorSupported);
}

/** `HH:MM:SS` in the configured zone — the dim prefix on every timeline line. */
export function stamp(opts?: RenderOptions): string {
  const at = (opts?.clock ?? ((): Date => new Date()))();
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(opts?.tz ? { timeZone: opts.tz } : {}),
  }).format(at);
}

/** `1.2k chars` past a thousand, plain below it. */
function chars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} char${n === 1 ? '' : 's'}`;
}

function secs(n: number): string {
  return `${Math.round(n)}s`;
}

function clip(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** The start-up block: who this agent is, what it runs, and that it is listening. */
export function renderBanner(info: BannerInfo, opts?: RenderOptions): string {
  const c = colors(opts);
  const label = (s: string): string => c.dim(s.padEnd(9));
  const runner = info.model ? `${info.runner} (${info.model})` : info.runner;
  const profile = info.profile ? ` · ${c.dim(`profile ${info.profile}`)}` : '';
  const last = info.once
    ? `  ${c.cyan('one pass')} — handling what is waiting, then exiting`
    : `  ${c.green('online')} — waiting for messages  ${c.dim('(Ctrl-C to stop)')}`;
  return [
    ``,
    `  ${c.bold('sparrow harness')}`,
    `  ${label('agent')}${c.bold(info.agent)} · ${info.org}${profile} · ${c.dim(info.server)}`,
    `  ${label('runner')}${c.bold(runner)} · ${c.dim(info.permissionMode)} · ${c.dim(info.cwd)}`,
    last,
    ``,
  ].join('\n');
}

/**
 * One timeline line, or `null` when the event is bookkeeping a human does not
 * need to see (acks ride the reply line that earned them).
 */
export function renderEvent(ev: HarnessEvent, opts?: RenderOptions): string | null {
  const c = colors(opts);
  const at = c.dim(stamp(opts));
  const line = (glyph: string, body: string): string => `${at} ${glyph} ${body}`;

  switch (ev.type) {
    case 'harness.enroll.waiting':
      return line(c.dim('◦'), c.dim(`${ev.name} — waiting for approval…`));
    case 'harness.enroll.done':
      return line(
        c.dim('◦'),
        `enrolled as ${c.bold(ev.agent)} in ${ev.org} ${c.dim(`(profile "${ev.profile}")`)}`,
      );
    case 'harness.enroll.reused':
      return line(
        c.dim('◦'),
        `already enrolled as ${c.bold(ev.agent)} ${c.dim(`(profile "${ev.profile}")`)}; running`,
      );
    case 'harness.online':
      return line(
        c.green('●'),
        `${c.green('online')} — waiting for messages  ${c.dim('(Ctrl-C to stop)')}`,
      );
    case 'harness.reconnected':
      return line(c.green('●'), c.dim('reconnected'));
    case 'harness.work': {
      const who = ev.from && !ev.group.includes(ev.from) ? ` · ${c.bold(ev.from)}` : '';
      const preview = ev.preview ? `: "${clip(ev.preview)}"` : '';
      const more = ev.count > 1 ? c.dim(` (+${ev.count - 1} more)`) : '';
      return line(c.cyan('→'), `${c.bold(ev.group)}${who}${preview}${more}`);
    }
    case 'harness.run.start':
      return line(
        c.yellow('⟳'),
        `${ev.runner} ${c.dim('·')} ${ev.items} message${ev.items === 1 ? '' : 's'} ${c.dim('·')} ${c.bold(ev.group)}`,
      );
    case 'harness.run.done':
      if (ev.replied) return null; // the reply line reports it
      return line(
        c.green('✓'),
        `handled ${c.bold(ev.group)} ${c.dim('·')} ${c.dim('nothing to say')} ${c.dim('·')} ${c.dim(secs(ev.seconds))}`,
      );
    case 'harness.reply':
      return line(
        c.green('✓'),
        `replied in ${c.bold(ev.group)} ${c.dim('·')} ${c.dim(chars(ev.chars))}${
          ev.truncated ? c.dim(' (truncated)') : ''
        } ${c.dim('·')} ${c.dim(secs(ev.seconds))}`,
      );
    case 'harness.run.failed': {
      const what = ev.timedOut
        ? `${ev.runner} timed out after ${secs(ev.seconds)}`
        : `${ev.runner} exited ${ev.code ?? '?'} after ${secs(ev.seconds)}`;
      const next = ev.gaveUp
        ? '— gave up after 3 tries; said so in the room and marked it read'
        : ev.retryInSeconds !== undefined
          ? `— left unread, retry in ${secs(ev.retryInSeconds)}`
          : '— left unread';
      return line(c.red('✗'), c.red(`${what} ${next}`));
    }
    case 'harness.ack':
      return null;
    case 'harness.note':
      return line(c.dim('◦'), c.dim(ev.message));
    case 'harness.error':
      return line(c.red('✗'), c.red(ev.message));
    case 'harness.stopped':
      return line(c.dim('◦'), c.dim(`stopped (${ev.reason})`));
    default:
      return null;
  }
}
