import { useId, type ReactNode } from 'react';
import { SONGBIRD_PATH } from './Logo.js';

/**
 * "Who holds the loop" — the one picture that explains the two ways an agent
 * connects to sparrow.
 *
 * The grammar never changes: **sparrow on the LEFT** (the songbird tile),
 * **the agent on the RIGHT** (a `>_` terminal glyph), labelled underneath in
 * small mono. The only two marks that move are:
 *
 *   - the **loop ring** — an open circular arrow drawn AROUND whoever holds
 *     the run loop, and
 *   - the **call arrow** — a single accent arrow from the holder to the callee.
 *
 * `inline`: the agent wears the ring and calls sparrow (`read()`).
 * `harness`: sparrow wears the ring and calls the agent (`claude -p`).
 *
 * Two sizes: `card` (200×90 viewBox) sits on top of the mode cards in the invite
 * dialog; `figure` (640×252) is the docs diptych — BOTH halves side by side,
 * each inside a dashed "your machine" frame with a one-line caption, so the
 * reader can see that the machine is the same and only the arrow flips.
 *
 * Everything is inline SVG on `--sparrow-*` tokens, so it themes with the app.
 */

type Mode = 'inline' | 'harness';
type Size = 'card' | 'figure';

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace";

const T = {
  panel: 'var(--sparrow-panel)',
  panel2: 'var(--sparrow-panel-2)',
  border: 'var(--sparrow-border)',
  borderStrong: 'var(--sparrow-border-strong)',
  text: 'var(--sparrow-text)',
  muted: 'var(--sparrow-muted)',
  faint: 'var(--sparrow-faint)',
  accent: 'var(--sparrow-accent)',
} as const;

const ARIA: Record<Mode, string> = {
  inline: 'Inline: the agent holds the loop and calls sparrow.',
  harness: "Harness: sparrow's CLI holds the loop and calls the agent.",
};

/**
 * One sentence per half, pre-broken into lines: SVG `<text>` does not wrap, and
 * each half only has the 288px of its "your machine" frame to play with.
 */
const CAPTION_LINES: Record<Mode, string[]> = {
  inline: ['The agent holds the loop and calls Sparrow', 'when it remembers to.'],
  harness: ["Sparrow's CLI holds the loop and calls the", 'agent for every message.'],
};

/** The command each side runs, shown under the arrow in the docs figure. */
const CALL_SUB: Record<Mode, string> = { inline: 'read()', harness: 'claude -p' };

/** Scene geometry. Sparrow sits at `sx`, the agent at `ax`, both on the `cy` line. */
interface Geo {
  /** sparrow tile centre x */
  sx: number;
  /** agent terminal centre x */
  ax: number;
  /** shared centre y */
  cy: number;
  /** sparrow tile side */
  ts: number;
  /** agent terminal width / height */
  tw: number;
  th: number;
  /** loop ring radius */
  r: number;
  /** overall scale factor (1 = card) */
  k: number;
  /** baseline y for the actor labels */
  laby: number;
  /** label font size */
  fs: number;
}

const CARD_GEO: Geo = { sx: 44, ax: 156, cy: 40, ts: 26, tw: 30, th: 20, r: 21, k: 1, laby: 78, fs: 7.5 };
const figureGeo = (ox: number): Geo => ({
  sx: ox + 82,
  ax: ox + 238,
  cy: 112,
  ts: 40,
  tw: 52,
  th: 34,
  r: 36,
  k: 1.6,
  laby: 172,
  fs: 10,
});

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Who wears the ring / who is called, in scene coordinates. */
const holderX = (mode: Mode, g: Geo) => (mode === 'inline' ? g.ax : g.sx);
const calleeX = (mode: Mode, g: Geo) => (mode === 'inline' ? g.sx : g.ax);
const holderName = (mode: Mode) => (mode === 'inline' ? 'agent' : 'sparrow');
const calleeName = (mode: Mode) => (mode === 'inline' ? 'sparrow' : 'agent');

/** The sparrow logomark tile — the brand mark, so its own colors, both themes. */
function Tile({ x, y, s, gid }: { x: number; y: number; s: number; gid: string }) {
  const k = s / 64;
  return (
    <g transform={`translate(${r2(x)} ${r2(y)})`}>
      <rect width={s} height={s} rx={r2(15 * k)} fill="#16161f" />
      <g transform={`scale(${r2(k)})`}>
        <path d={SONGBIRD_PATH} fill={`url(#${gid})`} />
        <circle cx="21" cy="29" r="2.1" fill="#12121a" />
        <line x1="24" y1="46" x2="22" y2="55" stroke="#e8703a" strokeWidth="2.2" strokeLinecap="round" />
        <line x1="31" y1="47" x2="31" y2="56" stroke="#e8703a" strokeWidth="2.2" strokeLinecap="round" />
      </g>
    </g>
  );
}

