// @vitest-environment jsdom
//
// 24 Oct 2026 reporting requirements (#39):
//   1. estimated and partly estimated movement figures are labelled wherever
//      they are shown or exported: the Joined tile, "New this month", the
//      6-month Joined chart, the CSV "Joined by month" rows (were "Monthly
//      signups"), the CSV window "Membership movement" row, past-month Members
//      drill-throughs, and partly estimated months on the Net New chart;
//   2. every percentage change carries the figures behind it ("+50% (3 vs 2)"),
//      on Reports pills as on Analysis;
//   3. a screen that counts by join date says so (Analysis, the AI report).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, LineChart: Pass, PieChart: Pass, ComposedChart: Pass,
    Bar: Pass, Line: Nothing, Pie: Pass, Cell: Nothing, XAxis: Nothing, YAxis: Nothing, Area: Nothing,
    Tooltip: Nothing, CartesianGrid: Nothing,
    ReferenceLine: (p: { x?: string; y?: number }) => <span data-reference-line={p.x ?? String(p.y)} />,
    ReferenceArea: (p: { x1: string; x2: string; strokeDasharray?: string }) => (
      <span data-band={`${p.x1}|${p.x2}`} data-dashed={p.strokeDasharray ? "yes" : "no"} />
    ),
  };
});
vi.mock("@/components/dashboard/MonthlyReportView", () => ({ default: () => null }));
vi.mock("@/components/dashboard/InitiativesPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/ConversionFunnel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/charts/Sparkline", () => ({ default: () => null }));

import ReportsView, {
  estimateLabel,
  joinedEstimateNote,
  monthPairEstimateNote,
  reportsCsv,
  trendDelta,
} from "@/components/dashboard/ReportsView";
import NetNewMembersCard from "@/components/dashboard/NetNewMembersCard";
import MembersList from "@/components/dashboard/MembersList";
import { createEmptyReportsData, type ReportsData } from "@/lib/reports";
import { MONTH_SO_FAR, WEEK_SO_FAR } from "@/lib/percent";
import { emptyMembershipReport, type MembershipReport } from "@/lib/membership-report";
import {
  combinedBasis,
  moversAndBasisInWindow,
  movementWindowBasis,
  type MembershipBasis,
  type MovementEvent,
} from "@/lib/membership-movement";
import { buildNetNewSeries, partlyEstimatedMonths } from "@/lib/net-new-series";
import { clubMonthWindow, clubMonthWindowForKey } from "@/lib/club-month";

afterEach(() => {
  cleanup();
  currentSearch = "";
});

const ATTRIBUTION = {
  rows: [],
  overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null },
  epochStart: null,
  minTrials: 5,
};

function mv(month: string, label: string, n: number, r: number, lost: number, basis: MembershipBasis, current = false) {
  return {
    month, label, new: n, rejoined: r, lost, lostCancelled: lost, lostCompleted: 0, net: n + r - lost,
    imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0, basis, isCurrentMonth: current,
  };
}

/** Aug and Sep reconstructed from the TeamUp history, Oct partly (the switch was 3 Oct). */
function membership(currentBasis: MembershipBasis = "mixed"): MembershipReport {
  return {
    ...emptyMembershipReport(),
    boundary: "2026-10-03T11:00:00.000Z",
    window: { from: "Aug 26", to: "Oct 26", months: 3 },
    historySource: "backfill",
    movementsByMonth: [
      mv("2026-08", "Aug 26", 4, 0, 1, "estimated"),
      mv("2026-09", "Sep 26", 2, 0, 2, "estimated"),
      mv("2026-10", "Oct 26", 2, 1, 1, currentBasis, true),
    ],
    headcountByMonth: [
      { month: "2026-08", label: "Aug 26", headcount: 30, basis: "estimated", isCurrentMonth: false, at: "2026-08-31T22:59:59.999Z" },
      { month: "2026-09", label: "Sep 26", headcount: 30, basis: "estimated", isCurrentMonth: false, at: "2026-09-30T22:59:59.999Z" },
      { month: "2026-10", label: "Oct 26", headcount: 32, basis: "mixed", isCurrentMonth: true, at: "2026-10-24T12:00:00.000Z" },
    ],
    totals: { new: 8, rejoined: 1, lost: 4, lostCancelled: 4, lostCompleted: 0, net: 5, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0 },
  };
}

