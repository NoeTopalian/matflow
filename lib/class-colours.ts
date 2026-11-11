/**
 * The class colours the class form offers, each with the name a screen reader
 * says and a sighted person would use. Kept in a `.ts` file so the values stay
 * out of the UI-RULES hex-literal ratchet (which scans `.tsx`).
 *
 * The first ten are the original palette, values and order unchanged, so every
 * class keeps the colour it was saved with and the picker reads as before.
 * Light blue, navy, grey and light yellow were added on 11 Nov 2026 (Sean's
 * request via Noe). A class keeps any colour it has, including one not in this
 * list; colours are a property of each class, never of its category.
 *
 * Pale colours are made readable where they are painted, not here: text in a
 * class colour goes through lib/color.ts legibleInk, and a small mark gets an
 * outline when lib/color.ts markNeedsOutline says it would vanish.
 */
import { legibleInk, markNeedsOutline, tintOver } from "@/lib/color";

export const CLASS_COLOURS: readonly { value: string; name: string }[] = [
  { value: "#3b82f6", name: "Blue" },
  { value: "#8b5cf6", name: "Purple" },
  { value: "#ec4899", name: "Pink" },
  { value: "#ef4444", name: "Red" },
  { value: "#f97316", name: "Orange" },
  { value: "#eab308", name: "Yellow" },
  { value: "#22c55e", name: "Green" },
  { value: "#14b8a6", name: "Teal" },
  { value: "#06b6d4", name: "Cyan" },
  { value: "#6366f1", name: "Indigo" },
  { value: "#93c5fd", name: "Light blue" },
  { value: "#1e3a8a", name: "Navy" },
  { value: "#94a3b8", name: "Grey" },
  { value: "#fde68a", name: "Light yellow" },
];

/** The staff timetable is light only (UI-RULES §1): its cards and chips sit on white. */
const STAFF_SURFACE = "#ffffff";

/**
 * A class's colour as TEXT on its own 12 % tint (the class card's schedule
 * pills): the hue kept, darkened only as far as 4.5:1 needs. Light yellow text
 * on its tint measured 1.1:1 before.
 */
export function classInk(colour: string): string {
  return legibleInk(colour, tintOver(colour, 0.12, STAFF_SURFACE), 4.5);
}

/**
 * A class's colour as a 3 px edge (the live chip's left border) on white:
 * darkened only as far as the non-text 3:1 floor needs, so a pale class still
 * shows which session is live.
 */
export function classEdge(colour: string): string {
  return legibleInk(colour, STAFF_SURFACE, 3);
}

/**
 * The style of a class's small dot: its colour, with a hairline ring in the
 * text tone when the colour alone would vanish on white (below 3:1). The
 * ring is drawn as a box-shadow, so the dot's size and the layout are unchanged.
 */
export function classDotStyle(colour: string): { background: string; boxShadow?: string } {
  return markNeedsOutline(colour, STAFF_SURFACE) ? { background: colour, boxShadow: "0 0 0 1px var(--tx-3)" } : { background: colour };
}

/** The default colour of a new class: the first of the palette, as before. */
export const DEFAULT_CLASS_COLOUR = CLASS_COLOURS[0].value;

/** The name of a palette colour, or null for a colour the palette does not hold. */
export function classColourName(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.toLowerCase();
  return CLASS_COLOURS.find((c) => c.value === v)?.name ?? null;
}
