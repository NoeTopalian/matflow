// @vitest-environment jsdom
/**
 * T2b (17 Oct 2026) — every percentage on Reports and Analysis shows its
 * numerator and denominator ("10% (1 of 10)"), churn has "Joined this month"
 * immediately beside it, an empty base reads "—" (never "0%"), and the status
 * card is split per Q4 A-2: current members by status, plus "Left the club: N"
 * with no percentage. The screen and the CSV print the same text.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
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
// Children with their own fetches or charts are not under test here.
vi.mock("@/components/dashboard/MonthlyReportView", () => ({ default: () => null }));
vi.mock("@/components/dashboard/InitiativesPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/ConversionFunnel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/NetNewMembersCard", () => ({ default: () => null }));
vi.mock("@/components/dashboard/charts/Sparkline", () => ({ default: () => null }));

import { formatRatio, formatPct, formatSigned, wholePct } from "@/components/dashboard/reports-primitives";
import ReportsView, { reportsCsv } from "@/components/dashboard/ReportsView";
import AnalysisView from "@/components/dashboard/AnalysisView";
import { createEmptyReportsData, type ReportsData } from "@/lib/reports";
import { resolveReportPeriod } from "@/lib/report-period";
/** The Analysis fixtures describe October 2026 (the default period, "this month"). */
const OCTOBER = resolveReportPeriod({}, new Date("2026-10-15T12:00:00.000Z"), "Europe/London");

describe("formatRatio", () => {
  it.each([
    [10, 1, 10, "10% (1 of 10)"],
    [3.2, 10, 312, "3.2% (10 of 312)"],
    [0.3, 1, 313, "0.3% (1 of 313)"],
    [0, 0, 25, "0% (0 of 25)"],
    [100, 13592, 13592, "100% (13,592 of 13,592)"],
    [45.25, 1234567, 2728000, "45.3% (1,234,567 of 2,728,000)"],
  ])("pct %s, %s of %s → %s", (pct, n, base, expected) => {
    expect(formatRatio(pct, n, base)).toBe(expected);
  });

  it("an empty base is a dash, never 0%", () => {
    expect(formatRatio(0, 0, 0)).toBe("—");
    expect(formatRatio(null, 0, 0)).toBe("—");
    expect(formatPct(0, 0)).toBe("—");
  });

  it("a null or non-finite rate is a dash even with a base", () => {
    expect(formatRatio(null, 1, 10)).toBe("—");
    expect(formatRatio(Number.NaN, 1, 10)).toBe("—");
  });

  it("wholePct is null on an empty base; formatSigned uses a true minus sign", () => {
    expect(wholePct(1, 0)).toBeNull();
    expect(wholePct(1, 3)).toBe(33);
    expect(formatSigned(3)).toBe("+3");
    expect(formatSigned(-2)).toBe("−2");
    expect(formatSigned(0)).toBe("0");
  });
});

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
      newMembersThisMonth: 3,
    },
    churn: { ratePct: 10, cancelled: 1, base: 10, joined: 3, net: 2 },
    churnRate: 10,
    // The net beside churn comes from the Net New Members card's current month (T8c review).
    membership: {
      ...base.membership,
      movementsByMonth: [
        { month: "2026-10", label: "Oct 26", new: 2, rejoined: 1, lost: 1, lostCancelled: 1, lostCompleted: 0, net: 2, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0, basis: "recorded", isCurrentMonth: true },
      ],
    },
    // The period's movement (this month): October's tally.
    periodMovement: {
      totals: { new: 2, rejoined: 1, lost: 1, lostCancelled: 1, lostCompleted: 0, net: 2, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0 },
      basis: "recorded",
      previousBasis: "none",
    },
    retention: { ratePct: 75, survived: 15, cohort: 20 },
    retentionRate: 75,
    paymentHealth: {
      ...base.paymentHealth,
      recoveryRate: 50,
      recovery: { ratePct: 50, recovered: 1, failedMembers: 2 },
    },
    currentMembersByStatus: [
      { status: "active", label: "Active", count: 9, percentage: 75 },
      { status: "inactive", label: "Inactive", count: 2, percentage: 17 },
      { status: "taster", label: "Taster", count: 1, percentage: 8 },
    ],
    checkInMethods: [
      { method: "qr", label: "QR", count: 30, percentage: 75 },
      { method: "admin", label: "Admin", count: 10, percentage: 25 },
    ],
    topClasses: [{ name: "Fundamentals", count: 90, sessions: 10, averageAttendance: 9, fillRate: 45, capacityTotal: 200 }],
    attendanceRate: {
      mode: "attendance-percentage", value: 33, label: "Members who attended", formula: "x",
      numerator: 3, denominator: 9,
    },
    ...overrides,
  };
}

function renderReports(data: ReportsData) {
  return render(<ReportsView data={data} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
}

function tileFor(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "p" });
  const card = el.closest("[data-testid='metric-card']");
  if (!card) throw new Error(`no metric card for ${label}`);
  return card as HTMLElement;
}

