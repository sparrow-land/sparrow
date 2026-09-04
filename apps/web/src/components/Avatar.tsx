import { useId, useState } from 'react';
import { agentVisual, humanVisual } from '../lib/avatar.js';

/**
 * The identity avatar shown everywhere a person or agent appears (message rows,
 * the sidebar, room member surfaces, the DM header).
 *
 *  - **Agents** render a deterministic procedural songbird — the brand mark
 *    recoloured by a continuous per-id hue as a 3-stop gradient, with a subtle
 *    pose flip, on a dark rounded-square tile with a faint rim (so the tile
 *    still reads on dark chat surfaces). Agents NEVER show an uploaded image.
 *  - **Humans** are round: an `<img>` when `avatarUrl` is present (falling back
 *    to the generated avatar if it fails to load), otherwise deterministic
 *    initials on a warm, AA-contrast two-stop gradient.
 *
 * Pure generation lives in {@link ../lib/avatar}; this wrapper only turns that
 * data into SVG and namespaces the gradient id per instance with `useId`.
 */
export interface AvatarProps {
  kind: 'human' | 'agent';
  /** Stable identity — the principal id (agents/humans) drives colour + pose. */
  id: string;
  displayName: string;
  /** Human image URL (ignored for agents); `null`/absent → generated fallback. */
  avatarUrl?: string | null;
  /** Rendered pixel size (square). Defaults to a chat-row 28px. */
  size?: number;
  className?: string;
}

export function Avatar({ kind, id, displayName, avatarUrl, size = 28, className = '' }: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);

  if (kind === 'agent') {
    return <AgentMark id={id} label={displayName} size={size} className={className} />;
  }

  const url = typeof avatarUrl === 'string' && avatarUrl.length > 0 ? avatarUrl : null;
  if (url && !imgFailed) {
    return (
      <img
        src={url}
        alt={displayName}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setImgFailed(true)}
        className={`shrink-0 rounded-full object-cover ${className}`.trim()}
        style={{ width: size, height: size }}
      />
    );
  }
  return <HumanInitials id={id} displayName={displayName} size={size} className={className} />;
}

/* -------------------------------------------------------------------------- */

const BIRD_BODY =
  'M4 30 L14 27 C15 20 27 17 31 25 C39 23 46 27 46 34 L56 40 L48 41 L52 47 L44 42 C41 45 36 46 29 46 C21 46 15 42 13 37 C13 35 13 34 14 33 Z';
const BIRD_WING = 'M24 29 C30 26 39 28 44 34 C41 39 33 41 27 38 C25 35 24 32 24 29 Z';

function AgentMark({
  id,
  label,
  size,
  className,
}: {
  id: string;
  label: string;
  size: number;
  className: string;
}) {
  const gid = `av-agent-${useId().replace(/:/g, '')}`;
  const {
    stops: [s1, s2, s3],
    flip,
  } = agentVisual(id);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`shrink-0 ${className}`.trim()}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={s1} />
          <stop offset=".5" stopColor={s2} />
          <stop offset="1" stopColor={s3} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="#16161f" />
      {/* Faint rim so the dark tile still reads on dark chat backgrounds. */}
      <rect x=".6" y=".6" width="62.8" height="62.8" rx="14.6" fill="none" stroke="#f3ede1" strokeOpacity=".11" />
      <g transform={flip ? 'translate(64,0) scale(-1,1)' : undefined}>
        <path fill={`url(#${gid})`} d={BIRD_BODY} />
        <path fill="#12121a" opacity=".18" d={BIRD_WING} />
        <circle cx="21" cy="29" r="2.1" fill="#12121a" />
        <line x1="24" y1="46" x2="22" y2="55" stroke={s2} strokeWidth="2.2" strokeLinecap="round" />
        <line x1="31" y1="47" x2="31" y2="56" stroke={s2} strokeWidth="2.2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function HumanInitials({
  id,
  displayName,
  size,
  className,
}: {
  id: string;
  displayName: string;
  size: number;
  className: string;
}) {
  const gid = `av-human-${useId().replace(/:/g, '')}`;
  const { top, bottom, initials, fontSize, ink } = humanVisual(id, displayName);
  return (
    <svg
      role="img"
      aria-label={displayName}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`shrink-0 ${className}`.trim()}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="32" fill={`url(#${gid})`} />
      <text
        x="32"
        y="34"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
        fontWeight="600"
        fontSize={fontSize}
        fill={ink}
      >
        {initials}
      </text>
    </svg>
  );
}
