// @vitest-environment jsdom
/**
 * G1 (27 Oct 2026; Sean, relayed 14 Oct: counts "with all times a % is
 * present"; owner instruction of 24 Oct 2026). Every percentage a person
 * reads carries its count and base, "42% (21 of 50)"; an empty base reads
 * "—", never "0%" or "NaN%"; a percentage change carries the two figures it
 * compares, "+12% (56 vs 50)". One test per surface this change touched:
 *
 *   - lib/percent.ts: the shared text helpers (screens and server alike);
 *   - the conversion funnel (Reports and /dashboard/attribution): bars and coach rows;
 *   - the attribution table's Conversion column;
 *   - the Reports CSV's conversion-funnel rows.
 *
 * Scope (owner decision, 27 Oct 2026, 23:30): the Reports and statistics
 * section only — Reports, Analysis and Conversion. The AI monthly-report
 * prompt and the attendance-import progress line are outside it; their
 * changes were reverted and are listed as residuals, not tested here.
 *
 * The donut legend (Reports, Analysis) is in percent-share-sites.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import {
  formatChange,
  formatGuardedRatio,
  formatGuardedRatioNote,
  formatPct,
  formatRatio,
  pctChange,
  ratioCounts,
} from "@/lib/percent";
import * as primitives from "@/components/dashboard/reports-primitives";
import ConversionFunnel from "@/components/dashboard/ConversionFunnel";
import AttributionView from "@/components/dashboard/AttributionView";
import { reportsCsv, trendDelta } from "@/components/dashboard/ReportsView";
import { changePillText } from "@/components/dashboard/AnalysisView";
import { buildFunnel, MIN_TRIALS_FOR_RATE, type AttributionData, type StaffConversionRow } from "@/lib/attribution";
import { createEmptyReportsData } from "@/lib/reports";

function row(over: Partial<StaffConversionRow> & Pick<StaffConversionRow, "userId" | "name">): StaffConversionRow {
  return {
    trialsRun: 0, signUps: 0, conversions: 0, conversionRate: null, lost: 0, undecided: 0,
    retained: 0, churned: 0, retentionRate: null,
    ...over,
  };
}

// Marco: 40 trials, 5 converted (12.5%), 4 of them still active (80%).
// Priya: 2 trials, under the minimum: N/A, with her counts.
// Sam: 4 trials, none converted, so "still active" has no base: "—".
// Lee: sign-ups only, no trial: no rate at all.
const ROWS: StaffConversionRow[] = [
  row({ userId: "a", name: "Marco Silva", trialsRun: 40, conversions: 5, conversionRate: 12.5, lost: 20, undecided: 15, retained: 4, churned: 1, retentionRate: 80 }),
  row({ userId: "s", name: "Sam Kerr", trialsRun: 4, conversions: 0, conversionRate: 0, lost: 4, undecided: 0, retained: 0, churned: 0, retentionRate: null }),
  row({ userId: "b", name: "Priya Nair", trialsRun: 2, conversions: 1, conversionRate: null, lost: 0, undecided: 1, retained: 1, churned: 0, retentionRate: null }),
  row({ userId: "l", name: "Lee Park", signUps: 3 }),
];
const ATTRIBUTION: AttributionData = {
  rows: ROWS,
  overall: buildFunnel(ROWS),
  epochStart: "2026-09-01T00:00:00.000Z",
  minTrials: MIN_TRIALS_FOR_RATE,
};

describe("lib/percent text helpers", () => {
  it("a rate reads 'x% (n of m)'; an empty base or undefined rate reads '—'", () => {
    expect(formatRatio(42, 21, 50)).toBe("42% (21 of 50)");
    expect(formatRatio(12.5, 5, 40)).toBe("12.5% (5 of 40)");
    expect(formatRatio(50, 617, 1234)).toBe("50% (617 of 1,234)");
    expect(formatRatio(0, 0, 0)).toBe("—");
    expect(formatRatio(null, 3, 10)).toBe("—");
    expect(formatRatio(Number.NaN, 3, 10)).toBe("—");
    expect(formatPct(0, 0)).toBe("—");
    expect(ratioCounts(1, 10)).toBe("(1 of 10)");
  });

  it("the Reports primitives re-export the same functions, so screens and server print one text", () => {
    expect(primitives.formatRatio).toBe(formatRatio);
    expect(primitives.formatPct).toBe(formatPct);
    expect(primitives.ratioCounts).toBe(ratioCounts);
  });

  it("a percentage change reads '+12% (56 vs 50)'; nothing to compare against reads '— (56 vs 0)'", () => {
    expect(formatChange(56, 50)).toBe("+12% (56 vs 50)");
    expect(formatChange(48, 50)).toBe("-4% (48 vs 50)");
    expect(formatChange(50, 50)).toBe("0% (50 vs 50)");
    expect(formatChange(1500, 1000)).toBe("+50% (1,500 vs 1,000)");
    // W3 (owner decision, 27 Oct 2026, 23:30): no percentage, the counts kept.
    expect(formatChange(56, 0)).toBe("— (56 vs 0)");
  });

  it("a guarded rate: the counts always, the percentage only above the minimum, '—' with no base", () => {
    expect(formatGuardedRatio(12.5, 5, 40)).toBe("12.5% (5 of 40)");
    expect(formatGuardedRatio(null, 1, 2)).toBe("N/A · too few (1 of 2)");
    expect(formatGuardedRatio(null, 0, 0)).toBe("—");
    expect(formatGuardedRatioNote(12.5, 5, 40, "of trials")).toBe("12.5% (5 of 40) of trials");
    expect(formatGuardedRatioNote(null, 1, 2, "of trials")).toBe("N/A · too few (1 of 2)");
    expect(formatGuardedRatioNote(null, 0, 0, "of converted")).toBe("—");
  });
});

describe("conversion funnel (Reports and /dashboard/attribution)", () => {
  it("the club-wide bars print each rate with its counts", () => {
    // Overall: 46 trials, 6 converted (13%), 5 of them still active (83.3%).
    render(<ConversionFunnel data={ATTRIBUTION} linkRows={false} />);
    expect(screen.getByText("13% (6 of 46) of trials")).toBeTruthy();
    expect(screen.getByText("83.3% (5 of 6) of converted")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d\.0%|NaN/);
  });

  it("each coach row prints the rate with its counts, N/A with counts under the minimum, and '—' with no base", () => {
    render(<ConversionFunnel data={ATTRIBUTION} linkRows={false} />);
    const list = screen.getByRole("list", { name: "Conversion funnel by coach" });
    const items = within(list).getAllByRole("listitem");
    const text = (name: string) => items.find((li) => li.textContent?.includes(name))!.textContent;
    expect(text("Marco Silva")).toContain("Converted12.5% (5 of 40)");
    expect(text("Marco Silva")).toContain("Still active80% (4 of 5)");
    expect(text("Sam Kerr")).toContain("Converted0% (0 of 4)");
    expect(text("Sam Kerr")).toContain("Still active—");
    expect(text("Priya Nair")).toContain("ConvertedN/A · too few (1 of 2)");
    expect(text("Priya Nair")).toContain("Still activeN/A · too few (1 of 1)");
    // Lee ran no trial, so he is not in the funnel.
    expect(items.some((li) => li.textContent?.includes("Lee Park"))).toBe(false);
  });

  it("with too few trials club-wide, the bars say N/A with the counts, never a percentage", () => {
    const few = [row({ userId: "b", name: "Priya Nair", trialsRun: 2, conversions: 0, undecided: 2 })];
    render(<ConversionFunnel data={{ ...ATTRIBUTION, rows: few, overall: buildFunnel(few) }} linkRows={false} />);
    // The bar and Priya's row both say it.
    expect(screen.getAllByText("N/A · too few (0 of 2)")).toHaveLength(2);
    // No conversions, so "still active" has no base at all.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\d%/);
  });
});

describe("attribution table, Conversion column", () => {
  it("prints '12.5% (5 of 40)', 'N/A · too few (1 of 2)' under the minimum (as the funnel does), and '—' for a coach with no trial", () => {
    render(<AttributionView data={ATTRIBUTION} />);
    const table = screen.getByRole("table");
    const cellFor = (name: string) => {
      const tr = within(table).getAllByRole("row").find((r) => r.textContent?.includes(name))!;
      const cells = within(tr).getAllByRole("cell");
      return cells[cells.length - 1].textContent;
    };
    expect(cellFor("Marco Silva")).toBe("12.5% (5 of 40)");
    expect(cellFor("Sam Kerr")).toBe("0% (0 of 4)");
    expect(cellFor("Priya Nair")).toBe("N/A · too few (1 of 2)");
    expect(cellFor("Lee Park")).toBe("—");
  });
});

describe("Reports CSV, conversion-funnel rows", () => {
  it("prints the same text as the funnel", () => {
    const csv = reportsCsv(createEmptyReportsData(), ATTRIBUTION);
    expect(csv).toContain("Conversion funnel,Converted,6,13% (6 of 46) of trials");
    expect(csv).toContain("Conversion funnel,Still active,5,83.3% (5 of 6) of converted");
    // W3: lost and no decision as shares of the coach's trials, as on screen.
    expect(csv).toContain("Conversion by coach,Marco Silva,40,converted 12.5% (5 of 40) · still active 80% (4 of 5) · lost 50% (20 of 40) · no decision 38% (15 of 40)");
    expect(csv).toContain("Conversion by coach,Sam Kerr,4,converted 0% (0 of 4) · still active — · lost 100% (4 of 4) · no decision 0% (0 of 4)");
    expect(csv).toContain("Conversion by coach,Priya Nair,2,converted N/A · too few (1 of 2) · still active N/A · too few (1 of 1) · lost 0 · no decision 1");
    expect(csv).not.toMatch(/\(N\/A\)|\d\.0%/);
  });
});

describe("one rounding rule for every change (review finding 2)", () => {
  // 229 vs 200 is exactly +14.5%. Dividing first gave 14.499999999999998 and
  // "+14%" on Reports and Analysis. (The AI report's own rounding is outside
  // the statistics section and is a listed residual, not pinned here.)
  it("229 vs 200 reads +15% on Reports and Analysis", () => {
    expect(pctChange(229, 200)).toBe(15);
    expect(formatChange(229, 200)).toBe("+15% (229 vs 200)");
    expect(trendDelta(229, 200)).toBe("+15% (229 vs 200)");
    expect(changePillText(229, 200)).toBe("+15% (229 vs 200)");
  });

  it("no change reads 0%, never +0%; a fall keeps its minus", () => {
    expect(changePillText(50, 50)).toBe("0% (50 vs 50)");
    expect(changePillText(170, 200)).toBe("-15% (170 vs 200)");
    expect(trendDelta(170, 200)).toBe("-15% (170 vs 200)");
  });
});
