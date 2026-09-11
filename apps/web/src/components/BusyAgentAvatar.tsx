import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { agentVisual } from '../lib/avatar.js';
import { Avatar } from './Avatar.js';
import './BusyAgentAvatar.css';

const motionQuery = '(prefers-reduced-motion: reduce)';
const visibilitySubscribers = new Set<() => void>();
const motionSubscribers = new Set<() => void>();
let removeVisibilityListener: (() => void) | null = null;
let removeMotionListener: (() => void) | null = null;

function subscribePageVisibility(notify: () => void) {
  visibilitySubscribers.add(notify);
  if (!removeVisibilityListener) {
    const broadcast = () => visibilitySubscribers.forEach((subscriber) => subscriber());
    document.addEventListener('visibilitychange', broadcast);
    removeVisibilityListener = () => document.removeEventListener('visibilitychange', broadcast);
  }
  return () => {
    visibilitySubscribers.delete(notify);
    if (visibilitySubscribers.size === 0) {
      removeVisibilityListener?.();
      removeVisibilityListener = null;
    }
  };
}

function subscribeReducedMotion(notify: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  motionSubscribers.add(notify);
  if (!removeMotionListener) {
    const query = window.matchMedia(motionQuery);
    const broadcast = () => motionSubscribers.forEach((subscriber) => subscriber());
    query.addEventListener('change', broadcast);
    removeMotionListener = () => query.removeEventListener('change', broadcast);
  }
  return () => {
    motionSubscribers.delete(notify);
    if (motionSubscribers.size === 0) {
      removeMotionListener?.();
      removeMotionListener = null;
    }
  };
}

function usePageVisible() {
  return useSyncExternalStore(
    subscribePageVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => typeof window.matchMedia === 'function' && window.matchMedia(motionQuery).matches,
    () => true,
  );
}

export interface BusyAgentAvatarProps {
  id: string;
  displayName: string;
  size: number;
  busy: boolean;
}

export function BusyAgentAvatar({ id, displayName, size, busy }: BusyAgentAvatarProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [onscreen, setOnscreen] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const pageVisible = usePageVisible();
  const reducedMotion = useReducedMotion();
  const visual = agentVisual(id);
  const spriteSrc = `/avatars/sparrow-v2/motion/${visual.base.id}.webp`;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === 'undefined') {
      setOnscreen(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setOnscreen(entry?.isIntersecting ?? false));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const shouldLoad = busy && onscreen && pageVisible && !reducedMotion && failedSrc !== spriteSrc;
  useEffect(() => {
    if (!shouldLoad || loadedSrc === spriteSrc) return;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => setLoadedSrc(spriteSrc);
    image.onerror = () => setFailedSrc(spriteSrc);
    image.src = spriteSrc;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [loadedSrc, shouldLoad, spriteSrc]);

  const moving = shouldLoad && loadedSrc === spriteSrc;
  return (
    <span
      ref={rootRef}
      className="busy-agent-avatar"
      style={{ width: size, height: size }}
      data-moving={moving}
      data-sprite-state={failedSrc === spriteSrc ? 'failed' : loadedSrc === spriteSrc ? 'ready' : 'static'}
    >
      <span className="busy-agent-avatar__still">
        <Avatar kind="agent" id={id} displayName={displayName} size={size} />
      </span>
      {loadedSrc === spriteSrc && (
        <span
          aria-hidden="true"
          className="busy-agent-avatar__sprite"
          style={{
            backgroundColor: visual.background.color,
            '--busy-avatar-sprite': `url("${spriteSrc}")`,
          } as CSSProperties}
        />
      )}
    </span>
  );
}
