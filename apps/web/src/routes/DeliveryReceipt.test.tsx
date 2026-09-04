import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MessageStatus, RecipientStatus, ReadStatus } from '@sparrow/common-types';
import { DeliveryReceipt } from './Room.js';

const NOW = Date.parse('2026-08-20T17:10:00Z');

function recip(
  id: string,
  displayName: string,
  status: ReadStatus,
  over: Partial<RecipientStatus> = {},
): RecipientStatus {
  return {
    id,
    kind: 'human', avatarUrl: null,
    displayName,
    status,
    receivedAt: status === 'received' || status === 'read' ? '2026-08-20T17:04:00Z' : null,
    readAt: status === 'read' ? '2026-08-20T17:05:00Z' : null,
    ...over,
  };
}

function status(recipients: RecipientStatus[]): MessageStatus {
  return { id: 'msg_1', kind: recipients.length > 1 ? 'broadcast' : 'dm', createdAt: '2026-08-20T17:00:00Z', recipients };
}

describe('DeliveryReceipt three-state rendering', () => {
  it('renders nothing (sent) when there is no receipt', () => {
    const { container } = render(<DeliveryReceipt receipt={undefined} nowMs={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing (sent) when no recipient has received it yet', () => {
    const { container } = render(<DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'unread')])} nowMs={NOW} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/delivered|read/i)).toBeNull();
  });

  it('shows the delivered glyph once a recipient has received it', () => {
    render(<DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'received')])} nowMs={NOW} />);
    expect(screen.getByText(/delivered/i)).toBeInTheDocument();
    expect(screen.queryByText(/^read/)).toBeNull();
  });

  it('delivered uses the dim/faint color, never the copper accent', () => {
    render(<DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'received')])} nowMs={NOW} />);
    const el = screen.getByText(/delivered/i);
    expect(el.className).toContain('--sparrow-faint');
    expect(el.className).not.toContain('--sparrow-accent');
  });

  it('shows the read indicator once the recipient has read it', () => {
    render(<DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'read')])} nowMs={NOW} />);
    const el = screen.getByText(/^read/);
    expect(el.textContent?.trim()).toMatch(/^read/);
    expect(el.className).toContain('--sparrow-good');
  });

  it('re-render with a received receipt flips a sent bubble to delivered', () => {
    const { container, rerender } = render(
      <DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'unread')])} nowMs={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'received')])} nowMs={NOW} />);
    expect(screen.getByText(/delivered/i)).toBeInTheDocument();
  });

  it('re-render with a read receipt flips delivered to read', () => {
    const { rerender } = render(
      <DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'received')])} nowMs={NOW} />,
    );
    expect(screen.getByText(/delivered/i)).toBeInTheDocument();
    rerender(<DeliveryReceipt receipt={status([recip('mem_a', 'Ada', 'read')])} nowMs={NOW} />);
    expect(screen.getByText(/^read/)).toBeInTheDocument();
    expect(screen.queryByText(/delivered/i)).toBeNull();
  });
});

describe('DeliveryReceipt broadcast aggregation', () => {
  it('delivered when ANY recipient has received (others still unread)', () => {
    render(
      <DeliveryReceipt
        receipt={status([recip('mem_a', 'Ada', 'received'), recip('mem_b', 'Bo', 'unread')])}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/delivered/i)).toBeInTheDocument();
    expect(screen.queryByText(/^read/)).toBeNull();
  });

  it('still delivered (not read) when SOME but not all have read', () => {
    render(
      <DeliveryReceipt
        receipt={status([recip('mem_a', 'Ada', 'read'), recip('mem_b', 'Bo', 'received')])}
        nowMs={NOW}
      />,
    );
    const el = screen.getByText(/delivered/i);
    expect(el).toBeInTheDocument();
    expect(el.textContent).toContain('1/2 read');
  });

  it('read only when ALL recipients have read', () => {
    render(
      <DeliveryReceipt
        receipt={status([recip('mem_a', 'Ada', 'read'), recip('mem_b', 'Bo', 'read')])}
        nowMs={NOW}
      />,
    );
    const el = screen.getByText(/^read/);
    expect(el.textContent).toContain('(2)');
  });

  it('tooltip carries per-recipient detail on broadcasts', () => {
    render(
      <DeliveryReceipt
        receipt={status([recip('mem_a', 'Ada', 'read'), recip('mem_b', 'Bo', 'received')])}
        nowMs={NOW}
      />,
    );
    const el = screen.getByText(/delivered/i);
    expect(el.getAttribute('title')).toContain('Ada: read');
    expect(el.getAttribute('title')).toContain('Bo: delivered');
  });
});
