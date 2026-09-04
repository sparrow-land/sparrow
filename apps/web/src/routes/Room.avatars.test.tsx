import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CapabilitiesResponse, Message } from '@sparrow/common-types';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { Avatar } from '../components/Avatar.js';
import type { ThreadItem } from '../lib/conversation.js';
import { MessageBubble, messageSender } from './Room.js';

const NOW = Date.parse('2026-08-20T17:10:00Z');
const CAPS: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};

const OWN: Message = {
  id: 'msg_1',
  from: { id: 'mem_self', kind: 'human', displayName: 'Jake Quist', avatarUrl: null },
  to: [{ id: 'mem_bot', kind: 'agent', displayName: 'deploy-bot', avatarUrl: null }],
  kind: 'broadcast', subject: null, body: 'ship it', attachments: [], suggestedReplies: [],
  inReplyTo: null, replyValue: null, origin: null, createdAt: '2026-08-20T10:05:00Z',
};

function renderBubble(props: Partial<Parameters<typeof MessageBubble>[0]>) {
  return render(
    <CapabilitiesProvider initial={CAPS}>
      <MessageBubble roomId="room_1" direction="out" outbox={OWN} nowMs={NOW} {...props} />
    </CapabilitiesProvider>,
  );
}

describe('MessageBubble — sender avatar', () => {
  it('renders a round human avatar for a human sender when showAvatar', () => {
    renderBubble({
      sender: { kind: 'human', id: 'usr_jake', displayName: 'Jake Quist', avatarUrl: null },
      showAvatar: true,
    });
    const av = screen.getByRole('img', { name: 'Jake Quist' });
    expect(av.tagName.toLowerCase()).toBe('svg');
    expect(av.querySelector('circle[r="32"]')).not.toBeNull(); // round
    expect(av.querySelector('text')?.textContent).toBe('JQ');
  });

  it('renders the agent bird tile for an agent sender', () => {
    renderBubble({
      sender: { kind: 'agent', id: 'agt_deploy', displayName: 'deploy-bot', avatarUrl: null },
      showAvatar: true,
    });
    const av = screen.getByRole('img', { name: 'deploy-bot' });
    expect(av.querySelector('rect[rx="15"]')).not.toBeNull(); // square tile
    expect(av.querySelector('circle[r="32"]')).toBeNull();
  });

  it('uses the human image when a sender has an avatarUrl', () => {
    renderBubble({
      sender: { kind: 'human', id: 'usr_jake', displayName: 'Jake Quist', avatarUrl: 'https://x/j.png' },
      showAvatar: true,
    });
    const img = screen.getByRole('img', { name: 'Jake Quist' }) as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('https://x/j.png');
  });

  it('hides the avatar on a run continuation (showAvatar=false) but keeps the indent', () => {
    const { container } = renderBubble({
      sender: { kind: 'human', id: 'usr_jake', displayName: 'Jake Quist', avatarUrl: null },
      showAvatar: false,
    });
    expect(screen.queryByRole('img', { name: 'Jake Quist' })).toBeNull();
    // The fixed-width slot is still present to keep bubbles indent-aligned.
    expect(container.querySelector('.w-7')).not.toBeNull();
  });
});

/** Gradient stop colours of an agent bird SVG, top→bottom — the identity fingerprint. */
function birdStops(svg: Element): (string | null)[] {
  return Array.from(svg.querySelectorAll('linearGradient stop')).map((s) =>
    s.getAttribute('stop-color'),
  );
}

/** A one-message (outbound) thread item from `atlas`, membered in a given room. */
function atlasItem(memberId: string): ThreadItem {
  const msg: Message = {
    id: 'msg_x',
    from: { id: memberId, kind: 'agent', displayName: 'atlas', avatarUrl: null, principalId: 'agt_atlas' },
    to: [], kind: 'broadcast', subject: null, body: 'hi', attachments: [], suggestedReplies: [],
    inReplyTo: null, replyValue: null, origin: null, createdAt: '2026-08-20T10:05:00Z',
  };
  return { id: 'msg_x', direction: 'out', createdAt: msg.createdAt, outbox: msg };
}

describe('procedural avatar identity is stable across surfaces (the bug fix)', () => {
  it('messageSender seeds off the principal id, not the per-room member id', () => {
    const inRoomA = messageSender(atlasItem('mem_roomA'));
    const inRoomB = messageSender(atlasItem('mem_roomB'));
    // Same agent, two rooms → identical avatar seed.
    expect(inRoomA.id).toBe('agt_atlas');
    expect(inRoomB.id).toBe('agt_atlas');
  });

  it('a message row and the sidebar draw the identical bird for one agent', () => {
    // The sidebar seeds off the principal id directly (AppShell AgentRow).
    const { container: sidebar } = render(
      <Avatar kind="agent" id="agt_atlas" displayName="atlas" size={24} />,
    );
    // The message row seeds via messageSender off a per-room MemberRef.
    const sender = messageSender(atlasItem('mem_roomA'));
    const { container: row } = renderBubble({ sender, showAvatar: true });

    const rowBird = row.querySelector('svg[aria-label="atlas"]')!;
    const sidebarBird = sidebar.querySelector('svg[aria-label="atlas"]')!;
    expect(birdStops(rowBird)).toEqual(birdStops(sidebarBird));
  });

  it('old payloads without principalId still match via the member→principal bridge', () => {
    const legacy = atlasItem('mem_roomA');
    // Strip principalId to simulate a pre-fix cached MemberRef.
    delete (legacy as { outbox: { from: { principalId?: string } } }).outbox.from.principalId;
    const bridge = new Map([['mem_roomA', 'agt_atlas']]);
    const sender = messageSender(legacy, bridge);
    expect(sender.id).toBe('agt_atlas');
  });
});
