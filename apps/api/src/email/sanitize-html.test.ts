import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from './sanitize-html.js';

/** Convenience: sanitize and fail loudly if the doc emptied when it shouldn't. */
function s(html: string): string {
  const out = sanitizeEmailHtml(html);
  expect(out).not.toBeNull();
  return out as string;
}

describe('sanitizeEmailHtml — tag allowlist', () => {
  it('keeps block, inline, list, table, link, image and code markup', () => {
    const html =
      '<p>Hello <strong>world</strong> and <em>friends</em></p>' +
      '<h2>Heading</h2><blockquote>quoted</blockquote>' +
      '<ul><li>one</li><li>two</li></ul><ol><li>three</li></ol>' +
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>' +
      '<pre><code>x = 1</code></pre><hr><br>' +
      '<a href="https://example.com">link</a>' +
      '<img src="https://example.com/a.png" alt="a">';
    const out = s(html);
    for (const tag of [
      'p', 'strong', 'em', 'h2', 'blockquote', 'ul', 'li', 'ol',
      'table', 'thead', 'tr', 'th', 'tbody', 'td', 'pre', 'code', 'a', 'img',
    ]) {
      expect(out).toContain(`<${tag}`);
    }
    expect(out).toContain('<hr>');
    expect(out).toContain('<br>');
  });

  it('drops a non-allowlisted tag but keeps its children', () => {
    expect(s('<marquee>hi <b>there</b></marquee>')).toBe('hi <b>there</b>');
    expect(s('<custom-element attr="x"><p>kept</p></custom-element>')).toBe('<p>kept</p>');
  });

  it('keeps text when the whole document is unwrapped', () => {
    expect(s('<html><body><div>hi</div></body></html>')).toContain('hi');
  });
});

describe('sanitizeEmailHtml — subtree removals', () => {
  const removed = [
    'script', 'style', 'link', 'iframe', 'object', 'embed', 'form', 'input', 'meta', 'base', 'svg',
  ];

  for (const tag of removed) {
    it(`removes <${tag}> and everything inside it`, () => {
      const out = sanitizeEmailHtml(`<p>before</p><${tag}>SECRET</${tag}><p>after</p>`);
      expect(out).toBe('<p>before</p><p>after</p>');
      expect(out).not.toContain('SECRET');
    });
  }

  it('removes a script nested inside an allowed tag, keeping the rest', () => {
    const out = s('<div><p>keep</p><script>alert(1)</script><p>keep2</p></div>');
    expect(out).not.toContain('alert');
    expect(out).toContain('keep');
    expect(out).toContain('keep2');
  });

  it('removes <svg><script> wholesale', () => {
    const out = sanitizeEmailHtml('<svg><script>alert(1)</script></svg>');
    expect(out).toBeNull();
  });

  it('does not treat markup inside a dropped script as tags', () => {
    const out = s('<p>a</p><script>if (1 < 2) { document.write("<img src=x>") }</script><p>b</p>');
    expect(out).toBe('<p>a</p><p>b</p>');
  });

  it('drops the remainder when a removed tag is never closed', () => {
    const out = s('<p>before</p><iframe src="https://evil.example">tail');
    expect(out).toBe('<p>before</p>');
  });

  it('handles nested same-name removals', () => {
    const out = s('<p>a</p><object><object>x</object>y</object><p>b</p>');
    expect(out).toBe('<p>a</p><p>b</p>');
  });
});

describe('sanitizeEmailHtml — attributes', () => {
  it('keeps only allowlisted attributes', () => {
    const out = s('<img src="https://e.com/a.png" alt="cat" title="t" width="10" height="20" class="x" id="y">');
    expect(out).toContain('src="https://e.com/a.png"');
    expect(out).toContain('alt="cat"');
    expect(out).toContain('title="t"');
    expect(out).toContain('width="10"');
    expect(out).toContain('height="20"');
    expect(out).not.toContain('class');
    expect(out).not.toContain('id=');
  });

  it('drops every on* handler', () => {
    const out = s('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert');
    const out2 = s('<p ONCLICK="alert(1)" onmouseover=\'x\'>hi</p>');
    expect(out2).toBe('<p>hi</p>');
  });

  it('never emits a target, even when the input has one', () => {
    const out = s('<a href="https://e.com" target="_blank" rel="noopener">x</a>');
    expect(out).not.toContain('target');
    expect(out).not.toContain('rel=');
    expect(out).toBe('<a href="https://e.com">x</a>');
  });

  it('escapes quotes and angle brackets inside kept attribute values', () => {
    const out = s('<img src="https://e.com/a.png" alt=\'he said "hi" <b>\'>');
    expect(out).toContain('&quot;');
    expect(out).not.toContain('alt="he said "');
  });
});

