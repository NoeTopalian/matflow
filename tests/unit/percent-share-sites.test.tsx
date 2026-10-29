// @vitest-environment jsdom
/** Review L6 round 2: every share formatter rounds half-up (29 of 200 -> 15, 14.5 at one decimal). */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: vi.fn() }));
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Nothing = () => null;
  return { ResponsiveContainer: Pass, PieChart: Pass, Pie: Pass, Cell: Nothing, Tooltip: Nothing };
});

import { pctOf } from "@/components/dashboard/ConversionFunnel";
import { computeRate, MIN_TRIALS_FOR_RATE } from "@/lib/attribution";
import { DonutLegend } from "@/components/dashboard/charts/DonutChart";

describe("share formatters round half-up", () => {
  it("ConversionFunnel pctOf: 29 of 200 -> 15%", () => {
    expect(pctOf(29, 200, 5)).toBe("15% (29 of 200)");
  });

  it("attribution computeRate keeps one decimal: 29 of 200 -> 14.5, 1 of 2000 -> 0.1", () => {
    expect(MIN_TRIALS_FOR_RATE).toBeLessThanOrEqual(200);
    expect(computeRate(200, 29)).toBe(14.5);
    expect(computeRate(2000, 1)).toBe(0.1);
    expect(computeRate(400, 201)).toBe(50.3); // 50.25 exactly; divide-first gave 50.2
  });

  // G1 (27 Oct 2026): the legend has one form, "x% (n of m)". The legacy
  // "29 (15%)" form, which had no base, is gone.
  it("DonutChart legend: 29 of 200 -> 15% (29 of 200)", () => {
    render(
      <DonutLegend
        data={[
          { label: "A", value: 29, color: "#111" },
          { label: "B", value: 171, color: "#222" },
        ]}
      />,
    );
    const ratios = screen.getAllByTestId("donut-legend-ratio").map((el) => el.textContent);
    expect(ratios).toEqual(["15% (29 of 200)", "86% (171 of 200)"]);
    expect(screen.getByText("A").closest("li")!.textContent).toBe("A15% (29 of 200)");
  });

  it("DonutChart legend: an empty donut reads '—', never 0% or NaN%", () => {
    render(<DonutLegend data={[{ label: "A", value: 0, color: "#111" }, { label: "B", value: 0, color: "#222" }]} />);
    expect(screen.getAllByTestId("donut-legend-ratio").map((el) => el.textContent)).toEqual(["—", "—"]);
  });
});
