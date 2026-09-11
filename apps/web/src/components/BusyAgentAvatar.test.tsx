import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyAgentAvatar } from './BusyAgentAvatar.js';

class ImageProbe {
  static instances: ImageProbe[] = [];
  decoding = '';
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  src = '';

  constructor() {
    ImageProbe.instances.push(this);
  }
}

function stubMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('BusyAgentAvatar', () => {
  beforeEach(() => {
    ImageProbe.instances = [];
    vi.stubGlobal('Image', ImageProbe);
    stubMotion(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('does not request a sprite while idle', () => {
    render(<BusyAgentAvatar id="agt_1" displayName="Botty" size={24} busy={false} />);
    expect(ImageProbe.instances).toHaveLength(0);
    expect(screen.getByRole('img', { name: 'Botty' })).toBeInTheDocument();
  });

  it('does not request or animate a sprite under reduced motion', async () => {
    stubMotion(true);
    const { container } = render(
      <BusyAgentAvatar id="agt_1" displayName="Botty" size={24} busy />,
    );
    await act(async () => {});
    expect(ImageProbe.instances).toHaveLength(0);
    expect(container.firstChild).toHaveAttribute('data-moving', 'false');
  });

  it('keeps the assigned static identity when its matching atlas is missing', async () => {
    const { container } = render(
      <BusyAgentAvatar id="agt_1" displayName="Botty" size={24} busy />,
    );
    await waitFor(() => expect(ImageProbe.instances).toHaveLength(1));
    expect(ImageProbe.instances[0]!.src).toMatch(/\/motion\/base-[123]\.webp$/);
    act(() => ImageProbe.instances[0]!.onerror?.());
    expect(container.firstChild).toHaveAttribute('data-sprite-state', 'failed');
    expect(screen.getByRole('img', { name: 'Botty' })).toBeInTheDocument();
  });

  it('loads while busy and fades back to the final frame when work stops', async () => {
    const { container, rerender } = render(
      <BusyAgentAvatar id="agt_1" displayName="Botty" size={24} busy />,
    );
    await waitFor(() => expect(ImageProbe.instances).toHaveLength(1));
    act(() => ImageProbe.instances[0]!.onload?.());
    expect(container.firstChild).toHaveAttribute('data-moving', 'true');
    expect(container.querySelector('.busy-agent-avatar__sprite')).toBeInTheDocument();

    rerender(<BusyAgentAvatar id="agt_1" displayName="Botty" size={24} busy={false} />);
    expect(container.firstChild).toHaveAttribute('data-moving', 'false');
    expect(container.querySelector('.busy-agent-avatar__sprite')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Botty' })).toBeInTheDocument();
  });
});
