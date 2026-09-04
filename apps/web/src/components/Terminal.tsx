import { CopyButton } from './CopyButton.js';

interface TerminalProps {
  /** Raw text shown in the block and placed on the clipboard by the copy button. */
  code: string;
  /** Optional label shown in the title bar (e.g. a filename or context). */
  label?: string;
  /**
   * Soft-wrap long lines instead of scrolling them sideways. Off by default —
   * a wrapped shell command reads as a broken one — but ON wherever the block
   * carries something a reader must be able to SEE WHOLE: prose (the invitation
   * blob) and anything containing an invite URL. A horizontal scrollbar there
   * does not merely look bad: the hidden tail is also missing from a copy made
   * by selecting the text, which is how a truncated invite URL got pasted
   * (issue #63). The copy button stays the exact route either way.
   */
  wrap?: boolean;
  className?: string;
}

/**
 * Signature terminal block: a traffic-light title bar with a copy button over
 * a monospace body. Used for every command / code example in the UI.
 */
export function Terminal({ code, label, wrap = false, className = '' }: TerminalProps) {
  return (
    <div className={`terminal ${className}`.trim()}>
      <div className="terminal-bar">
        <span className="terminal-dot" style={{ background: '#e0555b' }} />
        <span className="terminal-dot" style={{ background: '#d3924b' }} />
        <span className="terminal-dot" style={{ background: '#5bb98b' }} />
        {label && (
          <span className="mono ml-1 truncate text-xs text-[var(--sparrow-muted)]">{label}</span>
        )}
        <span className="ml-auto">
          <CopyButton value={code} />
        </span>
      </div>
      <pre className={`terminal-body${wrap ? ' terminal-wrap' : ''}`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
