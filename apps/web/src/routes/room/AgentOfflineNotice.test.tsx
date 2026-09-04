import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentOfflineNotice, AGENT_WAKE_INSTRUCTIONS } from './AgentOfflineNotice.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentOfflineNotice', () => {
  it('names the agent and explains it is not listening yet', () => {
    render(<AgentOfflineNotice agentName="deploy-bot" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/deploy-bot isn.?t listening yet/i);
    expect(status).toHaveTextContent(/message loop to come online/i);
    // The copyable instruction block is shown verbatim.
    expect(screen.getByText(AGENT_WAKE_INSTRUCTIONS)).toBeInTheDocument();
  });

  it('copies the wake instructions to the clipboard and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<AgentOfflineNotice agentName="deploy-bot" />);
    const btn = screen.getByRole('button', { name: /copy instructions/i });
    await userEvent.click(btn);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(AGENT_WAKE_INSTRUCTIONS);
    // Flips to a confirmed state after copying.
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });
});
