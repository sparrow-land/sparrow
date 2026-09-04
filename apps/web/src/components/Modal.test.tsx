import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal.js';

/**
 * The modal's focus contract (issue #47): focus moves INTO the dialog on open
 * and returns to whatever opened it on close — Escape, backdrop or the X. A
 * keyboard user who dismisses a dialog must land back where they were, not on
 * `document.body` at the top of the page.
 */
function Harness({ label = 'Open' }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      <button type="button">Other</button>
      {open && (
        <Modal title="Test dialog" labelledById="test-dialog-title" onClose={() => setOpen(false)}>
          <p>body</p>
          <button type="button">Inner</button>
        </Modal>
      )}
    </div>
  );
}

describe('Modal focus management', () => {
  it('moves focus into the dialog on open', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('returns focus to the trigger when Escape closes it', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    await userEvent.click(trigger);
    await screen.findByRole('dialog');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger even when a child autofocuses (issue #56)', async () => {
    // The real dialogs (Create a room, Add people) autofocus their first field.
    // React applies `autoFocus` during commit — BEFORE the modal's effects run —
    // so a capture of `document.activeElement` from inside an effect records the
    // INPUT, not the opener. The input is gone by the time the dialog closes, so
    // the restore was skipped and focus was stranded on `body`.
    function AutoFocusHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <Modal title="Create a room" onClose={() => setOpen(false)}>
              <input autoFocus aria-label="Name" />
            </Modal>
          )}
        </div>
      );
    }
    render(<AutoFocusHarness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(trigger);
    await screen.findByRole('dialog');
    // The child's own autofocus stands: the dialog does not yank focus back.
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger when the X closes it', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('button', { name: /^close$/i }));
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger when the backdrop closes it', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByTestId('modal-backdrop'));
    expect(document.activeElement).toBe(trigger);
  });

  it('survives a trigger that is gone by the time the dialog closes', async () => {
    // The opener can legitimately disappear while the dialog is open (a row that
    // re-renders away). Restoring focus to a detached node must not throw, and
    // must not leave focus on the dead element.
    function Vanishing() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <div>
          {!gone && (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                setGone(true);
              }}
            >
              Open
            </button>
          )}
          {open && (
            <Modal title="Test dialog" onClose={() => setOpen(false)}>
              <p>body</p>
            </Modal>
          )}
        </div>
      );
    }
    render(<Vanishing />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps the accessible dialog contract (role, modal, label, Escape)', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'test-dialog-title');
    expect(screen.getByRole('heading', { name: 'Test dialog' })).toHaveAttribute(
      'id',
      'test-dialog-title',
    );
  });
});
