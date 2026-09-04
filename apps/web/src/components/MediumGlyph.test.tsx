import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Lightbulb, Mail, MessagesSquare } from 'lucide-react';
import { MediumSchema } from '@sparrow/common-types';
import {
  INFO_BOX_MARKS,
  MEDIUM_GLYPHS,
  MediumGlyph,
  MediumMark,
  infoBoxToneStyle,
  mediumGlyph,
} from './MediumGlyph.js';

/**
 * The INFO BOX type registry. An info box (a non-message box in the activity
 * stream) has to say what KIND of thing it is before it is read — the
 * disposition badge only shows up when something went wrong, so on the happy
 * path nothing else distinguishes an email from an ordinary message. Since the
 * type-label pass, "say what kind" means three things at once: the glyph, the
 * type WORD next to it, and the type's own color.
 */

describe('MEDIUM_GLYPHS (the registry)', () => {
  it('has a decision for every medium common-types defines', () => {
    // Adding a medium to the wire must force a decision here, not silently
    // produce an unmarked card.
    expect(Object.keys(MEDIUM_GLYPHS).sort()).toEqual([...MediumSchema.options].sort());
  });

  it('leaves chat unmarked — it is the default register', () => {
    expect(MEDIUM_GLYPHS.chat).toBeNull();
    const { container } = render(<MediumGlyph medium="chat" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks every NON-chat medium with a glyph, a label, and a type tone', () => {
    for (const medium of MediumSchema.options) {
      if (medium === 'chat') continue;
      const spec = mediumGlyph(medium);
      expect(spec, medium).not.toBeNull();
      expect(spec!.label, medium).toMatch(/^\S/);
      // Every registered type owns a `--sparrow-type-*` identity token — the
      // "all DMs one color, all Email another" rule is registry-enforced.
      expect(spec!.tone, medium).toMatch(/^--sparrow-type-/);
    }
  });

  it('every registry tone token is defined in the stylesheet, in BOTH themes', () => {
    // Vitest runs with the package as cwd; import.meta.url is not a file URL here.
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    const tones = new Set(
      [...Object.values(MEDIUM_GLYPHS), ...Object.values(INFO_BOX_MARKS)]
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => s.tone),
    );
    for (const tone of tones) {
      const defs = css.split(`${tone}:`).length - 1;
      // Dark base + the two light blocks (media query and explicit choice).
      expect(defs, `${tone} must be defined in dark AND both light blocks`).toBe(3);
    }
  });

  it('defines the etch alphas in BOTH themes and draws hatch-over-wash from the box tone', () => {
    // The Tinted Etch container: the box's ground is its own type tone at a
    // whisper wash, engraved with a 45° hairline hatch drawn IN the same tone.
    // The alphas are per-theme dials (wash 6%/7%, hatch 13%/16%), so like the
    // tone tokens they must exist in dark and both light blocks.
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    for (const token of ['--sparrow-wash-a', '--sparrow-hatch-a']) {
      const defs = css.split(`${token}:`).length - 1;
      expect(defs, `${token} must be defined in dark AND both light blocks`).toBe(3);
    }
    const rule = css.slice(css.indexOf('.info-box'));
    expect(rule).toContain('repeating-linear-gradient');
    expect(rule).toContain('45deg');
    // Hatch layer over wash layer, both mixed from the SAME tone variable.
    expect(rule).toContain('var(--info-tone) var(--sparrow-hatch-a)');
    expect(rule).toContain('var(--info-tone) var(--sparrow-wash-a)');
  });

  it('the Hint mark is a lightbulb, not the old clover', () => {
    // "The system nudged the agent": a bulb is the one 13px silhouette that
    // reads as a tip. The old clover read as luck/decoration and taught nothing.
    expect(MEDIUM_GLYPHS.system!.Icon).toBe(Lightbulb);
    expect(MEDIUM_GLYPHS.system!.label).toBe('Hint');
  });

  it('registers the agent-DM oversight box mark (paired bubbles, "DM", dm tone)', () => {
    const spec = mediumGlyph('agent-dm');
    expect(spec).toEqual({ Icon: MessagesSquare, label: 'DM', tone: '--sparrow-type-dm' });
  });

  it('marks a medium this build has never heard of, labelled with its own word', () => {
    // A future server may stream one. Unmarked is the one thing it must not be —
    // that is the bug the registry exists to stop. Its tone falls back to the
    // muted ink: an unknown type gets no invented color identity.
    render(<MediumGlyph medium="pager" />);
    const glyph = screen.getByTestId('medium-glyph');
    expect(glyph).toHaveAttribute('data-medium', 'pager');
    expect(glyph).toHaveTextContent('Pager');
    expect(mediumGlyph('pager')!.tone).toBe('--sparrow-muted');
  });
});

