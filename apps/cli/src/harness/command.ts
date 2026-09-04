/**
 * `sparrow harness` — the command surface for harness mode.
 *
 * Everything here is wiring: parse the flags, enroll or resolve credentials,
 * decide what the timeline looks like, and hand a fully-configured
 * {@link runHarness} the client, the runner config and a work source. The
 * behaviour lives in the modules beside this one so it can be tested without a
 * terminal.
 */
import path from 'node:path';
import os from 'node:os';
import pc from 'picocolors';
import { SparrowClient, ApiError } from '@sparrow/client';
import { deriveDefaultAgentName } from '@sparrow/common-types/identity';
import type { Command as Cmd } from 'commander';
import {
  dedupeProfileName,
  loadCredentials,
  savePending,
  type PendingEnrollment,
} from '../credentials.js';
import {
  CliError,
  CLI_CLIENT_IDENT,
  buildClient,
  parseInviteUrl,
  type Env,
  type GlobalOpts,
} from '../util.js';
import type { CliIO } from '../index.js';
import {
  findAgentProfileForServer,
  pollEnrollmentUntilResolved,
  readOrgName,
  rememberOrgName,
  saveApprovedProfile,
} from './enroll-flow.js';
import { runHarness } from './orchestrator.js';
import { renderBanner, renderEvent, type BannerInfo, type HarnessEvent } from './render.js';
import type { RunnerConfig, RunnerKind } from './runner.js';
import { streamWorkSource } from './stream-source.js';

const BATCH_WINDOW_DEFAULT = 3;
const RUN_TIMEOUT_DEFAULT = 600;
const CONTEXT_DEFAULT = 20;
const PERMISSION_MODE_DEFAULT = 'acceptEdits';
const ENROLL_TIMEOUT_DEFAULT = 600;
/** Same stream-health defaults `watch`/`loop` use: ~3 missed heartbeats, 5-minute refresh. */
const STALE_MS = 75_000;
const MAX_STREAM_AGE_MS = 300_000;
/** Floor on how long a black-holed stream can delay a reply. */
const POLL_MS = 30_000;

/** Erase the current terminal line (only ever written to a real TTY). */
const CLEAR_LINE = `\r${String.fromCharCode(27)}[2K`;

/** What `registerHarnessCommand` needs from `runCli`'s closure. */
export interface HarnessDeps {
  env: Env;
  io: CliIO;
  /** `runCli`'s shared `-j/--profile/--server` option group. */
  withCommon: (cmd: Cmd) => Cmd;
  /** `runCli`'s action wrapper (json flag, error printing, exit code). */
  action: (
    handler: (opts: GlobalOpts & Record<string, unknown>, args: string[]) => Promise<void>,
  ) => (...cbArgs: unknown[]) => Promise<void>;
}

const NO_CREDENTIALS = [
  'No Sparrow credentials resolved, so there is no agent to run.',
  '',
  'Enroll and run in one step with the invite URL from your Sparrow window',
  '(the Invite dialog — copy the link):',
  '',
  '  sparrow harness --url https://your-sparrow/invite/<token>',
  '',
  'After that first run, plain `sparrow harness` picks the profile up again.',
].join('\n');

/** Shorten a path for the banner: `$HOME/proj` reads better as `~/proj`. */
function tildify(dir: string): string {
  const home = os.homedir();
  if (dir === home) return '~';
  return dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
}

