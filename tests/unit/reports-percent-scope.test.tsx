// @vitest-environment jsdom
/**
 * W3 (owner decision, 27 Oct 2026, 23:30): in the Reports and statistics
 * section (Reports, Analysis, Conversion), meaningful counts and percentages
 * belong together.
 *
 *   - A percentage carries its counts and a named denominator or comparison.
 *   - A count that is a share of a named population carries its percentage
 *     ("12 on hold · 9% of 130 active").
 *   - A standalone total has no percentage (no artificial 100%).
 *   - Zero previous: no percentage, "—" with the counts. Unknown: "—".
 *   - A part period against a whole one says so.
 *
 * Every assertion below pins the exact text a person reads. The behavioural
 * ones fail on 013426f6 (draft PR #50) and pass after this change.
 */
import { resolveReportPeriod, windowLabelOf } from "@/lib/report-period";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/reports",
}));
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, LineChart: Pass, PieChart: Pass, ComposedChart: Pass,
    Bar: Pass, Line: Nothing, Pie: Pass, Cell: Nothing, XAxis: Nothing, YAxis: Nothing, Area: Nothing,
    Tooltip: Nothing, CartesianGrid: Nothing, ReferenceLine: Nothing, ReferenceArea: Nothing,
  };
});
vi.mock("@/components/dashboard/MonthlyReportView", () => ({ default: () => null }));
vi.mock("@/components/dashboard/InitiativesPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/NetNewMembersCard", () => ({ default: () => null }));
vi.mock("@/components/dashboard/charts/Sparkline", () => ({ default: () => null }));

import { formatChange, MONTH_SO_FAR, WEEK_SO_FAR } from "@/lib/percent";
import ReportsView, { activeMembersDetail, activeMembersShort, reportsCsv, trendDelta } from "@/components/dashboard/ReportsView";
import ConversionFunnel from "@/components/dashboard/ConversionFunnel";
import AnalysisView from "@/components/dashboard/AnalysisView";
import { createEmptyReportsData, type ReportsData } from "@/lib/reports";
import { POPULATION_COPY } from "@/lib/member-population";
import { buildFunnel, MIN_TRIALS_FOR_RATE, type AttributionData, type StaffConversionRow } from "@/lib/attribution";

afterEach(() => cleanup());

function row(over: Partial<StaffConversionRow> & Pick<StaffConversionRow, "userId" | "name">): StaffConversionRow {
  return {
    trialsRun: 0, signUps: 0, conversions: 0, conversionRate: null, lost: 0, undecided: 0,
    retained: 0, churned: 0, retentionRate: null,
    ...over,
  };
}

// Overall: 46 trials, 24 lost, 16 no decision, 6 converted, 1 no longer active, 5 still active.
const ROWS: StaffConversionRow[] = [
  row({ userId: "a", name: "Marco Silva", trialsRun: 40, conversions: 5, conversionRate: 12.5, lost: 20, undecided: 15, retained: 4, churned: 1, retentionRate: 80 }),
  row({ userId: "s", name: "Sam Kerr", trialsRun: 4, conversions: 0, conversionRate: 0, lost: 4, undecided: 0, retained: 0, churned: 0, retentionRate: null }),
  row({ userId: "b", name: "Priya Nair", trialsRun: 2, conversions: 1, conversionRate: null, lost: 0, undecided: 1, retained: 1, churned: 0, retentionRate: null }),
];
const ATTRIBUTION: AttributionData = { rows: ROWS, overall: buildFunnel(ROWS), epochStart: null, minTrials: MIN_TRIALS_FOR_RATE };
const NO_TRIALS: AttributionData = { rows: [], overall: buildFunnel([]), epochStart: null, minTrials: MIN_TRIALS_FOR_RATE };

function reports(summary: Partial<ReportsData["summary"]> = {}): ReportsData {
  const base = createEmptyReportsData();
  return {
    ...base,
    summary: {
      ...base.summary,
      activeMembers: 130, activeOnHoldMembers: 12, currentMembers: 150, inactiveMembers: 12,
      attendanceThisWeek: 12, attendanceLastWeek: 120, newMembersThisMonth: 3, newMembersLastMonth: 10,
      ...summary,
    },
    weeklyAttendance: [
      { week: "13 Oct", count: 120, isCurrentWeek: false },
      { week: "20 Oct", count: 12, isCurrentWeek: true },
    ],
    topClasses: [{ name: "Fundamentals", count: 90, sessions: 10, averageAttendance: 9, fillRate: 45, capacityTotal: 200 }],
  };
}

