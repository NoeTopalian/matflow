// lf-2, 30 Sep 2026: the club colour as text on the dark member shell read
// 2.5–2.7:1 ("PINNED", "This week", "Next class"). legibleInk lifts it just
// far enough to read, keeps its hue, and leaves a passing colour alone.
import { describe, it, expect } from "vitest";
import { legibleInk } from "@/lib/color";

function lum(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("legibleInk", () => {
  it("lifts a dark club blue on the dark shell to at least 4.5:1", () => {
    for (const blue of ["#1d4ed8", "#3b82f6", "#dc2626", "#6366f1"]) {
      const ink = legibleInk(blue, "#111111");
      expect(ratio(ink, "#111111"), blue).toBeGreaterThanOrEqual(4.5);
      expect(ink).not.toBe("#ffffff"); // still the club's colour, not plain white
    }
  });

  it("darkens toward black on a light shell", () => {
    const ink = legibleInk("#60a5fa", "#f8fafc");
    expect(ratio(ink, "#f8fafc")).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves a colour that already reads unchanged", () => {
    expect(legibleInk("#fbbf24", "#111111")).toBe("#fbbf24");
  });

  it("returns the input when either colour cannot be parsed", () => {
    expect(legibleInk("not-a-colour", "#111111")).toBe("not-a-colour");
  });
});
