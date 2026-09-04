import { Lightbulb, Mail, MessagesSquare, Phone, Waypoints, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Medium } from '@sparrow/common-types';

/**
 * The INFO BOX TYPE REGISTRY — one glyph + type label + color identity per kind
 * of non-message box, so an info box in the activity stream says what kind of
 * thing it is before it is read.
 *
 * A conversation pane is one time-ordered column of everything that happened
 * with a counterpart across every medium (SPEC *Web UI → The conversation view
 * is an activity stream*). Chat bubbles are the DEFAULT REGISTER and carry no
 * mark — adding one to every message would say nothing. Every other register
 * gets the full mark — icon, then its type WORD in bold, both in the type's own
 * `--sparrow-type-*` color — because "this box is not an ordinary internal
 * message" is the fact a reader needs at a glance, and it must survive the
 * happy path: a disposition badge only appears when something went wrong. The
 * tones are deliberately NOT copper (copper stays "live / unread") and not the
 * semantic good/danger, so a type can never read as a state.
 *
 * Adding a medium is adding a line to {@link MEDIUM_GLYPHS} plus its token pair
 * in `index.css`. Nothing else in the info-box anatomy changes, which is the
 * point of a registry over per-card icons.
 */

export interface MediumGlyphSpec {
  Icon: LucideIcon;
  /** The type's name, rendered as bold TEXT immediately after the icon. */
  label: string;
  /** The type's `--sparrow-type-*` color token (registry-enforced in tests). */
  tone: string;
}

/**
 * medium → its mark, or `null` for a medium that renders unmarked.
 *
 * Icon choices deliberately avoid the app's voice CONTROLS (`Mic`, `Volume2`,
 * `Square`): those mean "record / play / stop" on a live control, and reusing
 * them as provenance would read as an affordance rather than a fact.
 */
export const MEDIUM_GLYPHS: Record<Medium, MediumGlyphSpec | null> = {
  // The default register: chat is what a room IS, so its bubbles stay clean.
  chat: null,
  email: { Icon: Mail, label: 'Email', tone: '--sparrow-type-email' },
  voice: { Icon: Phone, label: 'Voice', tone: '--sparrow-type-voice' },
  // Sparrow itself speaking — today that means one thing: a delivered hint.
  // The bulb is "the system handed your agent a tip"; the old clover read as
  // luck/decoration and taught nothing at 13px.
  system: { Icon: Lightbulb, label: 'Hint', tone: '--sparrow-type-hint' },
};

/**
 * UI-only registers that are not wire mediums but ARE info boxes on the same
 * rail, so they carry the same mark anatomy from the same registry. The
 * agent↔agent DM oversight box is chat on the wire; as a box in someone ELSE's
 * pane it needs its own identity.
 */
export const INFO_BOX_MARKS: Record<string, MediumGlyphSpec> = {
  'agent-dm': { Icon: MessagesSquare, label: 'DM', tone: '--sparrow-type-dm' },
};

/**
 * The fallback for a medium this client build has never heard of — a future
 * server may stream one. Marking it generically is strictly better than leaving
 * it unmarked: unmarked is exactly the "looks like an ordinary message" failure
 * the registry exists to prevent. The label is the raw medium word, so the
 * accessible name stays honest rather than inventing a name for it — and the
 * tone is the muted ink, because an unknown type earns no color identity.
 */
const UNKNOWN_ICON: LucideIcon = Waypoints;

/** The spec for any medium string, including one not in the registry. */
export function mediumGlyph(medium: string): MediumGlyphSpec | null {
  if (medium in MEDIUM_GLYPHS) return MEDIUM_GLYPHS[medium as Medium];
  if (medium in INFO_BOX_MARKS) return INFO_BOX_MARKS[medium]!;
  return {
    Icon: UNKNOWN_ICON,
    label: medium.charAt(0).toUpperCase() + medium.slice(1),
    tone: '--sparrow-muted',
  };
}

/**
 * The inline style handing an info box's CONTAINER its tone: `.info-box`
 * (index.css) draws the Tinted Etch — the type tone as a whisper wash under a
 * 45° hairline hatch in the same tone — off the one `--info-tone` variable this
 * sets. Deriving it here, from the same registry as the mark, is what makes a
 * new medium's box pick up its treatment automatically. Unknown mediums fall
 * back to the muted ink, matching their fallback mark.
 */
export function infoBoxToneStyle(medium: string): CSSProperties {
  const tone = mediumGlyph(medium)?.tone ?? '--sparrow-muted';
  return { '--info-tone': `var(${tone})` } as CSSProperties;
}

/**
 * The type mark for an info box's leading rail: the glyph, then the type's word
 * in bold small caps, both in the type's color — never glyph-only (the same
 * rule the direction glyph and the verification mark follow; here the word is
 * simply in view rather than screen-reader-only).
 *
 * Renders nothing at all for an unmarked medium (chat), so a caller can hand it
 * any entry without branching.
 */
export function MediumGlyph({ medium, size = 13 }: { medium: string; size?: number }) {
  const spec = mediumGlyph(medium);
  if (!spec) return null;
  const { Icon, label, tone } = spec;
  return (
    <span
      data-testid="medium-glyph"
      data-medium={medium}
      title={label}
      style={{ color: `var(${tone})` }}
      className="inline-flex shrink-0 items-center gap-1"
    >
      <Icon size={size} aria-hidden="true" />
      <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
    </span>
  );
}

/**
 * The same fact as a labelled line, for an EXPANDED info box's meta block: the
 * glyph plus the type's name, repeated so a reader who has opened a box does
 * not have to infer the register from the header row they scrolled past.
 */
export function MediumMark({ medium }: { medium: string }) {
  const spec = mediumGlyph(medium);
  if (!spec) return null;
  const { Icon, label, tone } = spec;
  return (
    <span
      data-testid="medium-mark"
      data-medium={medium}
      style={{ color: `var(${tone})` }}
      className="inline-flex items-center gap-1.5 self-start rounded-full border border-[var(--sparrow-border)] px-2 py-0.5 text-[10px] uppercase tracking-wider"
    >
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
