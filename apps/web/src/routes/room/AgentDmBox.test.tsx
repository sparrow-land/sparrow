import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { AgentDmBox, Message } from '@sparrow/common-types';
import { restoreFetch, useFetch, json } from '../../test/apiStub.js';
import { AgentDmCard, useAgentDmBoxes } from './AgentDmBox.js';

const ORG_ID = 'org_1';

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

function box(overrides: Partial<AgentDmBox> = {}): AgentDmBox {
  return {
    roomId: 'room_x',
    orgId: ORG_ID,
    agents: [
      { id: 'agt_a', name: 'alpha' },
      { id: 'agt_b', name: 'beta' },
    ],
    lastMessage: { preview: 'reply from beta', at: '2026-09-01T00:00:00.000Z' },
    severedAt: null,
    canSever: false,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    from: { id: 'mem_a', kind: 'agent', displayName: 'alpha', avatarUrl: null },
    to: [],
    kind: 'dm',
    subject: null,
    body: 'first from alpha',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The hook + card pair the way `Room` consumes them, minus the stream merge. */
function Probe() {
  const { boxes } = useAgentDmBoxes({ orgId: ORG_ID, enabled: true });
  return (
    <div>
      {boxes.map((b) => (
        <AgentDmCard key={b.roomId} orgId={ORG_ID} box={b} />
      ))}
    </div>
  );
}

/**
 * Render the probe over a stubbed API + a real (held-open) `/me/events` stream,
 * so a test can push live frames the way the app receives them. `list` is a live
 * ref: change it and a reconcile picks up the new set. Returns a `push` that
 * delivers one SSE frame to every open subscriber.
 */
function renderBoxes(opts: {
  list: () => AgentDmBox[];
  messages?: Message[];
  onMessagesUrl?: (url: string) => void;
  /** Answer the sever/allow POSTs; default is a plain success. */
  onGovern?: (url: string) => Response | undefined;
}) {
  const streams: ((s: string) => void)[] = [];
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/sever') || url.includes('/allow')) {
      const answer = opts.onGovern?.(url);
      if (answer) return answer;
      return url.includes('/sever')
        ? json({
            sever: {
              roomId: 'room_x',
              orgId: ORG_ID,
              agents: [
                { id: 'agt_a', name: 'alpha' },
                { id: 'agt_b', name: 'beta' },
              ],
              severedBy: { id: 'usr_1', displayName: 'Owner' },
              authority: 'org',
              severedAt: '2026-09-02T00:00:00.000Z',
            },
          })
        : json({ roomId: 'room_x', allowed: true });
    }
    if (url.includes('/me/events')) {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(': open\n\n'));
          streams.push((s) => c.enqueue(new TextEncoder().encode(s)));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes(`/orgs/${ORG_ID}/agent-dms/`) && url.includes('/messages')) {
      opts.onMessagesUrl?.(url);
      return json({ items: opts.messages ?? [message()], nextBefore: null });
    }
    if (url.includes(`/orgs/${ORG_ID}/agent-dms`)) {
      return json({ items: opts.list() });
    }
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
  useFetch(fetchMock as unknown as typeof fetch);

  const push = async (type: string, data: unknown) => {
    const frame = `id: 1\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    await act(async () => {
      for (const send of streams) send(frame);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const view = render(<Probe />);
  return { ...view, push, calls };
}

describe('AgentDmBox — agent↔agent DM oversight boxes', () => {
  it('renders a collapsed "<a> ↔ <b> DM" box with the last-message preview', async () => {
    renderBoxes({ list: () => [box()] });
    const toggle = await screen.findByRole('button', { name: /alpha ↔ beta/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('reply from beta')).toBeInTheDocument();
  });

  it('wears the borderless Tinted Etch container in the DM tone, at the compact density', async () => {
    renderBoxes({ list: () => [box()] });
    const toggle = await screen.findByRole('button', { name: /alpha ↔ beta/i });
    const card = toggle.closest<HTMLElement>('.info-box');
    expect(card).not.toBeNull();
    expect(card!.style.getPropertyValue('--info-tone')).toBe('var(--sparrow-type-dm)');
    expect(card!.className).not.toContain('border-[var(--sparrow-border)]');
    expect(card!.className).not.toContain('bg-[var(--sparrow-panel)]');
    // A DM box is a one-line ambient row like a hint — it takes the full
    // compact density (the email floor rule does not apply: no controls here).
    expect(toggle.className).toContain('py-[5px]');
  });

  it('expands in place to a READ-ONLY transcript — messages shown, no composer', async () => {
    renderBoxes({
      list: () => [box()],
      messages: [
        message({ id: 'msg_1', body: 'first from alpha' }),
        message({
          id: 'msg_2',
          from: { id: 'mem_b', kind: 'agent', displayName: 'beta', avatarUrl: null },
          body: 'second from beta',
          createdAt: '2026-09-01T00:01:00.000Z',
        }),
      ],
    });
    const toggle = await screen.findByRole('button', { name: /alpha ↔ beta/i });
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('first from alpha')).toBeInTheDocument());
    expect(screen.getByText('second from beta')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Read-only: there is no composer / text input in the expansion.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('reconciles live: a chat activity.appended makes a newly-eligible box appear', async () => {
    let boxes: AgentDmBox[] = [];
    const { push } = renderBoxes({ list: () => boxes });
    // Nothing at first.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /alpha ↔ beta/i })).toBeNull(),
    );
    // A DM happens; the server would now return the box.
    boxes = [box()];
    await push('activity.appended', {
      entry: { id: 'act_1', orgId: ORG_ID, medium: 'chat', type: 'chat.message', refs: { roomId: 'room_x' } },
    });
    expect(await screen.findByRole('button', { name: /alpha ↔ beta/i })).toBeInTheDocument();
  });

  /* --------------------------- sever / allow -------------------------- */

  it('shows no sever control to a human who only watches', async () => {
    renderBoxes({ list: () => [box()] });
    await screen.findByRole('button', { name: /alpha ↔ beta/i });
    expect(screen.queryByRole('button', { name: /^sever$/i })).toBeNull();
  });

  it('a human who governs the pair can sever it, then allow it again', async () => {
    const { calls } = renderBoxes({ list: () => [box({ canSever: true })] });
    await userEvent.click(await screen.findByRole('button', { name: /^sever$/i }));
    await waitFor(() =>
      expect(calls.some((u) => u.includes(`/orgs/${ORG_ID}/agent-dms/room_x/sever`))).toBe(true),
    );
    // The card says so and offers the way back — it never hides the transcript.
    expect(await screen.findByText('Severed')).toBeInTheDocument();
    expect(screen.getByText('reply from beta')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));
    await waitFor(() =>
      expect(calls.some((u) => u.includes(`/orgs/${ORG_ID}/agent-dms/room_x/allow`))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Severed')).toBeNull());
  });

  it('a severed box arrives flagged, and a refused allow explains itself', async () => {
    renderBoxes({
      list: () => [box({ canSever: true, severedAt: '2026-09-02T00:00:00.000Z' })],
      onGovern: (url) =>
        url.includes('/allow')
          ? json({ error: { code: 'forbidden', message: 'nope' } }, 403)
          : undefined,
    });
    expect(await screen.findByText('Severed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));
    expect(await screen.findByText(/owner or admin may need to lift it/i)).toBeInTheDocument();
    expect(screen.getByText('Severed')).toBeInTheDocument();
  });

  it('reconciles the box away when visibility is revoked (agent.unshared)', async () => {
    let boxes: AgentDmBox[] = [box()];
    const { push } = renderBoxes({ list: () => boxes });
    await screen.findByRole('button', { name: /alpha ↔ beta/i });
    boxes = [];
    await push('agent.unshared', { agent: { id: 'agt_a' } });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /alpha ↔ beta/i })).toBeNull(),
    );
  });
});
