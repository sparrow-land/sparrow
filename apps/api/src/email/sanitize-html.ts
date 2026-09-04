/**
 * Inbound HTML sanitization (SPEC v4 "The email medium → The inbound payload →
 * HTML sanitization").
 *
 * Email HTML is attacker-controlled markup that we store and later render in a
 * human's browser, so the untrusted form must never survive ingest: the payload
 * is sanitized ONCE, here, and only the result is persisted. Cleaning at render
 * time would mean every future reader — web UI, export, a client we have not
 * written yet — re-deriving the same judgement, and one that forgets is an XSS.
 *
 * The rule is an allowlist, not a blocklist: unknown tags lose their wrapper but
 * keep their children (a stray `<custom-card>` should not swallow the message),
 * while a short set of executable/fetching elements is removed with its whole
 * subtree. Everything is hand-rolled — no DOM, no dependency — because this runs
 * on every inbound message and must never throw or hang on malformed input.
 *
 * Two deliberate non-behaviours:
 *   - Remote `img` sources are KEPT. The server never fetches them; the reader
 *     opts in per thread in the UI, so a quarantined email cannot confirm
 *     receipt to a tracking pixel just by being ingested.
 *   - No `target`/`rel` is added. Rendering owns that; the stored markup stays
 *     presentation-neutral (and an incoming `target` is simply not allowlisted).
 */

/** Elements we keep, with their attributes filtered. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  // block text
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'br',
  // inline text
  'span', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins',
  'sub', 'sup', 'small', 'mark', 'abbr', 'cite', 'q', 'code', 'kbd', 'samp',
  'var', 'tt', 'wbr',
  // lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // tables
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  // media
  'img',
]);

/**
 * Elements removed WITH their subtree. The spec names the first eleven; the
 * extras are the same hazard under a different spelling (frames, applets, form
 * controls, and `template`/`noscript` content that parsers hand back as live
 * markup).
 */
const DROP_SUBTREE: ReadonlySet<string> = new Set([
  'script', 'style', 'link', 'iframe', 'object', 'embed', 'form', 'input',
  'meta', 'base', 'svg',
  'noscript', 'template', 'applet', 'frame', 'frameset', 'textarea', 'select',
  'button', 'option', 'math',
]);

/** Elements whose content is raw text, so `<` inside them is never a tag. */
const RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);

/** Elements that never have children and never take an end tag. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'col', 'wbr']);

/** Attributes allowed on any kept element. */
const GLOBAL_ATTRS: ReadonlySet<string> = new Set(['title', 'alt', 'width', 'height', 'style']);

/** Attributes allowed only on a specific element (URL-bearing, so tag-scoped). */
const TAG_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href']),
  img: new Set(['src']),
};

/** URL schemes a stored `href`/`src` may name. Anything else is dropped. */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'cid']);

/**
 * Style declarations we keep: colour, font/text presentation and alignment.
 * Anything that positions, sizes, floats or fetches is out — an email must not
 * escape its own frame in the reader's UI.
 */
const ALLOWED_STYLE_PROPS: ReadonlySet<string> = new Set([
  'color', 'background-color',
  'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-decoration', 'text-decoration-line', 'text-indent',
  'text-transform', 'vertical-align', 'white-space', 'direction',
]);

/** A named/numeric entity already written correctly; left untouched on output. */
const ENTITY_RX = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

/**
 * Whitespace plus the invisible characters attackers hide inside URLs and CSS:
 * C0/C1 controls, NBSP, the Unicode spaces/joiners and the BOM. Removing them
 * before a scheme or value check is what defeats `jav\tascript:`.
 */
const STRIPPABLE_RX =
  /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

interface Attr {
  name: string;
  value: string;
}

