import { describe, expect, it } from "vitest";
import { isLightShell, memberNavInk } from "@/app/member/nav-ink";

/**
 * The member tab bar's inactive label is 10px text (app/member/layout.tsx:494-499),
 * so WCAG 1.4.3 asks for 4.5:1 — "large text" starts at 18.66px bold / 24px and
 * this is neither. The campaign's browser sweep measured the shipped ink at
 * **2.43:1** on the seeded club ("Schedule", lf-2-pages-and-push.spec.ts:326).
 *
 * This test is that measurement without a browser: composite the ink's wash
 * over the bar, composite the bar over the club's background, and grade the
 * pair the way a browser paints them. Alpha is not optional — the ink AND the
 * bar are both washes, and dropping either alpha is how a 2.43:1 label reads
 * as legible on paper.
 */

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "").slice(0, 6);
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** `rgba(r,g,b,a)` or `#rrggbb`/`#rrggbbaa` → colour + alpha. */
function parseColour(c: string): { rgb: Rgb; a: number } {
  if (c.startsWith("#")) {
    const body = c.replace("#", "");
    const a = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;
    return { rgb: parseHex(body), a };
  }
  const parts = c.match(/-?\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) throw new Error(`unparseable colour: ${c}`);
  const [r, g, b] = parts.slice(0, 3).map(Number);
  return { rgb: { r, g, b }, a: parts.length > 3 ? Number(parts[3]) : 1 };
}

function over(fg: { rgb: Rgb; a: number }, bg: Rgb): Rgb {
  return {
    r: fg.rgb.r * fg.a + bg.r * (1 - fg.a),
    g: fg.rgb.g * fg.a + bg.g * (1 - fg.a),
    b: fg.rgb.b * fg.a + bg.b * (1 - fg.a),
  };
}

function luminance(c: Rgb): number {
  const [r, g, b] = [c.r, c.g, c.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What the inactive tab label actually measures on a club with this background. */
function inactiveLabelContrast(appBg: string): number {
  const ink = memberNavInk(appBg);
  const bar = over(parseColour(ink.navBg), parseHex(appBg));
  const label = over(parseColour(ink.inactiveCol), bar);
  return Math.round(ratio(label, bar) * 100) / 100;
}

describe("the member tab bar's inactive ink", () => {
  it("clears 4.5:1 on every light tenant background, white included", () => {
    for (const bg of ["#ffffff", "#f8fafc", "#f5f5f4", "#eef2ff", "#e2e8f0"]) {
      expect(isLightShell(bg), `${bg} is a light shell`).toBe(true);
      expect(inactiveLabelContrast(bg), `inactive tab label on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("clears 4.5:1 on every dark tenant background, black included", () => {
    for (const bg of ["#000000", "#111111", "#0a0a0a", "#1e1b4b"]) {
      expect(isLightShell(bg), `${bg} is a dark shell`).toBe(false);
      expect(inactiveLabelContrast(bg), `inactive tab label on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("stays subordinate to the active tab — it is muted, not full-strength ink", () => {
    // The point of the fix is legibility, not a bar of four identical labels:
    // the inactive ink must still be weaker than the shell's own body text
    // (#0f172a on light, #ffffff on dark — layout.tsx:189-190).
    const light = memberNavInk("#ffffff");
    const dark = memberNavInk("#111111");
    expect(parseColour(light.inactiveCol).a).toBeLessThan(1);
    expect(parseColour(dark.inactiveCol).a).toBeLessThan(1);
    expect(inactiveLabelContrast("#ffffff")).toBeLessThan(ratio(parseHex("#0f172a"), parseHex("#ffffff")));
  });

  it("keeps the light/dark rule the rest of the portal is themed against", () => {
    // The luma threshold moved file, so prove it did not move value: 160 on
    // the ITU-R BT.601 weights, the rule app/member/layout.tsx applied inline.
    expect(isLightShell("#a1a1a1")).toBe(true);  // luma 161 — just light
    expect(isLightShell("#a0a0a0")).toBe(false); // luma 160 exactly — the rule is `> 160`
  });
});
