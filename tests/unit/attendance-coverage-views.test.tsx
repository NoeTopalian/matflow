// @vitest-environment jsdom
/**
 * Attendance coverage on the statistics screens (owner rule, 28 Oct 2026):
 * "Missing attendance coverage must not automatically become a claim that
 * nobody attended." Before a club's attendance records begin, Reports, its
 * CSV and Analysis show "—" and say why; a period that starts before the
 * records counts only what exists and says where they start; a zero after the
 * start is a real zero and stays 0. Exact text, one block per case:
 *
 *   1. no records at all;
 *   2. a period wholly before the records start;
 *   3. a period that straddles the start;
 *   4. a real zero after the start;
 *   5. the CSV.
 *
 * The coverage objects are literal here (lib/attendance-coverage's shape), so
 * each case reads as the server would hand it to the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
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

import ReportsView, { attendanceChartRows, reportsCsv } from "@/components/dashboard/ReportsView";
import AnalysisView, { buildReport } from "@/components/dashboard/AnalysisView";
import { createEmptyReportsData, type ReportsData } from "@/lib/reports";
import { resolveReportPeriod, type ReportRange } from "@/lib/report-period";
// Types only (erased at run time), so this file ran against the code before the change.
import type { AttendanceCoverage, CoverageState } from "@/lib/attendance-coverage";

const NOW = new Date("2026-10-26T10:00:00.000Z"); // a Monday
const LONDON = "Europe/London";
const START = "2026-03-03T00:00:00.000Z"; // 3 Mar 2026, midnight in London
const ATTRIBUTION = { rows: [], overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null }, epochStart: null, minTrials: 5 };

const NOTE_NONE = "No attendance recorded yet";
const NOTE_BEFORE = "No attendance records for this period (MatFlow's records start 3 Mar 2026)";
const RECORDS_START = "Records start 3 Mar 2026";

type Coverage = AttendanceCoverage;
type Row = ReportsData["weeklyAttendance"][number];

const THIS_MONTH = () => resolveReportPeriod({}, NOW, LONDON);
const JAN_FEB = () => resolveReportPeriod({ period: "custom", from: "2026-01", to: "2026-02" }, NOW, LONDON);
const FEB_APR = () => resolveReportPeriod({ period: "custom", from: "2026-02", to: "2026-04" }, NOW, LONDON);

function reports(range: ReportRange, coverage: Coverage, over: Partial<ReportsData> = {}, summary: Partial<ReportsData["summary"]> = {}): ReportsData {
  const base = createEmptyReportsData();
  return {
    ...base,
    range,
    summary: { ...base.summary, totalMembers: 5, currentMembers: 5, activeMembers: 5, ...summary },
    attendanceRate: { mode: "checkins-per-member", value: 0, label: "Check-ins per active member", formula: "Total check-ins ÷ active members, this window.", numerator: 0, denominator: 5 },
    ...over,
    attendanceCoverage: coverage,
  } as ReportsData;
}

function zeroWeeks(coverage: CoverageState): Row[] {
  return ["7 Sept", "14 Sept", "21 Sept", "28 Sept", "5 Oct", "12 Oct", "19 Oct", "26 Oct"].map((week, i) => ({
    week, count: 0, isCurrentWeek: i === 7, inPeriod: i >= 4, coverage,
  }));
}

/** The [value, label, detail] lines of the Reports metric tile with this label. */
function tile(label: string): string[] {
  const el = screen.getByText(label, { selector: "p" });
  const card = el.closest("[data-testid='metric-card']") as HTMLElement;
  return [...card.querySelectorAll("p")].map((p) => p.textContent ?? "");
}

/** The Reports card under this heading. */
function card(title: string): HTMLElement {
  return screen.getByRole("heading", { name: title }).closest("[data-slot='card']") as HTMLElement;
}

/** The [value, label, sub] lines of the Analysis metric card with this label. */
function analysisCard(label: string): { lines: string[]; pill: string | null } {
  const el = screen.getByText(label, { selector: "p" });
  const c = el.closest("[data-slot='card']") as HTMLElement;
  const pill = c.querySelector("[data-testid='analysis-change-pill']");
  return { lines: [...c.querySelectorAll(":scope > p")].map((p) => p.textContent ?? ""), pill: pill?.textContent ?? null };
}

