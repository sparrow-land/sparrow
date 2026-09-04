import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { ApiError } from '@sparrow/client';

/**
 * The org-admin page's shared presentation kit. Extracted from `OrgSettings.tsx`
 * unchanged so the page's subsections can live in their own files (Email policy,
 * the org-wide email approvals, Contacts) and still look like one panel: the
 * anchored `Section`, the hairline `Panel`, the button/input classes, the saved
 * tick, and the plain-language error helper.
 */

/** An anchored subsection with a heading + optional lead paragraph. */
export function Section({
  id,
  title,
  lead,
  aside,
  children,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--sparrow-accent)]">
          {title}
        </h2>
        {aside}
      </div>
      {lead && <p className="mt-1.5 text-sm text-[var(--sparrow-muted)]">{lead}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-4 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function Notice({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5 text-sm text-[var(--sparrow-muted)] ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export const inputClass =
  'w-full rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm text-[var(--sparrow-text)] outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]';

export const primaryBtn =
  'rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50';

export const ghostBtn =
  'rounded-md border border-[var(--sparrow-border)] px-3 py-1.5 text-xs text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-border-strong)] hover:text-[var(--sparrow-text)] disabled:opacity-50';

export function Saved() {
  return (
    <span className="text-sm text-[var(--sparrow-good)]" role="status">
      <Check size={14} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline align-[-2px]" />
      Saved
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--sparrow-danger)]">{children}</p>;
}

export function Loading() {
  return <p className="text-sm text-[var(--sparrow-faint)]">Loading…</p>;
}

export function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function PolicyRadio({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--sparrow-text)]">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 accent-[var(--sparrow-accent)]"
      />
      <span>
        {label}
        {hint && <span className="mt-0.5 block text-xs text-[var(--sparrow-faint)]">{hint}</span>}
      </span>
    </label>
  );
}

export function PolicyGroup({
  label,
  help,
  plain = false,
  children,
}: {
  label: string;
  /** Plain-language help under the group's own label. */
  help?: ReactNode;
  /**
   * Sentence-length labels ("Email from people we don't recognize") read as a
   * question, not a field name — so they render sentence-case rather than in the
   * uppercase micro-label style the short v3 groups use.
   */
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="radiogroup" aria-label={label}>
      <p
        className={
          plain
            ? 'mb-2 text-sm font-medium text-[var(--sparrow-text)]'
            : 'mb-2 text-xs uppercase tracking-wider text-[var(--sparrow-faint)]'
        }
      >
        {label}
      </p>
      {help && <p className="-mt-1 mb-2 text-xs text-[var(--sparrow-muted)]">{help}</p>}
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
