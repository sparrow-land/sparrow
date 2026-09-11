/**
 * The songbird body outline (beak integrated as the leading point), in the
 * mark's 64×64 space. Exported so other art (see {@link LoopModeArt}) draws the
 * SAME bird rather than a lookalike.
 */
export const SONGBIRD_PATH =
  'M4 30 L14 27 C15 20 27 17 31 25 C39 23 46 27 46 34 L56 40 L48 41 L52 47 L44 42 C41 45 36 46 29 46 C21 46 15 42 13 37 C13 35 13 34 14 33 Z';

interface MarkProps {
  size?: number;
  className?: string;
  /**
   * Retained for API compatibility with the previous stroke-based mark. The
   * songbird mark is filled (not stroked), so this value is ignored; call sites
   * that still pass it continue to compile.
   */
  strokeWidth?: number;
}

/**
 * The canonical sparrow logomark. Keeping the geometry in a public brand asset
 * gives the app, website, and downloadable artwork one source of truth.
 */
export function Mark({ size = 24, className = '' }: MarkProps) {
  return (
    <img
      src="/brand/sparrow-icon.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={className}
    />
  );
}

interface GearProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

/**
 * A settings/config gear glyph — used purely as a UI affordance for per-room
 * and per-agent settings links, never as branding. Stroke-based, `currentColor`.
 */
export function Gear({ size = 24, className = '', strokeWidth = 1.9 }: GearProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {/* gear body + hub */}
      <circle cx="12" cy="12" r="5.3" />
      <circle cx="12" cy="12" r="1.9" />
      {/* eight teeth on the rim */}
      <line x1="17.2" y1="12" x2="19.8" y2="12" />
      <line x1="15.68" y1="15.68" x2="17.51" y2="17.51" />
      <line x1="12" y1="17.2" x2="12" y2="19.8" />
      <line x1="8.32" y1="15.68" x2="6.49" y2="17.51" />
      <line x1="6.8" y1="12" x2="4.2" y2="12" />
      <line x1="8.32" y1="8.32" x2="6.49" y2="6.49" />
      <line x1="12" y1="6.8" x2="12" y2="4.2" />
      <line x1="15.68" y1="8.32" x2="17.51" y2="6.49" />
    </svg>
  );
}

interface LogoProps {
  size?: number;
  className?: string;
  /** Hide the "sparrow" wordmark, showing only the mark. */
  markOnly?: boolean;
}

/** sparrow logomark + lowercase "sparrow" wordmark. */
export function Logo({ size = 22, className = '', markOnly = false }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <Mark size={size} />
      {!markOnly && (
        <span className="text-[1.05rem] font-semibold tracking-tight text-[var(--sparrow-text)]">
          sparrow
        </span>
      )}
    </span>
  );
}