/** Which runner the flags selected — and a clear error when they selected two. */
function resolveRunner(opts: Record<string, unknown>): { kind: RunnerKind; command?: string } {
  const chosen: Array<{ kind: RunnerKind; command?: string }> = [];
  if (opts.claude) chosen.push({ kind: 'claude' });
  if (opts.codex) chosen.push({ kind: 'codex' });
  if (opts.gemini) chosen.push({ kind: 'gemini' });
  if (typeof opts.exec === 'string') chosen.push({ kind: 'exec', command: opts.exec });
  if (chosen.length > 1) {
    throw new CliError('Pick ONE runner: --claude (the default), --codex, --gemini, or --exec <cmd>.');
  }
  return chosen[0] ?? { kind: 'claude' };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function registerHarnessCommand(program: Cmd, deps: HarnessDeps): void {
  const { env, io } = deps;

  /** Follow an invite: enroll, wait for approval if it is held, save the profile. */
  const enroll = async (
    inviteToken: string,
    server: string,
    name: string,
    opts: GlobalOpts & Record<string, unknown>,
    emit: (ev: HarnessEvent) => void,
  ): Promise<{ token: string; profileName: string }> => {
    const explicit = opts.profile as string | undefined;
    const profileName = explicit ?? dedupeProfileName(name, loadCredentials(env).profiles);
    const anon = new SparrowClient({ server, clientIdent: CLI_CLIENT_IDENT });
    const res = await anon.enrollAgent(inviteToken, { name });

    if (res.status === 'admitted') {
      const saved = saveApprovedProfile(
        env,
        { server, inviteToken, enrollmentId: '', enrollmentToken: '', name, profileName },
        {
          status: 'approved',
          agent: res.agent,
          key: res.key,
          org: res.org,
          dmRoomId: res.dmRoomId,
          emailAddress: res.agent.emailAddress,
        },
      );
      emit({
        type: 'harness.enroll.done',
        agent: saved.agent.name,
        org: saved.org.name,
        profile: profileName,
      });
      return { token: res.key, profileName };
    }

    // Held for approval: persist the pending record (so a Ctrl-C is resumable
    // with `sparrow enroll --resume`) and wait, exactly as `sparrow enroll` does.
    const pending: PendingEnrollment = {
      server,
      inviteToken,
      enrollmentId: res.enrollment.id,
      enrollmentToken: res.enrollmentToken,
      name,
      profileName,
    };
    savePending(env, pending);
    emit({ type: 'harness.enroll.waiting', name });
    const poll = await pollEnrollmentUntilResolved(
      anon,
      pending,
      positiveInt(opts.enrollTimeout, ENROLL_TIMEOUT_DEFAULT) * 1000,
      env,
    );
    if (poll.status === 'timeout') {
      if (poll.unreachable) {
        throw new CliError(
          `Lost contact with the server while waiting for approval (${poll.lastError ?? 'unreachable'}). ` +
            'Your request is saved — re-run `sparrow harness --url <url>` (or ' +
            '`sparrow enroll --resume`) to keep waiting.',
        );
      }
      throw new CliError(
        'Still waiting for approval. The request is saved — re-run `sparrow harness --url <url>` ' +
          '(or `sparrow enroll --resume`) to keep waiting.',
      );
    }
    if (poll.status === 'denied') throw new CliError('Your enrollment request was denied.');
    const saved = saveApprovedProfile(env, pending, poll);
    emit({
      type: 'harness.enroll.done',
      agent: saved.agent.name,
      org: saved.org.name,
      profile: profileName,
    });
    const key = loadCredentials(env).profiles[profileName]?.token;
    if (!key) throw new CliError('Enrollment approved but the key could not be stored.');
    return { token: key, profileName };
  };

  deps
    .withCommon(program.command('harness'))
    .description(
      'HARNESS MODE: sparrow owns the loop and SPAWNS your agent. Holds /me/events (so you are ' +
        'genuinely online) and, when work arrives, runs `claude -p` (or --codex/--gemini/--exec) ' +
        'to handle it and posts its final text as the reply. Items are acked only after a ' +
        'successful reply. With --url it enrolls first, exactly as `sparrow enroll` does.',
    )
    .option('--url <inviteUrl>', 'enroll with this invite URL first, then run (idempotent)')
    .option('--claude', 'run `claude -p` as the agent runner (the default)')
    .option('--codex', 'run `codex exec` as the agent runner')
    .option('--gemini', 'run `gemini` as the agent runner')
    .option('--exec <cmd>', 'run any command as the runner: prompt on stdin, stdout is the reply')
    .option('--model <model>', 'model passed through to the runner')
    .option('--name <agentName>', 'agent name when enrolling (default {host}-{folder}, or SPARROW_NAME)')
    .option('--cwd <dir>', 'working directory the runner is spawned in (default: this directory)')
    .option(
      '--permission-mode <mode>',
      `claude --permission-mode (default ${PERMISSION_MODE_DEFAULT}); with -p claude DENIES rather than prompts, so a run can fail but never hangs`,
    )
    .option(
      '--yolo',
      'bypass permissions in the runner (claude bypassPermissions, gemini -y, codex full access)',
    )
    .option('--no-resume', 'never reuse a claude session — every run starts fresh')
    .option(
      '--context <n>',
      `prepend this many recent transcript messages to the prompt (default ${CONTEXT_DEFAULT}; for claude only on a session's first run)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--run-timeout <seconds>',
      `kill the runner's process group after this long and count it as a failure (default ${RUN_TIMEOUT_DEFAULT})`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--batch-window <seconds>',
      `collect a burst this long before spawning one runner for it (default ${BATCH_WINDOW_DEFAULT})`,
      (v) => Number.parseInt(v, 10),
    )
    .option('--once', 'handle whatever is waiting now (one pass) and exit 0 — for smoke tests and cron')
    .option('-v, --verbose', "also stream the runner's stderr")
    .option(
      '--enroll-timeout <seconds>',
      `(with --url) max seconds to wait for approval (default ${ENROLL_TIMEOUT_DEFAULT})`,
      (v) => Number.parseInt(v, 10),
    )
    .addHelpText(
      'after',
      [
        '',
        'Inline mode pastes an invite into a session you already have open, and that session owns',
        'the loop. Harness mode inverts it: this process owns the loop and your agent is a',
        'function it calls. Leave it running on a machine that stays up.',
        '',
        'The runner is spawned unattended, so permissions are a decision you make here, once:',
        '`claude -p` DENIES anything it would otherwise prompt for, so a run can fail but never',
        'hangs. --permission-mode acceptEdits (the default) lets it edit files; --yolo removes the',
        'guard rails entirely and belongs on a sandbox or a repo you can revert.',
        '',
        'Examples:',
        '  sparrow harness --url https://sparrow.example.com/invite/ivk_... --cwd ~/proj',
        '  sparrow harness --codex --model gpt-5',
        '  sparrow harness --exec "my-agent --stdin" --once',
      ].join('\n'),
    )
    .action(
      deps.action(async (opts) => {
        const json = Boolean(opts.json);
        const verbose = Boolean(opts.verbose);
        const runnerChoice = resolveRunner(opts);
        const cwd = (opts.cwd as string | undefined) ?? process.cwd();

        /* ------------------------------ output ------------------------------ */
        let banner: BannerInfo | undefined;
        let bannerShown = false;
        const emit = (ev: HarnessEvent): void => {
          if (json) {
            io.out(`${JSON.stringify(ev)}\n`);
            return;
          }
          // The banner IS the online line, so coming online prints the banner —
          // once. (Under `--once` the banner is already out, and it says "one
          // pass"; announcing "waiting for messages" underneath it would
          // contradict the mode.)
          if (ev.type === 'harness.online') {
            if (banner && !bannerShown) {
              bannerShown = true;
              io.out(`${renderBanner(banner)}\n`);
            }
            return;
          }
          const line = renderEvent(ev);
          if (line !== null) io.out(`${line}\n`);
        };

        /* -------------------- credentials: enroll or resolve -------------------- */
        let server: string;
        let token: string;
        let profileName: string | undefined;
        let reused = false;

        const inviteUrl = opts.url as string | undefined;
        if (inviteUrl) {
          const parsed = parseInviteUrl(
            inviteUrl,
            (opts.server as string | undefined) ?? env.SPARROW_SERVER,
          );
          server = parsed.server;
          const existing = findAgentProfileForServer(
            env,
            server,
            (opts.profile as string | undefined) ?? env.SPARROW_PROFILE,
          );
          if (existing) {
            // Re-running with the invite still in the scrollback must not mint a
            // second agent — notice the first one and just run.
            token = existing.profile.token;
            profileName = existing.name;
            reused = true;
            // The invite itself names the org (unauthenticated), which is how a
            // profile enrolled before we started keeping the name catches up.
            if (readOrgName(env, profileName) === undefined) {
              try {
                const info = await new SparrowClient({
                  server,
                  clientIdent: CLI_CLIENT_IDENT,
                }).inviteInfo(parsed.token);
                rememberOrgName(env, profileName, info.org.name);
              } catch {
                /* an expired invite still runs; the banner falls back to the id */
              }
            }
          } else {
            const name =
              (opts.name as string | undefined) ?? env.SPARROW_NAME ?? deriveDefaultAgentName();
            const enrolled = await enroll(parsed.token, server, name, opts, emit);
            token = enrolled.token;
            profileName = enrolled.profileName;
          }
        } else {
          let resolved;
          try {
            resolved = buildClient(opts, env);
          } catch {
            throw new CliError(NO_CREDENTIALS);
          }
          if (!resolved.token) throw new CliError(NO_CREDENTIALS);
          server = resolved.server;
          token = resolved.token;
          profileName = resolved.profileName;
        }

        const client = new SparrowClient({ server, token, clientIdent: CLI_CLIENT_IDENT });

        /* ------------------------------ who am I ------------------------------ */
        const me = await client.me();
        if (me.type !== 'agent') {
          throw new CliError(
            'sparrow harness runs an AGENT. This profile is a human login — enroll an agent with ' +
              '`sparrow harness --url <invite url>`.',
          );
        }
        const orgName = await orgNameOf(client, me.orgId, env, profileName);
        if (reused && profileName) {
          emit({ type: 'harness.enroll.reused', agent: me.name, profile: profileName });
        }

        /* ------------------------------ the runner ------------------------------ */
        const runner: RunnerConfig = {
          kind: runnerChoice.kind,
          command: runnerChoice.command,
          model: opts.model as string | undefined,
          cwd,
          permissionMode: (opts.permissionMode as string | undefined) ?? PERMISSION_MODE_DEFAULT,
          yolo: Boolean(opts.yolo),
          runTimeoutMs: positiveInt(opts.runTimeout, RUN_TIMEOUT_DEFAULT) * 1000,
        };
        const once = Boolean(opts.once);
        banner = {
          agent: me.name,
          org: orgName,
          profile: profileName,
          server,
          runner:
            runnerChoice.kind === 'exec' ? (runnerChoice.command ?? 'exec') : runnerChoice.kind,
          model: runner.model,
          permissionMode: runner.yolo ? 'bypassPermissions' : runner.permissionMode,
          cwd: tildify(cwd),
          once,
        };
        // A one-pass run makes no claim about being online, so its banner does
        // not wait for the stream — and cannot lose the race against a queue
        // that is already drained by the time the socket opens.
        if (once && !json) {
          bannerShown = true;
          io.out(`${renderBanner(banner)}\n`);
        }

        /* ------------------------------- signals ------------------------------- */
        // SIGINT/SIGTERM stop CLEANLY and exit 0: the in-flight runner is killed,
        // nothing is acked, statuses go idle. Deliberately NOT the shared listener
        // signal helper, which stamps the skill heartbeat and exits 143 — harness
        // mode runs no skill, and a deliberate stop is not a failure.
        const controller = new AbortController();
        const onSignal = (sig: string) => (): void => {
          emit({ type: 'harness.stopped', reason: sig });
          controller.abort();
        };
        const onInt = onSignal('SIGINT');
        const onTerm = onSignal('SIGTERM');
        const onHup = onSignal('SIGHUP');
        process.once('SIGINT', onInt);
        process.once('SIGTERM', onTerm);
        process.once('SIGHUP', onHup);

        const spinner = json ? undefined : makeSpinner();

        try {
          await runHarness({
            client,
            env,
            profileName,
            agent: { name: me.name, orgName },
            server,
            runner,
            batchWindowMs: positiveInt(opts.batchWindow, BATCH_WINDOW_DEFAULT) * 1000,
            contextCount: positiveInt(opts.context, CONTEXT_DEFAULT),
            // commander maps `--no-resume` to `resume === false`.
            resumeSessions: opts.resume !== false,
            once,
            signal: controller.signal,
            workSource: streamWorkSource({
              client,
              staleMs: STALE_MS,
              maxStreamAgeMs: MAX_STREAM_AGE_MS,
              pollMs: POLL_MS,
              isFatal: (e) =>
                e instanceof ApiError && (e.status === 426 || e.code === 'client_upgrade_required'),
            }),
            emit: (ev) => {
              spinner?.observe(ev);
              emit(ev);
            },
            // `-v`: the runner's own stderr, indented and dimmed so it reads as
            // subordinate to the timeline rather than competing with it.
            onRunnerStderr: verbose
              ? (chunk): void =>
                  io.err(pc.dim(chunk.replace(/^/gm, '    ').replace(/\s+$/, '')) + '\n')
              : undefined,
          });
        } finally {
          spinner?.stop();
          process.off('SIGINT', onInt);
          process.off('SIGTERM', onTerm);
          process.off('SIGHUP', onHup);
        }
      }),
    );
}

/**
 * The org's DISPLAY NAME for the banner and the runner's prompt.
 *
 * There is no route that hands a running agent its org name: `GET /orgs/:orgId`
 * and `GET /me/orgs` both require a human SESSION, and `GET /me` gives an agent
 * an `orgId` and nothing more. So the name is whatever enrollment stored
 * (see `ProfileState.orgName`), and the live lookup is kept only because a
 * HUMAN profile — or a later agent-readable route — can still answer it. The id
 * is the last resort: ugly, but never wrong.
 */
async function orgNameOf(
  client: SparrowClient,
  orgId: string,
  env: Env,
  profileName?: string,
): Promise<string> {
  try {
    const name = (await client.getOrg(orgId)).name;
    if (name && profileName) rememberOrgName(env, profileName, name);
    if (name) return name;
  } catch {
    /* session-only route — an agent key lands here every time */
  }
  return (profileName ? readOrgName(env, profileName) : undefined) ?? orgId;
}

/**
 * The live elapsed counter under a run. Only on a real TTY: piped output gets
 * the one-line run/reply pair and nothing that needs a carriage return to erase.
 */
function makeSpinner(): { observe: (ev: HarnessEvent) => void; stop: () => void } | undefined {
  const out = process.stdout;
  if (!out.isTTY) return undefined;
  const frames = ['|', '/', '-', '\\'];
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let frame = 0;
  const clear = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    out.write(CLEAR_LINE);
  };
  return {
    observe: (ev) => {
      if (ev.type === 'harness.run.start') {
        clear();
        startedAt = Date.now();
        timer = setInterval(() => {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          out.write(`${CLEAR_LINE}  ${frames[frame++ % frames.length]} ${secs}s`);
        }, 120);
        (timer as unknown as { unref?: () => void }).unref?.();
      } else if (
        ev.type === 'harness.run.done' ||
        ev.type === 'harness.run.failed' ||
        ev.type === 'harness.reply'
      ) {
        clear();
      }
    },
    stop: clear,
  };
}
