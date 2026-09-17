/**
 * Who is running under this state dir — subagents (fact) and background shells
 * (inference).
 *
 * SUBAGENTS. Claude Code fires `SubagentStart`/`SubagentStop` around each one,
 * and the auto-status hook records one file per running subagent under
 * `<state dir>/subagents/`, named by agent id. That is the only signal there is:
 * subagents are NOT separate OS processes (a session running one shows only its
 * MCP server and background shells in the process tree), and the docs say not to
 * read `<session>/subagents/*.jsonl`.
 *
 * STALENESS. A crash between start and stop leaves a marker nobody will ever
 * delete, so anything older than 12h is ignored here. The number is deliberately
 * generous: 12h of a phantom in the note costs a little accuracy, while a
 * tighter window would drop a real long-running subagent out of it. The HOOKS do
 * the deleting — this reader, and `sparrow skill status` with it, stays
 * read-only.
 *
 * SHELLS used to be pure inference. They are not any more: MEASURED 2026-09-17
 * against a real headless session, the `Stop` payload carries `background_tasks`
 * — `{id,type,status,description,command}` — and it appears on `Stop` and
 * `SubagentStop` only, not on UserPromptSubmit or PostToolUse (all four tested).
 * The docs list neither the field nor the distinction. The Stop hook records it
 * (minus `command`, which is whatever a user typed), so {@link
 * backgroundTaskStatusLine} reports a FACT, dated to the turn end it came from.
 *
 * The old process-tree inference survives as the FALLBACK for the one case the
 * record cannot answer — no turn has ended in this state dir yet, which is
 * exactly the fresh session where someone asks first. It recognises bash
 * children of the session process whose command line sources
 * `~/.claude/shell-snapshots/snapshot-bash-*.sh`, and every string it produces
 * says "inferred", because the two kinds of claim must never read alike.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Markers older than this are crash leftovers, not subagents. */
export const SUBAGENT_STALE_SECONDS = 12 * 3600;

export interface Subagent {
  agent: string;
  type: string;
  /** ISO time the subagent started, when the marker carries one. */
  at?: string;
}

export function subagentDir(stateDir: string): string {
  return path.join(stateDir, 'subagents');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Every LIVE subagent marker. Malformed files are skipped rather than thrown
 * over (this runs inside `status`), and stale ones are ignored but left on disk.
 */
export function readSubagents(stateDir: string, now = Date.now()): Subagent[] {
  const dir = subagentDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: Subagent[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const ageSeconds = (now - fs.statSync(file).mtimeMs) / 1000;
      if (ageSeconds >= SUBAGENT_STALE_SECONDS) continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      const rec = parsed as Record<string, unknown>;
      out.push({
        agent: str(rec.agent) ?? name.replace(/\.json$/, ''),
        type: str(rec.type) ?? 'unknown',
        ...(str(rec.at) ? { at: str(rec.at) } : {}),
      });
    } catch {
      // A half-written marker tells us nothing.
    }
  }
  return out;
}

/**
 * `code-review, 2× explore` — types sorted by name, repeats counted. The `N×`
 * prefix is not part of the sort key, and this is the same grammar the hook's
 * note composer uses (`subagent_summary` in sparrow-auto-status.sh).
 */
export function subagentTypeList(subagents: Subagent[]): string {
  const counts = new Map<string, number>();
  for (const s of subagents) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, n]) => (n > 1 ? `${n}× ${type}` : type))
    .join(', ');
}

/** The `subagents:` status line body (scope stated, because it is per state dir). */
export function subagentStatusLine(stateDir: string, now = Date.now()): string {
  const live = readSubagents(stateDir, now);
  if (live.length === 0) return 'none running (this state dir)';
  return `${live.length} running (this state dir): ${subagentTypeList(live)}`;
}

/* --------------------------------- shells --------------------------------- */

export interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

/** `ps` once, or undefined where it cannot be run (no ps, sandbox, Windows). */
function processTable(): Proc[] | undefined {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows: Proc[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! });
    }
    return rows.length > 0 ? rows : undefined;
  } catch {
    return undefined;
  }
}

