import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Concepts } from './Concepts.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <Concepts />
    </MemoryRouter>,
  );
}

function flatText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

function wordCount(container: HTMLElement): number {
  return flatText(container).trim().split(/\s+/).filter(Boolean).length;
}

describe('Concepts — the model a reader has to leave with', () => {
  it('keeps every section', () => {
    renderPage();
    for (const h of [
      /^Org$/,
      /^Human$/,
      /^Agent$/,
      /^Member$/,
      /^Visibility$/,
      /invite & enrollment/i,
      /direct messages/i,
      /read state/i,
    ]) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
    }
  });

  it('states the reach rule: invites and visibility, never a guessed URL', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/guess/i);
    expect(text).toMatch(/invites/i);
    expect(text).toMatch(/visibility/i);
    expect(text).toMatch(/orgs never see each other/i);
  });

  it('keeps the identity facts (agent key, roles, first human, principal)', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toContain('agk_');
    for (const role of ['owner', 'admin', 'member']) expect(text).toContain(role);
    expect(text).toMatch(/first human/i);
    expect(text).toMatch(/principal/i);
  });

  it('keeps the isolation rule: room co-membership confers nothing', () => {
    const { container } = renderPage();
    expect(flatText(container)).toMatch(/co-membership confers nothing/i);
  });

  it('keeps the invite/enrollment table facts', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toContain('/invite/');
    expect(text).toContain('ivk_');
    expect(text).toContain('enr_');
    expect(text).toMatch(/7 days/);
    expect(text).toMatch(/1–30/);
    expect(text).toMatch(/24 hours/);
    expect(text).toContain('sparrow enroll');
  });

  it('keeps the DM facts: one room per unordered pair, and who may open one', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/one DM room per unordered pair/i);
    expect(text).toMatch(/visible to them/i);
    expect(text).toMatch(/always DM its owner/i);
  });

  /** The three rules and the sever authority are the load-bearing part. */
  it('keeps the three agent-to-agent rules and who can sever', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/three rules/i);
    expect(text).toMatch(/share a room|shar\w+ a room/i);
    expect(text).toMatch(/at least one human can see both/i);
    expect(text).toMatch(/sever/i);
    expect(text).toMatch(/owner or admin/i);
    // Severing survives; the transcript does not vanish with it.
    expect(text).toMatch(/transcript/i);
  });

  it('keeps the read-state facts', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toContain('unread');
    expect(text).toContain('read');
    expect(text).toContain('to: "all"');
    expect(text).toContain('inbox');
    expect(text).toMatch(/peek/i);
  });
});

/**
 * The page is a mental model, not an essay: it was 783 rendered words before the
 * 2026-09 tone pass and is ~590 after, with every fact kept (the invite/enrollment
 * table alone is ~85 of them). This budget is the line; cutting further means
 * cutting facts.
 */
describe('Concepts — reads like a human wrote it', () => {
  it('stays inside its word budget', () => {
    const { container } = renderPage();
    expect(wordCount(container)).toBeLessThanOrEqual(600);
  });

  it('avoids the AI-prose tells', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).not.toMatch(/deliberately/i);
    expect(text).not.toMatch(/the whole trade/i);
    // No em-dash chains in the prose: at most one em dash per sentence. (Table
    // cells are their own fragments and an em dash there is just an empty cell.)
    for (const p of container.querySelectorAll('p')) {
      for (const sentence of (p.textContent ?? '').split(/(?<=[.:!?])\s+/)) {
        expect((sentence.match(/—/g) ?? []).length).toBeLessThanOrEqual(1);
      }
    }
  });
});
