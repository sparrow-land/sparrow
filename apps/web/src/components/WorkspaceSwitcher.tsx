import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import {
  WorkspaceDirectoryResponseSchema,
  type WorkspaceDirectoryEntry,
  type WorkspaceSwitcher as WorkspaceSwitcherConfig,
} from '@sparrow/common-types';

/**
 * The cloud-injectable workspace switcher (leftnav org header, button variant).
 *
 * A plain self-hosted instance has NO switcher (capabilities.workspaceSwitcher is
 * null) — the header is a static label instead (see AppShell). When the instance
 * advertises a directory service, the org name becomes this button: opening it
 * fetches the caller's workspaces browser-side from `config.directoryUrl` (with
 * credentials) and lists them. The current workspace (matched by URL host) is
 * checked and non-navigating; the others navigate on click. A "Create a
 * workspace" action appears only when `config.createUrl` is set.
 *
 * The fetch runs ON OPEN, never on mount — the switcher adds zero network cost to
 * a normal page view. On any fetch failure (network / 401 / CORS) the popover
 * degrades to the current name plus a single "Manage workspaces" link to the
 * directory service's origin, rather than a broken/empty list.
 */

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; items: WorkspaceDirectoryEntry[] }
  | { status: 'error' };

/** The directory service's origin, for the failure-fallback link. Best-effort. */
function directoryOrigin(directoryUrl: string): string {
  try {
    return new URL(directoryUrl).origin;
  } catch {
    return directoryUrl;
  }
}

/** Whether a workspace URL points at the host we're currently on. */
function isCurrentHost(url: string): boolean {
  try {
    return new URL(url).host === window.location.host;
  } catch {
    return false;
  }
}

export function WorkspaceSwitcher({
  orgName,
  config,
}: {
  orgName: string;
  config: WorkspaceSwitcherConfig;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await fetch(config.directoryUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const parsed = WorkspaceDirectoryResponseSchema.parse(body);
      setState({ status: 'ready', items: parsed.items });
    } catch {
      setState({ status: 'error' });
    }
  }, [config.directoryUrl]);

  // Fetch ON OPEN (once per open), never on mount.
  useEffect(() => {
    if (open && state.status === 'idle') void load();
  }, [open, state.status, load]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-[var(--sparrow-text)] transition-colors hover:bg-[var(--sparrow-panel-2)]"
      >
        <span className="min-w-0 flex-1 truncate">{orgName}</span>
        <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-[var(--sparrow-muted)]" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Switch workspace"
          className="absolute left-2 right-2 z-50 mt-1 rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel)] py-1 shadow-lg"
        >
          {state.status === 'loading' && (
            <p className="px-3 py-2 text-xs text-[var(--sparrow-faint)]">Loading…</p>
          )}

          {state.status === 'error' && (
            <div className="px-3 py-2">
              <p className="truncate text-sm text-[var(--sparrow-text)]">{orgName}</p>
              <a
                href={directoryOrigin(config.directoryUrl)}
                className="mt-1 inline-block text-xs text-[var(--sparrow-accent)] hover:underline"
              >
                Manage workspaces
              </a>
            </div>
          )}

          {state.status === 'ready' &&
            state.items.map((item) => {
              const current = isCurrentHost(item.url);
              return current ? (
                <div
                  key={item.slug}
                  role="menuitemradio"
                  aria-checked="true"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--sparrow-text)]"
                >
                  <Check size={14} aria-hidden="true" className="shrink-0 text-[var(--sparrow-accent)]" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                </div>
              ) : (
                <button
                  key={item.slug}
                  type="button"
                  role="menuitemradio"
                  aria-checked="false"
                  onClick={() => window.location.assign(item.url)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--sparrow-muted)] transition-colors hover:bg-[var(--sparrow-panel-2)] hover:text-[var(--sparrow-text)]"
                >
                  <span className="w-[14px] shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                </button>
              );
            })}

          {state.status === 'ready' && config.createUrl && (
            <>
              <div
                role="separator"
                className="my-1 border-t border-[var(--sparrow-border)]"
              />
              <button
                type="button"
                role="menuitem"
                onClick={() => window.location.assign(config.createUrl!)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--sparrow-muted)] transition-colors hover:bg-[var(--sparrow-panel-2)] hover:text-[var(--sparrow-text)]"
              >
                <Plus size={14} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">Create a workspace</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
