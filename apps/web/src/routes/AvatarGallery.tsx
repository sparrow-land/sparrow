import { useEffect } from 'react';
import { Avatar } from '../components/Avatar.js';
import { PresenceAvatar } from '../components/PresenceAvatar.js';

const SEEDS = Array.from({ length: 24 }, (_, index) => `agt_gallery_${index + 1}`);
const PRESENCE = ['online', 'active', 'offline'] as const;

export function AvatarGallery() {
  useEffect(() => {
    const previousTitle = document.title;
    const existingIcon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const previousHref = existingIcon?.getAttribute('href') ?? null;
    const icon = existingIcon ?? Object.assign(document.createElement('link'), { rel: 'icon' });
    if (!existingIcon) document.head.append(icon);
    document.title = 'Sparrow · Avatar & mark pilot';
    icon.href = '/brand/sparrow-icon.svg';
    return () => {
      document.title = previousTitle;
      if (existingIcon && previousHref !== null) existingIcon.setAttribute('href', previousHref);
      else icon.remove();
    };
  }, []);

  return (
    <main className="min-h-full bg-[var(--sparrow-bg)] px-6 py-8 text-[var(--sparrow-text)]">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 border-b border-[var(--sparrow-border)] pb-5">
          <h1 className="m-0 text-2xl font-semibold">Sparrow avatar pilot</h1>
          <p className="mt-2 text-sm text-[var(--sparrow-muted)]">Deterministic v2 base art and background pairings at production sizes.</p>
        </header>
        <section aria-labelledby="large-heading">
          <h2 id="large-heading" className="mb-4 text-sm font-semibold uppercase text-[var(--sparrow-muted)]">Large inspection</h2>
          <div className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-4 md:grid-cols-6">
            {SEEDS.map((seed, index) => (
              <figure key={seed} className="m-0 flex flex-col items-center gap-2">
                <Avatar kind="agent" id={seed} displayName={`Agent ${index + 1}`} size={96} />
                <figcaption className="mono text-xs text-[var(--sparrow-muted)]">{seed.replace('agt_gallery_', '#')}</figcaption>
              </figure>
            ))}
          </div>
        </section>
        <section className="mt-10 border-t border-[var(--sparrow-border)] pt-6" aria-labelledby="sizes-heading">
          <h2 id="sizes-heading" className="mb-5 text-sm font-semibold uppercase text-[var(--sparrow-muted)]">Production scale and presence</h2>
          <div className="flex flex-wrap items-end gap-8">
            {[24, 26, 28, 64].map((size, index) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <PresenceAvatar kind="agent" id={SEEDS[index]!} displayName={`Agent ${index + 1}`} size={size} presence={PRESENCE[index % PRESENCE.length]!} busy={index === 1} />
                <span className="mono text-xs text-[var(--sparrow-muted)]">{size}px</span>
              </div>
            ))}
          </div>
        </section>
        <section className="mt-10 border-t border-[var(--sparrow-border)] pt-6" aria-labelledby="marks-heading">
          <h2 id="marks-heading" className="mb-5 text-sm font-semibold uppercase text-[var(--sparrow-muted)]">Mark sizing study</h2>
          <div className="flex flex-wrap gap-10">
            {['sparrow-mark.svg', 'sparrow-icon.svg'].map((asset) => (
              <figure key={asset} className="m-0">
                <div className="flex h-20 items-center gap-5 rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-5">
                  {[16, 24, 32, 64].map((size) => <img key={size} src={`/brand/${asset}`} width={size} height={size} alt="" />)}
                </div>
                <figcaption className="mono mt-2 text-xs text-[var(--sparrow-muted)]">{asset} · 16 / 24 / 32 / 64</figcaption>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
