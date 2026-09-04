/**
 * The principal event bus + journal key (SPEC v4 "Events (SSE) → Journal key"):
 * the per-principal journal and the principal event bus are keyed by
 * **(principalType, principalId)**, not by human id. v3's principal-level events
 * all targeted humans; v4's `email.received` / `email.sent` target AGENTS, so an
 * agent must be a first-class journalable recipient. This is the seam the email
 * medium plugs into — the chat build exercises it directly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from './db/index.js';
import { EventJournal } from './event-journal.js';
import { EventBus, type SseEnvelope } from './events.js';

describe('EventBus — keyed by (principalType, principalId)', () => {
  let dir: string;
  let handle: DbHandle;
  let journal: EventJournal;
  let bus: EventBus;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sparrow-bus-'));
    handle = openDb(dir);
    journal = new EventJournal(handle.sqlite);
    bus = new EventBus();
    bus.bindJournal(journal);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers to the subscriber with the matching principal type AND id', () => {
    const toHuman: SseEnvelope[] = [];
    const toAgent: SseEnvelope[] = [];
    bus.subscribe('human', 'p_1', (e) => toHuman.push(e));
    bus.subscribe('agent', 'p_1', (e) => toAgent.push(e));

    bus.publish('agent', 'p_1', 'activity.appended', {
      entry: { id: 'act_1' },
    } as never);

    // Same id, different kind — the human subscriber must NOT see it.
    expect(toHuman).toHaveLength(0);
    expect(toAgent).toHaveLength(1);
    expect(toAgent[0]!.event).toBe('activity.appended');
  });

  it('journals under the target principal so an agent can replay it', () => {
    bus.publish('agent', 'agt_1', 'activity.appended', { entry: { id: 'act_1' } } as never);
    bus.publish('human', 'usr_1', 'activity.appended', { entry: { id: 'act_2' } } as never);

    const agentRows = journal.replaySince('agent', 'agt_1', 0);
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]!.event).toBe('activity.appended');
    // The human journal is a separate cursor space.
    expect(journal.replaySince('human', 'agt_1', 0)).toHaveLength(0);
    expect(journal.replaySince('human', 'usr_1', 0)).toHaveLength(1);
  });

  it('the emitted envelope carries the journal cursor it was written under', () => {
    let seen: SseEnvelope | undefined;
    bus.subscribe('agent', 'agt_1', (e) => (seen = e));
    bus.publish('agent', 'agt_1', 'activity.appended', { entry: { id: 'act_1' } } as never);
    expect(seen!.id).toBe(journal.latestId('agent', 'agt_1'));
  });
});
