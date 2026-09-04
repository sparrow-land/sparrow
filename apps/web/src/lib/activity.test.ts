import { describe, it, expect } from 'vitest';
import type { ActivityEntry, AgentDmBox, InboxItem } from '@sparrow/common-types';
import { mergeStream, collapseStream, interleaveAgentDms, type StreamRow } from './activity.js';
import type { ThreadItem } from './conversation.js';
import { activityEntry, chatEntry, hintEntry } from '../test/fixtures.js';

function chat(id: string, createdAt: string): ThreadItem {
  const inbox = {
    id,
    from: { id: 'mem_1', kind: 'human', displayName: 'Jake', avatarUrl: null },
    kind: 'dm',
    subject: null,
    preview: 'hi',
    truncated: false,
    attachmentCount: 0,
    status: 'read',
    createdAt,
  } as unknown as InboxItem;
  return { id, direction: 'in', createdAt, inbox };
}

function entry(id: string, createdAt: string, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return activityEntry({ id, createdAt, refs: { emailThreadId: 'eth_1', emailId: `eml_${id}` }, ...overrides });
}

describe('mergeStream — one time-ordered column across mediums', () => {
  it('interleaves chat bubbles and email entries by createdAt', () => {
    const rows = mergeStream(
      [chat('msg_1', '2026-08-31T10:00:00Z'), chat('msg_2', '2026-08-31T12:00:00Z')],
      [entry('act_1', '2026-08-31T11:00:00Z')],
    );
    expect(rows.map((r) => r.kind)).toEqual(['chat', 'email', 'chat']);
  });

  it('ignores chat-medium entries (the room route is the authority for chat)', () => {
    const rows = mergeStream([], [chatEntry({ createdAt: '2026-08-31T11:00:00Z' })]);
    expect(rows).toEqual([]);
  });

  it('ignores entries whose type or medium this client does not recognize', () => {
    const unknown = {
      ...activityEntry(),
      medium: 'telepathy',
      type: 'telepathy.thought',
    } as unknown as ActivityEntry;
    expect(mergeStream([], [unknown])).toEqual([]);
    // A registered-but-unrendered v4 type is ignored too, never thrown on.
    expect(mergeStream([], [activityEntry({ medium: 'voice', type: 'voice.transcribed' })])).toEqual([]);
  });
});