describe("ReportsView — churn tile with counts, joined beside it", () => {
  it("shows 10% (1 of 10) and the Joined tile immediately after it", () => {
    renderReports(reports());
    const churn = tileFor("Churn rate this month");
    expect(churn.textContent).toContain("10% (1 of 10)");
    // D11: the Joined tile sits immediately after churn, by the movement definition.
    const joined = screen.getByTestId("reports-joined-tile");
    // The churn tile is a drill-through link around its card.
    expect((churn.closest("a") ?? churn).nextElementSibling).toBe(joined);
    expect(within(joined).getByText("Joined this month (new + rejoined)")).toBeTruthy();
    expect(screen.getByTestId("reports-joined-value").textContent).toBe("3");
    expect(screen.getByTestId("reports-joined-new-this-month").textContent).toBe("New2");
    expect(screen.getByTestId("reports-joined-rejoined-this-month").textContent).toBe("Rejoined1");
    expect(screen.getByTestId("reports-joined-tasters-this-month").textContent).toBe("Tasters added0");
    expect(screen.getByTestId("reports-joined-lost-this-month").textContent).toBe("Left1");
    expect(screen.getByTestId("reports-joined-net").textContent).toBe("Net +2 this month (new + rejoined − left)");
  });

  it("an empty base renders a dash on the churn tile, not 0%", () => {
    renderReports(reports({ churn: { ratePct: null, cancelled: 0, base: 0, joined: 0, net: 0 }, churnRate: 0 }));
    const churn = tileFor("Churn rate this month");
    expect(churn.textContent).toContain("—");
    expect(churn.textContent).not.toMatch(/0%/);
  });

  it("payment recovery and 6-month survival carry their counts", () => {
    renderReports(reports());
    expect(tileFor("Payment recovery rate").textContent).toContain("50% (1 of 2)");
    expect(screen.getByText(/6-month survival: 75% \(15 of 20\)/)).toBeTruthy();
  });
});

describe("ReportsView — every percentage shows its counts, matching the CSV", () => {
  it("status card is split: current shares with counts, then Left the club with no percentage", () => {
    renderReports(reports());
    expect(screen.getByText("Current members by status")).toBeTruthy();
    expect(screen.getByText("75% (9 of 12)")).toBeTruthy();
    expect(screen.getByText("17% (2 of 12)")).toBeTruthy();
    const left = screen.getByTestId("left-the-club");
    expect(left.textContent).toContain("Left the club: 3");
    expect(left.textContent).not.toMatch(/%/);
    expect(screen.queryByText(/Members by Status/)).toBeNull();
  });

  it("attention row counts inactive only and states the active share of current members", () => {
    renderReports(reports());
    expect(screen.getByText("2 inactive to review")).toBeTruthy();
    expect(screen.getByText("75% (9 of 12) of current members are active")).toBeTruthy();
    expect(screen.queryByText(/need review/)).toBeNull();
  });

  it("self-service, check-in methods, top-class fill and the rate readout all carry counts", () => {
    renderReports(reports());
    expect(screen.getByText("75% (30 of 40) self or QR")).toBeTruthy();
    expect(screen.getByText("75% (30 of 40)")).toBeTruthy();
    expect(screen.getByText("9/session · fill 45% (90 of 200)")).toBeTruthy();
    expect(screen.getByTestId("rate-readout-counts").textContent).toBe("(3 of 9)");
  });

  it("the CSV rows print exactly what the screen prints", () => {
    const data = reports();
    const csv = reportsCsv(data, ATTRIBUTION as never);
    renderReports(data);
    for (const text of [
      "10% (1 of 10)",
      "50% (1 of 2)",
      "75% (15 of 20)",
      "75% (9 of 12)",
      "75% (30 of 40)",
      "45% (90 of 200)",
    ]) {
      expect(csv).toContain(text);
      expect(document.body.textContent).toContain(text);
    }
    expect(csv).toContain("Left the club,Cancelled members,3,");
  });
});

describe("AnalysisView — engagement shows its counts", () => {
  const metrics = {
    totalMembers: 312, newThisMonth: 7, newLastMonth: 4, checkinsThisMonth: 50, checkinsLastMonth: 40,
    activeClasses: 6, activeMembersThisMonth: 31, monthLabel: "October 2026", gymName: "Test club", range: OCTOBER,
  };

  it("prints the rate with (n of m), and the change pills' two counts", () => {
    render(<AnalysisView metrics={metrics} primaryColor="#3b82f6" />);
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("(31 of 312) active members checked in this month")).toBeTruthy();
    expect(screen.getByText("7 joined this month · 4 last month")).toBeTruthy();
    expect(screen.getByText("this month · 40 last month")).toBeTruthy();
    // Every change pill shows the two figures it compares, never a bare "+x%".
    const pills = screen.getAllByTestId("analysis-change-pill").map((p) => p.textContent);
    expect(pills).toEqual(["+75% (7 vs 4)", "+25% (50 vs 40)"]);
    for (const p of pills) expect(p).toMatch(/^[+-]?\d+% \(\d+ vs \d+\)$/);
  });

  it("no active members → a dash, not 0%", () => {
    render(<AnalysisView metrics={{ ...metrics, totalMembers: 0, activeMembersThisMonth: 0 }} primaryColor="#3b82f6" />);
    expect(screen.getByText("No active members yet")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });
});

describe("half-up rounding on the Reports surfaces (review L6, round 2)", () => {
  it("wholePct from reports-primitives gives 15 for 29 of 200", () => {
    expect(wholePct(29, 200)).toBe(15);
  });

  it("CSV status Active row and Active share row print the same text for 29 of 200", () => {
    const data = reports({
      summary: { ...reports().summary, currentMembers: 200, activeMembers: 29 },
      currentMembersByStatus: [{ status: "active", label: "Active", count: 29, percentage: 15 }],
    });
    const csv = reportsCsv(data, ATTRIBUTION as never);
    const lines = csv.split("\n");
    const status = lines.find((l) => l.startsWith("Current members by status,Active,"));
    const share = lines.find((l) => l.startsWith("Owner insights,Active share of current members,"));
    expect(status).toContain("15% (29 of 200)");
    expect(share).toContain("15% (29 of 200)");
  });
});
