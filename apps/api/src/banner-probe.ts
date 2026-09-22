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
 * The exchange is three requests written back to back, and answered in order:
 *
 *   1. `ESC _ G i=31,s=1,v=1,a=q,t=d,f=24;AAAA ESC \` — a kitty graphics
 *      *query* (`a=q`): "could you accept this 1x1 RGB image under id 31?".
 *      `a=q` means the terminal answers but draws NOTHING and stores nothing.
 *      A terminal that implements the protocol answers `ESC _ G i=31;OK ESC \`,
 *      or an error such as `ESC _ G i=31;ENOTSUPPORTED:... ESC \` — the error
 *      is still an answer, and it means "not for us". (No `q=2` here: that key
 *      would suppress exactly the reply we are asking for.)
 *   2. `ESC [ > 0 q` — XTVERSION, "what are you called?". kitty, Ghostty,
 *      WezTerm, iTerm2, foot and xterm all answer it with a DCS frame,
 *      `ESC P > | <name and version> ESC \`.
 *   3. `ESC [ c` — DA1, "identify yourself". EVERY VT-ish terminal answers it
 *      (`ESC [ ? 6 2 ; ... c`), and answers it last, after the other two.
 *
 * So DA1 is the fence: once its reply lands the conversation is over, and the
 * probe waits for it even when it already knows the answer — see
 * {@link probeKittyGraphics}. That is also what makes the probe bounded instead
 * of a hang: a terminal that ignores the APC and the DCS entirely still trips
 * the fence microseconds later.
 *
 * WHY THE NAME, AND NOT JUST `OK` (2026-09-21). iTerm2 3.5 implements the kitty
 * protocol *partially*: it answers the feature query with `OK`, and then fails
 * the real transmission with `ENOENT:Image not found after transmission`,
 * leaving a blank hole where the bird should be. `OK` therefore proves only
 * "speaks the protocol"; the NAME is what proves "one of the three terminals we
 * know draws it without prompting and without falling over". Both are required.
 *
 * Nothing here is written unless BOTH stdin and stdout are real TTYs, and the
 * probe never throws: every failure path is a `false`, i.e. the ASCII bird.
 */

/**
 * Terminals whose name we accept from XTVERSION. The same three the env
 * allowlist in `banner.ts` recognises (`onImageAllowlist` imports this list, so
 * the two halves of the decision can never drift apart).
 */
export const IMAGE_TERMINAL_ALLOWLIST = ['kitty', 'ghostty', 'wezterm'] as const;

/** The kitty graphics feature query. `i=31` is ours; the reply echoes it. */
export const KITTY_GRAPHICS_QUERY = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\';

/** XTVERSION: "name and version, please" — answered as a DCS `>|` frame. */
export const XTVERSION_QUERY = '\x1b[>0q';

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

/** What the bytes so far amount to. */
export interface ProbeResult {
  /** The decision the evidence supports; `pending` while evidence is missing. */
  verdict: ProbeVerdict;
  /** The XTVERSION name, verbatim, when the terminal has given one. */
  terminal?: string;
  /** Whether the DA1 fence has landed — i.e. whether `verdict` is final. */
  fenced: boolean;
}

/** The id we asked about — a reply for any other id is somebody else's. */
const PROBE_IMAGE_ID = '31';

/** A whole APC frame: `ESC _ G <body> ESC \`, body free of further escapes. */
const APC_REPLY = /\x1b_G([^\x1b]*)\x1b\\/g;
/** A whole XTVERSION reply: `ESC P > | <name> ESC \` (a DCS frame). */
const XTVERSION_REPLY = /\x1bP>\|([^\x1b]*)\x1b\\/;
/** A DA1 reply: `ESC [ ? <params> c`. */
const DA1_REPLY = /\x1b\[\?[0-9;]*c/;

/**
 * Whether an XTVERSION name is one of ours. Terminals answer things like
 * `kitty(0.36.4)`, `ghostty 1.1.3`, `WezTerm 20240203-110809-5046fc22` and
 * `iTerm2 3.5.14`, so the comparison is on the leading run of letters,
 * lower-cased — never a substring search, which would let `iTerm2` in through
 * some other terminal's version string.
 */
function allowlistedTerminal(name: string | undefined): boolean {
  const head = /^[a-z]+/.exec((name ?? '').trim().toLowerCase())?.[0];
  return head !== undefined && IMAGE_TERMINAL_ALLOWLIST.some((t) => t === head);
}

/**
 * Read the bytes collected so far and decide — a pure function, so every
 * response shape can be asserted without a terminal.
 *
 * `supported` needs BOTH a positive answer for OUR image id AND an allowlisted
 * name: `OK` proves the protocol is spoken, the name proves the terminal
 * actually draws it (iTerm2 says `OK` and then fails the transmission).
 *
 * Order is evidence too, because the terminal answers in the order we asked:
 *  - anything after the DA1 fence is ignored entirely — the fence ends it;
 *  - a graphics reply only counts if it precedes the XTVERSION reply, so a name
 *    arriving with no `OK` in front of it is itself a "no graphics answer".
 *
 * Everything short of that is `unsupported` once there is anything final to go
 * on (the fence, a name, or an error for our id) and `pending` otherwise: a
 * half-read APC or DCS frame must never be mistaken for a refusal.
 */
export function parseProbeResponse(buf: Buffer): ProbeResult {
  // latin1: the replies are ASCII, and a byte-per-char decode can never
  // swallow a lone ESC into a replacement character mid-frame.
  const text = buf.toString('latin1');
  const fenceAt = text.search(DA1_REPLY);
  const fenced = fenceAt !== -1;
  const before = fenced ? text.slice(0, fenceAt) : text;

  const version = XTVERSION_REPLY.exec(before);
  const terminal = version?.[1]?.trim();
  // Graphics replies count only ahead of the name: the terminal answers our
  // queries in the order we wrote them.
  const graphics = version ? before.slice(0, version.index) : before;

  let ok = false;
  let errorForUs = false;
  APC_REPLY.lastIndex = 0;
  for (const match of graphics.matchAll(APC_REPLY)) {
    const body = match[1] ?? '';
    const semi = body.indexOf(';');
    const keys = semi === -1 ? body : body.slice(0, semi);
    const payload = semi === -1 ? '' : body.slice(semi + 1);
    const ours = keys.split(',').some((kv) => kv.trim() === `i=${PROBE_IMAGE_ID}`);
    if (!ours) continue;
    // An `OK` leaves the question open until the name arrives; an error for our
    // id is already the whole answer.
    if (payload.trim().startsWith('OK')) ok = true;
    else errorForUs = true;
  }

  const result = (verdict: ProbeVerdict): ProbeResult =>
    terminal === undefined ? { verdict, fenced } : { verdict, terminal, fenced };

  if (ok && allowlistedTerminal(terminal)) return result('supported');
  // A name, an error for our id, or the fence: each one closes a door.
  if (fenced || terminal !== undefined || errorForUs) return result('unsupported');
  return result('pending');
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
 * Ask the terminal whether it speaks the kitty graphics protocol — and which
 * terminal it is.
 *
 * Resolves `true` only when an `OK` for our query AND an allowlisted XTVERSION
 * name have both arrived before the DA1 fence; `false` for everything else,
 * including the timeout, a non-TTY, a stdin that will not go raw, and any
 * thrown error.
 *
 * It ALWAYS waits for the fence (or the timeout), even once the answer is known
 * to be yes. Resolving early restores the line discipline while the replies we
 * ourselves requested are still in flight, and the cooked terminal then echoes
 * them onto the screen — which is exactly how `^[[?64;1;2;...c` ended up under
 * the banner on iTerm2. Nothing we asked for may outlive raw mode.
 *
 * It restores the previous raw mode, pauses stdin and removes its listener on
 * EVERY path — a probe that left the terminal raw would be far worse than a
 * missing picture.
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
        const { verdict, fenced } = parseProbeResponse(chunks);
        // The fence, and ONLY the fence, ends the conversation early: a yes
        // that has not been fenced yet still has a DA1 reply coming.
        if (fenced) settle(verdict === 'supported');
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
        // Order matters: graphics, then the name, then the fence. The terminal
        // answers them in the same order, so a fence with nothing in front of
        // it is a definitive "no".
        stdout.write(KITTY_GRAPHICS_QUERY);
        stdout.write(XTVERSION_QUERY);
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