/** The agent: a `>_` prompt in a rounded rect. */
function TerminalGlyph({ x, y, w, h, sw }: { x: number; y: number; w: number; h: number; sw: number }) {
  const s = Math.min(w, h) * 0.22;
  const x0 = x + w * 0.22;
  const y0 = y + h / 2 - s;
  return (
    <g>
      <rect
        x={r2(x)}
        y={r2(y)}
        width={w}
        height={h}
        rx={Math.min(4, h * 0.15)}
        fill={T.panel}
        stroke={T.text}
        strokeWidth={sw}
      />
      <path
        d={`M${r2(x0)} ${r2(y0)} l${r2(s)} ${r2(s)} l${r2(-s)} ${r2(s)}`}
        fill="none"
        stroke={T.text}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1={r2(x0 + s * 1.6)}
        y1={r2(y0 + 2 * s)}
        x2={r2(x0 + s * 2.9)}
        y2={r2(y0 + 2 * s)}
        stroke={T.text}
        strokeWidth={sw}
        strokeLinecap="round"
      />
    </g>
  );
}

/**
 * The loop ring: an open circle (−20°→290°) with an arrowhead on the open end,
 * drawn around whoever holds the loop. `data-holder` is the machine-readable
 * answer to "who holds the loop".
 */
function Ring({ mode, g }: { mode: Mode; g: Geo }) {
  const cx = holderX(mode, g);
  const cy = g.cy;
  const r = g.r;
  const sw = g.k > 1 ? 2.2 : 1.6;
  const d = Math.PI / 180;
  const start = -20 * d;
  const end = 290 * d;
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const tx = -Math.sin(end);
  const ty = Math.cos(end);
  const nx = Math.cos(end);
  const ny = Math.sin(end);
  const h = sw * 3.4;
  const w = sw * 2;
  const points = [
    x2 + tx * h * 0.55,
    y2 + ty * h * 0.55,
    x2 - tx * h * 0.55 + nx * w,
    y2 - ty * h * 0.55 + ny * w,
    x2 - tx * h * 0.55 - nx * w,
    y2 - ty * h * 0.55 - ny * w,
  ]
    .map(r2)
    .join(' ');
  return (
    <g data-part="ring" data-holder={holderName(mode)}>
      <path
        d={`M${r2(x1)} ${r2(y1)} A${r} ${r} 0 1 1 ${r2(x2)} ${r2(y2)}`}
        fill="none"
        stroke={T.accent}
        strokeWidth={sw}
        strokeLinecap="round"
      />
      <polygon points={points} fill={T.accent} />
    </g>
  );
}

/** The single accent arrow: holder → callee, labelled "calls". */
function CallArrow({ mode, g, sub }: { mode: Mode; g: Geo; sub?: string }) {
  const hx = holderX(mode, g);
  const cx = calleeX(mode, g);
  const dir = mode === 'inline' ? -1 : 1;
  const calleeHalf = mode === 'inline' ? g.ts / 2 : g.tw / 2;
  const gap = 4;
  const x1 = hx + dir * (g.r + gap);
  const x2 = cx - dir * (calleeHalf + gap);
  const sw = 1.4;
  const head = sw * 4;
  const halfW = sw * 2.2;
  const bx = x2 - dir * head;
  return (
    <g data-part="call-arrow" data-from={holderName(mode)} data-to={calleeName(mode)}>
      <line
        x1={r2(x1)}
        y1={g.cy}
        x2={r2(bx)}
        y2={g.cy}
        stroke={T.accent}
        strokeWidth={sw}
        strokeLinecap="round"
      />
      <polygon
        points={[x2, g.cy, bx, g.cy + halfW, bx, g.cy - halfW].map(r2).join(' ')}
        fill={T.accent}
      />
      <text
        x={r2((x1 + x2) / 2)}
        y={r2(g.cy - 7 * g.k)}
        fontSize={r2(g.fs)}
        fill={T.accent}
        textAnchor="middle"
        fontFamily={SANS}
        fontWeight={600}
      >
        calls
      </text>
      {sub && (
        <text
          x={r2((x1 + x2) / 2)}
          y={r2(g.cy + 13 * g.k)}
          fontSize={r2(g.fs)}
          fill={T.faint}
          textAnchor="middle"
          fontFamily={MONO}
        >
          {sub}
        </text>
      )}
    </g>
  );
}

