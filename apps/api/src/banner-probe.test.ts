import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DA1_QUERY,
  KITTY_GRAPHICS_QUERY,
  PROBE_TIMEOUT_MS,
  XTVERSION_QUERY,
  parseProbeResponse,
  probeKittyGraphics,
} from './banner-probe.js';

const ESC = '\x1b';
/** What a kitty-graphics terminal answers our `i=31` query with. */
const OK = `${ESC}_Gi=31;OK${ESC}\\`;
/** What every VT-ish terminal answers DA1 with (the fence). */
const DA1 = `${ESC}[?62;c`;
/** An XTVERSION (`ESC [ > 0 q`) reply: DCS `>|<name>` ST. */
const XT = (name: string): string => `${ESC}P>|${name}${ESC}\\`;

const buf = (...parts: string[]): Buffer => Buffer.from(parts.join(''), 'latin1');

describe('parseProbeResponse', () => {
  it('is supported only when the OK AND an allowlisted terminal name arrive', () => {
    expect(parseProbeResponse(buf(OK, XT('ghostty 1.1.3'), DA1))).toMatchObject({
      verdict: 'supported',
      terminal: 'ghostty 1.1.3',
    });
    expect(parseProbeResponse(buf(OK, XT('kitty(0.36.4)')))).toMatchObject({
      verdict: 'supported',
      terminal: 'kitty(0.36.4)',
    });
    expect(
      parseProbeResponse(buf(OK, XT('WezTerm 20240203-110809-5046fc22'))),
    ).toMatchObject({ verdict: 'supported' });
  });

  it('is UNSUPPORTED for iTerm2, which answers OK and then fails the transmission', () => {
    // The bug, in one assertion: OK alone is not enough, because iTerm2 says OK
    // to the query and then draws nothing.
    expect(parseProbeResponse(buf(OK, XT('iTerm2 3.5.14'), DA1))).toEqual({
      verdict: 'unsupported',
      terminal: 'iTerm2 3.5.14',
      fenced: true,
    });
  });

  it('is unsupported when the terminal will not name itself', () => {
    // OK, no XTVERSION reply at all, then the fence.
    expect(parseProbeResponse(buf(OK, DA1))).toMatchObject({ verdict: 'unsupported' });
  });

  it('is unsupported when an allowlisted name arrives with no OK in front of it', () => {
    // We ask graphics-first, so a name with no graphics reply before it means
    // the terminal never answered the graphics query.
    expect(parseProbeResponse(buf(XT('ghostty 1.1.3')))).toMatchObject({
      verdict: 'unsupported',
      terminal: 'ghostty 1.1.3',
    });
    expect(parseProbeResponse(buf(XT('ghostty 1.1.3'), DA1))).toMatchObject({
      verdict: 'unsupported',
    });
  });

  it('is unsupported when the DA1 fence arrives with no graphics reply before it', () => {
    expect(parseProbeResponse(buf(DA1))).toEqual({ verdict: 'unsupported', fenced: true });
    expect(parseProbeResponse(buf(`${ESC}[?1;2c`))).toMatchObject({ verdict: 'unsupported' });
  });

  it('treats DA1 as the fence: nothing after it counts', () => {
    // Should not happen — the terminal answers in the order we asked — but if
    // it did, a late OK must not resurrect the verdict.
    expect(parseProbeResponse(buf(DA1, OK, XT('kitty(0.36.4)')))).toMatchObject({
      verdict: 'unsupported',
      fenced: true,
    });
  });

  it('is unsupported when the terminal answers the query with an error', () => {
    expect(
      parseProbeResponse(buf(`${ESC}_Gi=31;ENOTSUPPORTED:no graphics${ESC}\\`, DA1)),
    ).toMatchObject({ verdict: 'unsupported' });
    // ...even before the fence: an i=31 answer that is not OK is an answer.
    expect(parseProbeResponse(buf(`${ESC}_Gi=31;EBADF:bad${ESC}\\`))).toMatchObject({
      verdict: 'unsupported',
    });
  });

  it('is pending until an OK split across chunks is whole', () => {
    const half = OK.slice(0, 6);
    expect(parseProbeResponse(buf(half))).toMatchObject({ verdict: 'pending' });
    expect(parseProbeResponse(buf(half, OK.slice(6)))).toMatchObject({ verdict: 'pending' });
    expect(
      parseProbeResponse(buf(half, OK.slice(6), XT('kitty(0.36.4)'))),
    ).toMatchObject({ verdict: 'supported' });
  });

  it('is pending until a DCS name reply split across chunks is whole', () => {
    const xt = XT('ghostty 1.1.3');
    // Split mid-name...
    expect(parseProbeResponse(buf(OK, xt.slice(0, 8)))).toMatchObject({ verdict: 'pending' });
    // ...and split inside the two-byte `ESC \` terminator itself.
    const upToEsc = xt.slice(0, xt.length - 1);
    expect(parseProbeResponse(buf(OK, upToEsc))).toMatchObject({ verdict: 'pending' });
    expect(parseProbeResponse(buf(OK, upToEsc, '\\'))).toMatchObject({
      verdict: 'supported',
      terminal: 'ghostty 1.1.3',
    });
  });

  it('is pending on garbage and on nothing at all', () => {
    expect(parseProbeResponse(buf(''))).toMatchObject({ verdict: 'pending' });
    expect(parseProbeResponse(buf('hello\r\n'))).toMatchObject({ verdict: 'pending' });
    expect(parseProbeResponse(buf(`${ESC}[0m`))).toMatchObject({ verdict: 'pending' });
  });

  it('ignores a graphics reply for somebody else’s image id', () => {
    expect(parseProbeResponse(buf(`${ESC}_Gi=7;OK${ESC}\\`))).toMatchObject({
      verdict: 'pending',
    });
    expect(
      parseProbeResponse(buf(`${ESC}_Gi=7;OK${ESC}\\`, XT('kitty(0.36.4)'))),
    ).toMatchObject({ verdict: 'unsupported' });
  });

  it('matches the name case-insensitively, and only the three allowlisted ones', () => {
    for (const name of ['KITTY(0.36.4)', 'Ghostty 1.2.0', 'wezterm 20240203']) {
      expect(parseProbeResponse(buf(OK, XT(name))).verdict).toBe('supported');
    }
    for (const name of ['foot(1.16.2)', 'iTerm2 3.5.14', 'Konsole 22.08', 'XTerm(389)']) {
      expect(parseProbeResponse(buf(OK, XT(name), DA1)).verdict).toBe('unsupported');
    }
  });

  it('reports the fence so the caller knows when it may stop listening', () => {
    expect(parseProbeResponse(buf(OK, XT('ghostty 1.1.3'))).fenced).toBe(false);
    expect(parseProbeResponse(buf(OK, XT('ghostty 1.1.3'), DA1)).fenced).toBe(true);
  });
});