describe('collapseStream — smart about noise, never hiding what needs action', () => {
  function emailRows(entries: ActivityEntry[]): StreamRow[] {
    return mergeStream([], entries);
  }

  it('leaves one or two same-thread entries as individual cards', () => {
    const rows = collapseStream(
      emailRows([entry('a', '2026-08-31T10:00:00Z'), entry('b', '2026-08-31T10:01:00Z')]),
    );
    expect(rows.map((r) => r.kind)).toEqual(['email', 'email']);
  });

  it('collapses a run of 3+ consecutive entries in the same thread into one summary', () => {
    const rows = collapseStream(
      emailRows([
        entry('a', '2026-08-31T10:00:00Z'),
        entry('b', '2026-08-31T10:01:00Z'),
        entry('c', '2026-08-31T10:02:00Z'),
        entry('d', '2026-08-31T10:03:00Z'),
      ]),
    );
    expect(rows).toHaveLength(1);
    const run = rows[0]!;
    expect(run.kind).toBe('thread-run');
    if (run.kind !== 'thread-run') throw new Error('expected a thread run');
    expect(run.entries).toHaveLength(4);
    expect(run.subject).toBe('Re: Q3 rollout');
    // The newest entry supplies the summary row's snippet + badge.
    expect(run.newest.id).toBe('d');
  });

  it('never collapses across a different thread', () => {
    const rows = collapseStream(
      emailRows([
        entry('a', '2026-08-31T10:00:00Z'),
        entry('b', '2026-08-31T10:01:00Z'),
        entry('c', '2026-08-31T10:02:00Z', { refs: { emailThreadId: 'eth_2', emailId: 'eml_c' } }),
      ]),
    );
    expect(rows.map((r) => r.kind)).toEqual(['email', 'email', 'email']);
  });

  it('never collapses across a chat bubble (runs are what is rendered adjacently)', () => {
    const rows = collapseStream(
      mergeStream(
        [chat('msg_1', '2026-08-31T10:01:30Z')],
        [
          entry('a', '2026-08-31T10:00:00Z'),
          entry('b', '2026-08-31T10:01:00Z'),
          entry('c', '2026-08-31T10:02:00Z'),
        ],
      ),
    );
    expect(rows.map((r) => r.kind)).toEqual(['email', 'email', 'chat', 'email']);
  });

  it('collapses consecutive rejected entries into one muted divider', () => {
    const rows = collapseStream(
      emailRows([
        entry('a', '2026-08-31T10:00:00Z', { type: 'email.rejected' }),
        entry('b', '2026-08-31T10:01:00Z', { type: 'email.rejected' }),
        entry('c', '2026-08-31T10:02:00Z', { type: 'email.rejected' }),
      ]),
    );
    expect(rows).toHaveLength(1);
    const run = rows[0]!;
    if (run.kind !== 'rejected-run') throw new Error('expected a rejected run');
    expect(run.entries).toHaveLength(3);
  });

  it('keeps a lone rejected entry out of the conversation too (still expandable)', () => {
    const rows = collapseStream(emailRows([entry('a', '2026-08-31T10:00:00Z', { type: 'email.rejected' })]));
    expect(rows[0]!.kind).toBe('rejected-run');
  });

  it('never collapses quarantined or held entries — they need the owner', () => {
    const rows = collapseStream(
      emailRows([
        entry('a', '2026-08-31T10:00:00Z'),
        entry('b', '2026-08-31T10:01:00Z', { type: 'email.quarantined' }),
        entry('c', '2026-08-31T10:02:00Z', { type: 'email.held' }),
        entry('d', '2026-08-31T10:03:00Z'),
        entry('e', '2026-08-31T10:04:00Z'),
        entry('f', '2026-08-31T10:05:00Z'),
      ]),
    );
    // a | quarantined | held | then a 3-run collapses.
    expect(rows.map((r) => r.kind)).toEqual(['email', 'email', 'email', 'thread-run']);
  });

  it('folds an email.resolved entry into the card it resolves (no duplicate row)', () => {
    const rows = collapseStream(
      emailRows([
        entry('a', '2026-08-31T10:00:00Z', {
          type: 'email.quarantined',
          refs: { emailThreadId: 'eth_1', emailId: 'eml_x' },
        }),
        entry('b', '2026-08-31T10:05:00Z', {
          type: 'email.resolved',
          refs: { emailThreadId: 'eth_1', emailId: 'eml_x' },
        }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('email');
  });

  it('renders a resolved entry on its own when its email is outside the window', () => {
    const rows = collapseStream(
      emailRows([
        entry('b', '2026-08-31T10:05:00Z', {
          type: 'email.resolved',
          refs: { emailThreadId: 'eth_1', emailId: 'eml_gone' },
        }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('email');
  });

  // A live `email.resolved` mutates the CARD (its badge, its graying) — it must
  // never re-flow the column: a row the viewer was reading may not fold itself
  // into a run, or vanish into a rejected divider, because an approval landed.
  it('is stable under live resolutions — collapsing reads the entry’s own type', () => {
    const entries = [
      entry('a', '2026-08-31T10:00:00Z'),
      entry('b', '2026-08-31T10:01:00Z', { type: 'email.quarantined' }),
      entry('c', '2026-08-31T10:02:00Z'),
    ];
    expect(collapseStream(emailRows(entries)).map((r) => r.kind)).toEqual([
      'email',
      'email',
      'email',
    ]);
  });
});

describe('hint entries — sparrow speaking rides the column too', () => {
  it('mergeStream keeps a hint.delivered entry, ordered by createdAt', () => {
    const rows = mergeStream(
      [chat('msg_1', '2026-08-31T10:00:00Z'), chat('msg_2', '2026-08-31T12:00:00Z')],
      [hintEntry({ createdAt: '2026-08-31T11:00:00Z' })],
    );
    expect(rows.map((r) => r.kind)).toEqual(['chat', 'hint', 'chat']);
  });

  it('collapseStream passes hints through one-to-one — hints never collapse', () => {
    const rows = collapseStream(
      mergeStream(
        [],
        [
          hintEntry({ id: 'act_h1', createdAt: '2026-08-31T10:00:00Z' }),
          hintEntry({ id: 'act_h2', createdAt: '2026-08-31T10:01:00Z' }),
          hintEntry({ id: 'act_h3', createdAt: '2026-08-31T10:02:00Z' }),
        ],
      ),
    );
    expect(rows.map((r) => r.kind)).toEqual(['hint', 'hint', 'hint']);
  });

  it('a hint between two same-thread emails breaks their run (columns stay honest)', () => {
    const entries = [
      entry('a', '2026-08-31T10:00:00Z'),
      entry('b', '2026-08-31T10:01:00Z'),
      hintEntry({ createdAt: '2026-08-31T10:01:30Z' }),
      entry('c', '2026-08-31T10:02:00Z'),
      entry('d', '2026-08-31T10:03:00Z'),
    ];
    const rows = collapseStream(mergeStream([], entries));
    // 2+2 emails around the hint: neither side reaches the run threshold of 3.
    expect(rows.map((r) => r.kind)).toEqual(['email', 'email', 'hint', 'email', 'email']);
  });
});

describe('interleaveAgentDms — oversight boxes ride the same column', () => {
  const box = (roomId: string, at: string | null): AgentDmBox => ({
    roomId,
    orgId: 'org_1',
    agents: [
      { id: 'agt_a', name: 'vm8' },
      { id: 'agt_b', name: 'vm9' },
    ],
    lastMessage: at ? { preview: 'ping', at } : null,
    severedAt: null,
    canSever: false,
  });

  it('positions each box between chat rows by its lastMessage time', () => {
    const rows = collapseStream(
      mergeStream([chat('msg_1', '2026-08-31T10:00:00Z'), chat('msg_2', '2026-08-31T12:00:00Z')], []),
    );
    const out = interleaveAgentDms(rows, [box('room_x', '2026-08-31T11:00:00Z')]);
    expect(out.map((r) => r.kind)).toEqual(['chat', 'agent-dm', 'chat']);
  });

  it('a box at the same instant as a bubble lands after it; boxes stay id-stable among themselves', () => {
    const rows = collapseStream(mergeStream([chat('msg_1', '2026-08-31T10:00:00Z')], []));
    const out = interleaveAgentDms(rows, [
      box('room_z', '2026-08-31T10:00:00Z'),
      box('room_a', '2026-08-31T10:00:00Z'),
    ]);
    expect(out.map((r) => (r.kind === 'agent-dm' ? r.box.roomId : r.kind))).toEqual([
      'chat',
      'room_a',
      'room_z',
    ]);
  });

  it('drops a box with no message yet, and leaves the column untouched with no boxes', () => {
    const rows = collapseStream(mergeStream([chat('msg_1', '2026-08-31T10:00:00Z')], []));
    expect(interleaveAgentDms(rows, [box('room_x', null)])).toEqual(rows);
    expect(interleaveAgentDms(rows, [])).toEqual(rows);
  });
});
