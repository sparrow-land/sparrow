import { useId } from 'react';

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
 * The sparrow logomark: a gradient songbird (warm gold → orange → magenta) on a
 * dark rounded tile. Colors are baked into the mark, so it reads consistently on
 * any surface and stays crisp from 16px favicons to large hero art. The gradient
 * id is namespaced with `useId` so several instances on one page never collide.
 */
export function Mark({ size = 24, className = '' }: MarkProps) {
  const gid = `sparrow-mark-${useId().replace(/[:]/g, '')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2c14e" />
          <stop offset=".5" stopColor="#e8703a" />
          <stop offset="1" stopColor="#c8456b" />
        </linearGradient>
      </defs>
      {/* dark rounded tile */}
      <rect width="64" height="64" rx="15" fill="#16161f" />
      {/* songbird body (beak integrated as the leading point) */}
      <path
        fill={`url(#${gid})`}
        d={SONGBIRD_PATH}
      />
      {/* folded-wing overlay */}
      <path
        fill="#12121a"
        opacity=".18"
        d="M24 29 C30 26 39 28 44 34 C41 39 33 41 27 38 C25 35 24 32 24 29 Z"
      />
      {/* eye */}
      <circle cx="21" cy="29" r="2.1" fill="#12121a" />
      {/* legs */}
      <line x1="24" y1="46" x2="22" y2="55" stroke="#e8703a" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="31" y1="47" x2="31" y2="56" stroke="#e8703a" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
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

/** sparrow logomark (songbird mark) + lowercase "sparrow" wordmark. */
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
