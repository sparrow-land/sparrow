import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordingOverlay } from './RecordingOverlay.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.style.overflow = '';
});

describe('RecordingOverlay', () => {
  it('renders a dialog with a giant stop target and a labelled timer', () => {
    render(<RecordingOverlay onStop={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: /recording/i });
    expect(dialog).toBeInTheDocument();
    // The primary surface is one big stop button.
    expect(within(dialog).getByRole('button', { name: /stop/i })).toBeInTheDocument();
    // A live timer is present.
    expect(within(dialog).getByRole('timer')).toHaveTextContent('00:00');
  });

  it('renders the live level meter inside the overlay', () => {
    render(<RecordingOverlay onStop={vi.fn()} onCancel={vi.fn()} stream={null} />);
    const dialog = screen.getByRole('dialog', { name: /recording/i });
    expect(within(dialog).getByTestId('voice-level-meter')).toBeInTheDocument();
  });

  it('ticks the elapsed time once per second (mm:ss)', () => {
    vi.useFakeTimers();
    try {
      render(<RecordingOverlay onStop={vi.fn()} onCancel={vi.fn()} />);
      const timer = screen.getByRole('timer');
      expect(timer).toHaveTextContent('00:00');
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(timer).toHaveTextContent('00:01');
      act(() => {
        vi.advanceTimersByTime(64_000);
      });
      expect(timer).toHaveTextContent('01:05');
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls onStop when the big target is clicked', async () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    render(<RecordingOverlay onStop={onStop} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel (not onStop) when the Cancel control is clicked', async () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    render(<RecordingOverlay onStop={onStop} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('cancels (discards) on Escape — the safer semantic', async () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    render(<RecordingOverlay onStop={onStop} onCancel={onCancel} />);
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('locks background scroll while open and restores it on unmount', () => {
    const { unmount } = render(<RecordingOverlay onStop={vi.fn()} onCancel={vi.fn()} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
