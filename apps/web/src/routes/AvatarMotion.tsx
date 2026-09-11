import { useEffect, useState } from 'react';
import { MotionAvatarStudy } from '../components/MotionAvatarStudy.js';
import { PresenceGlyph } from '../components/StatusIndicator.js';
import { PresenceAvatar } from '../components/PresenceAvatar.js';
import { agentVisual } from '../lib/avatar.js';
import './AvatarMotion.css';

const BIRDS = ['Round', 'Profile', 'Expressive'].map((name, i) => ({
  name,
  id: Array.from({ length: 100 }, (_, n) => `agt_motion_${n}`).find((id) => agentVisual(id).base.id === `base-${i + 1}`)!,
}));

export function AvatarMotion() {
  const [busy, setBusy] = useState(true);
  const [reduce, setReduce] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return (
    <main className="motion-study">
      <header className="motion-study-header">
        <div><div className="motion-eyebrow">Sparrow / Motion study</div><h1>Busy avatars</h1></div>
        <div className="motion-controls">
          <label><input type="checkbox" checked={busy} onChange={(e) => setBusy(e.target.checked)} /> Busy</label>
          <label><input type="checkbox" checked={reduce} onChange={(e) => setReduce(e.target.checked)} /> Reduced motion</label>
        </div>
      </header>
      <div className="motion-integrated">
        {BIRDS.map(({ name, id }) => <section key={id}>
          <h2>{name}</h2>
          <div className="motion-agent-row selected">
            <PresenceAvatar kind="agent" id={id} displayName={name} presence="online" busy={busy} animateBusy={!reduce} size={28} />
            <span>{name}</span><span className="motion-state">{busy ? 'Working' : 'Idle'}</span>
          </div>
          <div className="motion-inspection">
            <PresenceAvatar kind="agent" id={id} displayName={name} presence="online" busy={busy} animateBusy={!reduce} size={128} />
            <span className="motion-dimension">128 px</span>
          </div>
        </section>)}
      </div>
      <details className="motion-previous"><summary>Earlier comparison</summary><div className="motion-comparison">
        {(['energetic', 'hovering'] as const).map((mode, index) => (
          <section key={mode} aria-labelledby={`${mode}-heading`}>
            <h2 id={`${mode}-heading`}>{index === 0 ? 'A / CSS wingbeats' : 'B / Sprite hover'}</h2>
            <div className="motion-sidebar">
              <h3>Agents</h3>
              {['Atlas', 'Nova', 'Scout'].map((name, i) => (
                <div className={`motion-agent-row ${i === 0 ? 'selected' : ''}`} key={name}>
                  <span className="motion-cluster">
                    <MotionAvatarStudy busy={busy && i !== 2} mode={mode} reducedMotion={reduce} paused={hidden} />
                    <span className="motion-status"><PresenceGlyph presence="online" busy={busy && i !== 2} /></span>
                  </span>
                  <span>{name}</span><span className="motion-state">{busy && i !== 2 ? 'Working' : 'Idle'}</span>
                </div>
              ))}
            </div>
            <div className="motion-inspection">
              <MotionAvatarStudy busy={busy} mode={mode} size={128} reducedMotion={reduce} paused={hidden} />
              <div><span className="motion-dimension">128 px</span><p>{busy ? 'Working' : 'Idle'}</p></div>
            </div>
          </section>
        ))}
      </div></details>
      <section className="motion-chat" aria-labelledby="chat-heading">
        <h2 id="chat-heading">Conversation</h2>
        <div className="motion-chat-row">
          <MotionAvatarStudy busy={false} mode="calm" />
          <div><strong>Atlas</strong><span className="motion-time"> 14:32</span><p>The checks are complete. I am reviewing the results.</p></div>
        </div>
      </section>
    </main>
  );
}
