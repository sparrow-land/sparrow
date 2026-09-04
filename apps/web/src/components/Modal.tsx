import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * A small accessible modal dialog: portalled to the body, backdrop + Escape
 * close, focus moved in on mount and restored on unmount, and a Tab focus trap.
 * Design-system framed (copper hairline, slate panel).
 */
export function Modal({
  title,
  onClose,
  children,
  labelledById,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  labelledById?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Whatever opened us, captured during the FIRST RENDER. A `useState`
  // initializer runs before React commits anything, which is the only moment
  // the opener is still the focused element: React applies a child's
  // `autoFocus` during commit, so an effect reading `document.activeElement`
  // (as this did) recorded the dialog's own input instead — and since that
  // input is gone by the time the dialog closes, the restore was skipped and
  // focus was stranded on `body` for exactly the dialogs that autofocus,
  // Create-a-room and Add-people (issue #56).
  const [opener] = useState<Element | null>(() => document.activeElement);

  useEffect(() => {
    const dialog = dialogRef.current;
    // Move focus in — unless a child already claimed it via `autoFocus`, whose
    // whole point is to put the caret in the first field.
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    return () => {
      // The opener gets focus back on close (Escape, backdrop, X or an unmount
      // by the host). Guard the restore: it can be gone or detached by then (a
      // row that re-rendered away), and focusing a detached node throws in some
      // engines and silently strands focus on `body` in others — so only a
      // still-connected, focusable element is restored to.
      if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
        opener.focus();
      }
    };
  }, [opener]);

  function focusables(): HTMLElement[] {
    const root = dialogRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled'));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const els = focusables();
    if (els.length === 0) {
      e.preventDefault();
      return;
    }
    const first = els[0]!;
    const last = els[els.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-16 sm:py-24">
      <div
        data-testid="modal-backdrop"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative w-full max-w-lg rounded-xl border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel)] shadow-[0_0_0_1px_rgba(211,146,75,0.06),0_24px_70px_-18px_rgba(0,0,0,0.85)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--sparrow-border)] px-5 py-3.5">
          <h2 id={labelledById} className="text-sm font-semibold">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-1.5 py-0.5 text-sm text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
