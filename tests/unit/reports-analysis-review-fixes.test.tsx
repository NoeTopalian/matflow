// @vitest-environment jsdom
/**
 * Review fixes on T1/T2b (17 Oct 2026):
 * - Analysis "Member mix" shares CURRENT members only, "x% (n of m)", with
 *   those who left as a count (Q4 A-2), so it agrees with Reports;
 * - the generated monthly report says there is no rate when there are no
 *   active members, instead of "an engagement rate of — —";
 * - the Reports "Active members" tile and its CSV row say what they count and
 *   mark the members on hold inside it (Q4 A-1);
 * - Class composition and the funnel drop-offs carry their counts (Q6), and
 *   class composition is in the CSV;
 * - the top "New this month" tile uses the same words as the Joined tile;
 * - the Attendance page's distinct-attendee tile no longer says "Active
 *   Members".
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, LineChart: Pass, PieChart: Pass,
    Bar: Pass, Line: Nothing, Pie: Pass, Cell: Nothing, XAxis: Nothing, YAxis: Nothing,
    Tooltip: Nothing, CartesianGrid: Nothing,
  };
});
vi.mock("@/components/dashboard/MonthlyReportView", () => ({ default: () => null }));
vi.mock("@/components/dashboard/InitiativesPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/NetNewMembersCard", () => ({ default: () => null }));
vi.mock("@/components/dashboard/charts/Sparkline", () => ({ default: () => null }));

import ReportsView, { reportsCsv } from "@/components/dashboard/ReportsView";
import AnalysisView, { buildReport } from "@/components/dashboard/AnalysisView";
import AttendanceView from "@/components/dashboard/AttendanceView";
import { pctOf, dropText } from "@/components/dashboard/ConversionFunnel";
import { createEmptyReportsData, type ReportsData } from "@/lib/reports";
import { resolveReportPeriod } from "@/lib/report-period";
/** The Analysis fixtures describe October 2026 (the default period, "this month"). */
const OCTOBER = resolveReportPeriod({}, new Date("2026-10-15T12:00:00.000Z"), "Europe/London");

const ATTRIBUTION = {
  rows: [],
  overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null },
  epochStart: null,
  minTrials: 5,
};

function reports(overrides: Partial<ReportsData> = {}): ReportsData {
  const base = createEmptyReportsData();
  return {
    ...base,
    summary: {
      ...base.summary,
      totalMembers: 15, currentMembers: 12, activeMembers: 9, inactiveMembers: 2, tasterMembers: 1, cancelledMembers: 3,
      activeOnHoldMembers: 1, newMembersThisMonth: 3,
    },
    churn: { cancelled: 1, joined: 3, net: 2, opening: 9, base: 12, ratePct: 8.3 },
    topClasses: [
      { name: "Fundamentals", count: 30, sessions: 10, averageAttendance: 3, fillRate: null, capacityTotal: 0 },
      { name: "Open Mat", count: 10, sessions: 5, averageAttendance: 2, fillRate: null, capacityTotal: 0 },
    ],
    ...overrides,
  };
}

function tileFor(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "p" });
  const card = el.closest("[data-testid='metric-card']");
  if (!card) throw new Error(`no metric card for ${label}`);
  return card as HTMLElement;
}

const METRICS = {
  totalMembers: 9, newThisMonth: 2, newLastMonth: 1, checkinsThisMonth: 50, checkinsLastMonth: 40,
  activeClasses: 6, activeMembersThisMonth: 6, monthLabel: "October 2026", gymName: "Test club", range: OCTOBER,
  membersByStatus: [
    { status: "active", label: "Active", count: 9 },
    { status: "inactive", label: "Inactive", count: 2 },
    { status: "taster", label: "Taster", count: 1 },
  ],
  leftMembers: 3,
  monthlyTrend: [{ label: "Oct", value: 50 }],
};

