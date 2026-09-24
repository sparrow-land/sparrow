/** The ONE reading of an on/off environment switch, shared by every caller. */
import { describe, expect, it } from 'vitest';
import { envSwitchedOff, envSwitchedOn } from './util.js';

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