/** Escape text content, leaving already-valid entities alone (no double-escape). */
function escapeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '<') {
      out += '&lt;';
    } else if (ch === '>') {
      out += '&gt;';
    } else if (ch === '&') {
      const m = ENTITY_RX.exec(text.slice(i, i + 40));
      if (m && m.index === 0) {
        out += m[0];
        i += m[0].length - 1;
      } else {
        out += '&amp;';
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** The named entities that matter once a value is being judged, not displayed. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  tab: '\t', newline: '\n', colon: ':', sol: '/', lpar: '(', rpar: ')',
};

/** Decode entities so obfuscated URLs and CSS are judged in their real form. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g,
    (whole: string, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return '';
          }
        }
        return '';
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

/** Re-encode an attribute value for output; input is already entity-decoded. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A URL is safe when it names no scheme (relative, anchor, protocol-relative) or
 * names an allowlisted one. Whitespace, controls and entities come out first,
 * because `&#106;avascript:` and `jav\tascript:` are what a browser actually runs.
 */
function safeUrl(rawValue: string): string | null {
  const decoded = decodeEntities(rawValue);
  const probe = decoded.replace(STRIPPABLE_RX, '');
  if (probe === '') return null;
  const colon = probe.indexOf(':');
  if (colon > 0) {
    const scheme = probe.slice(0, colon);
    // Only a syntactically valid scheme is a scheme, and only before any path
    // separator — `photos/a:b.png` is a relative path, not a `photos` URL.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) {
      const firstSep = probe.search(/[/?#]/);
      const isScheme = firstSep === -1 || colon < firstSep;
      if (isScheme && !ALLOWED_SCHEMES.has(scheme.toLowerCase())) return null;
    }
  }
  return decoded.trim();
}

/**
 * Filter a `style` attribute down to the presentational declarations, dropping
 * any value that fetches (`url(...)`), computes (`expression(...)`) or smuggles
 * a comment. Returns null when nothing survives, so the attribute disappears.
 */
function filterStyle(rawValue: string): string | null {
  const decoded = decodeEntities(rawValue);
  // A CSS comment can split a property name past a naive scan; neutralize it.
  const source = decoded.replace(/\/\*[\s\S]*?(\*\/|$)/g, ';');
  const kept: string[] = [];
  for (const declaration of source.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (value === '' || !ALLOWED_STYLE_PROPS.has(prop)) continue;
    const probe = value.replace(STRIPPABLE_RX, '').toLowerCase();
    if (
      probe.includes('url(') ||
      probe.includes('expression(') ||
      probe.includes('javascript:') ||
      probe.includes('vbscript:') ||
      probe.includes('@import') ||
      // A CSS escape (`\75 rl(`) is only ever an attempt to hide one of the above.
      probe.includes('\\') ||
      probe.includes('<')
    ) {
      continue;
    }
    kept.push(`${prop}:${value}`);
  }
  return kept.length > 0 ? kept.join(';') : null;
}

/** Keep, rewrite or drop one attribute of a kept element. */
function filterAttr(tag: string, attr: Attr): Attr | null {
  const name = attr.name;
  // Event handlers go first, before any allowlist lookup can be talked around.
  if (name.startsWith('on')) return null;
  const tagScoped = TAG_ATTRS[tag];
  if (!GLOBAL_ATTRS.has(name) && !(tagScoped?.has(name) ?? false)) return null;

  if (name === 'href' || name === 'src') {
    const url = safeUrl(attr.value);
    return url === null ? null : { name, value: url };
  }
  if (name === 'style') {
    const style = filterStyle(attr.value);
    return style === null ? null : { name, value: style };
  }
  return { name, value: decodeEntities(attr.value) };
}

interface ParsedTag {
  name: string;
  attrs: Attr[];
  selfClosing: boolean;
  /** Index just past the closing `>` (or end of input for a truncated tag). */
  end: number;
}

/** Parse a start tag's attributes; `from` sits just after the tag name. */
function parseAttrs(html: string, from: number, name: string): ParsedTag {
  const attrs: Attr[] = [];
  let i = from;
  let selfClosing = false;
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i] as string)) i++;
    if (i >= html.length) break;
    if (html[i] === '>') {
      i++;
      break;
    }
    if (html[i] === '/') {
      selfClosing = true;
      i++;
      continue;
    }
    const nameStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i] as string)) i++;
    const attrName = html.slice(nameStart, i).toLowerCase();
    while (i < html.length && /\s/.test(html[i] as string)) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i] as string)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        i++;
        const close = html.indexOf(quote, i);
        value = close === -1 ? html.slice(i) : html.slice(i, close);
        i = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !/[\s>]/.test(html[i] as string)) i++;
        value = html.slice(valueStart, i);
        if (value.endsWith('/')) {
          // `<img src=x/>` — read the slash as the tag's, not the value's.
          selfClosing = true;
          value = value.slice(0, -1);
        }
      }
    }
    // An empty name happens on junk like `<p ="v">`; the value is still consumed,
    // so the scanner always advances and malformed input cannot loop.
    if (attrName !== '') attrs.push({ name: attrName, value });
  }
  return { name, attrs, selfClosing, end: i };
}

