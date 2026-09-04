import { describe, expect, it } from 'vitest';
import { NO_REPLY, buildPrompt, type BuildPromptInput } from './prompt.js';

const base: BuildPromptInput = {
  agent: { name: 'vm8-sparrow', orgName: 'Acme Inc' },
  group: { kind: 'chat', label: '#Product', roomKind: 'project' },
  transcript: [],
  messages: [
    {
      from: 'Jake Quist',
      at: '2026-09-03T10:00:00.000Z',
      subject: null,
      body: 'can you check the deploy?',
    },
  ],
};

describe('harness prompt', () => {
  it('names the agent, its org, the room and the harness in the system framing', () => {
    const { system } = buildPrompt(base);
    expect(system).toContain('vm8-sparrow');
    expect(system).toContain('Acme Inc');
    expect(system).toContain('#Product');
    expect(system).toContain('sparrow harness');
  });

  it('states that the final response is posted verbatim as the reply', () => {
    const { system } = buildPrompt(base);
    expect(system).toMatch(/final text response is your reply/i);
    expect(system).toMatch(/verbatim/i);
    expect(system).toMatch(/do not .*sparrow/i);
    expect(system).toContain(NO_REPLY);
  });

  it('renders each new message with sender and timestamp', () => {
    const { user } = buildPrompt(base);
    expect(user).toContain('Jake Quist');
    expect(user).toContain('2026-09-03T10:00:00.000Z');
    expect(user).toContain('can you check the deploy?');
  });

  it('numbers several messages in arrival order', () => {
    const { user } = buildPrompt({
      ...base,
      messages: [
        { from: 'Jake Quist', at: '2026-09-03T10:00:00.000Z', subject: null, body: 'first' },
        { from: 'Ana', at: '2026-09-03T10:00:02.000Z', subject: null, body: 'second' },
      ],
    });
    expect(user.indexOf('first')).toBeLessThan(user.indexOf('second'));
    expect(user).toContain('2 new messages');
  });

  it('includes a transcript section when context is supplied', () => {
    const { user } = buildPrompt({
      ...base,
      transcript: [
        { from: 'vm8-sparrow', at: '2026-09-03T09:00:00.000Z', subject: null, body: 'earlier line' },
      ],
    });
    expect(user).toContain('Recent conversation');
    expect(user).toContain('earlier line');
    expect(user.indexOf('earlier line')).toBeLessThan(user.indexOf('can you check the deploy?'));
  });

  it('omits the transcript section when there is none', () => {
    expect(buildPrompt(base).user).not.toContain('Recent conversation');
  });

  it('frames an email group as a thread reply to an outsider', () => {
    const { system } = buildPrompt({
      ...base,
      group: { kind: 'email', label: '“Invoice question”', subject: 'Invoice question' },
      messages: [
        { from: 'Kim <kim@outside.example>', at: '2026-09-03T10:00:00.000Z', subject: 'Invoice question', body: 'what is this charge?' },
      ],
    });
    expect(system).toContain('email');
    expect(system).toContain('Invoice question');
    expect(system).toMatch(/outside/i);
  });

  it('combined is the system framing followed by the messages', () => {
    const { system, user, combined } = buildPrompt(base);
    expect(combined.startsWith(system)).toBe(true);
    expect(combined.endsWith(user)).toBe(true);
  });
});
