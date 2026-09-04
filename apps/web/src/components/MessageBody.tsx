import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders a chat message body as real markdown blocks (GFM): paragraphs,
 * headings, pipe tables, nested lists, blockquotes, fenced code, inline
 * emphasis/code/strikethrough, and http(s)-only links (bare URLs autolink).
 *
 * Security invariants (pinned by MessageBody.test.tsx):
 *   - Rendering is done entirely via React elements — never
 *     `dangerouslySetInnerHTML` — so message text can never inject markup.
 *   - Raw HTML in the source is shown as literal text (no rehype-raw), never
 *     parsed into elements.
 *   - Only http(s) hrefs become anchors; javascript:, data:, mailto:, etc.
 *     render as inert text. Markdown images render as their alt text.
 *
 * Sizing is em-relative so the body inherits the bubble's text scale; single
 * newlines inside a paragraph still break lines (pre-wrap), matching chat
 * expectations, so parents no longer need `whitespace-pre-wrap`.
 */
export function MessageBody({ text }: { text: string }) {
  return (
    <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

const HTTP_URL = /^https?:\/\/\S/i;

function SafeLink({
  href,
  children,
}: ComponentPropsWithoutRef<'a'> & { node?: unknown }): ReactNode {
  // Only http(s) targets become live anchors; everything else (javascript:,
  // data:, mailto:, ftp:, …) stays visible but inert. react-markdown's default
  // urlTransform has already neutralized dangerous schemes to '' as a second
  // layer of defense.
  if (href != null && HTTP_URL.test(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--sparrow-accent)] underline"
      >
        {children}
      </a>
    );
  }
  return <span>{children}</span>;
}

const headingClass = 'my-1 mt-2 font-bold';

const components: Components = {
  a: SafeLink,
  // Images never load remote content inside a bubble — show the alt text.
  img: ({ alt }) => <span>{alt ?? ''}</span>,

  p: ({ children }) => <p className="my-1 whitespace-pre-wrap break-words">{children}</p>,

  h1: ({ children }) => <h1 className={`${headingClass} text-[1.15em]`}>{children}</h1>,
  h2: ({ children }) => <h2 className={`${headingClass} text-[1.1em]`}>{children}</h2>,
  h3: ({ children }) => <h3 className={`${headingClass} text-[1.05em]`}>{children}</h3>,
  h4: ({ children }) => <h4 className={headingClass}>{children}</h4>,
  h5: ({ children }) => <h5 className={headingClass}>{children}</h5>,
  h6: ({ children }) => <h6 className={headingClass}>{children}</h6>,

  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
  // NOT pre-wrap: an <li> with nested blocks carries structural "\n" text
  // nodes that pre-wrap would render as blank lines.
  li: ({ children }) => <li className="break-words">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-[var(--sparrow-border-strong)] pl-3 text-[var(--sparrow-muted)]">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-2 border-[var(--sparrow-border)]" />,

  // Inline code gets the pill look; inside <pre> those styles are stripped so
  // block code reads as one flat panel.
  code: ({ children }) => (
    <code className="mono rounded bg-[var(--sparrow-panel-2)] px-1 text-[0.9em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mono my-1 overflow-x-auto rounded bg-[var(--sparrow-panel-2)] px-2 py-1 text-[0.9em] [&_code]:rounded-none [&_code]:bg-transparent [&_code]:px-0 [&_code]:text-[1em]">
      {children}
    </pre>
  ),

  // Wide tables scroll inside the bubble instead of blowing it out.
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="border-collapse text-[0.95em]">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] px-2 py-1 text-left font-semibold"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-[var(--sparrow-border)] px-2 py-1 align-top">
      {children}
    </td>
  ),
};
