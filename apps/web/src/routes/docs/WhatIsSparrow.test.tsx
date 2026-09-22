import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WhatIsSparrow } from './WhatIsSparrow.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <WhatIsSparrow />
    </MemoryRouter>,
  );
}

/** Page text with whitespace collapsed, so a sentence split across elements still matches. */
function flatText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

function headingTexts(container: HTMLElement, level: 'h2' | 'h3'): string[] {
  return [...container.querySelectorAll(level)].map((h) =>
    (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

function figures(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('figure')];
}

/**
 * Claims on this page come from `README.md` — the "What is Sparrow?",
 * "Intended audience and typical setup", "Email, voice, and identity" and
 * "How does it work?" sections — and from SPEC.md. A reader who arrived from
 * the repo must recognise the sentences. These are the load-bearing ones; if
 * the README's claim changes, this page changes with it.
 */
const README_CLAIMS: [claim: string, section: string][] = [
  ['messaging system built for your agents', 'README — What is Sparrow?'],
  ['your hardware', 'README — What is Sparrow?'],
  ['Slack for agents', 'README — What is Sparrow?'],
  ['not a harness', 'README — What is Sparrow?'],
  ['unopinionated', 'README — What is Sparrow?'],
  ['power users who run more than one agent', 'README — Intended audience'],
  ['Tailscale', 'README — Intended audience'],
  ['tool call', 'README — How does it work?'],
];

describe('What is Sparrow', () => {
  it('opens by saying what Sparrow is, not what it promises', () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'What is Sparrow' })).toBeInTheDocument();
    expect(flatText(container)).toMatch(/messaging.{0,40}built for your agents/i);
  });

  /**
   * Four questions, in the order a stranger asks them, then the send-off. The
   * headings are the page: a reader who only reads the TOC has still been told
   * what Sparrow is and is not.
   */
  it('answers four questions and then sends the reader on', () => {
    const { container } = renderPage();
    expect(headingTexts(container, 'h2')).toEqual([
      'What it is',
      'Who it is for',
      'What it is not',
      'How it works',
      'Email, voice, and identity',
      'Where next',
    ]);
  });

  it.each(README_CLAIMS)('keeps the README claim “%s” (%s)', (claim) => {
    const { container } = renderPage();
    expect(flatText(container).toLowerCase()).toContain(claim.toLowerCase());
  });

  /** The three things it runs on, in the README's own possessive triple. */
  it('names your hardware, your agent sessions and your instructions', () => {
    const text = flatText(renderPage().container);
    expect(text).toMatch(/your hardware/i);
    expect(text).toMatch(/your agent sessions/i);
    expect(text).toMatch(/your instructions/i);
  });

  /**
   * "Not a harness" is the claim most easily read as a contradiction — sparrow
   * ships a `sparrow harness` command — so the page says which sense it means
   * and names the runners it works with rather than leaving it at a slogan.
   */
  it('says which runners it works with, so “not a harness” is not a slogan', () => {
    const text = flatText(renderPage().container);
    for (const runner of ['Claude Code', 'Codex', 'Gemini']) {
      expect(text, runner).toContain(runner);
    }
    expect(text).toMatch(/does not rewrite|doesn’t rewrite/i);
  });

  /** The surfaces, and the two doors. Depth belongs to the pages that own it. */
  it('sketches the server, the web UI and the three client surfaces', () => {
    const { container } = renderPage();
    const text = flatText(container);
    expect(text).toMatch(/web UI/i);
    for (const surface of ['CLI', 'MCP', 'SDK']) expect(text, surface).toContain(surface);
    expect(text).toMatch(/invite/i);
    expect(text).toMatch(/approv/i);
    expect(text).toMatch(/rooms/i);
  });

  /**
   * Email and voice are the one place this page could over-claim: they are NOT
   * out of the box. The page has to say that they need vendor keys.
   */
  it('marks email and voice as configuration, not as included', () => {
    const text = flatText(renderPage().container);
    expect(text).toMatch(/email address/i);
    expect(text).toMatch(/voice/i);
    expect(text).toMatch(/vendor keys|external vendor/i);
  });

  it('never claims sparrow runs the agents or is safe on the open internet', () => {
    const text = flatText(renderPage().container).toLowerCase();
    expect(text).not.toContain('hardened for the open internet.');
    expect(text).toMatch(/is ?n[o']t hardened for the open internet/i);
    // The agents run on your machines; sparrow does not host them.
    expect(text).toMatch(/run on your own machines/i);
  });

  /* -------------------------------------------------------------- figure -- */

  it('carries the one infographic, with real alt text and a caption', () => {
    const { container } = renderPage();
    const figs = figures(container);
    expect(figs.length).toBe(1);
    const img = figs[0]!.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/docs/img/what-is-sparrow/what-is-sparrow.png');
    expect(img?.getAttribute('loading')).toBe('lazy');
    const alt = img?.getAttribute('alt') ?? '';
    expect(alt.length, alt).toBeGreaterThan(60);
    expect(alt.toLowerCase(), alt).not.toContain('infographic');
    expect(alt.toLowerCase(), alt).not.toContain('diagram');
    expect(figs[0]!.querySelector('figcaption')?.textContent?.trim()).toBeTruthy();
  });

  /* --------------------------------------------------------------- links -- */

  it('hands the reader on to the walk-through and the agent’s-eye page', () => {
    const { container } = renderPage();
    for (const href of ['/docs', '/docs/what-my-agent-sees', '/docs/concepts', '/docs/self-hosting']) {
      expect(container.querySelector(`a[href="${href}"]`), href).toBeTruthy();
    }
  });

  /**
   * This is the first page in the tree and the one a reader bounces off if it
   * reads like a brochure. It is an orientation, not a manual: no commands, no
   * tables, and a length somebody actually finishes.
   */
  it('stays a two-minute orientation with no commands in it', () => {
    const { container } = renderPage();
    expect(container.querySelector('.terminal')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    const words = flatText(container).trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(450);
    expect(words).toBeLessThanOrEqual(900);
  });
});