function metrics(range: ReportRange, coverage: Coverage | undefined, over: Record<string, unknown> = {}) {
  return {
    totalMembers: 10, newThisMonth: 0, newLastMonth: 0, checkinsThisMonth: 0, checkinsLastMonth: 0,
    activeClasses: 3, activeMembersThisMonth: 0, monthLabel: range.label, gymName: "Test club", range,
    membersByStatus: [{ status: "active", label: "Active", count: 10 }], leftMembers: 0,
    monthlyTrend: [{ label: "Oct", value: 0 }],
    ...over,
    coverage,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ── 1. No records at all ──────────────────────────────────────────────────────
describe("1. a club with no attendance records at all", () => {
  const NONE: Coverage = { start: null, timeZone: LONDON, period: "none", previous: "none", thisWeek: "none", lastWeek: "none" };

  it("Reports shows — and 'No attendance recorded yet', never 0", () => {
    render(<ReportsView data={reports(THIS_MONTH(), NONE, { weeklyAttendance: zeroWeeks("none") })} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(tile("Check-ins")).toEqual(["—", "Check-ins", NOTE_NONE]);
    expect(tile("Attendance this week")).toEqual(["—", "Attendance this week", `Now · ${NOTE_NONE}`]);
    expect(tile("Busiest class")).toEqual(["—", "Busiest class", NOTE_NONE]);
    const rate = screen.getByTestId("rate-readout");
    expect(rate.querySelector("span")!.textContent).toBe("—");
    expect(screen.queryByTestId("rate-readout-counts")).toBeNull();
    expect(screen.getByTestId("rate-readout-note").textContent).toBe(NOTE_NONE);
    expect(screen.queryByTestId("reports-trend-total")).toBeNull();
    for (const title of ["Class composition", "Check-in trend", "Weekly Attendance", "Top Classes", "Check-In Methods"]) {
      expect(within(card(title)).getByText(NOTE_NONE, { selector: "p" })).toBeTruthy();
    }
  });

  it("Analysis shows — for check-ins and engagement, with the note and no change pill", () => {
    render(<AnalysisView metrics={metrics(THIS_MONTH(), NONE as never)} primaryColor="#3b82f6" />);
    expect(analysisCard("Check-ins")).toEqual({ lines: ["—", "Check-ins", NOTE_NONE], pill: null });
    expect(analysisCard("Engagement")).toEqual({ lines: ["—", "Engagement", NOTE_NONE], pill: null });
    expect(screen.getByText(NOTE_NONE, { selector: "p.text-sm" })).toBeTruthy(); // the check-ins-by-month card
  });

  it("the written analysis does not say nobody checked in", () => {
    const text = buildReport(metrics(THIS_MONTH(), NONE as never) as never, []);
    expect(text).toContain("Test club has 10 active members today across 3 classes. No attendance recorded yet, so check-ins and engagement are not reported.");
    expect(text).not.toContain("recorded 0 check-ins");
  });
});

// ── 2. A period wholly before the records start ──────────────────────────────
describe("2. a period wholly before the records start (3 Mar 2026)", () => {
  const BEFORE: Coverage = { start: START, timeZone: LONDON, period: "before", previous: "before", thisWeek: "covered", lastWeek: "covered" };
  const rows: Row[] = [
    { week: "26 Jan", count: 0, isCurrentWeek: false, inPeriod: true, coverage: "before" },
    { week: "2 Feb", count: 0, isCurrentWeek: false, inPeriod: true, coverage: "before" },
  ];

  it("Reports shows — with the date the records start", () => {
    render(<ReportsView data={reports(JAN_FEB(), BEFORE, { weeklyAttendance: rows }, { attendanceThisWeek: 12, attendanceLastWeek: 10 })} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(tile("Check-ins")).toEqual(["—", "Check-ins", NOTE_BEFORE]);
    expect(tile("Busiest class")).toEqual(["—", "Busiest class", NOTE_BEFORE]);
    // This week is covered: it keeps its real figure.
    expect(tile("Attendance this week")[0]).toBe("12");
    expect(screen.getByTestId("rate-readout").querySelector("span")!.textContent).toBe("—");
    expect(screen.getByTestId("rate-readout-note").textContent).toBe(NOTE_BEFORE);
    for (const title of ["Class composition", "Check-in trend", "Weekly Attendance", "Top Classes", "Check-In Methods"]) {
      expect(within(card(title)).getByText(NOTE_BEFORE, { selector: "p" })).toBeTruthy();
    }
  });

  it("Analysis shows — with the date the records start", () => {
    render(<AnalysisView metrics={metrics(JAN_FEB(), BEFORE as never)} primaryColor="#3b82f6" />);
    expect(analysisCard("Check-ins")).toEqual({ lines: ["—", "Check-ins", NOTE_BEFORE], pill: null });
    expect(analysisCard("Engagement")).toEqual({ lines: ["—", "Engagement", NOTE_BEFORE], pill: null });
  });
});

// ── 3. A period that straddles the start ─────────────────────────────────────
describe("3. a period that straddles the records start (Feb – Apr 2026)", () => {
  const PARTIAL: Coverage = { start: START, timeZone: LONDON, period: "partial", previous: "before", thisWeek: "covered", lastWeek: "covered" };
  const rows: Row[] = [
    { week: "23 Feb", count: 0, isCurrentWeek: false, inPeriod: true, coverage: "before" },
    { week: "2 Mar", count: 5, isCurrentWeek: false, inPeriod: true, coverage: "partial" },
    { week: "9 Mar", count: 35, isCurrentWeek: false, inPeriod: true, coverage: "covered" },
  ];
  const over: Partial<ReportsData> = {
    weeklyAttendance: rows,
    topClasses: [{ name: "Fundamentals", count: 40, sessions: 10, averageAttendance: 4, fillRate: null, capacityTotal: 0 }],
    checkInMethods: [{ method: "admin", label: "Admin", count: 40, percentage: 100 }],
    attendanceRate: { mode: "checkins-per-member", value: 8, label: "Check-ins per active member", formula: "Total check-ins ÷ active members, this window.", numerator: 40, denominator: 5 },
  };

  it("Reports counts what exists and says where the records start", () => {
    render(<ReportsView data={reports(FEB_APR(), PARTIAL, over, { totalCheckIns: 40 })} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(tile("Check-ins")).toEqual(["40", "Check-ins", `Feb – Apr 2026 · ${RECORDS_START}`]);
    expect(screen.getByTestId("reports-trend-total").textContent).toBe("40");
    expect(screen.getByTestId("reports-trend-coverage").textContent).toBe(RECORDS_START);
    expect(screen.getByTestId("rate-readout-note").textContent).toBe(RECORDS_START);
    expect(within(card("Top Classes")).getByText(`Check-ins, average attendance, and fill rate — Feb – Apr 2026 · ${RECORDS_START}`)).toBeTruthy();
    expect(within(card("Weekly Attendance")).getByText(`Feb – Apr 2026 · ${RECORDS_START}, weeks without records shaded as no data`)).toBeTruthy();
  });

  it("bars before the start are no-data, not zero, and every uncovered bar is marked for the tooltip", () => {
    const data = reports(FEB_APR(), PARTIAL, over, { totalCheckIns: 40 });
    expect(attendanceChartRows(data).map((r) => [r.week, r.value, r.note])).toEqual([
      ["23 Feb", null, "No records (MatFlow's records start 3 Mar 2026)"],
      ["2 Mar", 5, "Partly covered (records start 3 Mar 2026)"],
      ["9 Mar", 35, null],
    ]);
  });

  it("Analysis counts what exists and gives no percentage against the uncovered period before", () => {
    render(<AnalysisView metrics={metrics(FEB_APR(), PARTIAL as never, { checkinsThisMonth: 40, checkinsLastMonth: 0, activeMembersThisMonth: 6 })} primaryColor="#3b82f6" />);
    expect(analysisCard("Check-ins")).toEqual({
      lines: ["40", "Check-ins", `in Feb – Apr 2026 · ${RECORDS_START} · — (no records for the period before)`],
      pill: null,
    });
    expect(analysisCard("Engagement").lines[2]).toBe(`(6 of 10) active members checked in in Feb – Apr 2026 · ${RECORDS_START}`);
  });
});

// ── 4. A real zero after the start ───────────────────────────────────────────
describe("4. a covered period with genuinely no check-ins", () => {
  const COVERED: Coverage = { start: "2025-01-10T00:00:00.000Z", timeZone: LONDON, period: "covered", previous: "covered", thisWeek: "covered", lastWeek: "covered" };

  it("Reports keeps 0, with no coverage note", () => {
    render(<ReportsView data={reports(THIS_MONTH(), COVERED, { weeklyAttendance: zeroWeeks("covered") })} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(tile("Check-ins")).toEqual(["0", "Check-ins", "October 2026 (to today)"]);
    expect(tile("Attendance this week")).toEqual(["0", "Attendance this week", "Now · check-ins since Monday"]);
    expect(screen.getByTestId("reports-trend-total").textContent).toBe("0");
    expect(screen.getByTestId("rate-readout").querySelector("span")!.textContent).toBe("0");
    expect(screen.getByTestId("rate-readout-counts").textContent).toBe("(0 check-ins ÷ 5 members)");
    expect(within(card("Top Classes")).getByText("No check-ins in this period", { selector: "p" })).toBeTruthy();
    expect(screen.queryByText(/No attendance record/)).toBeNull();
    expect(screen.queryByText(/Records start/)).toBeNull();
  });

  it("Analysis keeps 0 and compares it with the period before", () => {
    render(<AnalysisView metrics={metrics(THIS_MONTH(), COVERED as never, { checkinsLastMonth: 12 })} primaryColor="#3b82f6" />);
    expect(analysisCard("Check-ins")).toEqual({ lines: ["0", "Check-ins", "so far this month · 12 in all last month"], pill: "-100% (0 vs 12)" });
    expect(analysisCard("Engagement").lines[0]).toBe("0%");
  });
});

// ── 5. The CSV ───────────────────────────────────────────────────────────────
describe("5. the CSV follows the same rule: — plus the note in the Detail column", () => {
  const lines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n");

  it("no records at all", () => {
    const NONE: Coverage = { start: null, timeZone: LONDON, period: "none", previous: "none", thisWeek: "none", lastWeek: "none" };
    const rows: Row[] = [
      { week: "19 Oct", count: 0, isCurrentWeek: false, inPeriod: true, coverage: "none" },
      { week: "26 Oct", count: 0, isCurrentWeek: true, inPeriod: true, coverage: "none" },
    ];
    const csv = lines(reportsCsv(reports(THIS_MONTH(), NONE, { weeklyAttendance: rows }), ATTRIBUTION as never));
    for (const want of [
      "Summary,Attendance this week,—,Now · No attendance recorded yet",
      "Summary,Check-ins,—,October 2026 (to today) · No attendance recorded yet",
      "Summary,Attendance rate — Check-ins per active member,—,\"Total check-ins ÷ active members, this window. · October 2026 (to today) · No attendance recorded yet\"",
      "Weekly attendance,19 Oct,—,No attendance recorded yet",
      "Weekly attendance,26 Oct,—,Current week · No attendance recorded yet",
      "Class composition,All classes,—,October 2026 (to today) · No attendance recorded yet",
      "Top classes,All classes,—,October 2026 (to today) · No attendance recorded yet",
      "Check-in methods,All methods,—,October 2026 (to today) · No attendance recorded yet",
      "Owner insights,Self-service check-in,—,Self or QR · October 2026 (to today) · No attendance recorded yet",
    ]) expect(csv).toContain(want);
    expect(csv.some((l) => /^Summary,Check-ins,0,/.test(l))).toBe(false);
  });

  it("a period that straddles the start, and a real zero after it", () => {
    const PARTIAL: Coverage = { start: START, timeZone: LONDON, period: "partial", previous: "before", thisWeek: "covered", lastWeek: "covered" };
    const rows: Row[] = [
      { week: "23 Feb", count: 0, isCurrentWeek: false, inPeriod: true, coverage: "before" },
      { week: "2 Mar", count: 5, isCurrentWeek: false, inPeriod: true, coverage: "partial" },
      { week: "9 Mar", count: 35, isCurrentWeek: false, inPeriod: true, coverage: "covered" },
    ];
    const csv = lines(reportsCsv(reports(FEB_APR(), PARTIAL, {
      weeklyAttendance: rows,
      topClasses: [{ name: "Fundamentals", count: 40, sessions: 10, averageAttendance: 4, fillRate: null, capacityTotal: 0 }],
      attendanceRate: { mode: "checkins-per-member", value: 8, label: "Check-ins per active member", formula: "Total check-ins ÷ active members, this window.", numerator: 40, denominator: 5 },
    }, { totalCheckIns: 40 }), ATTRIBUTION as never));
    for (const want of [
      "Summary,Check-ins,40,Feb – Apr 2026 · Records start 3 Mar 2026",
      "Summary,Attendance rate — Check-ins per active member,8 (40 check-ins ÷ 5 members),\"Total check-ins ÷ active members, this window. · Feb – Apr 2026 · Records start 3 Mar 2026\"",
      "Weekly attendance,23 Feb,—,No records (MatFlow's records start 3 Mar 2026)",
      "Weekly attendance,2 Mar,5,Partly covered (records start 3 Mar 2026)",
      "Weekly attendance,9 Mar,35,",
      "Top classes,Fundamentals,40,\"Feb – Apr 2026 · Records start 3 Mar 2026, 4/session, fill rate no capacity set\"",
    ]) expect(csv).toContain(want);

    const COVERED: Coverage = { start: "2025-01-10T00:00:00.000Z", timeZone: LONDON, period: "covered", previous: "covered", thisWeek: "covered", lastWeek: "covered" };
    const zero = lines(reportsCsv(reports(THIS_MONTH(), COVERED, { weeklyAttendance: zeroWeeks("covered") }), ATTRIBUTION as never));
    expect(zero).toContain("Summary,Check-ins,0,October 2026 (to today)");
    expect(zero).toContain("Weekly attendance,26 Oct,0,Current week");
  });
});
