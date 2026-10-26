// @vitest-environment jsdom
// The Reports period on screen (Noe, 26 Oct 2026): one selector, every period
// card names the same months, the default reads exactly as before, a custom
// run never asks the server for something it would refuse, and the
// drill-throughs carry the whole run.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import React from "react";

const replaceMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams("weeks=12&classId=c1"),
}));
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, LineChart: Pass, PieChart: Pass,
    Bar: Pass, Line: Nothing, Pie: Pass, Cell: Nothing, XAxis: Nothing, YAxis: Nothing,
    Tooltip: Nothing, CartesianGrid: Nothing, ReferenceArea: Nothing,
  };
});
vi.mock("@/components/dashboard/MonthlyReportView", () => ({ default: () => null }));
vi.mock("@/components/dashboard/InitiativesPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/ConversionFunnel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/NetNewMembersCard", () => ({ default: () => null }));
vi.mock("@/components/dashboard/charts/Sparkline", () => ({ default: () => null }));

import ReportsView, { monthDrillHref, reportsCsv } from "@/components/dashboard/ReportsView";
import { customRun, periodWords, resolveReportPeriod } from "@/lib/report-period";
import { createEmptyReportsData, type ReportsData } from "@/lib/reports";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const LONDON = "Europe/London";
const ATTRIBUTION = { rows: [], overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null }, epochStart: null, minTrials: 5 };

function report(period: Parameters<typeof resolveReportPeriod>[0]): ReportsData {
  const base = createEmptyReportsData();
  return {
    ...base,
    range: resolveReportPeriod(period, NOW, LONDON),
    summary: { ...base.summary, newMembersThisMonth: 7, newMembersLastMonth: 4 },
    churn: { ratePct: 5, cancelled: 2, base: 40, joined: 9, net: 7 },
    periodMovement: {
      totals: { new: 7, rejoined: 2, lost: 2, lostCancelled: 2, lostCompleted: 0, net: 7, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 1 },
      basis: "recorded",
      previousBasis: "recorded",
    },
  };
}

beforeEach(() => {
  replaceMock.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("periodWords", () => {
  it("the default reads exactly as the page always has", () => {
    expect(periodWords(resolveReportPeriod({}, NOW, LONDON))).toMatchObject({ during: "this month", before: "last month" });
  });
  it.each([
    ["last-month", "last month", "the month before"],
    ["3m", "in the last 3 months", "the 3 months before"],
    ["12m", "in the last 12 months", "the 12 months before"],
  ])("%s → %s / %s", (period, during, before) => {
    expect(periodWords(resolveReportPeriod({ period }, NOW, LONDON))).toMatchObject({ during, before });
  });
  it("a custom run names its months", () => {
    expect(periodWords(resolveReportPeriod({ period: "custom", from: "2026-01", to: "2026-06" }, NOW, LONDON)).during).toBe("in Jan – Jun 2026");
  });
});

describe("customRun", () => {
  it("moving From past To pulls To along; moving To before From pulls From back", () => {
    expect(customRun("2026-08", "2026-03", "from", "2026-10")).toEqual({ from: "2026-08", to: "2026-08" });
    expect(customRun("2026-08", "2026-03", "to", "2026-10")).toEqual({ from: "2026-03", to: "2026-03" });
  });
  it("never passes this month", () => {
    expect(customRun("2026-09", "2027-02", "to", "2026-10")).toEqual({ from: "2026-09", to: "2026-10" });
  });
  it("keeps the run within 24 months by moving the other end", () => {
    expect(customRun("2023-01", "2026-10", "from", "2026-10")).toEqual({ from: "2023-01", to: "2024-12" });
    expect(customRun("2023-01", "2026-10", "to", "2026-10")).toEqual({ from: "2024-11", to: "2026-10" });
  });
});

describe("monthDrillHref", () => {
  it("one month carries `month`; several carry the whole run as from/to", () => {
    expect(monthDrillHref("new-this-month", undefined, resolveReportPeriod({ period: "last-month" }, NOW, LONDON))).toBe("/dashboard/members?filter=new-this-month&month=2026-09");
    expect(monthDrillHref("lost-this-month", undefined, resolveReportPeriod({ period: "3m" }, NOW, LONDON))).toBe("/dashboard/members?filter=lost-this-month&from=2026-08&to=2026-10");
  });
});

describe("ReportsView with a period", () => {
  it("every period card names the same months; the selector and month pickers show the period", () => {
    render(<ReportsView data={report({ period: "3m" })} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect((screen.getByLabelText("Reporting period") as HTMLSelectElement).value).toBe("3m");
    expect((screen.getByLabelText("Period from month") as HTMLInputElement).value).toBe("2026-08");
    expect((screen.getByLabelText("Period to month") as HTMLInputElement).value).toBe("2026-10");
    expect(screen.getByText("New in the last 3 months", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Churn rate in the last 3 months", { selector: "p" })).toBeTruthy();
    const joined = screen.getByTestId("reports-joined-tile");
    expect(within(joined).getByText("Joined in the last 3 months (new + rejoined)")).toBeTruthy();
    expect(screen.getByTestId("reports-joined-net").textContent).toBe("Net +7 in the last 3 months (new + rejoined − left)");
    expect(screen.getByTestId("reports-joined-new-this-month").textContent).toBe("New7");
    expect(screen.getByTestId("reports-joined-new-this-month").getAttribute("href")).toBe("/dashboard/members?filter=new-this-month&from=2026-08&to=2026-10");
  });

  it("choosing a preset asks for that period and drops the old weeks parameter, keeping the other filters", () => {
    render(<ReportsView data={report({})} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "6m" } });
    expect(replaceMock).toHaveBeenCalledTimes(1);
    const url = new URL(replaceMock.mock.calls[0][0], "https://x.test");
    expect(url.searchParams.get("period")).toBe("6m");
    expect(url.searchParams.has("weeks")).toBe(false);
    expect(url.searchParams.get("classId")).toBe("c1");
  });

  it("editing a month picks a custom run the server will accept", () => {
    render(<ReportsView data={report({ period: "3m" })} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    fireEvent.change(screen.getByLabelText("Period from month"), { target: { value: "2026-11" } });
    const url = new URL(replaceMock.mock.calls[0][0], "https://x.test");
    // November is after this month: both ends stay at this month.
    expect([url.searchParams.get("period"), url.searchParams.get("from"), url.searchParams.get("to")]).toEqual(["custom", "2026-10", "2026-10"]);
  });

  it("the CSV states the period and uses its words", () => {
    const csv = reportsCsv(report({ period: "3m" }), ATTRIBUTION as never);
    expect(csv).toContain("Report,Period,Aug – Oct 2026,");
    expect(csv).toContain("Health,Churn in the last 3 months,5% (2 of 40),");
    // The detail has commas in it, so the cell is quoted.
    expect(csv).toContain('Summary,New members in the last 3 months,7,"The 3 months before: 4');
  });
});
