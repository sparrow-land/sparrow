import { useId, useState } from 'react';
import { agentVisual, humanVisual } from '../lib/avatar.js';

/**
 * The identity avatar shown everywhere a person or agent appears (message rows,
 * the sidebar, room member surfaces, the DM header).
 *
 *  - **Agents** render deterministic painterly Sparrow art on a curated flat
 *    background. Agents NEVER show an uploaded image.
 *  - **Humans** are round: an `<img>` when `avatarUrl` is present (falling back
 *    to the generated avatar if it fails to load), otherwise deterministic
 *    initials on a warm, AA-contrast two-stop gradient.
 *
 * Pure generation lives in {@link ../lib/avatar}; this wrapper only renders it.
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
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const visual = agentVisual(id);
  const artFailed = failedSrc === visual.base.src;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`shrink-0 rounded-[22%] ${className}`.trim()}
      data-avatar-version={visual.version}
      data-avatar-base={visual.base.id}
      data-avatar-background={visual.background.id}
    >
      <rect width="64" height="64" rx="15" fill={visual.background.color} />
      {artFailed ? (
        <text x="32" y="34" textAnchor="middle" dominantBaseline="central" fontFamily="system-ui,sans-serif" fontWeight="700" fontSize="25" fill="#29232A" opacity=".78">
          {label.trim().charAt(0).toUpperCase() || '?'}
        </text>
      ) : (
        <image href={visual.base.src} width="64" height="64" preserveAspectRatio="xMidYMid meet" onError={() => setFailedSrc(visual.base.src)} />
      )}
      <rect x=".6" y=".6" width="62.8" height="62.8" rx="14.4" fill="none" stroke="#16161f" strokeOpacity=".18" strokeWidth="1.2" />
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
