// Verifier lane 2 (30 Sep 2026): the member portal's colour tokens live on
// #member-app, and overlays portalled to <body> drew in the staff (light)
// theme — a white sheet in the dark portal. Overlays attach inside
// #member-app when it exists, and to <body> otherwise (staff pages).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("overlay portal target", () => {
  it("portals into the themed member root when present", () => {
    const s = readFileSync(join(process.cwd(), "components/ui/overlay.tsx"), "utf8");
    expect(s.includes('document.getElementById("member-app") ?? document.body')).toBe(true);
  });
  it("the member root keeps an id the overlay can find", () => {
    const s = readFileSync(join(process.cwd(), "app/member/layout.tsx"), "utf8");
    expect(s).toMatch(/id="member-app"/);
  });
});
