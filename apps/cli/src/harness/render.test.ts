import { describe, expect, it } from 'vitest';
import { renderBanner, renderEvent, resolveColors } from './render.js';

const ESC = '';
const at = new Date('2026-09-03T14:05:09.000Z');
const opts = { colors: false, clock: () => at, tz: 'UTC' };

describe('harness banner', () => {
  const info = {
    agent: 'vm8-sparrow',
    org: 'Acme Inc',
    profile: 'harness-smoke',
    server: 'https://sparrow.example.com',
    runner: 'claude',
    model: 'fable',
    permissionMode: 'acceptEdits',
    cwd: '~/proj',
  };
  const banner = renderBanner(info, opts);

  it('names the agent, org, profile and server on one line', () => {
    expect(banner).toContain('sparrow harness');
    expect(banner).toContain('agent');
    expect(banner).toContain(
      'vm8-sparrow · Acme Inc · profile harness-smoke · https://sparrow.example.com',
    );
  });

  it('omits the profile clause when the credential has no profile name', () => {
    const bare = renderBanner({ ...info, profile: undefined }, opts);
    expect(bare).toContain('vm8-sparrow · Acme Inc · https://sparrow.example.com');
    expect(bare).not.toContain('profile');
  });

  it('names the runner, model, permission mode and cwd on the next', () => {
    expect(banner).toContain('runner   claude (fable) · acceptEdits · ~/proj');
  });

  it('ends with the online line and how to stop', () => {
    expect(banner).toContain('online — waiting for messages');
    expect(banner).toContain('Ctrl-C to stop');
  });

  it('--once says it is doing one pass, not that it is waiting', () => {
    const once = renderBanner({ ...info, once: true }, opts);
    expect(once).toContain('one pass — handling what is waiting, then exiting');
    expect(once).not.toContain('waiting for messages');
    expect(once).not.toContain('Ctrl-C');
  });

  it('never carries a token', () => {
    const withToken = renderBanner(
      {
        agent: 'a',
        org: 'o',
        profile: 'p',
        server: 'https://s',
        runner: 'claude',
        permissionMode: 'acceptEdits',
        cwd: '/x',
      },
      opts,
    );
    expect(withToken).not.toMatch(/agk_|ses_|Bearer/);
  });
});

describe('harness timeline lines', () => {
  const line = (ev: Parameters<typeof renderEvent>[0]): string => renderEvent(ev, opts) ?? '';

  it('stamps every line with a HH:MM:SS timestamp', () => {
    expect(line({ type: 'harness.online', agent: 'a', org: 'o', server: 's' })).toMatch(
      /^14:05:09 /,
    );
  });

  it('online and reconnected use the green dot', () => {
    expect(line({ type: 'harness.online', agent: 'a', org: 'o', server: 's' })).toContain('●');
    expect(line({ type: 'harness.reconnected' })).toContain('●');
    expect(line({ type: 'harness.reconnected' })).toContain('reconnected');
  });

  it('new work reads room · sender: preview', () => {
    const out = line({
      type: 'harness.work',
      group: '#Product',
      from: 'Jake Quist',
      preview: 'can you check the deploy?',
      count: 1,
    });
    expect(out).toContain('→');
    expect(out).toContain('#Product · Jake Quist: "can you check the deploy?"');
  });

  it('a run start names the runner, the item count and the room', () => {
    const out = line({
      type: 'harness.run.start',
      runner: 'claude fable',
      group: '#Product',
      items: 2,
    });
    expect(out).toContain('⟳');
    expect(out).toContain('claude fable · 2 messages · #Product');
  });

  it('a reply reports where, how big and how long', () => {
    const out = line({ type: 'harness.reply', group: '#Product', chars: 1234, seconds: 34 });
    expect(out).toContain('✓');
    expect(out).toContain('replied in #Product · 1.2k chars · 34s');
  });

  it('a failure says what exited, after how long, and when the retry is', () => {
    const out = line({
      type: 'harness.run.failed',
      runner: 'claude',
      group: '#Product',
      code: 1,
      seconds: 12,
      retryInSeconds: 30,
    });
    expect(out).toContain('✗');
    expect(out).toContain('claude exited 1 after 12s — left unread, retry in 30s');
  });

  it('a timeout says so instead of an exit code', () => {
    const out = line({
      type: 'harness.run.failed',
      runner: 'claude',
      group: '#Product',
      code: null,
      seconds: 600,
      retryInSeconds: 30,
      timedOut: true,
    });
    expect(out).toContain('claude timed out after 600s');
  });

  it('enroll progress is the dim ring', () => {
    expect(line({ type: 'harness.enroll.waiting', name: 'vm8-sparrow' })).toContain('◦');
    expect(line({ type: 'harness.enroll.waiting', name: 'vm8-sparrow' })).toContain(
      'waiting for approval',
    );
  });

  it('a run that produced no reply says so', () => {
    const out = line({
      type: 'harness.run.done',
      group: '#Product',
      seconds: 3,
      chars: 0,
      replied: false,
    });
    expect(out).toContain('nothing to say');
  });

  it('truncation is called out', () => {
    const out = line({
      type: 'harness.reply',
      group: '#Product',
      chars: 8000,
      seconds: 4,
      truncated: true,
    });
    expect(out).toContain('truncated');
  });

  it('with colors on, wraps in ANSI and still contains the text', () => {
    const out = renderEvent({ type: 'harness.reconnected' }, { ...opts, colors: true }) ?? '';
    expect(out).toContain(ESC);
    expect(out.split(ESC).join('').replace(/\[[0-9;]*m/g, '')).toContain('reconnected');
  });
});

/**
 * Colors are resolved ONCE, from the environment the CLI was handed — never
 * re-sniffed per line. CI runners set `FORCE_COLOR`, which is exactly why the
 * harness must not decide "colorful" from a global picocolors probe: the
 * command passes an explicit flag so its output is a function of its inputs.
 */
describe('resolveColors', () => {
  it('is off without a TTY', () => {
    expect(resolveColors({}, false)).toBe(false);
  });

  it('is on for a plain interactive terminal', () => {
    expect(resolveColors({}, true)).toBe(true);
  });

  it('honors NO_COLOR over a TTY', () => {
    expect(resolveColors({ NO_COLOR: '1' }, true)).toBe(false);
    expect(resolveColors({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('is off under CI even when the runner fakes a TTY', () => {
    expect(resolveColors({ CI: 'true' }, true)).toBe(false);
  });

  it('FORCE_COLOR wins over CI and a missing TTY', () => {
    expect(resolveColors({ CI: 'true', FORCE_COLOR: '1' }, false)).toBe(true);
    expect(resolveColors({ FORCE_COLOR: '0' }, true)).toBe(false);
  });

  it('NO_COLOR beats FORCE_COLOR (the stricter opt-out wins)', () => {
    expect(resolveColors({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
  });
});