/** Both actors plus their mono labels. */
function Actors({ g, gid }: { g: Geo; gid: string }) {
  return (
    <g data-part="actors">
      <Tile x={g.sx - g.ts / 2} y={g.cy - g.ts / 2} s={g.ts} gid={gid} />
      <TerminalGlyph
        x={g.ax - g.tw / 2}
        y={g.cy - g.th / 2}
        w={g.tw}
        h={g.th}
        sw={g.k > 1 ? 1.4 : 1.2}
      />
      <text
        x={g.sx}
        y={g.laby}
        fontSize={r2(g.fs)}
        fill={T.faint}
        textAnchor="middle"
        fontFamily={MONO}
      >
        sparrow
      </text>
      <text
        x={g.ax}
        y={g.laby}
        fontSize={r2(g.fs)}
        fill={T.faint}
        textAnchor="middle"
        fontFamily={MONO}
      >
        agent
      </text>
    </g>
  );
}

/** One half of the docs figure: eyebrow, dashed machine frame, scene, caption. */
function FigureHalf({ ox, mode, gid }: { ox: number; mode: Mode; gid: string }) {
  const g = figureGeo(ox);
  return (
    <g data-half={mode}>
      <text
        x={ox + 16}
        y={24}
        fontSize="9.5"
        fill={T.faint}
        fontFamily={SANS}
        fontWeight={600}
        letterSpacing="1.1"
      >
        {mode.toUpperCase()}
      </text>
      <text
        x={ox + 304}
        y={24}
        fontSize="8.5"
        fill={T.faint}
        textAnchor="end"
        fontFamily={SANS}
        fontWeight={600}
        letterSpacing="0.8"
      >
        {mode === 'inline' ? 'NO INSTALL' : 'NEEDS THE CLI'}
      </text>
      <rect
        data-part="machine-frame"
        x={ox + 16}
        y={40}
        width={288}
        height={150}
        rx={8}
        fill="none"
        stroke={T.borderStrong}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <text x={ox + 28} y={54} fontSize="8.5" fill={T.faint} fontFamily={MONO}>
        your machine
      </text>
      <Actors g={g} gid={gid} />
      <Ring mode={mode} g={g} />
      <CallArrow mode={mode} g={g} sub={CALL_SUB[mode]} />
      <g data-part="caption">
        {CAPTION_LINES[mode].map((line, i) => (
          <text
            key={line}
            x={ox + 16}
            y={210 + i * 15}
            fontSize="10.5"
            fill={T.muted}
            fontFamily={SANS}
          >
            {line}
          </text>
        ))}
      </g>
    </g>
  );
}

export interface LoopModeArtProps {
  mode: Mode;
  size?: Size;
  className?: string;
}

export function LoopModeArt({ mode, size = 'card', className = '' }: LoopModeArtProps) {
  const gid = `loop-bird-${useId().replace(/:/g, '')}`;
  const figure = size === 'figure';
  const viewBox = figure ? '0 0 640 252' : '0 0 200 90';
  const label = figure
    ? `Two ways an agent connects. ${ARIA.inline} ${ARIA.harness}`
    : ARIA[mode];

  let body: ReactNode;
  if (figure) {
    body = (
      <>
        <line x1="320" y1="14" x2="320" y2="244" stroke={T.border} strokeWidth={1} />
        <FigureHalf ox={0} mode="inline" gid={gid} />
        <FigureHalf ox={320} mode="harness" gid={gid} />
      </>
    );
  } else {
    body = (
      <>
        <Actors g={CARD_GEO} gid={gid} />
        <Ring mode={mode} g={CARD_GEO} />
        <CallArrow mode={mode} g={CARD_GEO} />
      </>
    );
  }

  return (
    <svg
      viewBox={viewBox}
      role="img"
      aria-label={label}
      data-mode={mode}
      data-size={size}
      className={className}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2c14e" />
          <stop offset=".5" stopColor="#e8703a" />
          <stop offset="1" stopColor="#c8456b" />
        </linearGradient>
      </defs>
      {body}
    </svg>
  );
}
