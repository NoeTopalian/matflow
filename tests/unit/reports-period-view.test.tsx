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
    churn: { cancelled: 2, joined: 9, net: 7, opening: 31, base: 40, ratePct: 5 },
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
    // Churn: the percentage with its counts, and the cancellations worded for the period, under the title "Churn" (owner, 27 and 31 Oct 2026).
    const churn = screen.getByRole("link", { name: "Churn: 5% (2 of 40), 2 cancellations in the last 3 months — see the members behind this number" });
    expect([...churn.querySelectorAll("p")].map((p) => p.textContent).slice(0, 3)).toEqual(["5% (2 of 40)", "Churn", "2 cancellations in the last 3 months, of 40 members"]);
    // The full wording, under "What counts" beside the link (31 Oct 2026).
    expect(within(churn.closest("[data-testid='metric-card']") as HTMLElement).getByTestId("metric-card-more").textContent).toBe("What counts2 cancellations in the last 3 months, out of 40 members (31 at the start, 9 became members since) · Every cancellation in the period, including people who joined during it. Finished prepaid courses are not churn (they are in Left). Club-wide");
    expect(churn.getAttribute("href")).toBe("/dashboard/members?filter=churned-this-month&from=2026-08&to=2026-10");
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

  it("picking a month picks a custom run the server will accept", () => {
    render(<ReportsView data={report({ period: "3m" })} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    // To moved before From (Aug): From follows it back, so the run is never inverted.
    fireEvent.change(screen.getByLabelText("Period to month"), { target: { value: "2026-07" } });
    const url = new URL(replaceMock.mock.calls[0][0], "https://x.test");
    expect([url.searchParams.get("period"), url.searchParams.get("from"), url.searchParams.get("to")]).toEqual(["custom", "2026-07", "2026-07"]);
  });

  it("the month lists offer only real months, newest first, ending with this month", () => {
    render(<ReportsView data={report({})} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    const options = [...(screen.getByLabelText("Period to month") as HTMLSelectElement).options].map((o) => o.value);
    expect(options[0]).toBe("2026-10");
    expect(options).toHaveLength(36);
    expect(options).not.toContain("2026-11");
  });

  it("a preset choice carries its months, so the page can show them before the server answers", async () => {
    const { default: PeriodSelector } = await import("@/components/dashboard/PeriodSelector");
    const onSelect = vi.fn();
    render(<PeriodSelector shown={{ period: "this-month", from: "2026-10", to: "2026-10" }} latestMonth="2026-10" timeZone={LONDON} onSelect={onSelect} />);
    fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "3m" } });
    expect(onSelect).toHaveBeenCalledWith({ period: "3m", from: "2026-08", to: "2026-10" });
  });

  it("the CSV states the period and uses its words", () => {
    const csv = reportsCsv(report({ period: "3m" }), ATTRIBUTION as never);
    expect(csv).toContain("Report,Period,Aug – Oct 2026,");
    expect(csv).toContain('Health,Churn in the last 3 months,5% (2 of 40),"2 cancellations in the last 3 months, out of 40 members (31 at the start, 9 became members since) · ');
    // The detail has commas in it, so the cell is quoted.
    // The change against the period before, worded by lib/report-period periodChange (W3 + #48).
    expect(csv).toContain('Summary,New members in the last 3 months,7,"Change +75% (7 so far in the last 3 months vs 4 all the 3 months before)');
  });
});

describe("the CSV marks the chart's context weeks (re-review 26 Oct 2026)", () => {
  it("a week before the period says it is shown for context; a week inside it does not", () => {
    const data = report({});
    data.attendanceBucket = "week";
    data.weeklyAttendance = [
      { week: "21 Sep", count: 4, isCurrentWeek: false, inPeriod: false },
      { week: "26 Oct", count: 6, isCurrentWeek: true, inPeriod: true },
    ];
    const csv = reportsCsv(data, ATTRIBUTION as never);
    expect(csv).toContain("Weekly attendance,21 Sep,4,Outside the period (shown for context)");
    expect(csv).toContain("Weekly attendance,26 Oct,6,Current week");
  });
});

describe("Analysis with a period", () => {
  const metrics = (period: Parameters<typeof resolveReportPeriod>[0]) => ({
    totalMembers: 20, newThisMonth: 3, newLastMonth: 2, checkinsThisMonth: 50, checkinsLastMonth: 40,
    activeClasses: 4, activeMembersThisMonth: 10, gymName: "Test club",
    range: resolveReportPeriod(period, NOW, LONDON),
    monthLabel: resolveReportPeriod(period, NOW, LONDON).label,
  });

  it("the report and the interview use the period's words", async () => {
    const { buildReport, questionsFor } = await import("@/components/dashboard/AnalysisView");
    const text = buildReport(metrics({ period: "3m" }), []);
    expect(text).toContain("# Analysis — Aug – Oct 2026");
    expect(text).toContain("**3 joined** (new + rejoined) in the last 3 months, compared to 2 the 3 months before");
    expect(questionsFor(resolveReportPeriod({ period: "3m" }, NOW, LONDON))[0]).toBe("How many new members joined through word-of-mouth or referrals in the last 3 months?");
    // The default reads as it always has.
    expect(buildReport(metrics({}), [])).toContain("# Monthly Analysis — October 2026");
  });

  it("choosing a period on Analysis asks for it on the Analysis page", async () => {
    const { default: AnalysisView } = await import("@/components/dashboard/AnalysisView");
    render(<AnalysisView metrics={metrics({})} primaryColor="#3b82f6" />);
    fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "12m" } });
    const url = new URL(replaceMock.mock.calls[0][0], "https://x.test");
    expect(url.pathname).toBe("/dashboard/analysis");
    expect(url.searchParams.get("period")).toBe("12m");
  });
});

describe("Payment Health follows the period (review 26 Oct 2026)", () => {
  it("shows failed payments in the period, not the fixed 30 days", () => {
    const data = report({ period: "12m" });
    data.paymentHealth = { ...data.paymentHealth, failedInPeriod: 7, failedLast30Days: 1 };
    render(<ReportsView data={data} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(screen.getByTestId("reports-failed-in-period").textContent).toBe("7");
    expect(screen.getByText("Failed in the last 12 months")).toBeTruthy();
    expect(reportsCsv(data, ATTRIBUTION as never)).toContain("Payments,Failed payments in the last 12 months,7,");
  });
});
