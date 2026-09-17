/**
 * Who is running under a state dir.
 *
 * Two different kinds of claim live in this module, and the tests are split the
 * same way. The SUBAGENT half is a fact written by hooks, and every branch of it
 * is covered here with real files. The SHELL half is an inference off the
 * process tree; what is pinned below is the part that decides the answer — the
 * walk to the session process and the two command-line shapes — against a
 * captured `ps` sample. What is NOT covered by any fixture, and cannot be from a
 * test runner, is the live path: running `ps` inside a real Claude Code session
 * and parsing its output. That is inspection-only, which is exactly why the
 * printed line says "inferred" and why an unanswerable question prints `unknown`
 * rather than `0`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countBackgroundShells,
  countShellsIn,
  readBackgroundTasks,
  readSubagents,
  shellStatusLine,
  subagentStatusLine,
  subagentTypeList,
  SUBAGENT_STALE_SECONDS,
  type Proc,
} from './subagents.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-sub-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function marker(id: string, type: string, ageSeconds = 0): void {
  const dir = path.join(stateDir, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.json`);
  const at = new Date(Date.now() - ageSeconds * 1000);
  fs.writeFileSync(f, JSON.stringify({ version: 1, agent: id, type, at: at.toISOString() }));
  fs.utimesSync(f, at, at);
}

describe('readSubagents', () => {
  it('is empty when the directory does not exist', () => {
    expect(readSubagents(stateDir)).toEqual([]);
  });

  it('reads agent, type and start time', () => {
    marker('ag_1', 'explore');
    expect(readSubagents(stateDir)[0]).toMatchObject({ agent: 'ag_1', type: 'explore' });
    expect(readSubagents(stateDir)[0]!.at).toBeDefined();
  });

  it('ignores a marker older than 12h, and does not delete it', () => {
    marker('ag_old', 'explore', SUBAGENT_STALE_SECONDS + 60);
    expect(readSubagents(stateDir)).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'subagents', 'ag_old.json'))).toBe(true);
  });

  it('keeps one just inside the window', () => {
    marker('ag_edge', 'explore', SUBAGENT_STALE_SECONDS - 60);
    expect(readSubagents(stateDir)).toHaveLength(1);
  });

  it('skips a malformed marker instead of throwing', () => {
    marker('ag_1', 'explore');
    fs.writeFileSync(path.join(stateDir, 'subagents', 'junk.json'), '{not json');
    expect(readSubagents(stateDir).map((s) => s.agent)).toEqual(['ag_1']);
  });

  it('falls back to the filename and "unknown" for a marker missing its fields', () => {
    fs.mkdirSync(path.join(stateDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'subagents', 'ag_x.json'), JSON.stringify({ version: 1 }));
    expect(readSubagents(stateDir)[0]).toMatchObject({ agent: 'ag_x', type: 'unknown' });
  });
});

describe('subagentTypeList — the same grammar the hook composes', () => {
  it('sorts by type name and counts repeats, the multiplier not affecting the sort', () => {
    marker('a', 'explore');
    marker('b', 'explore');
    marker('c', 'code-review');
    expect(subagentTypeList(readSubagents(stateDir))).toBe('code-review, 2× explore');
  });

  it('is empty for nothing', () => {
    expect(subagentTypeList([])).toBe('');
  });
});

describe('subagentStatusLine', () => {
  it('says none, and names the scope so nobody reads it as per-session', () => {
    expect(subagentStatusLine(stateDir)).toBe('none running (this state dir)');
  });

  it('counts AGENTS and lists types', () => {
    marker('a', 'explore');
    marker('b', 'explore');
    marker('c', 'code-review');
    expect(subagentStatusLine(stateDir)).toBe('3 running (this state dir): code-review, 2× explore');
  });
});

/**
 * The `ps -eo pid=,ppid=,args=` sample below is the shape this box produces: a
 * `claude` session with two background shells sourcing a shell snapshot, an MCP
 * server, and an unrelated login bash that must NOT be counted.
 */
const PS_SAMPLE: Proc[] = [
  { pid: 1, ppid: 0, args: '/sbin/init' },
  { pid: 100, ppid: 1, args: '/usr/bin/node /usr/local/bin/claude' },
  { pid: 101, ppid: 100, args: '/bin/bash -c source /home/jake/.claude/shell-snapshots/snapshot-bash-abc.sh && npm test' },
  { pid: 102, ppid: 100, args: '/bin/bash -c source /home/jake/.claude/shell-snapshots/snapshot-bash-def.sh && tail -f log' },
  { pid: 103, ppid: 100, args: 'node /home/jake/mcp/server.js' },
  { pid: 104, ppid: 100, args: '/bin/bash -c sparrow skill status' }, // a tool call, not a background shell
  { pid: 105, ppid: 1, args: '-bash' }, // somebody's login shell
  { pid: 106, ppid: 104, args: 'node /usr/local/bin/sparrow skill status' }, // us
];

