// @vitest-environment jsdom
/**
 * Where the records stop (31 Oct 2026). A club that moved from TeamUp has its
 * imported visits up to the export and, until it starts checking people in on
 * MatFlow, nothing after. Those weeks used to read as a real 0 ("nobody
 * trained"); now they are "no records", said as such, until MatFlow check-ins
 * resume. Exact text, one block per case:
 *
 *   1. the rule (lib/attendance-coverage coverageOf over the club's runs);
 *   2. the read (three probes: first record, last imported visit, first MatFlow check-in after it);
 *   3. the words;
 *   4. Reports for a club in that state (Sean's, synthetic numbers);
 *   5. the "Whole club" tag while a class or age filter is on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

import ReportsView, { attendanceChartRows, attendanceCoverageView, noDataRuns } from "@/components/dashboard/ReportsView";
import { createEmptyReportsData, type ReportsData } from "@/lib/reports";
import { resolveReportPeriod } from "@/lib/report-period";
import {
  attendanceCoverageFor,
  bucketNote,
  comparisonGap,
  coverageOf,
  noCoverage,
  noRecordsNote,
  partialNote,
  readAttendanceCoverage,
  type AttendanceCoverage,
  type CoverageSpans,
} from "@/lib/attendance-coverage";

const LONDON = "Europe/London";
const NOW = new Date("2026-10-31T10:00:00.000Z"); // Saturday; London is on GMT after 25 Oct
const START = new Date("2024-03-04T00:00:00.000Z"); // records start 4 Mar 2024
const HISTORY_END = new Date("2026-10-26T00:00:00.000Z"); // the last imported visit was on Sun 25 Oct 2026
const SPANS: CoverageSpans = { start: START, historyEnd: HISTORY_END, resumes: null };
const RESUMED: CoverageSpans = { ...SPANS, resumes: new Date("2026-11-09T00:00:00.000Z") };
const ATTRIBUTION = { rows: [], overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null }, epochStart: null, minTrials: 5 };

const GAP_NOTE = "No attendance records for this period (imported history ends 25 Oct 2026; no check-ins recorded in MatFlow since)";
const GAP_BAR = "No records (imported history ends 25 Oct 2026; no check-ins recorded in MatFlow since)";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// ── 1. The rule ──────────────────────────────────────────────────────────────
describe("1. coverageOf over the club's runs", () => {
  it("before the records, inside the history, after it with no MatFlow check-ins, and across its end", () => {
    expect(coverageOf(SPANS, "2024-01-01T00:00:00.000Z", "2024-02-01T00:00:00.000Z")).toBe("before");
    expect(coverageOf(SPANS, "2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z")).toBe("covered");
    // The week after the export: no records, never a zero.
    expect(coverageOf(SPANS, "2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z")).toBe("gap");
    expect(noCoverage("gap")).toBe(true);
    // October holds both: counted, but only partly covered.
    expect(coverageOf(SPANS, "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z")).toBe("partial");
  });

  it("MatFlow check-ins resume the records: the weeks between stay a gap, the weeks after are covered", () => {
    expect(coverageOf(RESUMED, "2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z")).toBe("gap");
    expect(coverageOf(RESUMED, "2026-11-09T00:00:00.000Z", "2026-11-16T00:00:00.000Z")).toBe("covered");
    expect(coverageOf(RESUMED, "2026-11-02T00:00:00.000Z", "2026-11-16T00:00:00.000Z")).toBe("partial");
  });

  it("a club with no imported history keeps one open run from its first record (unchanged)", () => {
    const live: CoverageSpans = { start: START, historyEnd: null, resumes: null };
    expect(coverageOf(live, "2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z")).toBe("covered");
    expect(coverageOf(START, "2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z")).toBe("covered");
    expect(coverageOf({ start: null, historyEnd: null, resumes: null }, "2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z")).toBe("none");
  });

  it("a comparison against a gap has no percentage", () => {
    expect(comparisonGap("gap")).toBe("— (no records for the period before)");
  });
});

// ── 2. The read ──────────────────────────────────────────────────────────────
describe("2. readAttendanceCoverage", () => {
  type Args = { where: Record<string, unknown>; orderBy: { checkInTime: "asc" | "desc" } };

  function client(results: Array<{ checkInTime: Date } | null>) {
    const calls: Args[] = [];
    const findFirst = vi.fn(async (args: Args) => {
      calls.push(args);
      return results[calls.length - 1] ?? null;
    });
    return { tx: { attendanceRecord: { findFirst } } as never, calls };
  }

  it("imported history with no MatFlow check-in since: the history end is the day after the last imported visit, no resume", async () => {
    // First record 4 Mar 2024 18:00; last imported visit Sun 25 Oct 2026 19:30 (GMT); nothing since.
    const { tx, calls } = client([{ checkInTime: new Date("2024-03-04T18:00:00.000Z") }, { checkInTime: new Date("2026-10-25T19:30:00.000Z") }, null]);
    const spans = await readAttendanceCoverage(tx, "tenant-a", LONDON);
    expect(spans.start?.toISOString()).toBe("2024-03-04T00:00:00.000Z");
    expect(spans.historyEnd?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(spans.resumes).toBeNull();
    // Every probe is the club's own (tenant-scoped); imported = method "import" or an import job.
    expect(calls.map((c) => c.where.tenantId)).toEqual(["tenant-a", "tenant-a", "tenant-a"]);
    expect(calls[1]).toMatchObject({ where: { OR: [{ checkInMethod: "import" }, { importJobId: { not: null } }] }, orderBy: { checkInTime: "desc" } });
    expect(calls[2]).toMatchObject({ where: { checkInMethod: { not: "import" }, importJobId: null, checkInTime: { gte: new Date("2026-10-26T00:00:00.000Z") } }, orderBy: { checkInTime: "asc" } });
  });

  it("the history end is the club's next midnight across a clock change (last visit on the BST day, 24 Oct)", async () => {
    // 24 Oct 2026 is BST: 22:30Z is 23:30 local on the 24th, so the next club day starts 25 Oct 00:00 BST = 24 Oct 23:00Z.
    const { tx } = client([{ checkInTime: new Date("2024-03-04T18:00:00.000Z") }, { checkInTime: new Date("2026-10-24T22:30:00.000Z") }, null]);
    expect((await readAttendanceCoverage(tx, "tenant-a", LONDON)).historyEnd?.toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });

  it("MatFlow check-ins after the history: they resume from that club day", async () => {
    const { tx } = client([{ checkInTime: new Date("2024-03-04T18:00:00.000Z") }, { checkInTime: new Date("2026-10-25T19:30:00.000Z") }, { checkInTime: new Date("2026-11-09T18:05:00.000Z") }]);
    expect((await readAttendanceCoverage(tx, "tenant-a", LONDON)).resumes?.toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });

  it("no imported rows: one open run, and no third probe", async () => {
    const { tx, calls } = client([{ checkInTime: new Date("2026-03-03T09:00:00.000Z") }, null]);
    const spans = await readAttendanceCoverage(tx, "tenant-a", LONDON);
    expect(spans).toEqual({ start: new Date("2026-03-03T00:00:00.000Z"), historyEnd: null, resumes: null });
    expect(calls).toHaveLength(2);
  });

  it("a club with records but no import job never runs the latest-imported probe (it would walk every record)", async () => {
    const calls: unknown[] = [];
    const findFirst = vi.fn(async (args: unknown) => { calls.push(args); return { checkInTime: new Date("2026-03-03T09:00:00.000Z") }; });
    const jobs = vi.fn(async () => null);
    const spans = await readAttendanceCoverage({ attendanceRecord: { findFirst }, importJob: { findFirst: jobs } } as never, "tenant-a", LONDON);
    expect(spans).toEqual({ start: new Date("2026-03-03T00:00:00.000Z"), historyEnd: null, resumes: null });
    expect(calls).toHaveLength(1);
    expect(jobs).toHaveBeenCalledWith({ where: { tenantId: "tenant-a" }, select: { id: true } });
  });

  it("with an import job the probes run as before", async () => {
    const { tx, calls } = client([{ checkInTime: new Date("2024-03-04T18:00:00.000Z") }, { checkInTime: new Date("2026-10-25T19:30:00.000Z") }, null]);
    const withJob = { ...(tx as object), importJob: { findFirst: vi.fn(async () => ({ id: "job-1" })) } };
    expect((await readAttendanceCoverage(withJob as never, "tenant-a", LONDON)).historyEnd?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(calls).toHaveLength(3);
  });

  it("no records at all: one probe", async () => {
    const { tx, calls } = client([null]);
    expect(await readAttendanceCoverage(tx, "tenant-a", LONDON)).toEqual({ start: null, historyEnd: null, resumes: null });
    expect(calls).toHaveLength(1);
  });
});

// ── 3. The words ─────────────────────────────────────────────────────────────
describe("3. the notes", () => {
  const c = attendanceCoverageFor(SPANS, LONDON, { start: "2026-10-26T00:00:00.000Z", end: "2026-11-02T00:00:00.000Z" }, { start: "2026-10-19T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z" });

  it("the page coverage carries the history end and the states", () => {
    expect(c).toEqual({
      start: "2024-03-04T00:00:00.000Z",
      historyEnd: "2026-10-26T00:00:00.000Z",
      resumes: null,
      timeZone: LONDON,
      period: "gap",
      previous: "covered",
    });
  });

  it("no records after the history, a partly covered span, and a bar", () => {
    expect(noRecordsNote(c, "gap")).toBe(GAP_NOTE);
    expect(partialNote(c, "partial")).toBe("Records cover 4 Mar 2024 – 25 Oct 2026");
    expect(bucketNote(c, "gap")).toBe(GAP_BAR);
    expect(bucketNote(c, "partial")).toBe("Partly covered (records cover 4 Mar 2024 – 25 Oct 2026)");
    // Before the records it still says where they start.
    expect(noRecordsNote(c, "before")).toBe("No attendance records for this period (MatFlow's records start 4 Mar 2024)");
  });

  it("once MatFlow check-ins resume, the notes name both runs", () => {
    const r = attendanceCoverageFor(RESUMED, LONDON, { start: "2026-11-02T00:00:00.000Z", end: "2026-11-09T00:00:00.000Z" }, { start: "2026-10-26T00:00:00.000Z", end: "2026-11-02T00:00:00.000Z" });
    expect(r.period).toBe("gap");
    expect(noRecordsNote(r, "gap")).toBe("No attendance records for this period (imported history ends 25 Oct 2026; MatFlow check-ins from 9 Nov 2026)");
    expect(partialNote(r, "partial")).toBe("Records cover 4 Mar 2024 – 25 Oct 2026 and from 9 Nov 2026");
  });
});

// ── 4. Reports for a club whose history has ended ───────────────────────────
function seanLike(over: Partial<ReportsData> = {}): ReportsData {
  const base = createEmptyReportsData();
  const range = resolveReportPeriod({}, NOW, LONDON); // October 2026, to today
  const coverage: AttendanceCoverage = {
    ...attendanceCoverageFor(SPANS, LONDON, range, range.previous),
    thisWeek: coverageOf(SPANS, "2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z"),
    lastWeek: coverageOf(SPANS, "2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"),
  };
  const weeks = ["7 Sept", "14 Sept", "21 Sept", "28 Sept", "5 Oct", "12 Oct", "19 Oct", "26 Oct"];
  const starts = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
  return {
    ...base,
    range,
    summary: { ...base.summary, totalMembers: 320, currentMembers: 315, activeMembers: 312, totalCheckIns: 180, attendanceThisWeek: 0, attendanceLastWeek: 52 },
    attendanceRate: { mode: "checkins-per-member", value: 0.6, label: "Check-ins per active member", formula: "Total check-ins ÷ active members, this window.", numerator: 180, denominator: 312 },
    weeklyAttendance: weeks.map((week, i) => ({
      week,
      count: i === 7 ? 0 : 50,
      isCurrentWeek: i === 7,
      inPeriod: i >= 4,
      coverage: coverageOf(SPANS, `${starts[i]}T00:00:00.000Z`, i === 7 ? "2026-11-02T00:00:00.000Z" : `${starts[i + 1]}T00:00:00.000Z`),
    })),
    ...over,
    attendanceCoverage: coverage,
  } as ReportsData;
}

function tile(label: string): string[] {
  const el = screen.getByText(label, { selector: "p" });
  const card = el.closest("[data-testid='metric-card']") as HTMLElement;
  return [...card.querySelectorAll("p")].map((p) => p.textContent ?? "");
}

describe("4. Reports after the imported history ends, before any MatFlow check-in", () => {
  it("this week is no records, not 0; the month is counted and says where the records stop", () => {
    const data = seanLike();
    const cov = attendanceCoverageView(data);
    expect(cov.thisWeekMissing).toBe(GAP_NOTE);
    expect(cov.partial).toBe("Records cover 4 Mar 2024 – 25 Oct 2026");
    render(<ReportsView data={data} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(tile("Attendance this week").slice(0, 3)).toEqual(["—", "Attendance this week", `Now · ${GAP_NOTE}`]);
    expect(tile("Check-ins").slice(0, 3)).toEqual(["180", "Check-ins", "October 2026 (to today) · Records cover 4 Mar 2024 – 25 Oct 2026"]);
  });

  it("the week since the export is a no-data bar with its reason, shaded as its own run", () => {
    const rows = attendanceChartRows(seanLike());
    expect(rows.map((r) => [r.week, r.value, r.note]).slice(-2)).toEqual([
      ["19 Oct", 50, null],
      ["26 Oct", null, GAP_BAR],
    ]);
    expect(noDataRuns(rows)).toEqual([{ from: "26 Oct", to: "26 Oct", label: "No records since import" }]);
  });

  it("runs before the records start and after the history ends are shaded separately", () => {
    const rows = [
      { week: "a", value: null, coverage: "before" },
      { week: "b", value: null, coverage: "before" },
      { week: "c", value: 4, coverage: "covered" },
      { week: "d", value: null, coverage: "gap" },
      { week: "e", value: null, coverage: "gap" },
    ];
    expect(noDataRuns(rows)).toEqual([
      { from: "a", to: "b", label: "No records" },
      { from: "d", to: "e", label: "No records since import" },
    ]);
  });
});

// ── 5. "Whole club" while a filter is on ─────────────────────────────────────
describe("5. the Whole club tag", () => {
  const kids = () => seanLike({ filters: { classId: null, className: null, ageGroup: "kids" } });

  it("with Kids picked, every figure the filter does not narrow says Whole club; the attendance ones do not", () => {
    render(<ReportsView data={kids()} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    for (const label of ["Active members", "Active classes", "Churn", "Payment recovery rate"]) {
      expect(tile(label)[1], label).toBe(`${label}Whole club`);
    }
    expect(screen.getByText("New this month", { exact: false, selector: "p" }).textContent).toBe("New this monthWhole club");
    expect(screen.getByTestId("reports-joined-tile").textContent).toContain("Joined this month (new + rejoined)Whole club");
    expect(screen.getByRole("heading", { name: /Health Metrics/ }).textContent).toBe("Health MetricsWhole club");
    expect(screen.getByText("Member attention", { exact: false, selector: "p" }).textContent).toBe("Member attentionWhole club");
    // A screen reader hears it too: the drill-through link's name carries it.
    expect(screen.getByRole("link", { name: /^Active members \(whole club\) — see the members behind this number$/ })).toBeTruthy();
    expect(tile("Check-ins")[1]).toBe("Check-ins");
    expect(tile("Busiest class")[1]).toBe("Busiest class");
  });

  it("with no filter there is no tag anywhere", () => {
    render(<ReportsView data={seanLike()} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(screen.queryAllByTestId("whole-club-tag")).toHaveLength(0);
  });
});
