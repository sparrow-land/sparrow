/**
 * Claude session continuity for `sparrow harness`: one session per (profile,
 * conversation), remembered in `<state>/harness/sessions.json`.
 *
 * Harness mode spawns a fresh process per burst of work, so without this every
 * message to `#Product` starts an agent with amnesia. Keying by CONVERSATION
 * (room or email thread) rather than by agent is what makes the resumed session
 * the right one: an agent talking in three rooms holds three threads of thought,
 * exactly as a person does. Keying by PROFILE keeps two agents enrolled on one
 * machine out of each other's sessions.
 *
 * Best-effort throughout: this is a convenience, never a correctness input. A
 * missing, unreadable or corrupt store reads as empty and a failed write is
 * swallowed — the worst case is one run that starts fresh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from '@sparrow/skill';

type Env = Record<string, string | undefined>;

/** `<state>/harness/sessions.json` — beside the heartbeat, under the same state dir. */
export function sessionsPath(env: Env): string {
  return path.join(resolveStateDir(env), 'harness', 'sessions.json');
}

/** profile → conversation key (`room:<id>` / `thread:<id>`) → runner session id. */
type SessionFile = Record<string, Record<string, string>>;

function load(env: Env): SessionFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsPath(env), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SessionFile;
  } catch {
    return {};
  }
}

function save(env: Env, data: SessionFile): void {
  try {
    const file = sessionsPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* a lost session id costs one fresh run, never a failed reply */
  }
}

/** The stored runner session id for one conversation, if any. */
export function readSession(env: Env, profile: string, key: string): string | undefined {
  const entry = load(env)[profile]?.[key];
  return typeof entry === 'string' && entry !== '' ? entry : undefined;
}

/** Remember the session a run established, so the next one can resume it. */
export function writeSession(env: Env, profile: string, key: string, sessionId: string): void {
  const data = load(env);
  data[profile] = { ...(data[profile] ?? {}), [key]: sessionId };
  save(env, data);
}

/** Forget one conversation's session (a `--resume` the runner could not honor). */
export function dropSession(env: Env, profile: string, key: string): void {
  const data = load(env);
  if (data[profile]?.[key] === undefined) return;
  delete data[profile]![key];
  save(env, data);
}
