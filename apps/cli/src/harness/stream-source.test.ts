import { describe, expect, it } from 'vitest';
import type { SparrowClient } from '@sparrow/client';
import { streamWorkSource } from './stream-source.js';
import type { WorkHandlers } from './orchestrator.js';

const noopHandlers: WorkHandlers = {
  onWork: () => {},
  onClawback: () => {},
  onOnline: () => {},
  onReconnect: () => {},
  onNote: () => {},
};

describe('streamWorkSource', () => {
  it('subscribes quiet — presence/status frames are never delivered to the harness', async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    const client = {
      meEvents: (_onEvent: unknown, opts: unknown) => {
        seen.push(opts);
        // Abort as soon as the first stream is open so the runner returns.
        queueMicrotask(() => controller.abort());
        return { close() {}, closed: new Promise<void>((r) => setTimeout(r, 0)) };
      },
    } as unknown as SparrowClient;

    await streamWorkSource({ client })(noopHandlers, controller.signal);

    expect(seen.length).toBeGreaterThan(0);
    expect((seen[0] as { quiet?: readonly string[] }).quiet).toEqual(['presence', 'status']);
  });
});
