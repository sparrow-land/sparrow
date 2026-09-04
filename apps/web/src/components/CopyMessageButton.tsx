import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';

/** How long the button says "Copied" before reverting. */
const COPIED_MS = 1500;

/** Does this browser expose an async clipboard we can write through? */
export function hasClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.clipboard != null &&
    typeof navigator.clipboard.writeText === 'function'
  );
}

/**
 * Put a message on the clipboard in up to two flavors.
 *
 *   text/plain — ALWAYS the source the message was authored in (markdown for
 *                chat, the plain part for email). Pasting into an editor, a
 *                terminal or another chat must round-trip the original, never
 *                the flattened render.
 *   text/html  — the rendered bubble, when the platform can carry a second
 *                flavor, so rich editors (docs, mail composers) keep the
 *                formatting.
 *
 * Every failure path is soft: a browser without `ClipboardItem` gets plain
 * text, a rejected rich write retries as plain text, and a denied permission
 * simply returns false (the caller shows no confirmation). Nothing throws.
 */
export async function copyMessage(text: string, html: string | null): Promise<boolean> {
  if (!hasClipboard()) return false;
  const clipboard = navigator.clipboard;
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;

  if (html && Item && typeof clipboard.write === 'function') {
    try {
      await clipboard.write([
        new Item({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return true;
    } catch {
      // Safari/Firefox may refuse a multi-flavor write; plain text still works.
    }
  }

  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyMessageButtonProps {
  /** The ORIGINAL source to place on the clipboard (markdown, not the render). */
  text: string;
  /** Rendered HTML for the rich flavor, read at click time from the live DOM. */
  getHtml?: () => string | null;
  label?: string;
  className?: string;
}

/**
 * The small copy affordance that rides on a message bubble (Jake, 2026-09-02:
 * "it would be great if there was an actual copy button on the chat bubble").
 *
 * It is quiet by default and reveals itself on hover/focus of the bubble at
 * desktop widths; on narrow/touch layouts, where there is no hover, it stays
 * visible — the same rule the sidebar's row actions already follow. Space is
 * reserved either way, so revealing it never reflows the bubble.
 *
 * Clicking must not disturb the composer: the button suppresses the default
 * mousedown focus, so the caret stays where the reader left it. It is still
 * reachable (and focusable) by keyboard.
 *
 * If the browser has no clipboard API at all the button does not render —
 * better absent than present-and-dead.
 */
export function CopyMessageButton({
  text,
  getHtml,
  label = 'Copy message',
  className = '',
}: CopyMessageButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!hasClipboard()) return null;

  async function onClick() {
    const ok = await copyMessage(text, getHtml?.() ?? null);
    if (!ok || !alive.current) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (alive.current) setCopied(false);
    }, COPIED_MS);
  }

  return (
    <button
      type="button"
      // Keep the composer's caret: a click copies without taking focus.
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
      onClick={() => void onClick()}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={`shrink-0 rounded p-1 text-[var(--sparrow-faint)] opacity-100 transition-opacity hover:text-[var(--sparrow-accent)] motion-reduce:transition-none md:opacity-0 md:focus-visible:opacity-100 md:group-focus-within:opacity-100 md:group-hover:opacity-100 ${
        copied ? 'text-[var(--sparrow-good)] md:opacity-100' : ''
      } ${className}`}
    >
      {copied ? (
        <Check size={13} strokeWidth={2.5} aria-hidden="true" />
      ) : (
        <Copy size={13} aria-hidden="true" />
      )}
    </button>
  );
}
