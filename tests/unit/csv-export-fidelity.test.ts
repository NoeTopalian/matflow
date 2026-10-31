import { resolveReportPeriod } from "@/lib/report-period";
import { describe, it, expect, vi } from "vitest";
import { csvCell, csvDocument, CSV_UTF8_BOM } from "@/lib/csv";

/**
 * Export fidelity (3 Oct 2026, Total BJJ handover): the two owner exports —
 * payments CSV and Reports CSV — must hand back every byte of every value, and
 * a spreadsheet must not execute anything in them. A round trip through an
 * RFC-4180 parser is the proof that the bytes survive; the formula guard is
 * the proof that nothing runs.
 */

// next/navigation and recharts are only touched when ReportsView RENDERS; the
// pure CSV builder never calls them, so a stub is enough for the import.
vi.mock("next/navigation", () => ({ useRouter: () => ({}), useSearchParams: () => new URLSearchParams() }));

/** A strict RFC-4180 reader: the oracle the exports are checked against. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

const stripBom = (s: string) => (s.startsWith(CSV_UTF8_BOM) ? s.slice(1) : s);

describe("csvCell — hostile cells survive a round trip", () => {
  const cases: [string, string, string][] = [
    // [label, input, what a reader gets back]
    ["comma", "Smith, John", "Smith, John"],
    ["double quote", 'Jo "The Hammer" Bloggs', 'Jo "The Hammer" Bloggs'],
    ["embedded LF", "line one\nline two", "line one\nline two"],
    ["embedded CRLF", "line one\r\nline two", "line one\r\nline two"],
    ["UK mobile with a space", "07700 900123", "07700 900123"],
    ["UK mobile, digits only", "07700900123", "07700900123"],
    ["postcode with leading zero", "0A1 1AA", "0A1 1AA"],
    ["accented", "Zoé Brontë", "Zoé Brontë"],
    ["emoji", "Kids 🥋 class", "Kids 🥋 class"],
    // The formula guard prefixes ONE apostrophe and nothing else — every other
    // character of the value comes back intact.
    ["leading =", "=HYPERLINK(\"http://x\",\"y\")", "'=HYPERLINK(\"http://x\",\"y\")"],
    ["leading +", "+44 7700 900123", "'+44 7700 900123"],
    ["leading -", "-1+cmd", "'-1+cmd"],
    ["leading @", "@SUM(A1)", "'@SUM(A1)"],
  ];
  for (const [label, input, expected] of cases) {
    it(`${label}`, () => {
      const parsed = parseCsv(stripBom(csvDocument([["a", input, "z"]])));
      expect(parsed).toEqual([["a", expected, "z"]]);
    });
  }

  it("a very long cell (20,000 characters with commas and quotes) comes back whole", () => {
    const long = 'x,"y"\n'.repeat(4000);
    expect(long.length).toBe(24000);
    expect(parseCsv(stripBom(csvDocument([[long]])))).toEqual([[long]]);
  });

  it("blank, zero and null are three different things on the way out", () => {
    // "" and null both give an empty cell (CSV cannot tell them apart); 0 is "0".
    expect(csvCell("")).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
    expect(parseCsv(stripBom(csvDocument([["", 0, null]])))).toEqual([["", "0", ""]]);
  });

  it("a negative NUMBER (a refund) stays numeric — no apostrophe", () => {
    expect(csvCell(-4500)).toBe("-4500");
  });
});

describe("csvDocument — encoding and line endings", () => {
  it("starts with a UTF-8 BOM so Excel on Windows reads é correctly", () => {
    const doc = csvDocument([["Zoé"]]);
    expect(doc.charCodeAt(0)).toBe(0xfeff);
    const bytes = new TextEncoder().encode(doc);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // é is the two UTF-8 bytes C3 A9, not a code-page byte.
    expect([...bytes.slice(5, 7)]).toEqual([0xc3, 0xa9]);
  });

  it("separates rows with CRLF and writes exactly one BOM", () => {
    const doc = csvDocument([["a"], ["b"]]);
    expect(doc).toBe(`${CSV_UTF8_BOM}a\r\nb`);
    expect(doc.split(CSV_UTF8_BOM).length).toBe(2);
  });
});

describe("Reports CSV (components/dashboard/ReportsView.tsx reportsCsv)", () => {
  it("passes every cell through the guard, writes a BOM and parses back row for row", async () => {
    const { reportsCsv } = await import("@/components/dashboard/ReportsView");
    const data = {
      weeksBack: 12,
      filters: { classId: null, className: null, ageGroup: null },
      summary: {
        totalMembers: 10, currentMembers: 9, activeMembers: 8, inactiveMembers: 1, cancelledMembers: 1, tasterMembers: 0,
        totalCheckIns: 0, totalActiveClasses: 2, attendanceThisWeek: 0, attendanceLastWeek: 0,
        newMembersThisMonth: 2, newMembersLastMonth: 0,
      },
      attendanceRate: { mode: "per_member_week", label: "Rate", value: null, formula: "a / b", numerator: 0, denominator: 0 },
      retentionRate: null,
      retention: { ratePct: null, survived: 0, cohort: 0 },
      // Churn (27 Oct 2026): the period's cancellations, a count (October has
      // none: lostCancelled 0 below). D11: joined and net are the movement
      // figures for the current month (Oct: 2 new + 1 rejoined).
      churn: { cancelled: 0, joined: 3, net: 3, opening: 6, base: 9, ratePct: 0 },
      paymentHealth: {
        overdueCount: 0, noPaymentYetCount: 0, failedLast30Days: 0, recoveryRate: 50,
        recovery: { ratePct: 50, recovered: 1, failedMembers: 2 },
      },
      weeklyAttendance: [],
      monthlySignups: [],
      topClasses: [{ name: "=HYPERLINK(\"http://evil\",\"x\")", count: 3, averageAttendance: 1.5, fillRate: null, capacityTotal: 0 }],
      membersByStatus: [{ status: "active", label: "Active, paying", count: 8, percentage: 80 }],
      currentMembersByStatus: [
        { status: "active", label: "Active, paying", count: 8, percentage: 89 },
        { status: "inactive", label: "Inactive", count: 1, percentage: 11 },
      ],
      checkInMethods: [],
      // T8c: movement and headcount by month; the first month is estimated.
      membership: {
        historySource: "ledger",
        fromJoinDates: 0,
        window: { from: "Sep 26", to: "Oct 26", months: 2 },
        totals: { new: 3, rejoined: 1, lost: 2, lostCancelled: 1, lostCompleted: 1, net: 2, imported: 5, otherIn: 0, otherOut: 0 },
        movementsByMonth: [
          { month: "2026-09", label: "Sep 26", new: 1, rejoined: 0, lost: 2, lostCancelled: 1, lostCompleted: 1, net: -1, imported: 0, otherIn: 0, otherOut: 0, basis: "estimated", isCurrentMonth: false },
          { month: "2026-10", label: "Oct 26", new: 2, rejoined: 1, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 3, imported: 5, otherIn: 0, otherOut: 0, basis: "mixed", isCurrentMonth: true },
        ],
        headcountByMonth: [
          { month: "2026-09", label: "Sep 26", headcount: 0, basis: "estimated", isCurrentMonth: false, at: "2026-09-30T22:59:59.999Z" },
          { month: "2026-10", label: "Oct 26", headcount: 8, basis: "recorded", isCurrentMonth: true, at: "2026-10-17T13:05:00.000Z" },
        ],
      },
      // T2c: the CSV states when its figures were computed.
      generatedAt: new Date(2026, 9, 17, 14, 5).toISOString(),
      // The statistics period (this month) and its movement: October's tally.
      range: resolveReportPeriod({}, new Date(2026, 9, 17, 14, 5), "Europe/London"),
      periodMovement: {
        totals: { new: 2, rejoined: 1, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 3, imported: 5, otherIn: 0, otherOut: 0, tasterAdded: 0 },
        basis: "mixed",
        previousBasis: "estimated",
      },
    };
    const attribution = {
      rows: [{ name: "Zoé \"Coach\" 🥋", trialsRun: 2, conversions: 1, conversionRate: null, retained: 1, retentionRate: null, lost: 0, undecided: 1 }],
      overall: { trials: 2, lost: 0, undecided: 1, converted: 1, conversionRate: null, churned: 0, retained: 1, retentionRate: null },
      epochStart: null,
      minTrials: 5,
    };
    // The fixture carries only the fields the CSV reads.
    const csv = reportsCsv(data as never, attribution as never);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(stripBom(csv));
    expect(rows[0]).toEqual(["Section", "Metric", "Value", "Detail"]);
    // T2c: the first data row is the as-of stamp, in the same en-GB
    // date-time the screen uses ("As of 14:05").
    expect(rows[1]).toEqual(["Report", "Generated at", "17 Oct 2026, 14:05", "Figures cached for up to 60 seconds"]);
    // Every row has the same four columns — no cell split a row.
    expect(rows.every((r) => r.length === 4)).toBe(true);
    const topClass = rows.find((r) => r[0] === "Top classes");
    expect(topClass?.[1]).toBe("'=HYPERLINK(\"http://evil\",\"x\")");
    // Q4 A-2 split: current members by status, shares over current members
    // with their counts; those who left are a count with no percentage.
    const status = rows.find((r) => r[0] === "Current members by status");
    expect(status).toEqual(["Current members by status", "Active, paying", "8", "89% (8 of 9)"]);
    expect(rows.some((r) => r[0] === "Members by status")).toBe(false);
    const left = rows.find((r) => r[0] === "Left the club");
    expect(left?.[2]).toBe("1");
    expect(left?.[3]).not.toMatch(/%/);
    // Churn row: the tile's percentage with its counts, the cancellations and base in words, what it counts, the period's estimate note.
    const churnRow = rows.find((r) => r[1] === "Churn this month");
    expect(churnRow?.[2]).toBe("0% (0 of 9)");
    expect(churnRow?.[3]).toBe("0 cancellations this month, out of 9 members (6 at the start, 3 became members since) · Every cancellation in the period, including people who joined during it. Finished prepaid courses are not churn (they are in Left). Club-wide · Partly estimated");
    // D11: the Joined tile line for line — the movement definition, the card's figures.
    const joined = rows.find((r) => r[1] === "Joined this month (new + rejoined)");
    expect(joined?.[2]).toBe("3");
    expect(joined?.[3]).toMatch(/^New 2 · Rejoined 1 · Tasters added 0 · Left 0 · Net \+3 · New: first ever start/);
    expect(rows.find((r) => r[1] === "Rejoined this month")?.[2]).toBe("1");
    expect(rows.find((r) => r[1] === "Payment recovery")?.[2]).toBe("50% (1 of 2)");
    // Undefined rates export as a dash, never "0%".
    expect(rows.find((r) => r[1] === "6-month survival")?.[2]).toBe("—");
    expect(rows.find((r) => r[1] === "Self-service check-in")?.[2]).toBe("—");
    expect(rows.find((r) => r[1] === "Active share of current members")?.[2]).toBe("89% (8 of 9)");
    // T8c: the window's tally, one movement row per month with its basis, and
    // the headcount at each month end; today's equals the Active members tile.
    const movement = rows.find((r) => r[0] === "Membership movement");
    expect(movement?.[1]).toBe("Sep 26 – Oct 26");
    expect(movement?.[2]).toBe("2");
    expect(movement?.[3]).toMatch(/^New 3 · Rejoined 1 · Left 2 \(cancelled 1, completed course 1\) · Tasters added 0 · New: first ever start/);
    expect(movement?.[3]).toContain("Members deleted from MatFlow are not in past months.");
    const byMonth = rows.filter((r) => r[0] === "Membership movement by month");
    expect(byMonth.map((r) => [r[1], r[2]])).toEqual([["Sep 26", "-1"], ["Oct 26", "3"]]);
    expect(byMonth[0][3]).toContain("Estimated from your TeamUp history");
    expect(byMonth[1][3]).toContain("Brought over by an import without dated history 5");
    expect(byMonth[1][3]).toContain("Partly estimated");
    const heads = rows.filter((r) => r[0] === "Active members at month end");
    expect(heads.map((r) => [r[1], r[2]])).toEqual([["Sep 26", "0"], ["Oct 26", "8"]]);
    expect(heads[1][2]).toBe(String(data.summary.activeMembers));
    expect(heads[1][3]).toBe("Today, equals Active members");
    expect(heads[0][3]).toBe("Active members at month end · Estimated from your TeamUp history");
    const coach = rows.find((r) => r[0] === "Conversion by coach");
    expect(coach?.[1]).toBe("Zoé \"Coach\" 🥋");
    // No text cell in the file starts with a live formula character. A
    // negative number we rendered ourselves (a month's net, -1) is data, not a
    // formula, and stays a number (lib/csv.ts csvCell).
    for (const r of rows) for (const c of r) expect(/^[=+\-@]/.test(c) && !/^-\d+$/.test(c)).toBe(false);
  });

  // T2c acceptance 3: the as-of row states the time shown on screen, and the
  // file name carries the same date — both from generatedAt, not "now".
  it("the Generated at row and the file name come from generatedAt, and agree with the on-screen 'As of' time", async () => {
    const { reportsCsv, reportsCsvFilename, generatedAtTime } = await import("@/components/dashboard/ReportsView");
    // 23:40 local: late enough that a UTC-derived date could be the next day
    // in a zone east of UTC, or the wrong day when the page is left open.
    const generatedAt = new Date(2026, 9, 17, 23, 40).toISOString();
    const minimal = {
      weeksBack: 4,
      filters: { classId: null, className: null, ageGroup: null },
      summary: { totalMembers: 0, currentMembers: 0, activeMembers: 0, cancelledMembers: 0, totalCheckIns: 0, totalActiveClasses: 0, attendanceThisWeek: 0, attendanceLastWeek: 0, newMembersThisMonth: 0, newMembersLastMonth: 0 },
      attendanceRate: { mode: "checkins-per-member", label: "Rate", value: null, formula: "a / b", numerator: 0, denominator: 0 },
      retention: { ratePct: null, survived: 0, cohort: 0 },
      churn: { cancelled: 0, joined: 0, net: 0, opening: 0, base: 0, ratePct: null },
      paymentHealth: { recovery: { ratePct: null, recovered: 0, failedMembers: 0 } },
      weeklyAttendance: [], monthlySignups: [], topClasses: [], currentMembersByStatus: [], checkInMethods: [],
      membership: { movementsByMonth: [], headcountByMonth: [] },
      generatedAt,
      range: resolveReportPeriod({}, new Date(generatedAt), "Europe/London"),
      periodMovement: { totals: { new: 0, rejoined: 0, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 0, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0 }, basis: "none", previousBasis: "none" },
    };
    const attribution = { rows: [], overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null }, epochStart: null, minTrials: 5 };
    const rows = parseCsv(stripBom(reportsCsv(minimal as never, attribution as never)));
    expect(rows[1]).toEqual(["Report", "Generated at", "17 Oct 2026, 23:40", "Figures cached for up to 60 seconds"]);
    expect(generatedAtTime(generatedAt)).toBe("23:40");
    expect(rows[1][2]).toContain(generatedAtTime(generatedAt));
    expect(reportsCsvFilename(generatedAt)).toBe("matflow-reports-2026-10-17.csv");
  });

  it("an unreadable generatedAt prints a dash, never 'Invalid Date'", async () => {
    const { generatedAtTime } = await import("@/components/dashboard/ReportsView");
    expect(generatedAtTime("not a date")).toBe("—");
  });
});