describe('countShellsIn — the inference, pinned against a ps sample', () => {
  it('walks up to the session process and counts its snapshot shells', () => {
    expect(countShellsIn(PS_SAMPLE, 106)).toBe(2);
  });

  it('counts the same from the session process itself', () => {
    expect(countShellsIn(PS_SAMPLE, 100)).toBe(2);
  });

  it('counts zero for a session with no background shells', () => {
    const table = PS_SAMPLE.filter((p) => p.pid !== 101 && p.pid !== 102);
    expect(countShellsIn(table, 106)).toBe(0);
  });

  it('answers UNKNOWN when there is no claude ancestor (a plain terminal)', () => {
    expect(countShellsIn(PS_SAMPLE, 105)).toBeUndefined();
  });

  it('answers unknown rather than guessing when the chain is broken', () => {
    expect(countShellsIn(PS_SAMPLE, 999)).toBeUndefined();
  });

  it('never counts another session\'s shells', () => {
    const table: Proc[] = [
      ...PS_SAMPLE,
      { pid: 200, ppid: 1, args: '/usr/bin/node /usr/local/bin/claude' },
      { pid: 201, ppid: 200, args: '/bin/bash -c source /home/x/.claude/shell-snapshots/snapshot-bash-z.sh && sleep 1' },
    ];
    expect(countShellsIn(table, 106)).toBe(2);
  });
});

describe('the live shell inference', () => {
  /**
   * DELIBERATELY SHAPE-ONLY. The answer depends on where the suite runs: under a
   * Claude Code session (how this was developed — the run that wrote this file
   * resolved a session and counted 2 background shells, which is the only live
   * evidence the code path works) it is a number; on CI, or anywhere without a
   * `claude` ancestor or a readable process table, it is undefined. Asserting
   * either would pin the environment, not the behaviour. What IS asserted is the
   * contract that matters: never a guess, and the string always says which kind
   * of answer it is.
   */
  it('either counts or says it cannot tell — never a bare number pretending to be fact', () => {
    const n = countBackgroundShells();
    const line = shellStatusLine();
    if (n === undefined) {
      expect(line).toBe('unknown (no turn has ended in this state dir yet)');
    } else {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(line).toBe(`${n} (inferred from the process tree; no turn has ended in this state dir yet)`);
    }
  });
});

/* ------------------------- the background-task record ---------------------- *
 * MEASURED 2026-09-17: the Stop payload's `background_tasks` is the harness's
 * own answer, so this line stops being an inference once a turn has ended. It is
 * a SNAPSHOT of that moment, which is why every rendering says "as of the last
 * turn end" and carries the time.
 * ------------------------------------------------------------------------- */
function writeTasks(tasks: Record<string, string>[], at = new Date()): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'background-tasks.json'),
    JSON.stringify({ version: 1, at: at.toISOString(), tasks }),
  );
}
const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('readBackgroundTasks', () => {
  it('is undefined when no turn has ended here', () => {
    expect(readBackgroundTasks(stateDir)).toBeUndefined();
  });

  it('is undefined for a malformed record, rather than throwing', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'background-tasks.json'), '{not json');
    expect(readBackgroundTasks(stateDir)).toBeUndefined();
  });

  it('reads the four fields it keeps', () => {
    writeTasks([{ id: 'bn0', type: 'shell', status: 'running', description: 'Tail the log' }]);
    expect(readBackgroundTasks(stateDir)!.tasks[0]).toEqual({
      id: 'bn0',
      type: 'shell',
      status: 'running',
      description: 'Tail the log',
    });
  });
});

describe('shellStatusLine — from the record', () => {
  it('names the running tasks and when the snapshot was taken', () => {
    const at = new Date();
    writeTasks(
      [
        { id: 'bn0', type: 'shell', status: 'running', description: 'Sleep 40 seconds in background' },
        { id: 'bn1', type: 'shell', status: 'running', description: 'Build the bundle' },
      ],
      at,
    );
    expect(shellStatusLine(stateDir)).toBe(
      `2 running (as of the last turn end, ${hhmm(at)}): Sleep 40 seconds in background, Build the bundle`,
    );
  });

  it('says none for an empty list', () => {
    const at = new Date();
    writeTasks([], at);
    expect(shellStatusLine(stateDir)).toBe(`none running (as of the last turn end, ${hhmm(at)})`);
  });

  it('ignores tasks that are no longer running', () => {
    const at = new Date();
    writeTasks([{ id: 'bn1', type: 'shell', status: 'completed', description: 'Build' }], at);
    expect(shellStatusLine(stateDir)).toBe(`none running (as of the last turn end, ${hhmm(at)})`);
  });

  it('falls back to the id when a task carries no description', () => {
    const at = new Date();
    writeTasks([{ id: 'bn0', type: 'shell', status: 'running', description: '' }], at);
    expect(shellStatusLine(stateDir)).toBe(`1 running (as of the last turn end, ${hhmm(at)}): bn0`);
  });

  it('still says "as of the last turn end" when the record has no timestamp', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'background-tasks.json'), JSON.stringify({ version: 1, tasks: [] }));
    expect(shellStatusLine(stateDir)).toBe('none running (as of the last turn end)');
  });
});
