import { useState } from 'react';

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

/** Small button that copies `value` to the clipboard and confirms briefly. */
export function CopyButton({ value, label = 'Copy', className = '' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for environments without the async clipboard API.
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`shrink-0 rounded-md border px-2.5 py-1 text-xs transition-colors ${
        copied
          ? 'border-[var(--sparrow-accent-2)] text-[var(--sparrow-accent)]'
          : 'border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] text-[var(--sparrow-muted)] hover:border-[var(--sparrow-accent-2)] hover:text-[var(--sparrow-text)]'
      } ${className}`}
      aria-label={label}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
