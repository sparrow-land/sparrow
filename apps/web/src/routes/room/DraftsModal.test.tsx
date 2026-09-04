import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Draft } from '@sparrow/common-types';
import { DraftsModal } from './DraftsModal.js';

const drafts: Draft[] = [
  { id: 'drf_1', text: 'first draft', createdAt: '2026-08-20T00:00:01.000Z' },
  { id: 'drf_2', text: 'second draft', createdAt: '2026-08-20T00:00:02.000Z' },
];

function setup(overrides: Partial<React.ComponentProps<typeof DraftsModal>> = {}) {
  const props: React.ComponentProps<typeof DraftsModal> = {
    drafts,
    sending: false,
    onInsert: vi.fn(),
    onSend: vi.fn(),
    onDelete: vi.fn(),
    onCombine: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<DraftsModal {...props} />);
  return props;
}

describe('DraftsModal', () => {
  it('lists this room’s drafts oldest first', () => {
    setup();
    const texts = screen.getAllByText(/draft$/).map((el) => el.textContent);
    expect(texts).toEqual(['first draft', 'second draft']);
  });

  it('clicking a draft text inserts it', async () => {
    const { onInsert } = setup();
    await userEvent.click(screen.getByText('first draft'));
    expect(onInsert).toHaveBeenCalledWith(drafts[0]);
  });

  it('clicking a draft text also removes it (content lives on in the composer)', async () => {
    const { onInsert, onDelete } = setup();
    await userEvent.click(screen.getByText('first draft'));
    expect(onInsert).toHaveBeenCalledWith(drafts[0]);
    expect(onDelete).toHaveBeenCalledWith(drafts[0]);
  });

  it('offers Combine when there are 2+ drafts and fires onCombine', async () => {
    const { onCombine } = setup();
    await userEvent.click(screen.getByRole('button', { name: /combine/i }));
    expect(onCombine).toHaveBeenCalledTimes(1);
  });

  it('hides Combine with fewer than 2 drafts', () => {
    setup({ drafts: [drafts[0]!] });
    expect(screen.queryByRole('button', { name: /combine/i })).not.toBeInTheDocument();
  });

  it('the row Send affordance sends that draft', async () => {
    const { onSend } = setup();
    const sendButtons = screen.getAllByRole('button', { name: /^send/i });
    await userEvent.click(sendButtons[0]!);
    expect(onSend).toHaveBeenCalledWith(drafts[0]);
  });

  it('disables row Send while a message is in flight', () => {
    setup({ sending: true });
    for (const b of screen.getAllByRole('button', { name: /^send/i })) {
      expect(b).toBeDisabled();
    }
  });

  it('the trash affordance deletes that draft', async () => {
    const { onDelete } = setup();
    const delButtons = screen.getAllByRole('button', { name: /delete draft/i });
    await userEvent.click(delButtons[1]!);
    expect(onDelete).toHaveBeenCalledWith(drafts[1]);
  });

  it('shows an empty state when there are no drafts', () => {
    setup({ drafts: [] });
    expect(screen.getByText(/no drafts/i)).toBeInTheDocument();
  });
});
