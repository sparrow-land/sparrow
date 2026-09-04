/**
 * ONE landmark id for the whole app's main content, and the link that jumps to
 * it. Every chrome — the org {@link AppShell}, the org-less {@link BareShell},
 * the marketing/auth {@link SiteHeader}, and the docs layout — puts
 * {@link MAIN_CONTENT_ID} on its outermost `<main>` and renders
 * {@link SkipLink} as its FIRST tabbable element.
 *
 * Without it, a keyboard or screen-reader user re-tabbed the entire sidebar —
 * every human, every agent, every room — before reaching the conversation, on
 * every single navigation.
 */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Visually hidden until focused, then a real, visible control at the top-left —
 * the convention, and the only way the affordance is discoverable at all (a
 * skip link nobody can see focus is a skip link nobody uses).
 *
 * The target carries `tabIndex={-1}` so the jump moves FOCUS and not merely the
 * scroll position; without it the next Tab would resume from the link, which is
 * exactly the sidebar the reader just skipped.
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only rounded-md focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:border focus:border-[var(--sparrow-accent)] focus:bg-[var(--sparrow-panel)] focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--sparrow-accent)]"
    >
      Skip to content
    </a>
  );
}