/** A stdin that behaves like a TTY, and records what the probe did to it. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawCalls: boolean[] = [];
  resumed = 0;
  paused = 0;
  setRawMode(mode: boolean): this {
    this.rawCalls.push(mode);
    this.isRaw = mode;
    return this;
  }
  resume(): this {
    this.resumed += 1;
    return this;
  }
  pause(): this {
    this.paused += 1;
    return this;
  }
  /** Deliver bytes as the terminal would. */
  answer(...parts: string[]): void {
    this.emit('data', Buffer.from(parts.join(''), 'latin1'));
  }
}

const fakeStdout = (): { isTTY: boolean; writes: string[]; write: (s: string) => boolean } => {
  const writes: string[] = [];
  return {
    isTTY: true,
    writes,
    write(s: string) {
      writes.push(s);
      return true;
    },
  };
};

describe('probeKittyGraphics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the graphics query, THEN XTVERSION, THEN the DA1 fence, in order', async () => {
    const stdin = new FakeStdin();
    const stdout = fakeStdout();
    const done = probeKittyGraphics({ stdin, stdout });
    expect(stdout.writes).toEqual([KITTY_GRAPHICS_QUERY, XTVERSION_QUERY, DA1_QUERY]);
    expect(stdout.writes.join('')).toBe(
      `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[>0q${ESC}[c`,
    );
    stdin.answer(OK, XT('ghostty 1.1.3'), DA1);
    expect(await done).toBe(true);
  });

  it('never quietens the feature query: q=2 would suppress the answer we need', () => {
    expect(KITTY_GRAPHICS_QUERY).not.toContain('q=2');
    expect(KITTY_GRAPHICS_QUERY).toContain('a=q');
  });

  it('resolves true only for an OK from an allowlisted terminal', async () => {
    const yes = new FakeStdin();
    const yesDone = probeKittyGraphics({ stdin: yes, stdout: fakeStdout() });
    yes.answer(OK, XT('kitty(0.36.4)'), DA1);
    expect(await yesDone).toBe(true);

    // iTerm2: says OK, fails the transmission. Never the image.
    const iterm = new FakeStdin();
    const itermDone = probeKittyGraphics({ stdin: iterm, stdout: fakeStdout() });
    iterm.answer(OK, XT('iTerm2 3.5.14'), DA1);
    expect(await itermDone).toBe(false);

    const plain = new FakeStdin();
    const plainDone = probeKittyGraphics({ stdin: plain, stdout: fakeStdout() });
    plain.answer(DA1);
    expect(await plainDone).toBe(false);
  });

  it('assembles a reply that arrives in pieces', async () => {
    const stdin = new FakeStdin();
    const done = probeKittyGraphics({ stdin, stdout: fakeStdout() });
    const all = `${OK}${XT('ghostty 1.1.3')}${DA1}`;
    for (let i = 0; i < all.length; i += 5) stdin.answer(all.slice(i, i + 5));
    expect(await done).toBe(true);
  });

  it('waits for the DA1 fence even when the answer is already yes', async () => {
    // Nothing we asked for may arrive after raw mode is restored: a late reply
    // on a cooked terminal is echoed onto the screen as garbage.
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    let value: boolean | 'pending' = 'pending';
    const done = probeKittyGraphics({ stdin, stdout: fakeStdout(), timeoutMs: 500 }).then((v) => {
      value = v;
      return v;
    });
    stdin.answer(OK, XT('ghostty 1.1.3'));
    await vi.advanceTimersByTimeAsync(499);
    expect(value).toBe('pending');
    // Still raw, still listening: the fence has not landed.
    expect(stdin.rawCalls).toEqual([true]);
    expect(stdin.listenerCount('data')).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await done).toBe(false);
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  it('gives up after the timeout when the terminal says nothing', async () => {
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    const done = probeKittyGraphics({ stdin, stdout: fakeStdout(), timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(499);
    stdin.emit('noop');
    await vi.advanceTimersByTimeAsync(2);
    expect(await done).toBe(false);
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  it('keeps the default timeout generous enough for an ssh round trip', () => {
    expect(PROBE_TIMEOUT_MS).toBe(500);
  });

  it('restores raw mode, pauses stdin and unhooks on every path', async () => {
    for (const reply of [[OK, XT('ghostty 1.1.3'), DA1], [DA1]]) {
      const stdin = new FakeStdin();
      const done = probeKittyGraphics({ stdin, stdout: fakeStdout() });
      expect(stdin.rawCalls).toEqual([true]);
      expect(stdin.resumed).toBe(1);
      stdin.answer(...reply);
      await done;
      expect(stdin.rawCalls).toEqual([true, false]);
      expect(stdin.isRaw).toBe(false);
      expect(stdin.paused).toBe(1);
      expect(stdin.listenerCount('data')).toBe(0);
    }
  });

  it('restores the PREVIOUS raw mode, not a hardcoded false', async () => {
    const stdin = new FakeStdin();
    stdin.isRaw = true;
    const done = probeKittyGraphics({ stdin, stdout: fakeStdout() });
    stdin.answer(DA1);
    await done;
    expect(stdin.rawCalls).toEqual([true, true]);
  });

  it('stops listening the moment the fence lands', async () => {
    const stdin = new FakeStdin();
    const done = probeKittyGraphics({ stdin, stdout: fakeStdout() });
    stdin.answer(OK, XT('kitty(0.36.4)'), DA1);
    expect(await done).toBe(true);
    // Late bytes reach nobody: no listener, and no second resolution.
    expect(stdin.listenerCount('data')).toBe(0);
    stdin.answer('garbage');
  });

  it('writes NOTHING and resolves false when either stream is not a TTY', async () => {
    const cases = [
      { stdin: Object.assign(new FakeStdin(), { isTTY: false }), stdout: fakeStdout() },
      { stdin: new FakeStdin(), stdout: { ...fakeStdout(), isTTY: false } },
    ];
    for (const c of cases) {
      const stdout = c.stdout as ReturnType<typeof fakeStdout>;
      expect(await probeKittyGraphics({ stdin: c.stdin, stdout })).toBe(false);
      expect(stdout.writes).toEqual([]);
      expect((c.stdin as FakeStdin).rawCalls).toEqual([]);
    }
  });

  it('writes nothing when stdin cannot be put in raw mode (a pipe pretending)', async () => {
    const stdin = new EventEmitter() as unknown as FakeStdin & { isTTY: boolean };
    stdin.isTTY = true;
    const stdout = fakeStdout();
    expect(await probeKittyGraphics({ stdin, stdout })).toBe(false);
    expect(stdout.writes).toEqual([]);
  });

  it('never throws: a failing write resolves false with raw mode restored', async () => {
    const stdin = new FakeStdin();
    const stdout = {
      isTTY: true,
      write(): boolean {
        throw new Error('EPIPE');
      },
    };
    expect(await probeKittyGraphics({ stdin, stdout })).toBe(false);
    expect(stdin.rawCalls).toEqual([true, false]);
    expect(stdin.paused).toBe(1);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('never throws: a stdin that refuses raw mode resolves false', async () => {
    const stdin = new FakeStdin();
    stdin.setRawMode = () => {
      throw new Error('EINVAL');
    };
    const stdout = fakeStdout();
    expect(await probeKittyGraphics({ stdin, stdout })).toBe(false);
    expect(stdout.writes).toEqual([]);
  });
});
