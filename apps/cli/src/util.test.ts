/** The ONE reading of an on/off environment switch, shared by every caller. */
import { describe, expect, it } from 'vitest';
import { ApiError } from '@sparrow-land/sdk';
import { describeError, envSwitchedOff, envSwitchedOn } from './util.js';

describe('envSwitchedOn / envSwitchedOff', () => {
  it('on: set, non-empty, and not an explicit off word (any case, trimmed)', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'anything', ' TRUE ']) expect(envSwitchedOn(v), v).toBe(true);
    for (const v of [undefined, '', '  ', '0', 'false', 'no', 'off', ' OFF ', 'False']) {
      expect(envSwitchedOn(v), String(v)).toBe(false);
    }
  });

  it('off: only an explicit off word — unset or empty is NOT off', () => {
    for (const v of ['0', 'false', 'no', 'off', ' Off ']) expect(envSwitchedOff(v), v).toBe(true);
    for (const v of [undefined, '', '1', 'yes', 'anything']) expect(envSwitchedOff(v), String(v)).toBe(false);
  });
});

/* ==================================================================
 * describeError — a diagnostic line that is never empty.
 *
 * `String(e?.message ?? e)` printed `fetch failed` (or nothing at all) for a
 * failed inbox read: undici hides the real reason — a headers timeout, a reset
 * socket — in `.cause`. The operator needs the whole chain.
 * ================================================================== */
describe('describeError', () => {
  it('names an ApiError by status and code, with its message', () => {
    const e = new ApiError({ code: 'internal', status: 500, message: 'upstream read timed out' });
    const s = describeError(e);
    expect(s).toContain('500');
    expect(s).toContain('internal');
    expect(s).toContain('upstream read timed out');
  });

  it('walks the cause chain (undici fetch failed → headers timeout)', () => {
    const inner = Object.assign(new Error('Headers Timeout Error'), {
      name: 'HeadersTimeoutError',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    const outer = new TypeError('fetch failed', { cause: inner });
    const s = describeError(outer);
    expect(s).toContain('TypeError: fetch failed');
    expect(s).toContain('HeadersTimeoutError');
    expect(s).toContain('UND_ERR_HEADERS_TIMEOUT');
    expect(s).toContain('Headers Timeout Error');
    expect(s.indexOf('fetch failed')).toBeLessThan(s.indexOf('UND_ERR_HEADERS_TIMEOUT'));
  });

  it('includes a node errno-style code (ECONNRESET) from a nested cause', () => {
    const errno = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104 });
    const s = describeError(new TypeError('fetch failed', { cause: errno }));
    expect(s).toContain('ECONNRESET');
  });

  it('does not repeat a code the message already carries', () => {
    const errno = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(describeError(errno).match(/ECONNRESET/g)).toHaveLength(1);
  });

  it('describes an AggregateError by its members (connect refused on every address)', () => {
    const a = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    const b = Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED' });
    const agg = Object.assign(new AggregateError([a, b], ''), { code: 'ECONNREFUSED' });
    const s = describeError(new TypeError('fetch failed', { cause: agg }));
    expect(s).toContain('AggregateError');
    expect(s).toContain('127.0.0.1:1');
    expect(s).toContain('::1:1');
  });

  it('is never empty: an Error with no message falls back to its name / constructor', () => {
    expect(describeError(new Error(''))).toBe('Error');
    class WeirdFailure extends Error {}
    const w = new WeirdFailure('');
    w.name = '';
    expect(describeError(w)).toBe('WeirdFailure');
  });

  it('is never empty for odd thrown values', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError('')).not.toBe('');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(null)).toBe('null');
    expect(describeError({ code: 'X' })).toContain('X');
    expect(describeError(42)).toBe('42');
  });

  it('survives a cyclic cause chain and bounds its depth', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    const s = describeError(a);
    expect(s).toContain('a');
    expect(s.length).toBeLessThan(500);
  });

  it('keeps an abort distinguishable', () => {
    const e = new DOMException('This operation was aborted', 'AbortError');
    expect(describeError(e)).toContain('AbortError');
  });
});
