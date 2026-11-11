// The class colour palette (11 Nov 2026: grey, light yellow, navy and light blue added) and how a class colour is
// made readable where it is painted. Contrast floors: 4.5:1 for text, 3:1 for marks and edges (WCAG 1.4.3, 1.4.11).
import { describe, it, expect } from "vitest";
import { CLASS_COLOURS, DEFAULT_CLASS_COLOUR, MEMBER_MARK_SHARE, classColourName, classDotStyle, classEdge, classInk, memberClassMark } from "@/lib/class-colours";
import { contrastRatio, legibleInk, markNeedsOutline, mixHex, tintOver } from "@/lib/color";

const WHITE = "#ffffff";

describe("the palette", () => {
  it("keeps the original ten colours, values and order unchanged, so no saved class changes colour", () => {
    expect(CLASS_COLOURS.slice(0, 10).map((c) => c.value)).toEqual([
      "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#6366f1",
    ]);
    expect(DEFAULT_CLASS_COLOUR).toBe("#3b82f6");
  });

  it("adds light blue, navy, grey and light yellow, each named; no value or name twice", () => {
    expect(CLASS_COLOURS.slice(10).map((c) => c.name)).toEqual(["Light blue", "Navy", "Grey", "Light yellow"]);
    expect(new Set(CLASS_COLOURS.map((c) => c.value)).size).toBe(CLASS_COLOURS.length);
    expect(new Set(CLASS_COLOURS.map((c) => c.name)).size).toBe(CLASS_COLOURS.length);
    for (const c of CLASS_COLOURS) expect(c.value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("names a palette colour whatever its case, and nothing else", () => {
    expect(classColourName("#FDE68A")).toBe("Light yellow");
    expect(classColourName("#94a3b8")).toBe("Grey");
    expect(classColourName("#123456")).toBeNull();
    expect(classColourName(null)).toBeNull();
  });
});

describe("readable wherever it is painted (every palette colour)", () => {
  it.each(CLASS_COLOURS.map((c) => [c.name, c.value]))("%s: schedule-pill text reaches 4.5:1 on its own tint", (_name, value) => {
    expect(contrastRatio(classInk(value), tintOver(value, 0.12, WHITE))!).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CLASS_COLOURS.map((c) => [c.name, c.value]))("%s: the live edge reaches 3:1 against the chip's own tint and the white outside it", (_name, value) => {
    expect(contrastRatio(classEdge(value), tintOver(value, 0.12, WHITE))!).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(classEdge(value), WHITE)!).toBeGreaterThanOrEqual(3);
  });

  it.each(CLASS_COLOURS.map((c) => [c.name, c.value]))("%s: the dot is either 3:1 on white or ringed", (_name, value) => {
    const style = classDotStyle(value);
    expect(style.background).toBe(value);
    if (contrastRatio(value, WHITE)! < 3) expect(style.boxShadow).toBe("0 0 0 1px var(--tx-3)");
    else expect(style.boxShadow).toBeUndefined();
  });

  it("light yellow and grey are the cases that needed it: unreadable as themselves, readable as painted", () => {
    for (const pale of ["#fde68a", "#94a3b8"]) {
      expect(contrastRatio(pale, tintOver(pale, 0.12, WHITE))!).toBeLessThan(4.5);
      expect(markNeedsOutline(pale)).toBe(true);
    }
    // A strong colour that already passes is left exactly as it is.
    expect(classInk("#1e3a8a")).toBe("#1e3a8a");
    expect(classEdge("#3b82f6")).toBe("#3b82f6");
  });
});

describe("member shell: the selection ring, live edge and progress bar (memberClassMark)", () => {
  // app/member/layout.tsx: the shell's text, the ring's gap (--member-elevated) and the background, per shell.
  const SHELLS = [
    { shell: "light", text: "#0f172a", gap: "#f8fafc", bg: "#ffffff" },
    { shell: "dark", text: "#ffffff", gap: "#0e1013", bg: "#111111" },
  ];
  const cases = SHELLS.flatMap((s) => CLASS_COLOURS.map((c) => [s.shell, c.name, c.value, s] as const));
  it.each(cases)("%s shell, %s: the mark reaches 3:1 against the gap beside it and the shell behind it", (_shell, _name, value, s) => {
    const mark = mixHex(value, s.text, MEMBER_MARK_SHARE);
    expect(contrastRatio(mark, s.gap)!).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(mark, s.bg)!).toBeGreaterThanOrEqual(3);
  });

  it("is a half-and-half CSS mix with the shell's text colour", () => {
    expect(MEMBER_MARK_SHARE).toBe(0.5);
    expect(memberClassMark("#fde68a")).toBe("color-mix(in srgb, #fde68a 50%, var(--member-text) 50%)");
  });

  it("light yellow at the old 60 % share failed on the light shell (the review's case)", () => {
    expect(contrastRatio(mixHex("#fde68a", "#0f172a", 0.6), "#f8fafc")!).toBeLessThan(3);
  });
});

describe("colour maths", () => {
  it("contrast of black on white is 21:1, of a colour on itself 1:1; unreadable input is null", () => {
    expect(contrastRatio("#000000", WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio("#3b82f6", "#3b82f6")).toBeCloseTo(1, 5);
    expect(contrastRatio("blue", WHITE)).toBeNull();
  });

  it("one parser: an 8-digit colour reads as its first six digits everywhere, legibleInk included", () => {
    expect(contrastRatio("#000000ff", WHITE)).toBeCloseTo(21, 5);
    expect(tintOver("#000000ff", 0.5, WHITE)).toBe("#808080");
    expect(markNeedsOutline("#1e3a8aff")).toBe(false);
    expect(legibleInk("#1e3a8aff", WHITE)).toBe("#1e3a8aff");
  });

  it("a tint over white is the alpha blend; full alpha is the colour itself", () => {
    expect(tintOver("#000000", 0.5, WHITE)).toBe("#808080");
    expect(tintOver("#fde68a", 1, WHITE)).toBe("#fde68a");
    expect(tintOver("#fde68a", 0, WHITE)).toBe("#ffffff");
  });
});
