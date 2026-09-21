/**
 * Asking the terminal, instead of guessing from `TERM`.
 *
 * The banner's env ALLOWLIST (`imageBannerMode` in `banner.ts`) cannot see
 * through a container: inside `docker run -it` the host terminal's `TERM` and
 * `TERM_PROGRAM` are gone and `TERM` is a plain `xterm`, so a Ghostty or kitty
 * user gets the ASCII bird even though their terminal would happily draw the
 * illustration. This module closes that gap the way timg, chafa and notcurses
 * do it — a runtime feature query, written to the terminal and read back.
 *
 * The exchange is two requests written back to back:
 *
 *   1. `ESC _ G i=31,s=1,v=1,a=q,t=d,f=24;AAAA ESC \` — a kitty graphics
 *      *query* (`a=q`): "could you accept this 1x1 RGB image under id 31?".
 *      `a=q` means the terminal answers but draws NOTHING and stores nothing.
 *      A terminal that implements the protocol answers `ESC _ G i=31;OK ESC \`,
 *      or an error such as `ESC _ G i=31;ENOTSUPPORTED:... ESC \` — the error
 *      is still an answer, and it means "not for us".
 *   2. `ESC [ c` — DA1, "identify yourself". EVERY VT-ish terminal answers it
 *      (`ESC [ ? 6 2 ; ... c`), and answers it in order, after the query.
 *
 * So DA1 is the fence: once its reply lands we are done waiting, and if no
 * graphics reply preceded it the terminal does not speak the protocol. That is
 * what makes the probe bounded instead of a hang — a terminal that ignores the
 * APC entirely still trips the fence microseconds later.
 *
 * Nothing here is written unless BOTH stdin and stdout are real TTYs, and the
 * probe never throws: every failure path is a `false`, i.e. the ASCII bird.
 */

/** The kitty graphics feature query. `i=31` is ours; the reply echoes it. */
export const KITTY_GRAPHICS_QUERY = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\';

/** DA1: the "you have your answer now" fence every terminal replies to. */
export const DA1_QUERY = '\x1b[c';

/**
 * How long to wait for the terminal to speak, in milliseconds.
 *
 * DA1 comes back in microseconds locally and in ~100 ms over a slow ssh link,
 * so 500 ms is generous. It is deliberately NOT smaller: if we restore the line
 * discipline while a reply is still in flight, the cooked terminal ECHOES the
 * late `ESC [ ? 62 ; c` onto the screen as garbage under the banner (and leaves
 * it in the next reader's input). The cost of being generous is a half-second
 * on a terminal that answers nothing at all, which is rare; the cost of being
 * hasty is visible junk on terminals that behave perfectly.
 */
export const PROBE_TIMEOUT_MS = 500;

/** The verdict so far. `pending` means "keep listening", never "no". */
export type ProbeVerdict = 'supported' | 'unsupported' | 'pending';

/** The id we asked about — a reply for any other id is somebody else's. */
const PROBE_IMAGE_ID = '31';

/** A whole APC frame: `ESC _ G <body> ESC \`, body free of further escapes. */
const APC_REPLY = /\x1b_G([^\x1b]*)\x1b\\/g;
/** A DA1 reply: `ESC [ ? <params> c`. */
const DA1_REPLY = /\x1b\[\?[0-9;]*c/;

/**
 * Read the bytes collected so far and decide — a pure function, so every
 * response shape can be asserted without a terminal.
 *
 * `supported` needs a positive answer for OUR image id. `unsupported` is either
 * an answer for our id that is not `OK` (an `E...` error), or the DA1 fence
 * arriving with no such `OK` before it. Anything else is `pending`: a half-read
 * APC frame must never be mistaken for a refusal.
 */
export function parseProbeResponse(buf: Buffer): ProbeVerdict {
  // latin1: the replies are ASCII, and a byte-per-char decode can never
  // swallow a lone ESC into a replacement character mid-frame.
  const text = buf.toString('latin1');
  let answeredForUs = false;
  APC_REPLY.lastIndex = 0;
  for (const match of text.matchAll(APC_REPLY)) {
    const body = match[1] ?? '';
    const semi = body.indexOf(';');
    const keys = semi === -1 ? body : body.slice(0, semi);
    const payload = semi === -1 ? '' : body.slice(semi + 1);
    const ours = keys
      .split(',')
      .some((kv) => kv.trim() === `i=${PROBE_IMAGE_ID}`);
    if (!ours) continue;
    if (payload.trim().startsWith('OK')) return 'supported';
    answeredForUs = true;
  }
  if (answeredForUs) return 'unsupported';
  return DA1_REPLY.test(text) ? 'unsupported' : 'pending';
}

/** The parts of `process.stdin` the probe uses — all a test has to fake. */
export interface ProbeStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/** The parts of `process.stdout` the probe uses. */
export interface ProbeStdout {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface ProbeOptions {
  stdin?: ProbeStdin;
  stdout?: ProbeStdout;
  /** Defaults to {@link PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Ask the terminal whether it speaks the kitty graphics protocol.
 *
 * Resolves `true` only on an explicit `OK` for our query; `false` for
 * everything else, including the timeout, a non-TTY, a stdin that will not go
 * raw, and any thrown error. It restores the previous raw mode, pauses stdin
 * and removes its listener on EVERY path — a probe that left the terminal raw
 * would be far worse than a missing picture.
 */
export async function probeKittyGraphics(opts: ProbeOptions = {}): Promise<boolean> {
  const { stdin, stdout, timeoutMs = PROBE_TIMEOUT_MS } = opts;
  // Preconditions, checked before a single byte is written: we only interrogate
  // a terminal that is on both ends of this process.
  if (!stdin || !stdout) return false;
  if (stdin.isTTY !== true || stdout.isTTY !== true) return false;
  if (typeof stdin.setRawMode !== 'function') return false;
  // Captured here, where the guard above has narrowed it: the closures below
  // are re-entered later, and TypeScript rightly stops trusting the check by
  // then. Bound, so it is still the stream's own method.
  const setRawMode = stdin.setRawMode.bind(stdin) as (mode: boolean) => unknown;

  try {
    return await new Promise<boolean>((resolve) => {
      const wasRaw = stdin.isRaw === true;
      let settled = false;
      let chunks = Buffer.alloc(0);
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onData = (chunk: Buffer): void => {
        chunks = Buffer.concat([chunks, Buffer.from(chunk)]);
        const verdict = parseProbeResponse(chunks);
        // `pending` is the only case that keeps us listening; the moment there
        // is an answer we stop reading, so nothing past it is consumed.
        if (verdict !== 'pending') settle(verdict === 'supported');
      };

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        try {
          stdin.removeListener('data', onData);
        } catch {
          /* nothing left to unhook */
        }
        try {
          stdin.pause();
        } catch {
          /* already closed */
        }
        try {
          setRawMode(wasRaw);
        } catch {
          /* the fd went away; nothing we can do or need to do */
        }
      };

      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      try {
        setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
        timer = setTimeout(() => settle(false), timeoutMs);
        // A pending probe must never be the reason the process stays alive.
        (timer as { unref?: () => void }).unref?.();
        // Order matters: the query first, the fence second. The terminal
        // answers them in the same order, so a fence with nothing in front of
        // it is a definitive "no".
        stdout.write(KITTY_GRAPHICS_QUERY);
        stdout.write(DA1_QUERY);
      } catch {
        settle(false);
      }
    });
  } catch {
    // Belt and braces: the promise above resolves rather than rejects, but a
    // missing banner is never worth an unhandled rejection at startup.
    return false;
  }
}
