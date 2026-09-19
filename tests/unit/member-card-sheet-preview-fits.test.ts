import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * The A4 sheet must not drag the whole page sideways on a narrow screen.
 *
 * Evidence this exists to hold (round-2 campaign log, lane L-C):
 *
 *     Error: card sheet as owner at 768: [scrollWidth, innerWidth] at 768px
 *     - 768
 *     + 794
 *
 * 210mm is 793.7px. The card is a physical object and the preview is
 * deliberately true size — shrinking it would move the cut line away from
 * where the guillotine actually falls — so the fix is to give the sheets their
 * own scrolling band rather than to resize them. The page then holds still and
 * the Print button, the mode toggles and the member picker stay under the
 * pointer at 768 and below.
 *
 * WHY THIS TEST IS SOURCE-SHAPED. The assertion that really matters is a
 * layout one, and it is already written where a layout engine exists:
 * tests/e2e/campaign/assess/lc-3-import-photos-cards.spec.ts:390 and :416
 * assert `[document.documentElement.scrollWidth, window.innerWidth]` equals
 * `[768, 768]` on this screen, in both render modes. jsdom has no layout, so a
 * Vitest render could not tell the fixed version from the broken one — it
 * would pass either way, which is worse than not existing. What Vitest CAN
 * hold, and what it holds here, is that the mechanism is not quietly deleted:
 * the band exists, it scrolls on screen, it is switched back off for print,
 * and the sheets are inside it.
 */
const SOURCE = readFileSync(
  resolve(process.cwd(), "components/print/MemberCardSheet.tsx"),
  "utf8",
);

describe("MemberCardSheet — the A4 preview is contained on screen", () => {
  it("declares a scrolling band for the sheets", () => {
    const rule = SOURCE.match(/\.card-sheet-preview\s*\{[^}]*\}/);
    expect(rule, ".card-sheet-preview must be declared").not.toBeNull();
    expect(rule![0]).toMatch(/overflow-x:\s*auto/);
  });

  it("puts the band back to visible for print, so no card can be clipped", () => {
    const printBlock = SOURCE.match(/@media print \{[\s\S]*?\n\s{8}\}/);
    expect(printBlock, "the @media print block must still exist").not.toBeNull();
    expect(printBlock![0]).toMatch(/\.card-sheet-preview\s*\{\s*overflow:\s*visible/);
  });

  it("wraps the sheets in the band, not merely beside them", () => {
    const wrapAt = SOURCE.indexOf('<div className="card-sheet-preview">');
    const sheetsAt = SOURCE.indexOf("{sheets.map(");
    expect(wrapAt, "the band is rendered").toBeGreaterThan(-1);
    expect(sheetsAt, "the sheets are rendered").toBeGreaterThan(-1);
    expect(sheetsAt, "the sheets are inside the band").toBeGreaterThan(wrapAt);
  });

  it("keeps the paper at true size — the preview must never lie about the cut", () => {
    const page = SOURCE.match(/\.card-sheet-page\s*\{[^}]*\}/);
    expect(page![0], "210mm, unchanged: a scaled preview misplaces the guillotine line").toMatch(/width:\s*210mm/);
    const card = SOURCE.match(/\.card-sheet-card\s*\{[^}]*\}/);
    expect(card![0]).toMatch(/height:\s*148\.5mm/);
  });
});