function reports(m: MembershipReport = membership()): ReportsData {
  const base = createEmptyReportsData();
  return {
    ...base,
    summary: { ...base.summary, activeMembers: 32, currentMembers: 35, attendanceThisWeek: 45, attendanceLastWeek: 40, newMembersThisMonth: 2, newMembersLastMonth: 2 },
    churn: { ratePct: 3, cancelled: 1, base: 33, joined: 3, net: 2 },
    membership: m,
    monthlySignups: [
      { month: "Aug 2026", count: 4, isCurrentMonth: false, basis: "estimated" },
      { month: "Sep 2026", count: 2, isCurrentMonth: false, basis: "estimated" },
      { month: "Oct 2026", count: 3, isCurrentMonth: true, basis: m.movementsByMonth[2].basis },
    ],
  };
}

describe("estimate labels: pure rules", () => {
  it("a window's basis: none before any event, estimated before the first recorded event, mixed across it, recorded after", () => {
    const w = (from: string, to: string) => ({ start: new Date(from), at: new Date(to) });
    const first = Date.parse("2026-01-01T00:00:00Z");
    const boundary = Date.parse("2026-10-03T00:00:00Z");
    expect(movementWindowBasis(w("2025-11-01", "2025-11-30"), first, boundary, 0)).toBe("none");
    expect(movementWindowBasis(w("2026-09-01", "2026-09-30"), first, boundary, 3)).toBe("estimated");
    expect(movementWindowBasis(w("2026-10-01", "2026-10-31"), first, boundary, 0)).toBe("mixed");
    expect(movementWindowBasis(w("2026-11-01", "2026-11-30"), first, boundary, 0)).toBe("recorded");
    // A reconstructed move inside an otherwise recorded month makes it partly estimated.
    expect(movementWindowBasis(w("2026-11-01", "2026-11-30"), first, boundary, 1)).toBe("mixed");
    expect(movementWindowBasis(w("2026-09-01", "2026-09-30"), first, null, 0)).toBe("estimated");
  });

  it("a window total: all recorded, all estimated, or mixed; months with no data are ignored", () => {
    expect(combinedBasis(["recorded", "recorded"])).toBe("recorded");
    expect(combinedBasis(["none", "estimated", "estimated"])).toBe("estimated");
    expect(combinedBasis(["estimated", "recorded"])).toBe("mixed");
    expect(combinedBasis(["none"])).toBe("none");
  });

  it("the labels: wholly estimated says what it came from, partly estimated says so, recorded says nothing", () => {
    expect(estimateLabel("estimated", "Estimated from your TeamUp history")).toBe("Estimated from your TeamUp history");
    expect(estimateLabel("mixed", "Estimated from your TeamUp history")).toBe("Partly estimated");
    expect(estimateLabel("recorded", "x")).toBeNull();
    expect(estimateLabel("none", "x")).toBeNull();
  });

  it("the drill-through basis comes from the same replay: a back-filled (estimated) move in a past month", () => {
    const ev = (id: string, memberId: string, toStatus: string, at: string, estimated = false): MovementEvent => ({
      id, memberId, toStatus, occurredAt: new Date(at), createdAt: new Date(at), estimated,
    });
    const input = {
      events: [
        ev("e1", "m1", "active", "2026-09-10T10:00:00Z", true), // back-filled from TeamUp
        ev("e2", "m2", "active", "2026-10-10T10:00:00Z"), // recorded at the time
      ],
      live: [{ id: "m1", status: "active" }, { id: "m2", status: "active" }],
      now: new Date("2026-10-24T12:00:00Z"),
      boundary: new Date("2026-10-10T10:00:00Z"),
    };
    const sep = moversAndBasisInWindow(input, { start: new Date("2026-08-31T23:00:00Z"), at: new Date("2026-09-30T22:59:59.999Z") });
    expect(sep.movers.new).toEqual(["m1"]);
    expect(sep.basis).toBe("estimated");
    const oct = moversAndBasisInWindow(input, { start: new Date("2026-09-30T23:00:00Z"), at: input.now });
    expect(oct.movers.new).toEqual(["m2"]);
    // October began before the first recorded event, so it is partly estimated.
    expect(oct.basis).toBe("mixed");
  });

  it("the Net New chart's partly estimated months, by the view's basis", () => {
    const points = buildNetNewSeries(membership());
    expect(partlyEstimatedMonths(points)).toEqual(["Oct 26"]);
    expect(partlyEstimatedMonths(points, "headcountBasis")).toEqual(["Oct 26"]);
  });
});