describe("Analysis member mix — current members, with counts", () => {
  it("shares over current members as x% (n of m); left the club is a count with no share", () => {
    render(<AnalysisView metrics={METRICS} primaryColor="#3b82f6" />);
    expect(screen.getByText("Current members by status")).toBeTruthy();
    expect(screen.getByText("Current members")).toBeTruthy();
    expect(screen.queryByText("All members")).toBeNull();
    const ratios = screen.getAllByTestId("donut-legend-ratio").map((el) => el.textContent);
    // Same figures as the Reports "Current members by status" card for this club.
    expect(ratios).toEqual(["75% (9 of 12)", "17% (2 of 12)", "8% (1 of 12)"]);
    const left = screen.getByTestId("analysis-left-the-club");
    expect(left.textContent).toContain("Left the club: 3");
    expect(left.textContent).not.toMatch(/%/);
  });
});

describe("Monthly report text with no active members", () => {
  it("says there is no rate, never 'an engagement rate of —', and gives no verdict on it", () => {
    const text = buildReport({ ...METRICS, totalMembers: 0, activeMembersThisMonth: 0 }, []);
    expect(text).toContain("no engagement rate yet (no active members)");
    expect(text).not.toContain("engagement rate of —");
    expect(text).not.toContain("Engagement is below target");
  });

  it("with members, keeps the rate and its counts", () => {
    const text = buildReport(METRICS, []);
    expect(text).toContain("engagement rate of 67% (6 of 9)");
  });
});

describe("Reports — Active members says what it counts and marks holds", () => {
  it("tile and CSV carry the same detail: includes N on hold, excludes guardians", () => {
    const data = reports();
    render(<ReportsView data={data} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    const tile = tileFor("Active members");
    expect(tile.textContent).toContain("Includes 1 on hold");
    expect(tile.textContent).toContain("guardians");
    const csv = reportsCsv(data, ATTRIBUTION as never);
    const row = csv.split(/\r?\n/).find((line) => line.startsWith("Summary,Active members,"))!;
    expect(row).toContain("Includes 1 on hold");
    expect(row).toContain("guardians");
  });

  it("the top New this month tile uses the movement definition's words, not 'Member signups'", () => {
    render(<ReportsView data={reports()} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    const tile = tileFor("New this month");
    // D11: first ever start, by the movement definition.
    expect(tile.textContent).toContain("First ever start. Rejoins, tasters and imports are counted apart");
    expect(tile.textContent).not.toContain("Member signups");
  });
});

describe("Reports — class composition carries its base", () => {
  it("legend reads x% (n of m) over the top classes shown, and the CSV prints the same", () => {
    const data = reports();
    render(<ReportsView data={data} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    const ratios = screen.getAllByTestId("donut-legend-ratio").map((el) => el.textContent);
    expect(ratios).toEqual(["75% (30 of 40)", "25% (10 of 40)"]);
    expect(screen.getByText(/Share of check-ins across the top 2 classes/)).toBeTruthy();
    const csv = reportsCsv(data, ATTRIBUTION as never);
    expect(csv).toContain("Class composition,Fundamentals,30,75% (30 of 40) of check-ins across the top 2 classes");
  });
});

describe("Conversion funnel drop-offs carry their base", () => {
  it("25% (3 of 12), and still no share below the minimum trials", () => {
    expect(pctOf(3, 12, 5)).toBe("25% (3 of 12)");
    expect(dropText(3, "lost before joining", pctOf(3, 12, 5), true)).toBe("−3 lost before joining · 25% (3 of 12)");
    expect(pctOf(1, 2, 5)).toBeNull();
  });
});

describe("Attendance — distinct attendees are not 'Active Members'", () => {
  it("labels the tile Members who trained", () => {
    render(
      <AttendanceView
        records={[]}
        summary={{ totalThisMonth: 10, totalThisWeek: 4, uniqueMembersThisMonth: 7, topClass: null } as never}
        primaryColor="#3b82f6"
      />,
    );
    expect(screen.queryByText("Active Members")).toBeNull();
    const label = screen.getByText("Members who trained");
    expect(within(label.closest("div")!.parentElement!).getByText("7")).toBeTruthy();
    expect(screen.getByText("distinct members checked in this month")).toBeTruthy();
  });
});