const isSessionProcess = (args: string): boolean => /(^|\/)claude(\s|$)/.test(args);
const isBackgroundShell = (args: string): boolean =>
  /shell-snapshots\/snapshot-bash-/.test(args) && /(^|\/)(ba)?sh(\s|$)/.test(args.split(' ')[0] ?? '');

/**
 * How many background shells this session is running — or `undefined` when the
 * question cannot be answered here (no `claude` ancestor, or no readable process
 * table). NEVER a guess: the caller prints `unknown` rather than `0`, because
 * "none" and "cannot tell" are different answers and only one of them is honest.
 */
export function countBackgroundShells(startPid = process.pid): number | undefined {
  const table = processTable();
  if (!table) return undefined;
  return countShellsIn(table, startPid);
}

/**
 * The pure half of the inference, over an already-parsed process table: walk up
 * to the nearest `claude` ancestor and count its background-shell children.
 * Exported so the two shapes that actually decide the answer — what a session
 * process looks like, and what a background shell's command line looks like —
 * can be pinned against a real `ps` sample instead of trusted by eye.
 */
export function countShellsIn(table: Proc[], startPid: number): number | undefined {
  const byPid = new Map(table.map((p) => [p.pid, p]));

  // Walk up to the nearest `claude` ancestor: `status` usually runs as a Bash
  // tool call inside the session, several processes below it.
  let cursor = byPid.get(startPid);
  let session: Proc | undefined;
  for (let hops = 0; cursor && hops < 32; hops++) {
    if (isSessionProcess(cursor.args)) {
      session = cursor;
      break;
    }
    cursor = byPid.get(cursor.ppid);
  }
  if (!session) return undefined;
  return table.filter((p) => p.ppid === session.pid && isBackgroundShell(p.args)).length;
}

/* ---------------------------- background tasks ---------------------------- */

export interface BackgroundTask {
  id: string;
  type: string;
  status: string;
  description: string;
}

export interface BackgroundTaskRecord {
  /** ISO time of the turn end this snapshot came from. */
  at?: string;
  tasks: BackgroundTask[];
}

/**
 * What the harness reported at the last turn end, or undefined when no turn has
 * ended here yet (or the record is unreadable). Never throws: this runs inside
 * `status`.
 */
export function readBackgroundTasks(stateDir: string): BackgroundTaskRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'background-tasks.json'), 'utf8'),
    );
    if (!parsed || typeof parsed !== 'object') return undefined;
    const rec = parsed as Record<string, unknown>;
    if (!Array.isArray(rec.tasks)) return undefined;
    const tasks: BackgroundTask[] = [];
    for (const t of rec.tasks) {
      if (!t || typeof t !== 'object') continue;
      const row = t as Record<string, unknown>;
      tasks.push({
        id: str(row.id) ?? '',
        type: str(row.type) ?? '',
        status: str(row.status) ?? '',
        description: str(row.description) ?? '',
      });
    }
    return { ...(str(rec.at) ? { at: str(rec.at) } : {}), tasks };
  } catch {
    return undefined;
  }
}

/**
 * The `shells:` status line body.
 *
 * A dated FACT when a turn has ended here ("as of the last turn end" — it is a
 * snapshot of that moment, not of now, and saying so is the whole point), and
 * the labelled process-tree inference only when no record exists yet.
 */
export function shellStatusLine(stateDir?: string, startPid = process.pid): string {
  const record = stateDir === undefined ? undefined : readBackgroundTasks(stateDir);
  if (record) {
    const when = clockOfIso(record.at);
    const at = when ? `as of the last turn end, ${when}` : 'as of the last turn end';
    const running = record.tasks.filter((t) => t.status === 'running');
    if (running.length === 0) return `none running (${at})`;
    const named = running.map((t) => t.description || t.id).filter(Boolean).join(', ');
    return named ? `${running.length} running (${at}): ${named}` : `${running.length} running (${at})`;
  }
  const n = countBackgroundShells(startPid);
  return n === undefined
    ? 'unknown (no turn has ended in this state dir yet)'
    : `${n} (inferred from the process tree; no turn has ended in this state dir yet)`;
}

/** Local `HH:MM` for an ISO timestamp, or undefined when it cannot be read. */
function clockOfIso(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
