import { describe, it, expect } from 'vitest';
import { collectDocHeadings, slugifyHeading } from './toc.js';

describe('slugifyHeading', () => {
  it('lowercases and collapses punctuation into single dashes', () => {
    // The deep link named in #50 — it has to come out exactly like this.
    expect(slugifyHeading('Events (SSE)')).toBe('events-sse');
    expect(slugifyHeading('Docs by convention & hints')).toBe('docs-by-convention-hints');
    expect(slugifyHeading('Agents, visibility & sharing')).toBe('agents-visibility-sharing');
    expect(slugifyHeading('1 · Sign up')).toBe('1-sign-up');
    expect(slugifyHeading('Harness — sparrow holds the loop')).toBe('harness-sparrow-holds-the-loop');
    expect(slugifyHeading('Reverse proxy & tunnels')).toBe('reverse-proxy-tunnels');
  });

  it('joins on apostrophes rather than splitting the word', () => {
    expect(slugifyHeading("The invitee's surface")).toBe('the-invitees-surface');
    expect(slugifyHeading('The invitee’s surface')).toBe('the-invitees-surface');
  });

  it('folds accents and trims stray dashes', () => {
    expect(slugifyHeading('  Café mode  ')).toBe('cafe-mode');
    expect(slugifyHeading('--Weird--')).toBe('weird');
  });

  it('falls back to `section` when nothing survives', () => {
    expect(slugifyHeading('!!!')).toBe('section');
    expect(slugifyHeading('')).toBe('section');
  });
});

describe('collectDocHeadings', () => {
  function doc(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
  }

  it('writes an id onto every h2/h3 and reports them in document order', () => {
    const root = doc(`
      <h1>REST API</h1>
      <h2>Conventions</h2>
      <h3>Error envelope</h3>
      <h2>Events (SSE)</h2>
    `);
    expect(collectDocHeadings(root)).toEqual([
      { id: 'conventions', text: 'Conventions', level: 2 },
      { id: 'error-envelope', text: 'Error envelope', level: 3 },
      { id: 'events-sse', text: 'Events (SSE)', level: 2 },
    ]);
    // The ids really landed on the elements, so `#events-sse` resolves.
    expect(root.querySelector('h2#events-sse')?.textContent).toBe('Events (SSE)');
    // h1 is the page title, not a section — it stays out of the TOC.
    expect(root.querySelector('h1')?.id).toBe('');
  });

  it('de-duplicates colliding slugs, first occurrence keeping the bare slug', () => {
    const headings = collectDocHeadings(doc('<h2>Install</h2><h3>Install</h3><h2>Install</h2>'));
    expect(headings.map((h) => h.id)).toEqual(['install', 'install-2', 'install-3']);
  });

  it('skips empty headings and normalizes whitespace in the label', () => {
    const headings = collectDocHeadings(doc('<h2>  </h2><h2>Rooms &amp;\n  members</h2>'));
    expect(headings).toEqual([{ id: 'rooms-members', text: 'Rooms & members', level: 2 }]);
  });
});
