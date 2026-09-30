import type { ReactNode } from 'react';

/**
 * One org-visible agent tag, rendered `#cubes` in the small mono chip the
 * header and the Access tab's editor share. `children` adds trailing content
 * (the editor's remove button).
 */
export function TagChip({ tag, children }: { tag: string; children?: ReactNode }) {
  return (
    <span className="mono inline-flex items-center gap-0.5 rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-1.5 text-[11px] leading-[18px] text-[var(--sparrow-muted)]">
      <span aria-hidden="true" className="text-[var(--sparrow-faint)]">
        #
      </span>
      <span>{tag}</span>
      {children}
    </span>
  );
}

/** The header's tag chips — everyone in the org who can see the agent sees them. */
export function TagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className="inline-flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <li key={t}>
          <TagChip tag={t} />
        </li>
      ))}
    </ul>
  );
}