describe("estimate labels: Reports screen", () => {
  it("the Joined tile, the New this month tile and the Joined chart say what is estimated", () => {
    render(<ReportsView data={reports()} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(screen.getByTestId("reports-joined-estimate").textContent).toBe(
      "Partly estimated: some of this month's moves are reconstructed, not recorded at the time.",
    );
    expect(screen.getByText(/First ever start\. Rejoins, tasters and imports are counted apart · This month partly estimated · last month estimated from your TeamUp history/)).toBeTruthy();
    expect(screen.getByTestId("reports-joined-chart-estimate").textContent).toBe(
      "Estimated from your TeamUp history: Aug 2026, Sep 2026. Partly estimated: Oct 2026. Hollow dots are not wholly recorded at the time.",
    );
  });

  it("a wholly recorded club shows no estimate line anywhere", () => {
    const recorded: MembershipReport = {
      ...membership("recorded"),
      boundary: "2026-01-01T00:00:00.000Z",
      movementsByMonth: membership("recorded").movementsByMonth.map((r) => ({ ...r, basis: "recorded" as const })),
    };
    const data = reports(recorded);
    data.monthlySignups = data.monthlySignups.map((r) => ({ ...r, basis: "recorded" }));
    render(<ReportsView data={data} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    expect(screen.queryByTestId("reports-joined-estimate")).toBeNull();
    expect(screen.queryByTestId("reports-joined-chart-estimate")).toBeNull();
    expect(monthPairEstimateNote(recorded)).toBeNull();
    expect(joinedEstimateNote(data.monthlySignups, "Estimated")).toBeNull();
  });

  it("a trend pill carries the two figures behind its percentage", () => {
    expect(trendDelta(45, 40)).toBe("+13% (45 vs 40)");
    expect(trendDelta(30, 40)).toBe("-25% (30 vs 40)");
    // W3 (owner decision, 27 Oct 2026, 23:30): no previous figure, no
    // percentage, the counts kept (it read a bare "+5").
    expect(trendDelta(5, 0)).toBe("— (5 vs 0)");
    expect(trendDelta(4, 4)).toBeNull();
    render(<ReportsView data={reports()} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    // The Attendance this week pill and the Attendance pulse insight: this
    // week is Monday to now, last week the whole week, and both say so
    // (review finding 1, 27 Oct 2026).
    expect(screen.getAllByText("+13% (45 so far this week vs 40 all last week)")).toHaveLength(2);
    expect(screen.queryByText("on last week")).toBeNull();
    expect(screen.getByText("This week counts from Monday; last week is the whole week")).toBeTruthy();
  });

  it("a part period against a whole one says so: a Monday morning, and the month so far", () => {
    expect(trendDelta(12, 120, WEEK_SO_FAR)).toBe("-90% (12 so far this week vs 120 all last week)");
    expect(trendDelta(3, 10, MONTH_SO_FAR)).toBe("-70% (3 so far this month vs 10 all last month)");
    expect(trendDelta(5, 0, WEEK_SO_FAR)).toBe("— (5 so far this week vs 0 all last week)");
    expect(trendDelta(4, 4, WEEK_SO_FAR)).toBeNull();
    const data = reports();
    data.summary = { ...data.summary, attendanceThisWeek: 12, attendanceLastWeek: 120, newMembersThisMonth: 3, newMembersLastMonth: 10 };
    render(<ReportsView data={data} attribution={ATTRIBUTION as never} primaryColor="#3b82f6" />);
    const badges = screen.getAllByTestId("trend-badge").map((b) => b.textContent);
    expect(badges).toEqual([
      "-90% (12 so far this week vs 120 all last week)",
      "-70% (3 so far this month vs 10 all last month)",
    ]);
    // The Owner Insights pulse row prints the same text.
    expect(screen.getAllByText("-90% (12 so far this week vs 120 all last week)")).toHaveLength(2);
  });
});

describe("estimate labels: the CSV", () => {
  const csv = reportsCsv(reports(), ATTRIBUTION as never);
  const line = (start: string) => csv.split("\r\n").find((l) => l.startsWith(start)) ?? "";

  it("Joined by month rows (were 'Monthly signups') say which months are estimated", () => {
    expect(csv).not.toContain("Monthly signups");
    expect(line("Joined by month (new + rejoined),Aug 2026,4,")).toContain("Estimated from your TeamUp history");
    expect(line("Joined by month (new + rejoined),Oct 2026,3,")).toBe("Joined by month (new + rejoined),Oct 2026,3,Current month · Partly estimated");
  });

  it("the window Membership movement row is labelled partly estimated", () => {
    expect(line("Membership movement,Aug 26 – Oct 26,5,")).toMatch(/· Partly estimated"?$/);
  });

  it("this month's Joined, New, Rejoined, Tasters and Left rows and the summary New row carry the label", () => {
    for (const metric of ["Joined this month (new + rejoined)", "New this month", "Rejoined this month", "Tasters added this month", "Left this month"]) {
      expect(line(`Health,${metric},`)).toContain("Partly estimated");
    }
    expect(line("Summary,New members this month,2,")).toContain("This month partly estimated · last month estimated from your TeamUp history");
  });
});

describe("estimate labels: the Net New Members chart marks partly estimated months", () => {
  it("draws a dashed mark on each partly estimated month and names them under the chart", () => {
    const { container } = render(<NetNewMembersCard membership={membership()} />);
    const dashed = [...container.querySelectorAll("[data-band]")].filter((el) => el.getAttribute("data-dashed") === "yes");
    expect(dashed.map((el) => el.getAttribute("data-band"))).toEqual(["Oct 26|Oct 26"]);
    expect(screen.getByTestId("net-new-partly-estimated").textContent).toBe(
      "Partly estimated (dashed): Oct 26 — some of the moves are reconstructed, not recorded at the time.",
    );
  });
});

describe("estimate labels: a past month's Members drill-through", () => {
  const sep = clubMonthWindowForKey("2026-09", "Europe/London")!;
  const rows = [
    { id: "m1", name: "Ada Example", email: "ada@example.test", phone: "+447700900111", membershipType: "Adult", status: "active", accountType: "adult", paymentStatus: "paid", waiverAccepted: true, parentMemberId: null, joinedAt: "2026-09-10T10:00:00.000Z", cancelledAt: null, lastVisitAt: null, moved: ["new" as const] },
  ];
  function renderDrill(basis: MembershipBasis) {
    currentSearch = "filter=new-this-month&month=2026-09";
    return render(
      <MembersList
        members={rows as never}
        primaryColor="#3b82f6"
        role="owner"
        monthWindow={{ ...sep, isCurrent: false }}
        movers={{ new: 1, rejoined: 0, lost: 0, tasterAdded: 0 }}
        moversBasis={{ basis, caption: "Estimated from your TeamUp history" }}
      />,
    );
  }

  it("an estimated month says the moves are reconstructed", () => {
    renderDrill("estimated");
    expect(screen.getByTestId("members-headline").textContent).toBe("1 new in September 2026");
    expect(screen.getByTestId("members-headline-basis").textContent).toBe(
      "Estimated from your TeamUp history: these moves are reconstructed, not recorded at the time.",
    );
  });

  it("a partly estimated month says some are", () => {
    renderDrill("mixed");
    expect(screen.getByTestId("members-headline-basis").textContent).toBe(
      "Partly estimated: some of these moves are reconstructed, not recorded at the time.",
    );
  });

  it("a recorded month says nothing extra", () => {
    renderDrill("recorded");
    expect(screen.queryByTestId("members-headline-basis")).toBeNull();
  });
});

describe("Analysis and the AI report show the Reports Joined figure (review 25 Oct: never Member.joinedAt)", () => {
  it("the AI monthly report reads Joined from the movement replay and asks for counts with every percentage", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/ai-causal-report.ts"), "utf8");
    expect(src).toMatch(/- Members joined this period \(new \+ rejoined, the Reports "Joined" figure; imports are never joins/);
    expect(src).toMatch(/loadJoinedInWindows\(/);
    expect(src).not.toMatch(/joinedAt:/);
    expect(src).toMatch(/Whenever you give a percentage, give the two figures behind it as well/);
  });

  it("the Analysis page counts Joined by movement in the club's months, and its report says so", async () => {
    const page = readFileSync(path.join(process.cwd(), "app/dashboard/analysis/page.tsx"), "utf8");
    expect(page).toMatch(/loadJoinedInWindows\(/);
    expect(page).toMatch(/clubMonthWindow\(now, tenant\?\.timezone/);
    expect(page).not.toMatch(/joinedAt:/);
    const { buildReport } = await import("@/components/dashboard/AnalysisView");
    const text = buildReport(
      { totalMembers: 20, newThisMonth: 3, newLastMonth: 2, checkinsThisMonth: 50, checkinsLastMonth: 40, activeClasses: 4, activeMembersThisMonth: 10, monthLabel: "October 2026", gymName: "Test club" },
      [],
    );
    expect(text).toContain("**3 joined** (new + rejoined) this month, compared to 2 last month");
    const estimated = buildReport(
      { totalMembers: 20, newThisMonth: 3, newLastMonth: 2, joinedEstimated: true, checkinsThisMonth: 50, checkinsLastMonth: 40, activeClasses: 4, activeMembersThisMonth: 10, monthLabel: "October 2026", gymName: "Test club" },
      [],
    );
    expect(estimated).toContain("**3 joined** (new + rejoined) this month (partly estimated)");
  });

  it("the club month window used above is the club's (sanity)", () => {
    expect(clubMonthWindow(new Date("2026-09-15T12:00:00Z"), "Europe/London").monthKey).toBe("2026-09");
  });
});