describe('MediumGlyph (the collapsed row mark: icon + type label)', () => {
  it('renders the type label as VISIBLE bold text right after the icon', () => {
    render(<MediumGlyph medium="email" />);
    const glyph = screen.getByTestId('medium-glyph');
    const label = screen.getByText('Email');
    expect(label).toBeVisible();
    expect(label.classList.contains('sr-only')).toBe(false);
    expect(label.className).toContain('font-semibold');
    // The label holds its 10px at EVERY box density — identity does not shrink
    // when a row compacts (the 06a rule, inherited by the compact densities).
    expect(label.className).toContain('text-[10px]');
    // Icon first, word second — the label follows the glyph it names.
    expect(glyph.firstElementChild!.tagName.toLowerCase()).toBe('svg');
  });

  it('colors the whole mark with the type tone token', () => {
    render(<MediumGlyph medium="email" />);
    expect(screen.getByTestId('medium-glyph').style.color).toBe('var(--sparrow-type-email)');
  });

  it('each type keeps its own color identity', () => {
    const toneOf = (medium: string) => {
      const view = render(<MediumGlyph medium={medium} />);
      const color = screen.getByTestId('medium-glyph').style.color;
      view.unmount();
      return color;
    };
    const tones = ['email', 'voice', 'system', 'agent-dm'].map(toneOf);
    expect(new Set(tones).size).toBe(tones.length);
  });

  it('renders a distinct glyph per medium', () => {
    const svgFor = (medium: string) => {
      const view = render(<MediumGlyph medium={medium} />);
      const html = screen.getByTestId('medium-glyph').querySelector('svg')!.innerHTML;
      view.unmount();
      return html;
    };
    // Voice must not borrow the email mark (or the mic/speaker CONTROL icons).
    expect(svgFor('email')).not.toEqual(svgFor('voice'));
    expect(svgFor('system')).not.toEqual(svgFor('agent-dm'));
  });

  it('email keeps its envelope', () => {
    expect(MEDIUM_GLYPHS.email!.Icon).toBe(Mail);
  });
});

describe('infoBoxToneStyle (the container treatment derives from the registry)', () => {
  it('hands each medium its own tone as --info-tone', () => {
    // The Tinted Etch container reads its wash + hatch color from this one
    // variable, so a new medium's box gets its treatment from its registry
    // tone automatically — no per-card background styling.
    expect(infoBoxToneStyle('email')).toEqual({ '--info-tone': 'var(--sparrow-type-email)' });
    expect(infoBoxToneStyle('system')).toEqual({ '--info-tone': 'var(--sparrow-type-hint)' });
    expect(infoBoxToneStyle('agent-dm')).toEqual({ '--info-tone': 'var(--sparrow-type-dm)' });
  });

  it('an unknown medium falls back to the muted ink, matching its mark', () => {
    expect(infoBoxToneStyle('pager')).toEqual({ '--info-tone': 'var(--sparrow-muted)' });
  });
});

describe('MediumMark (the expanded card meta line)', () => {
  it('shows the medium name in view, in the type tone', () => {
    render(<MediumMark medium="email" />);
    const mark = screen.getByTestId('medium-mark');
    expect(mark).toHaveTextContent('Email');
    expect(mark.querySelector('.sr-only')).toBeNull();
    expect(mark.style.color).toBe('var(--sparrow-type-email)');
  });

  it('renders nothing for chat', () => {
    const { container } = render(<MediumMark medium="chat" />);
    expect(container).toBeEmptyDOMElement();
  });
});
