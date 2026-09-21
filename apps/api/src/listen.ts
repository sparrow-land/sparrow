/**
 * Binding the port without Fastify narrating it.
 *
 * `app.listen()` logs one `Server listening at <addr>` record at INFO level per
 * bound address, from *inside* `listen()` — so on a container with two
 * addresses (`127.0.0.1` and the bridge IP) the startup output read:
 *
 * ```
 * {"msg":"Server listening at http://127.0.0.1:8722"}
 * <banner>
 * {"msg":"Server listening at http://172.17.0.2:8722"}
 * {"msg":"sparrow API 0.1.46 listening on :8722"}
 * ```
 *
 * The banner is the first thing a human should see, and it cannot move earlier:
 * it is only honest once we are actually serving. So the fastify lines move out
 * of the way instead. Nothing is lost — the port is in our own "listening on"
 * line, and the addresses behind those records are the bind address we chose
 * (`0.0.0.0`) rendered per-interface, not news.
 *
 * The mechanism is the smallest one that works: raise the logger's level to
 * `warn` for the duration of the bind and put it back in a `finally`.
 * `listenTextResolver` cannot help — fastify logs whatever string it returns,
 * including an empty one.
 *
 * Two things this deliberately does NOT do:
 *  - it never LOWERS the level, so `LOG_LEVEL=error` does not get a louder
 *    window while it binds;
 *  - it never touches a logger that has no level — `LOG_LEVEL=off` builds the
 *    server with `logger: false`, whose no-op logger has no `level` at all.
 *
 * Errors stay audible: fastify rejects the listen promise on a bind failure and
 * logs nothing itself (see `logServerAddress` in fastify's `lib/server.js`), and
 * the `finally` restores the level before the caller's `catch` runs.
 */

/** The level we clamp UP to while binding: quiet for info/debug/trace. */
const QUIET_LEVEL = 'warn';
/** Its rank, named once so the comparison below needs no index lookup. */
const QUIET_RANK = 40;

/** Pino's standard level ordering — the only levels `loggerOptions` emits. */
const LEVEL_RANK: Readonly<Record<string, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: QUIET_RANK,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/** Where the server binds. The same shape `app.listen` takes. */
export interface QuietListenOptions {
  port: number;
  host: string;
}

/**
 * The narrow surface {@link listenQuietly} needs: a mutable logger level and a
 * promise-returning `listen`. `FastifyInstance` satisfies it; so does a fake.
 */
export interface QuietListenTarget {
  log: { level?: string };
  listen(options: QuietListenOptions): Promise<string>;
}

/**
 * `app.listen(options)`, minus fastify's own `Server listening at …` records.
 *
 * Returns whatever `listen` returns (the first bound address) and rejects with
 * whatever it rejects with, so it is a drop-in at the call site.
 */
export async function listenQuietly(
  app: QuietListenTarget,
  options: QuietListenOptions,
): Promise<string> {
  const log = app.log;
  const configured = typeof log?.level === 'string' ? log.level : undefined;
  const rank = configured === undefined ? undefined : LEVEL_RANK[configured];
  // Only known levels below `warn` are worth muting: an unknown custom level is
  // someone else's decision, and warn-and-above already hides the info records.
  const quiet = rank !== undefined && rank < QUIET_RANK;
  if (quiet) log.level = QUIET_LEVEL;
  try {
    return await app.listen(options);
  } finally {
    if (quiet) log.level = configured as string;
  }
}
