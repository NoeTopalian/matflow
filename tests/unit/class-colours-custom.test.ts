// Custom class colours (25 Nov 2026): a class can carry any opaque shade a person picks, not only the 14 swatches.
// These are the guarantees that make that safe on the member schedule, checked for EVERY shade on a 16-step grid of
// RGB (4,096 colours, so white, black, pale yellow, navy and every mid-tone near them) on each member theme preset's
// shell: the painted surface, not the raw hex pair. Floors: 4.5:1 for text, 3:1 for the selection ring and live edge.
// Also the parsing and same-colour rules the class form relies on.
import { describe, it, expect } from "vitest";
import {
  CLASS_COLOURS, canonicalClassColour, memberBookedFill, memberEndedColour, MEMBER_MARK_SHARE, parseCustomClassColour,
  sameClassColour,
} from "@/lib/class-colours";
import { contrastRatio, mixHex, tintOver } from "@/lib/color";

// app/member/layout.tsx: the shell's text and the ring's gap are fixed per light/dark; the background is the club's.
// Backgrounds: the 8 dark and 4 light theme presets (components/dashboard/SettingsPage.tsx THEME_PRESETS).
const DARK = { text: "#ffffff", gap: "#0e1013" };
const LIGHT = { text: "#0f172a", gap: "#f8fafc" };
const SHELLS = [
  ...["#111111", "#0a0a0a", "#0d0d0d", "#0f0a1a", "#080f0a", "#050d12", "#0a0a14", "#120508"].map((bg) => ({ bg, ...DARK })),
  ...["#f8fafc", "#f0fdf4", "#fffbeb", "#f0f9ff"].map((bg) => ({ bg, ...LIGHT })),
];

const GRID: string[] = [];
for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
  GRID.push("#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""));
}
const NAMED = { white: "#ffffff", black: "#000000", paleYellow: "#fef9c3", navy: "#1e3a8a", midTone: "#7c8a6e" };

/** The worst ratio over the grid, with the colour that gave it, so a failure names the shade. */
function worst(f: (c: string) => number): { ratio: number; colour: string } {
  let w = { ratio: Infinity, colour: "" };
  for (const c of [...GRID, ...Object.values(NAMED)]) {
    const r = f(c);
    if (r < w.ratio) w = { ratio: r, colour: c };
  }
  return w;
}

describe("any shade on the member schedule, on every theme preset", () => {
  it.each(SHELLS.map((s) => [s.bg, s] as const))("shell %s: a block that is not booked keeps its name and time at 4.5:1", (_bg, s) => {
    // The block: the class colour at 32 % → 20 % (ended 16 % → 10 %) over 6 % of the shell's text over the shell.
    const base = mixHex(s.text, s.bg, 0.06);
    for (const [a, b] of [[0.32, 0.2], [0.16, 0.1]]) {
      const w = worst((c) => Math.min(contrastRatio(s.text, tintOver(c, a, base))!, contrastRatio(s.text, tintOver(c, b, base))!));
      expect(w.ratio, `worst shade ${w.colour}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("a booked block's ink reaches 4.5:1 on both gradient stops, live and ended (the fill moves only as far as needed)", () => {
    for (const ended of [false, true]) {
      const w = worst((c) => {
        const f = memberBookedFill(ended ? memberEndedColour(c) : c);
        return Math.min(contrastRatio(f.ink, f.from)!, contrastRatio(f.ink, f.to)!);
      });
      expect(w.ratio, `worst shade ${w.colour}${ended ? " (ended)" : ""}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("a shade that already passes is painted exactly as stored", () => {
    for (const c of [NAMED.white, NAMED.black, NAMED.navy, NAMED.paleYellow]) expect(memberBookedFill(c).from).toBe(c);
  });

  it.each(SHELLS.map((s) => [s.bg, s] as const))("shell %s: the selection ring and live edge reach 3:1 against the gap and the shell", (_bg, s) => {
    const w = worst((c) => {
      const mark = mixHex(c, s.text, MEMBER_MARK_SHARE);
      return Math.min(contrastRatio(mark, s.gap)!, contrastRatio(mark, s.bg)!);
    });
    expect(w.ratio, `worst shade ${w.colour}`).toBeGreaterThanOrEqual(3);
  });
});

describe("what a person types as a custom colour", () => {
  it("takes six hex digits with or without # and stores lower case #rrggbb", () => {
    expect(parseCustomClassColour("#1A2B3C")).toBe("#1a2b3c");
    expect(parseCustomClassColour("1a2b3c")).toBe("#1a2b3c");
    expect(parseCustomClassColour("  #ABCDEF ")).toBe("#abcdef");
  });

  it.each(["", "#", "#12345", "1234567", "#1234567", "#abc", "fff", "#12345g", "red", "#11223344", "##123456", "rgb(1,2,3)"])(
    "refuses %j",
    (v) => expect(parseCustomClassColour(v)).toBeNull(),
  );
});

describe("one colour in any letter case", () => {
  it("compares case-insensitively; null equals only null", () => {
    expect(sameClassColour("#3B82F6", "#3b82f6")).toBe(true);
    expect(sameClassColour("#3b82f6", "#3b82f7")).toBe(false);
    expect(sameClassColour(null, undefined)).toBe(true);
    expect(sameClassColour(null, "#3b82f6")).toBe(false);
  });

  it("a typed preset becomes that preset's own value; the saved colour stays as stored; anything else as given", () => {
    for (const c of CLASS_COLOURS) expect(canonicalClassColour(c.value.toUpperCase(), null)).toBe(c.value);
    expect(canonicalClassColour("#abcdef", "#ABCDEF")).toBe("#ABCDEF");
    expect(canonicalClassColour("#3b82f6", "#3B82F6")).toBe("#3B82F6");
    expect(canonicalClassColour("#123456", "#abcdef")).toBe("#123456");
  });
});
