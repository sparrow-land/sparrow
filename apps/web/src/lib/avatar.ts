/**
 * Deterministic procedural avatar generation — the owner-approved scheme
 * (agents = scheme A "brand bird recoloured"; humans = scheme 1 "initials on a
 * warm two-stop gradient"). Ported faithfully from the concept page's hash / RNG
 * / colour code.
 *
 * This module is PURE and unit-testable: given an id/name it returns plain data
 * (colour stops, a pose flip, initials, a contrast-safe gradient). The React
 * wrapper — {@link ../components/Avatar} — turns that data into SVG, namespacing
 * the gradient ids per instance with `useId` (SVG gradient-id collisions across
 * instances were a lesson learned previously).
 *
 * Same id/name always yields the same avatar; different ids spread across the
 * full hue wheel (agents) or the warm "dawn" arc, pink → gold (humans).
 */

/* ------------------------------------------------------------------ *
 * Deterministic hashing + RNG (xmur3 seed → mulberry32 stream).
 * ------------------------------------------------------------------ */

export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded [0,1) generator for a stable id/name string. */
export function makeRng(id: string): () => number {
  return mulberry32(xmur3(String(id))());
}

/* ------------------------------------------------------------------ *
 * Colour helpers.
 * ------------------------------------------------------------------ */

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export function relLum(hex: string): number {
  const c = hex.replace('#', '');
  const rgb = [0, 1, 2]
    .map((i) => parseInt(c.substr(i * 2, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}

export function contrast(a: string, b: string): number {
  const L1 = relLum(a);
  const L2 = relLum(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Raise lightness of a hue until it clears `min` contrast vs `ink` (capped). */
export function ensureL(h: number, s: number, l: number, ink: string, min: number): number {
  let L = l;
  while (L < 88 && contrast(hslToHex(h, s, L), ink) < min) L += 2;
  return L;
}

/* ------------------------------------------------------------------ *
 * Initials — 1–2 letters from a display name.
 * ------------------------------------------------------------------ */

/**
 * First + last initial (uppercased) for a multi-word name; the first letter for
 * a single word; `?` when there is nothing usable. Emoji / non-letters are kept
 * verbatim (they still render), matching the concept page.
 */
export function initials(name: string): string {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  let s = parts[0]![0]!;
  if (parts.length > 1) s += parts[parts.length - 1]![0]!;
  return s.toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Agents — scheme A: the brand songbird, recoloured.
 * ------------------------------------------------------------------ */

/** Three dawn-style stops (warm-shift top, cool-shift bottom) for a base hue. */
export function dawnStops(baseH: number): [string, string, string] {
  return [hslToHex(baseH + 16, 84, 64), hslToHex(baseH, 78, 56), hslToHex(baseH - 26, 62, 48)];
}

export interface AgentVisual {
  /** Gradient stops top→bottom. */
  stops: [string, string, string];
  /** Subtle left/right pose flip. */
  flip: boolean;
}

/** Deterministic plumage + pose for an agent id (continuous per-id hue). */
export function agentVisual(id: string): AgentVisual {
  const r = makeRng(id);
  const baseH = r() * 360; // continuous hue — no bucket collisions
  const flip = r() < 0.5;
  return { stops: dawnStops(baseH), flip };
}

/* ------------------------------------------------------------------ *
 * Humans — scheme 1: initials on a warm two-stop gradient.
 * ------------------------------------------------------------------ */

/** The warm "dawn" arc: 340 → 400 (=40) — pink → red → orange → gold. */
export const WARM = (t: number): number => 340 + t * 60;

/** Dark ink used for human initials; the gradient is lightened to clear AA on it. */
export const HUMAN_INK = '#1b1a24';

export interface HumanVisual {
  /** Top-left gradient stop. */
  top: string;
  /** Bottom-right gradient stop. */
  bottom: string;
  /** 1–2 letters. */
  initials: string;
  /** SVG font-size within the 64-unit viewBox. */
  fontSize: number;
  /** Text colour (dark ink). */
  ink: string;
}

/**
 * Deterministic human fallback. Hue is keyed off the stable principal `id` (so
 * two people who share a display name still read apart), initials off the
 * `displayName`. Lightness is auto-raised per hue to guarantee ≥4.6:1 (AA)
 * contrast against the dark ink on the darkest stop.
 */
export function humanVisual(id: string, displayName: string): HumanVisual {
  const r = makeRng(id);
  const hue = WARM(r());
  const hTop = hue + 10;
  const hBot = hue - 8;
  const top = hslToHex(hTop, 72, ensureL(hTop, 72, 68, HUMAN_INK, 4.6));
  const bottom = hslToHex(hBot, 66, ensureL(hBot, 66, 58, HUMAN_INK, 4.6));
  const ini = initials(displayName);
  return { top, bottom, initials: ini, fontSize: ini.length > 1 ? 25 : 30, ink: HUMAN_INK };
}

/* ------------------------------------------------------------------ *
 * Procedural-avatar seed selection.
 * ------------------------------------------------------------------ */

/** A member-ish ref that may (new payloads) or may not (old) carry a principal id. */
export interface AvatarSeedRef {
  /** Per-room member id (`mem_…`) — NOT stable across rooms. */
  id: string;
  /** Stable principal id (`agt_…`/`usr_…`), when the server/cache provides it. */
  principalId?: string | null;
}

/**
 * Choose the deterministic procedural-avatar seed for a member-ish ref.
 *
 * The seed MUST be the stable PRINCIPAL id so one agent/human draws the same
 * bird/gradient in every room and in the sidebar. Message rows and event refs
 * arrive as `MemberRef`s whose `id` is a per-room `mem_…` — seeding off that gave
 * a different avatar per room (the bug this fixes).
 *
 * Preference order: explicit `principalId` → a member→principal bridge built from
 * the room roster (rescues pre-fix cached payloads that lack `principalId`) → the
 * ref's own `id` (last-resort; keeps *something* rendering).
 */
export function avatarSeed(
  ref: AvatarSeedRef,
  memberToPrincipal?: ReadonlyMap<string, string>,
): string {
  return ref.principalId ?? memberToPrincipal?.get(ref.id) ?? ref.id;
}

/* ------------------------------------------------------------------ *
 * Contract-forward avatarUrl accessor.
 * ------------------------------------------------------------------ */

/**
 * Read `avatarUrl` off any human-carrying payload (roster/members, sidebar
 * humans, message sender refs, the DM counterpart). The field is part of the
 * pinned server contract but is modelled as OPTIONAL here so this compiles and
 * runs against both pre- and post-avatar servers: structural typing accepts a
 * ref that lacks the property, and a missing/blank value falls back to the
 * generated avatar. Agents never carry one.
 */
export function readAvatarUrl(o: unknown): string | null {
  if (o && typeof o === 'object' && 'avatarUrl' in o) {
    const url = (o as { avatarUrl?: unknown }).avatarUrl;
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}
