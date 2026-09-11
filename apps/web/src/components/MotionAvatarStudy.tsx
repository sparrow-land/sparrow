import { useState } from 'react';
import './MotionAvatarStudy.css';

export function MotionAvatarStudy({ busy, mode, size = 28, reducedMotion = false, paused = false }: {
  busy: boolean;
  mode: 'energetic' | 'calm' | 'hovering';
  size?: number;
  reducedMotion?: boolean;
  paused?: boolean;
}) {
  const [loaded, setLoaded] = useState({ body: false, wing: false, sprite: false });
  const [failed, setFailed] = useState(false);
  const ready = mode === 'hovering' ? loaded.sprite : loaded.body && loaded.wing;
  const moving = busy && !reducedMotion && !failed && ready;
  return (
    <span className="motion-avatar" role="img" aria-label={`Sparrow, ${busy ? 'busy' : 'idle'}`}
      data-moving={moving} data-mode={mode} data-paused={paused}
      style={{ width: size, height: size }}>
      <img className="motion-still" src="/avatars/sparrow-v2/base-3.webp" alt="" />
      <span className="motion-rig" aria-hidden="true">
        {mode === 'hovering' ? <>
          <img className="motion-preload" src="/avatars/motion-study/hover-sprites-v1.png" alt="" data-layer="sprite"
            onLoad={() => setLoaded((v) => ({ ...v, sprite: true }))} onError={() => setFailed(true)} />
          <span className="motion-sprite" />
        </> : <>
        <img className="motion-body" src="/avatars/sparrow-v2/base-3.webp" data-layer="body" alt=""
          onLoad={() => setLoaded((v) => ({ ...v, body: true }))} onError={() => setFailed(true)} />
        <img className="motion-wing" src="/avatars/sparrow-v2/base-3.webp" data-layer="wing" alt=""
          onLoad={() => setLoaded((v) => ({ ...v, wing: true }))} onError={() => setFailed(true)} />
        </>}
      </span>
    </span>
  );
}
