import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBody } from './MessageBody.js';

describe('MessageBody — blocks', () => {
  it('renders a GFM pipe table as a real <table> with the right cells', () => {
    const body = ['| # | Hint |', '|---|------|', '| 1 | look up |', '| 2 | look down |'].join(
      '\n',
    );
    const { container } = render(<MessageBody text={body} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const ths = [...table!.querySelectorAll('th')].map((th) => th.textContent);
    expect(ths).toEqual(['#', 'Hint']);
    const rows = [...table!.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['1', 'look up'],
      ['2', 'look down'],
    ]);
    // No literal pipe characters survive — the table is rendered, not shown raw.
    expect(container.textContent).not.toContain('|');
  });

  it('wraps tables in an overflow container so wide tables scroll', () => {
    const body = '| a | b |\n|---|---|\n| 1 | 2 |';
    const { container } = render(<MessageBody text={body} />);
    const table = container.querySelector('table')!;
    expect(table.parentElement!.className).toContain('overflow-x-auto');
  });

  it('renders unordered lists as <ul>/<li>, including nesting', () => {
    const body = '- one\n- two\n  - two.a\n  - two.b\n- three';
    const { container } = render(<MessageBody text={body} />);
    const outer = container.querySelector('ul');
    expect(outer).not.toBeNull();
    expect(container.querySelectorAll('li').length).toBe(5);
    // Nested list lives inside an outer <li>.
    expect(container.querySelector('li ul li')).not.toBeNull();
    expect(container.textContent).not.toContain('-');
  });

  it('renders ordered lists as <ol>/<li>', () => {
    const body = '1. first\n2. second';
    const { container } = render(<MessageBody text={body} />);
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect([...ol!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'first',
      'second',
    ]);
  });

  it('renders headings as real heading elements without the # marker', () => {
    const { container } = render(<MessageBody text="## Plan" />);
    const h = container.querySelector('h1, h2, h3, h4, h5, h6');
    expect(h).not.toBeNull();
    expect(h!.textContent).toBe('Plan');
    expect(container.textContent).not.toContain('#');
  });

  it('renders blockquotes', () => {
    const { container } = render(<MessageBody text="> quoted wisdom" />);
    const bq = container.querySelector('blockquote');
    expect(bq).not.toBeNull();
    expect(bq!.textContent).toContain('quoted wisdom');
  });

  it('renders paragraphs and preserves single-newline line breaks inside them', () => {
    const { container } = render(<MessageBody text={'line1\nline2'} />);
    const p = container.querySelector('p')!;
    expect(p.textContent).toBe('line1\nline2');
    // The paragraph carries pre-wrap so the newline actually breaks the line.
    expect(p.className).toContain('whitespace-pre-wrap');
  });
});

describe('MessageBody — inline', () => {
  it('renders **bold** as <strong> without visible delimiters', () => {
    const { container } = render(<MessageBody text="a **bold** b" />);
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('bold');
    expect(container.textContent).toBe('a bold b');
  });

  it('renders *italic* as <em>', () => {
    const { container } = render(<MessageBody text="*em*" />);
    const em = container.querySelector('em');
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe('em');
  });

  it('renders GFM ~~strikethrough~~ as <del>', () => {
    const { container } = render(<MessageBody text="~~gone~~" />);
    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe('gone');
  });

  it('renders inline code in a monospace <code> without backticks', () => {
    const { container } = render(<MessageBody text="run `grep` now" />);
    const code = container.querySelector('code')!;
    expect(code.textContent).toBe('grep');
    expect(code.className).toContain('mono');
    expect(container.textContent).not.toContain('`');
  });
});

describe('MessageBody — code fences', () => {
  it('renders a fenced block as <pre> with literal content (no markdown inside)', () => {
    const body = '```\n**not bold** | not | a | table |\n[x](https://y.io)\n```';
    const { container } = render(<MessageBody text={body} />);
    const pre = container.querySelector('pre')!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toBe('**not bold** | not | a | table |\n[x](https://y.io)\n');
    expect(pre.querySelector('strong')).toBeNull();
    expect(pre.querySelector('a')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });

  it('does not linkify a URL inside a code span', () => {
    const { container } = render(<MessageBody text="`https://example.com`" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
  });
});

describe('MessageBody — links', () => {
  it('renders a markdown link as a safe new-tab anchor', () => {
    const { container } = render(<MessageBody text="[docs](https://x.io)" />);
    const a = container.querySelector('a')!;
    expect(a).not.toBeNull();
    expect(a.getAttribute('href')).toBe('https://x.io');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('docs');
  });

  it('autolinks a bare https URL', () => {
    const { container } = render(<MessageBody text="see https://example.com ok" />);
    const a = container.querySelector('a')!;
    expect(a).not.toBeNull();
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.textContent).toBe('https://example.com');
  });

  it('autolinks a bare http URL', () => {
    const { container } = render(<MessageBody text="http://x.io/a?b=1" />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('http://x.io/a?b=1');
  });

  it('does not anchor non-http(s) schemes (ftp, mailto) — text stays visible', () => {
    const { container } = render(<MessageBody text="[x](ftp://h/f) [m](mailto:a@b.c)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('x');
    expect(container.textContent).toContain('m');
  });
});

describe('MessageBody — security invariants', () => {
  it('shows raw HTML as literal text, never as markup', () => {
    const body = '<b>not bold</b> <img src=x onerror=alert(1)> **real bold**';
    const { container } = render(<MessageBody text={body} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    // The tags themselves stay visible as text.
    expect(container.textContent).toContain('<b>');
    expect(container.textContent).toContain('</b>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('strong')!.textContent).toBe('real bold');
  });

  it('never renders a javascript: href as an anchor', () => {
    const { container } = render(<MessageBody text="[click](javascript:alert(1))" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click');
  });

  it('never renders a data: href as an anchor', () => {
    const { container } = render(
      <MessageBody text="[click](data:text/html,<script>alert(1)</script>)" />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('a <script> in the source never becomes a script element', () => {
    const { container } = render(<MessageBody text={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  it('markdown images render as inert text, not <img>', () => {
    const { container } = render(<MessageBody text="![alt](https://x.io/a.png)" />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('MessageBody — plain text', () => {
  it('renders plain text without decorative wrappers beyond a paragraph', () => {
    const { container } = render(<MessageBody text="just words" />);
    expect(container.textContent).toBe('just words');
    expect(container.querySelector('code, pre, table, ul, ol')).toBeNull();
  });

  it('renders an empty body without crashing', () => {
    const { container } = render(<MessageBody text="" />);
    expect(container.textContent).toBe('');
  });
});
