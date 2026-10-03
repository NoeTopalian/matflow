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
        totalMembers: 10, activeMembers: 8, inactiveMembers: 1, cancelledMembers: 1, tasterMembers: 0,
        totalCheckIns: 0, totalActiveClasses: 2, attendanceThisWeek: 0, attendanceLastWeek: 0,
        newMembersThisMonth: 0, newMembersLastMonth: 0,
      },
      attendanceRate: { mode: "per_member_week", label: "Rate", value: null, formula: "a / b" },
      retentionRate: null,
      weeklyAttendance: [],
      monthlySignups: [],
      topClasses: [{ name: "=HYPERLINK(\"http://evil\",\"x\")", count: 3, averageAttendance: 1.5, fillRate: null }],
      membersByStatus: [{ status: "active", label: "Active, paying", count: 8, percentage: 80 }],
      checkInMethods: [],
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
    // Every row has the same four columns — no cell split a row.
    expect(rows.every((r) => r.length === 4)).toBe(true);
    const topClass = rows.find((r) => r[0] === "Top classes");
    expect(topClass?.[1]).toBe("'=HYPERLINK(\"http://evil\",\"x\")");
    const status = rows.find((r) => r[0] === "Members by status");
    expect(status?.[1]).toBe("Active, paying");
    const coach = rows.find((r) => r[0] === "Conversion by coach");
    expect(coach?.[1]).toBe("Zoé \"Coach\" 🥋");
    // No cell in the file starts with a live formula character.
    for (const r of rows) for (const c of r) expect(/^[=+\-@]/.test(c)).toBe(false);
  });
});
