import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresenceAvatar } from './PresenceAvatar.js';

/**
 * The ONE avatar+status-dot cluster. Geometry assertions live here and only
 * here — surfaces assert they render this component, never its pixels.
 */
describe('PresenceAvatar', () => {
  it('renders the identity avatar with the presence glyph tucked bottom-right', () => {
    render(
      <PresenceAvatar
        kind="agent"
        id="agt_1"
        displayName="Botty"
        presence="online"
        busy={false}
      />,
    );
    expect(screen.getByRole('img', { name: 'Botty' })).toBeInTheDocument();
    const dot = screen.getByRole('img', { name: 'online' });
    // Canonical corner geometry: 1px inset with a 2px panel ring (the sidebar
    // treatment) — NOT the old header variant's padded/offset copy.
    const wrap = dot.parentElement!;
    expect(wrap.className).toContain('-bottom-px');
    expect(wrap.className).toContain('-right-px');
    expect(wrap.className).toContain('ring-2');
    expect(wrap.className).toContain('ring-[var(--sparrow-panel)]');
  });

  it.each(['online', 'offline'] as const)(
    'gives the %s dot an accessible name (and a tooltip) at the render site',
    (state) => {
      render(
        <PresenceAvatar kind="human" id="usr_1" displayName="Jake" presence={state} busy={false} />,
      );
      const dot = screen.getByRole('img', { name: state });
      expect(dot).toHaveAttribute('title', state);
      // The identity avatar keeps its own name — two images, two names.
      expect(screen.getByRole('img', { name: 'Jake' })).not.toBe(dot);
    },
  );

  it('carries the busy ring + tooltip through to the glyph', () => {
    render(
      <PresenceAvatar
        kind="human"
        id="usr_1"
        displayName="Jake"
        avatarUrl={null}
        presence="active"
        busy
        activeAgo="3m ago"
      />,
    );
    expect(screen.getByRole('img', { name: 'active 3m ago + working' })).toBeInTheDocument();
  });
});