/** Index of a raw-text element's end tag (or end of input when it never closes). */
function skipRawText(html: string, from: number, name: string): number {
  const rx = new RegExp(`</\\s*${name}\\b`, 'i');
  const m = rx.exec(html.slice(from));
  return m ? from + m.index : html.length;
}

/**
 * Whether the sanitized markup carries anything worth storing: visible text, or
 * an element that renders on its own (an image-only email is a real email).
 */
function hasContent(html: string): boolean {
  if (/<img\b/i.test(html)) return true;
  const text = decodeEntities(html.replace(/<[^>]*>/g, ''));
  return text.replace(STRIPPABLE_RX, '') !== '';
}

/** Sanitize an inbound HTML body ONCE at ingest; null when nothing survives. */
export function sanitizeEmailHtml(html: string): string | null {
  if (typeof html !== 'string' || html === '') return null;

  const out: string[] = [];
  /** Elements we have emitted an open tag for, innermost last. */
  const open: string[] = [];
  /** The subtree being discarded, with its nesting depth. */
  let dropping: { name: string; depth: number } | null = null;

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (!dropping) out.push(escapeText(html.slice(i)));
      break;
    }
    if (lt > i && !dropping) out.push(escapeText(html.slice(i, lt)));

    const next = html[lt + 1];

    // Comments, doctypes, CDATA and processing instructions: dropped whole.
    if (next === '!' || next === '?') {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        i = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf('>', lt + 1);
        i = close === -1 ? html.length : close + 1;
      }
      continue;
    }

    const isEnd = next === '/';
    const nameStart = lt + (isEnd ? 2 : 1);
    let j = nameStart;
    while (j < html.length && /[a-zA-Z0-9:_-]/.test(html[j] as string)) j++;
    const name = html.slice(nameStart, j).toLowerCase();
    if (name === '') {
      // A bare `<` (as in `1 < 2`) is text, not the start of a tag.
      if (!dropping) out.push('&lt;');
      i = lt + 1;
      continue;
    }

    if (isEnd) {
      const close = html.indexOf('>', j);
      i = close === -1 ? html.length : close + 1;
      if (dropping) {
        if (name === dropping.name && --dropping.depth <= 0) dropping = null;
        continue;
      }
      const at = open.lastIndexOf(name);
      if (at !== -1) {
        // Close whatever the sender left open inside this element as well.
        for (let k = open.length - 1; k >= at; k--) out.push(`</${open[k]}>`);
        open.length = at;
      }
      continue;
    }

    const tag = parseAttrs(html, j, name);
    i = tag.end;

    if (dropping) {
      // Count nesting so `<object><object>x</object>y</object>` closes correctly.
      if (name === dropping.name && !tag.selfClosing) dropping.depth += 1;
      if (RAW_TEXT.has(name)) i = skipRawText(html, i, name);
      continue;
    }

    if (DROP_SUBTREE.has(name)) {
      if (RAW_TEXT.has(name)) {
        i = skipRawText(html, i, name);
      } else if (!tag.selfClosing) {
        dropping = { name, depth: 1 };
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) continue; // wrapper dropped, children kept

    const attrs: string[] = [];
    const seen = new Set<string>();
    for (const attr of tag.attrs) {
      if (seen.has(attr.name)) continue;
      const kept = filterAttr(name, attr);
      if (!kept) continue;
      seen.add(attr.name);
      attrs.push(` ${kept.name}="${escapeAttr(kept.value)}"`);
    }
    out.push(`<${name}${attrs.join('')}>`);
    if (!VOID_TAGS.has(name) && !tag.selfClosing) open.push(name);
  }

  for (let k = open.length - 1; k >= 0; k--) out.push(`</${open[k]}>`);

  const result = out.join('').trim();
  return hasContent(result) ? result : null;
}
