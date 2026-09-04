import { describe, expect, it, vi } from 'vitest';
import { FakeVoiceProvider, FAKE_TRANSCRIPT } from './fake.js';

/** Drain a fake stream into the two text channels it emits. */
function collect(stream: {
  on(ev: 'partial' | 'committed', cb: (text: string) => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
}): { partials: string[]; committed: string[]; errors: Error[] } {
  const partials: string[] = [];
  const committed: string[] = [];
  const errors: Error[] = [];
  stream.on('partial', (t) => partials.push(t));
  stream.on('committed', (t) => committed.push(t));
  stream.on('error', (e) => errors.push(e));
  return { partials, committed, errors };
}

const chunk = (n: number) => Buffer.alloc(n, 1);

describe('FakeVoiceProvider.stream (deterministic streaming STT)', () => {
  it('is advertised as a streaming provider', () => {
    expect(typeof new FakeVoiceProvider().stream).toBe('function');
  });

  it('grows a fixed script through the pushes and commits the full transcript', () => {
    const stream = new FakeVoiceProvider().stream();
    const seen = collect(stream);

    stream.push(chunk(320));
    expect(seen.partials).toEqual(['fake']);
    stream.push(chunk(320));
    expect(seen.partials).toEqual(['fake', FAKE_TRANSCRIPT]);
    // The script is exhausted: every later push repeats the final partial, so
    // the transcript never regresses.
    stream.push(chunk(320));
    expect(seen.partials).toEqual(['fake', FAKE_TRANSCRIPT, FAKE_TRANSCRIPT]);

    stream.commit();
    expect(seen.committed).toEqual([FAKE_TRANSCRIPT]);
    expect(seen.errors).toEqual([]);
  });

  it('is byte-deterministic: two streams driven identically emit identically', () => {
    const provider = new FakeVoiceProvider();
    const runs = [0, 1].map(() => {
      const s = provider.stream();
      const seen = collect(s);
      s.push(chunk(64));
      s.push(chunk(9999));
      s.commit();
      s.close();
      return seen;
    });
    expect(runs[0]).toEqual(runs[1]);
  });

  it('close() is idempotent and silences later pushes/commits', () => {
    const stream = new FakeVoiceProvider().stream();
    const seen = collect(stream);
    stream.push(chunk(10));
    stream.close();
    stream.close();
    stream.close();
    stream.push(chunk(10));
    stream.commit();
    expect(seen.partials).toEqual(['fake']);
    expect(seen.committed).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  it('each stream() is an independent session (fresh script position)', () => {
    const provider = new FakeVoiceProvider();
    const a = provider.stream();
    const seenA = collect(a);
    a.push(chunk(8));
    a.push(chunk(8));
    const b = provider.stream({ language: 'en' });
    const seenB = collect(b);
    b.push(chunk(8));
    expect(seenA.partials).toEqual(['fake', FAKE_TRANSCRIPT]);
    expect(seenB.partials).toEqual(['fake']);
  });

  it('a handler registered twice is called twice (no dedupe surprises)', () => {
    const stream = new FakeVoiceProvider().stream();
    const cb = vi.fn();
    stream.on('partial', cb);
    stream.on('partial', cb);
    stream.push(chunk(4));
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
