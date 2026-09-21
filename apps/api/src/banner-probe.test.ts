import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DA1_QUERY,
  KITTY_GRAPHICS_QUERY,
  PROBE_TIMEOUT_MS,
  parseProbeResponse,
  probeKittyGraphics,
} from './banner-probe.js';

const ESC = '\x1b';
/** What a kitty-graphics terminal answers our `i=31` query with. */
const OK = `${ESC}_Gi=31;OK${ESC}\\`;
/** What every VT-ish terminal answers DA1 with (the fence). */
const DA1 = `${ESC}[?62;c`;

const buf = (...parts: string[]): Buffer => Buffer.from(parts.join(''), 'latin1');

describe('parseProbeResponse', () => {
  it('is supported when the OK reply arrives, with or without the DA1 fence', () => {
    expect(parseProbeResponse(buf(OK, DA1))).toBe('supported');
    expect(parseProbeResponse(buf(OK))).toBe('supported');
  });

  it('is unsupported when the DA1 fence arrives with no graphics reply before it', () => {
    expect(parseProbeResponse(buf(DA1))).toBe('unsupported');
    expect(parseProbeResponse(buf(`${ESC}[?1;2c`))).toBe('unsupported');
  });

  it('is unsupported when the terminal answers the query with an error', () => {
    expect(parseProbeResponse(buf(`${ESC}_Gi=31;ENOTSUPPORTED:no graphics${ESC}\\`, DA1))).toBe(
      'unsupported',
    );
    // ...even before the fence: an i=31 answer that is not OK is an answer.
    expect(parseProbeResponse(buf(`${ESC}_Gi=31;EBADF:bad${ESC}\\`))).toBe('unsupported');
  });

  it('is pending until an OK split across chunks is whole', () => {
    const half = OK.slice(0, 6);
    expect(parseProbeResponse(buf(half))).toBe('pending');
    expect(parseProbeResponse(buf(half, OK.slice(6)))).toBe('supported');
  });

  it('is pending on garbage and on nothing at all', () => {
    expect(parseProbeResponse(buf(''))).toBe('pending');
    expect(parseProbeResponse(buf('hello\r\n'))).toBe('pending');
    expect(parseProbeResponse(buf(`${ESC}[0m`))).toBe('pending');
  });

  it('ignores a graphics reply for somebody else’s image id', () => {
    expect(parseProbeResponse(buf(`${ESC}_Gi=7;OK${ESC}\\`))).toBe('pending');
    expect(parseProbeResponse(buf(`${ESC}_Gi=7;OK${ESC}\\`, DA1))).toBe('unsupported');
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

  it('writes the graphics query and THEN the DA1 fence, and nothing else', async () => {
    const stdin = new FakeStdin();
    const stdout = fakeStdout();
    const done = probeKittyGraphics({ stdin, stdout });
    expect(stdout.writes.join('')).toBe(`${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`);
    expect(stdout.writes).toEqual([KITTY_GRAPHICS_QUERY, DA1_QUERY]);
    stdin.answer(OK, DA1);
    expect(await done).toBe(true);
  });

  it('resolves true when the terminal says OK, false when only DA1 comes back', async () => {
    const ok = new FakeStdin();
    const okDone = probeKittyGraphics({ stdin: ok, stdout: fakeStdout() });
    ok.answer(OK, DA1);
    expect(await okDone).toBe(true);

    const plain = new FakeStdin();
    const plainDone = probeKittyGraphics({ stdin: plain, stdout: fakeStdout() });
    plain.answer(DA1);
    expect(await plainDone).toBe(false);
  });

  it('assembles a reply that arrives in pieces', async () => {
    const stdin = new FakeStdin();
    const done = probeKittyGraphics({ stdin, stdout: fakeStdout() });
    stdin.answer(OK.slice(0, 5));
    stdin.answer(OK.slice(5));
    expect(await done).toBe(true);
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
    for (const reply of [[OK, DA1], [DA1]]) {
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

  it('stops listening the moment it has an answer', async () => {
    const stdin = new FakeStdin();
    const done = probeKittyGraphics({ stdin, stdout: fakeStdout() });
    stdin.answer(OK, DA1);
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