describe("zero baseline: no percentage, '—' with the counts", () => {
  it("lib/percent formatChange", () => {
    expect(formatChange(12, 0)).toBe("— (12 vs 0)");
    expect(formatChange(12, 0, WEEK_SO_FAR)).toBe("— (12 so far this week vs 0 all last week)");
    expect(formatChange(0, 0)).toBe("— (0 vs 0)");
    // A real baseline is unchanged.
    expect(formatChange(56, 50)).toBe("+12% (56 vs 50)");
  });

  it("the Reports trend badge (it used to read a bare '+5')", () => {
    expect(trendDelta(5, 0)).toBe("— (5 vs 0)");
    expect(trendDelta(5, 0, WEEK_SO_FAR)).toBe("— (5 so far this week vs 0 all last week)");
    expect(trendDelta(3, 0, MONTH_SO_FAR)).toBe("— (3 so far this month vs 0 all last month)");
    expect(trendDelta(0, 0, WEEK_SO_FAR)).toBeNull();
  });

  it("the Analysis change pill shows '—' with its counts (it used to vanish)", () => {
    render(
      <AnalysisView
        metrics={{
          totalMembers: 50, newThisMonth: 3, newLastMonth: 0, checkinsThisMonth: 50, checkinsLastMonth: 40,
          activeClasses: 4, activeMembersThisMonth: 31, monthLabel: "October 2026", gymName: "Test club",
          range: resolveReportPeriod({}, new Date(), "Europe/London"),
          // One status: the legend reads its count, not "100% (50 of 50)".
          membersByStatus: [{ status: "active", label: "Active", count: 50 }],
        }}
        primaryColor="#3b82f6"
      />,
    );
    const pills = screen.getAllByTestId("analysis-change-pill");
    expect(pills.map((p) => p.textContent)).toEqual(["— (3 vs 0)", "+25% (50 vs 40)"]);
    expect(pills[0].getAttribute("aria-label")).toBe("— (3 so far this month vs 0 all last month): members joined");
    expect(screen.getAllByTestId("donut-legend-ratio").map((el) => el.textContent)).toEqual(["50"]);
    expect(document.body.textContent).not.toMatch(/100% \(/);
  });
});

describe("Reports: part periods and counts beside every change", () => {
  it("the Check-in trend card says 'so far this week vs all last week' like the tile (it read '-90% (12 vs 120)vs 120 last week')", () => {
    render(<ReportsView data={reports()} attribution={NO_TRIALS} primaryColor="#3b82f6" />);
    expect(screen.getAllByTestId("trend-badge").map((b) => b.textContent)).toEqual([
      "-90% (12 so far this week vs 120 all last week)", // Check-in trend card
      "-90% (12 so far this week vs 120 all last week)", // Attendance this week tile
      "-70% (3 so far this month vs 10 all last month)", // New this month tile
    ]);
    expect(document.body.textContent).not.toContain("vs 120 last week");
  });

  it("'No change' on the Attendance pulse keeps its two counts", () => {
    render(<ReportsView data={reports({ attendanceThisWeek: 40, attendanceLastWeek: 40 })} attribution={NO_TRIALS} primaryColor="#3b82f6" />);
    expect(screen.getByText("No change (40 so far this week vs 40 all last week)")).toBeTruthy();
  });
});

describe("Reports: a count that is a share of a named population carries its percentage", () => {
  const excludes = POPULATION_COPY.active.excludes;

  it("Active members: on hold as a share of active, active as a share of current members", () => {
    expect(activeMembersDetail({ activeMembers: 130, activeOnHoldMembers: 12, currentMembers: 150 })).toBe(
      `Includes 12 on hold · 9% of 130 active · 87% of 150 current members · ${excludes}`,
    );
    // An empty base has no percentage.
    expect(activeMembersDetail({ activeMembers: 0, activeOnHoldMembers: 0, currentMembers: 0 })).toBe(
      `Includes 0 on hold · 0 current members · ${excludes}`,
    );
    render(<ReportsView data={reports()} attribution={NO_TRIALS} primaryColor="#3b82f6" />);
    // The tile says it is a "Now" figure (the statistics period, #48) in one
    // short line; the full wording is under "What counts" (31 Oct 2026).
    expect(activeMembersShort({ activeMembers: 130, activeOnHoldMembers: 12, currentMembers: 150 })).toBe("Includes 12 on hold · 87% of 150 current members");
    expect(screen.getByText("Now · Includes 12 on hold · 87% of 150 current members")).toBeTruthy();
    expect(screen.getByText(`Includes 12 on hold · 9% of 130 active · 87% of 150 current members · ${excludes}`)).toBeTruthy();
  });

  it("Member attention: the inactive count with its share of current members", () => {
    render(<ReportsView data={reports()} attribution={NO_TRIALS} primaryColor="#3b82f6" />);
    expect(screen.getByText("12 inactive to review · 8% of 150 current members")).toBeTruthy();
  });

  it("a class's fill rate names its denominator: places", () => {
    render(<ReportsView data={reports()} attribution={NO_TRIALS} primaryColor="#3b82f6" />);
    expect(screen.getByText("9/session · fill 45% (90 of 200 places)")).toBeTruthy();
  });

  it("a share that is the whole by construction reads its count, never an artificial 100%", () => {
    // One class in the composition donut, one status, one check-in method:
    // each was "100% (n of n)".
    const data = reports();
    data.currentMembersByStatus = [{ status: "active", label: "Active", count: 150, percentage: 100 }];
    data.checkInMethods = [{ method: "admin", label: "Staff check-in", count: 40, percentage: 100 }];
    render(<ReportsView data={data} attribution={NO_TRIALS} primaryColor="#3b82f6" />);
    expect(screen.getAllByTestId("donut-legend-ratio").map((el) => el.closest("li")!.textContent)).toEqual(["Fundamentals90"]);
    expect(screen.getByText("Active").parentElement!.parentElement!.textContent).toBe("Active150");
    expect(screen.getByText("Staff check-in").parentElement!.parentElement!.textContent).toBe("Staff check-in40");
    expect(document.body.textContent).not.toMatch(/100% \(/);

    const csv = reportsCsv(data, NO_TRIALS);
    // The default period with no filters: the detail ends with the window label
    // alone (scopedWindowLabel), computed as the component does, so it stays
    // exact on any date.
    const windowLabel = windowLabelOf(resolveReportPeriod({}, new Date(), undefined));
    expect(windowLabel).not.toBe("");
    expect(csv).toContain(`Class composition,Fundamentals,90,All check-ins across the top 1 class · ${windowLabel}\r\n`);
    expect(csv).toContain("Current members by status,Active,150,All current members\r\n");
    expect(csv).toContain(`Check-in methods,Staff check-in,40,All check-ins · ${windowLabel}\r\n`);
    expect(csv).not.toMatch(/100% \(/);
  });

  it("with two or more slices the shares keep their counts", () => {
    const data = reports();
    data.currentMembersByStatus = [
      { status: "active", label: "Active", count: 130, percentage: 87 },
      { status: "inactive", label: "Inactive", count: 20, percentage: 13 },
    ];
    render(<ReportsView data={data} attribution={NO_TRIALS} primaryColor="#3b82f6" />);
    expect(screen.getByText("87% (130 of 150)")).toBeTruthy();
    expect(screen.getByText("13% (20 of 150)")).toBeTruthy();
  });
});

describe("Conversion funnel: drop-offs name their base; coach rows give lost and no-decision shares", () => {
  it("the club-wide drop-offs", () => {
    render(<ConversionFunnel data={ATTRIBUTION} linkRows={false} />);
    expect(screen.getByText("−24 lost before joining · 52% (24 of 46) of trials")).toBeTruthy();
    expect(screen.getByText("16 no decision recorded · 35% (16 of 46) of trials")).toBeTruthy();
    expect(screen.getByText("−1 no longer active · 17% (1 of 6) of converted")).toBeTruthy();
  });

  it("each coach: lost and no decision as shares of the trials they ran, counts only under the minimum", () => {
    render(<ConversionFunnel data={ATTRIBUTION} linkRows={false} />);
    const items = within(screen.getByRole("list", { name: "Conversion funnel by coach" })).getAllByRole("listitem");
    const text = (name: string) => items.find((li) => li.textContent?.includes(name))!.textContent;
    expect(text("Marco Silva")).toContain("Lost50% (20 of 40)");
    expect(text("Marco Silva")).toContain("No decision38% (15 of 40)");
    expect(text("Sam Kerr")).toContain("Lost100% (4 of 4)");
    expect(text("Sam Kerr")).toContain("No decision0% (0 of 4)");
    // Two trials is under the minimum of three: the counts, no percentage.
    expect(text("Priya Nair")).toContain("Lost0No decision1");
  });
});

describe("Reports CSV matches the screen", () => {
  const csv = reportsCsv(reports(), ATTRIBUTION);

  it("the week and month changes, with their part periods", () => {
    // "Now": attendance this week does not follow the statistics period (#48).
    expect(csv).toContain("Summary,Attendance this week,12,Now · Change -90% (12 so far this week vs 120 all last week)\r\n");
    // Quoted: the scope note after it has a comma.
    expect(csv).toContain("Summary,New members this month,3,\"Change -70% (3 so far this month vs 10 all last month) · First ever start.");
  });

  it("active members, fill rate and the funnel's drop-offs and coach shares", () => {
    // Quoted: the population note has commas.
    expect(csv).toContain(`Summary,Active members,130,"Includes 12 on hold · 9% of 130 active · 87% of 150 current members · ${POPULATION_COPY.active.excludes}"`);
    expect(csv).toContain("fill rate 45% (90 of 200 places)");
    expect(csv).toContain("Conversion funnel,Lost before joining,24,52% (24 of 46) of trials · Club-wide · rates need 3+ trials");
    expect(csv).toContain("Conversion funnel,No decision recorded,16,35% (16 of 46) of trials · Club-wide · rates need 3+ trials");
    expect(csv).toContain("Conversion funnel,No longer active,1,17% (1 of 6) of converted · Club-wide · rates need 3+ trials");
    expect(csv).toContain("Conversion by coach,Marco Silva,40,converted 12.5% (5 of 40) · still active 80% (4 of 5) · lost 50% (20 of 40) · no decision 38% (15 of 40)");
    expect(csv).toContain("Conversion by coach,Priya Nair,2,converted N/A · too few (1 of 2) · still active N/A · too few (1 of 1) · lost 0 · no decision 1");
  });
});