describe('sanitizeEmailHtml — URL schemes', () => {
  it('keeps http, https, mailto and cid', () => {
    expect(s('<a href="http://e.com/x">a</a>')).toContain('href="http://e.com/x"');
    expect(s('<a href="https://e.com/x">a</a>')).toContain('href="https://e.com/x"');
    expect(s('<a href="mailto:jo@e.com">a</a>')).toContain('href="mailto:jo@e.com"');
    expect(s('<img src="cid:part1.abc@e.com" alt="x">')).toContain('src="cid:part1.abc@e.com"');
  });

  it('drops javascript: hrefs but keeps the link text', () => {
    const out = s('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript');
    expect(out).toBe('<a>click</a>');
  });

  it('drops data: URLs on both href and src', () => {
    expect(s('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain('data:');
    const img = sanitizeEmailHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="x">');
    expect(img ?? '').not.toContain('data:');
  });

  it('sees through entity- and whitespace-obfuscated javascript URLs', () => {
    expect(s('<a href="&#106;avascript:alert(1)">x</a>')).not.toContain('avascript');
    expect(s('<a href="jav\tascript:alert(1)">x</a>')).not.toContain('ascript:');
    expect(s('<a href="  JaVaScRiPt:alert(1)">x</a>')).not.toContain('alert');
    expect(s('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript');
  });

  it('keeps remote image sources (the server never fetches them)', () => {
    const out = s('<img src="https://tracker.example/pixel.gif?u=1" alt="">');
    expect(out).toContain('src="https://tracker.example/pixel.gif?u=1"');
  });

  it('keeps relative and anchor URLs unmangled', () => {
    expect(s('<a href="#section">x</a>')).toContain('href="#section"');
    expect(s('<a href="/path/page">x</a>')).toContain('href="/path/page"');
  });
});

describe('sanitizeEmailHtml — style filtering', () => {
  it('keeps colour, font and alignment declarations', () => {
    const out = s('<p style="color:red;font-weight:bold;text-align:center">x</p>');
    expect(out).toContain('color:red');
    expect(out).toContain('font-weight:bold');
    expect(out).toContain('text-align:center');
  });

  it('drops layout, behaviour and expression declarations', () => {
    const out = s(
      '<p style="position:fixed;color:blue;behavior:url(x.htc);width:expression(alert(1))">x</p>',
    );
    expect(out).toContain('color:blue');
    expect(out).not.toContain('position');
    expect(out).not.toContain('behavior');
    expect(out).not.toContain('expression');
  });

  it('drops url() and javascript values even on allowlisted properties', () => {
    const out = s('<p style="background-color:url(javascript:alert(1));color:green">x</p>');
    expect(out).toContain('color:green');
    expect(out).not.toContain('url(');
    expect(out).not.toContain('javascript');
  });

  it('drops the style attribute entirely when nothing survives', () => {
    expect(s('<p style="position:absolute;z-index:9">x</p>')).toBe('<p>x</p>');
    expect(s('<p style="">x</p>')).toBe('<p>x</p>');
  });

  it('keeps quoted font families, escaped so they cannot break out of the attribute', () => {
    const out = s('<p style="font-family:\'Comic Sans MS\', serif">x</p>');
    expect(out).toContain('font-family:');
    expect(out).toContain('Comic Sans MS');
    const escaped = s('<p style=\'color:red;font-family:"Arial"\'>x</p>');
    expect(escaped).toContain('&quot;Arial&quot;');
    expect(escaped.match(/"/g)?.length).toBe(2); // only the attribute's own quotes
  });

  it('drops CSS escapes used to smuggle url() or expression()', () => {
    expect(s('<p style="color:\\75rl(x);font-weight:bold">x</p>')).toBe(
      '<p style="font-weight:bold">x</p>',
    );
  });

  it('drops CSS comment smuggling', () => {
    const out = s('<p style="color:red;/*x*/font-size:12px">x</p>');
    expect(out).not.toContain('/*');
    expect(out).toContain('color:red');
  });
});

describe('sanitizeEmailHtml — malformed input', () => {
  it('never throws on hostile or truncated markup', () => {
    const cases = [
      '<', '<<<>>>', '<p', '<p class=', '<a href=>x</a>', '</p></div>',
      '<p>a<b>b<i>c', '<!-- unterminated', '<![CDATA[x]]>', '<!doctype html>',
      '<?xml version="1.0"?><p>x</p>', '<p ="v">x</p>', '<3 is fine',
      '<p style=>x</p>', '<img src=x/>', '<a href=https://e.com/x>y</a>',
    ];
    for (const c of cases) {
      expect(() => sanitizeEmailHtml(c)).not.toThrow();
    }
  });

  it('treats a stray < as text', () => {
    expect(s('a < b and c > d')).toBe('a &lt; b and c &gt; d');
    expect(s('<p>1 < 2</p>')).toBe('<p>1 &lt; 2</p>');
  });

  it('closes tags left open at end of input', () => {
    expect(s('<p>a<b>b')).toBe('<p>a<b>b</b></p>');
  });

  it('ignores stray end tags', () => {
    expect(s('</b>text</p>')).toBe('text');
  });

  it('normalizes uppercase tag and attribute names', () => {
    expect(s('<P STYLE="COLOR:RED">Hi</P>')).toContain('<p');
    expect(s('<A HREF="https://e.com">x</A>')).toContain('<a href="https://e.com">');
  });

  it('accepts unquoted and single-quoted attribute values', () => {
    expect(s('<a href=https://e.com/x>y</a>')).toContain('href="https://e.com/x"');
    expect(s("<a href='https://e.com/y'>y</a>")).toContain('href="https://e.com/y"');
  });

  it('tolerates whitespace and newlines inside tags', () => {
    const out = s('<a\n  href = "https://e.com"\n  title="t"\n>x</a\n>');
    expect(out).toContain('href="https://e.com"');
    expect(out).toContain('title="t"');
    expect(out).toContain('x</a>');
  });

  it('drops comments, doctypes and processing instructions', () => {
    expect(s('<!doctype html><p>x</p><!-- <script>alert(1)</script> -->')).toBe('<p>x</p>');
  });

  it('does not hang on deeply nested markup', () => {
    const deep = '<div>'.repeat(5000) + 'x' + '</div>'.repeat(5000);
    const started = Date.now();
    expect(s(deep)).toContain('x');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('sanitizeEmailHtml — text and entities', () => {
  it('does not double-escape existing entities', () => {
    expect(s('<p>Tom &amp; Jerry &lt;3 &#169; &nbsp;end</p>')).toBe(
      '<p>Tom &amp; Jerry &lt;3 &#169; &nbsp;end</p>',
    );
  });

  it('escapes a bare ampersand', () => {
    expect(s('<p>Tom & Jerry</p>')).toBe('<p>Tom &amp; Jerry</p>');
  });

  it('escapes markup smuggled through text', () => {
    expect(s('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });
});

describe('sanitizeEmailHtml — empty results', () => {
  it('returns null for an empty or whitespace-only document', () => {
    expect(sanitizeEmailHtml('')).toBeNull();
    expect(sanitizeEmailHtml('   \n\t ')).toBeNull();
  });

  it('returns null when everything is stripped', () => {
    expect(sanitizeEmailHtml('<script>alert(1)</script>')).toBeNull();
    expect(sanitizeEmailHtml('<style>p{color:red}</style>')).toBeNull();
    expect(sanitizeEmailHtml('<p></p><div>  </div>')).toBeNull();
    expect(sanitizeEmailHtml('<p>&nbsp;</p>')).toBeNull();
  });

  it('keeps a document whose only content is an image', () => {
    expect(sanitizeEmailHtml('<img src="https://e.com/a.png" alt="">')).not.toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeEmailHtml('\n  <p>x</p>\n  ')).toBe('<p>x</p>');
  });
});
