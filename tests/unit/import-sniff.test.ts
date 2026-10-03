/**
 * Which import a CSV belongs to, from its header row (lib/importers/sniff.ts).
 *
 * The two operator failures of 3 Oct 2026 are reproduced first, at the parser
 * level, so the record of WHY the sniff exists cannot rot:
 *  - a TeamUp memberships export under the attendance import →
 *    "Missing required column(s): class (e.g. "Event Name")";
 *  - the same file under Members with Source "Generic CSV" (the panel default)
 *    → one error, "Couldn't find name or email columns", and totalRows 1
 *    (the preview's totalRows is drafts + errors).
 * Then the sniff itself, and a pin that keeps it agreeing with the parsers.
 */
import { describe, it, expect } from "vitest";
import { parseImport } from "@/lib/importers";
import { parseAttendanceCsv } from "@/lib/importers/attendance";
import { parseTeamUp } from "@/lib/importers/teamup";
import { csvHeaderCells, sniffCsvKind } from "@/lib/importers/sniff";

// The export's exact header row (tests/unit/import-teamup.test.ts) with one invented row.
const TEAMUP_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const TEAMUP_ROW =
  "Ada Lovelace,ada@example.test,,Adults Advanced 2026,recurring,active,Stripe,2026-01-14,2026-01-14,,,Yes,,,,,,,GB,,07000000001,,1990-04-15,,,";
// What TeamUp actually sends: a byte-order mark and CRLF line ends.
const TEAMUP_FILE = `﻿${TEAMUP_HEADER}\r\n${TEAMUP_ROW}\r\n`;

// TeamUp's real attendance report header (3 Oct 2026), verbatim.
const TEAMUP_ATTENDANCE_HEADER =
  "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";

const ATTENDANCE_HEADER = "Attendance ID,Customer Email,Customer Name,Event Name,Start Date,Start Time,Status";
const ATTENDANCE_FILE = `${ATTENDANCE_HEADER}\nA1,ada@example.test,Ada Lovelace,Fundamentals,2026-09-01,18:00,attended\n`;

describe("the two operator failures, reproduced (3 Oct 2026)", () => {
  it("a TeamUp memberships export under the attendance import fails on the class column", () => {
    const r = parseAttendanceCsv(TEAMUP_FILE);
    expect(r.rows).toHaveLength(0);
    expect(r.errors).toEqual([`Missing required column(s): class or offering (e.g. "Offering Type Name" or "Event Name").`]);
  });

  it("the same file under Members with Source Generic gives one header error and totalRows 1", () => {
    const { drafts, errors } = parseImport("generic", TEAMUP_FILE);
    expect(drafts).toHaveLength(0);
    expect(errors).toEqual([{ row: 0, reason: "Couldn't find name or email columns." }]);
    // app/api/admin/import/[id]/preview/route.ts: totalRows = drafts.length + errors.length
    expect(drafts.length + errors.length).toBe(1);
  });

  it("and under Source TeamUp it parses (BOM and CRLF included)", () => {
    const r = parseTeamUp(TEAMUP_FILE, { asOf: "2026-10-02" });
    expect(r.errors).toEqual([]);
    expect(r.drafts.map((d) => d.name)).toEqual(["Ada Lovelace"]);
  });
});

describe("sniffCsvKind", () => {
  it("recognises the TeamUp memberships export with a BOM and CRLF", () => {
    expect(sniffCsvKind(TEAMUP_FILE)).toBe("teamup_memberships");
    expect(sniffCsvKind(TEAMUP_HEADER)).toBe("teamup_memberships");
  });

  it("is case-insensitive and ignores surrounding spaces", () => {
    expect(sniffCsvKind(TEAMUP_HEADER.toUpperCase())).toBe("teamup_memberships");
    expect(sniffCsvKind(TEAMUP_HEADER.toLowerCase().split(",").map((h) => `  ${h} `).join(","))).toBe("teamup_memberships");
  });

  it("reads quoted header cells, including a quoted comma", () => {
    const quoted = TEAMUP_HEADER.split(",").map((h) => `"${h}"`).join(",") + ',"Notes, internal"';
    expect(csvHeaderCells(quoted)).toContain("notes, internal");
    expect(sniffCsvKind(quoted)).toBe("teamup_memberships");
  });

  it("reads the header only — a first 4 KB slice that cuts a data row is fine", () => {
    expect(sniffCsvKind(`${TEAMUP_HEADER}\r\n${TEAMUP_ROW.slice(0, 20)}`)).toBe("teamup_memberships");
  });

  it("names a TeamUp attendance export (a wrong report type for Members)", () => {
    expect(sniffCsvKind(ATTENDANCE_FILE)).toBe("teamup_attendance");
    expect(sniffCsvKind(`﻿${ATTENDANCE_HEADER.toUpperCase()}\r\n`)).toBe("teamup_attendance");
  });

  it("names the real TeamUp attendance export (26 columns) as attendance, not memberships", () => {
    // It also carries Customer Name, Membership Name and Status — the memberships trio.
    expect(sniffCsvKind(TEAMUP_ATTENDANCE_HEADER)).toBe("teamup_attendance");
    expect(sniffCsvKind(`﻿${TEAMUP_ATTENDANCE_HEADER}\r\n`)).toBe("teamup_attendance");
  });

  it("names the real TeamUp memberships header as memberships", () => {
    expect(sniffCsvKind(TEAMUP_HEADER)).toBe("teamup_memberships");
  });

  it("a memberships header missing Membership Name is not called a TeamUp memberships export", () => {
    expect(sniffCsvKind(TEAMUP_HEADER.replace("Membership Name,", ""))).not.toBe("teamup_memberships");
  });

  it("keeps valid generic / MindBody / Glofox / Wodify member files as member files", () => {
    expect(sniffCsvKind("name,email,phone,dob,membership,status,joined")).toBe("generic_members");
    expect(sniffCsvKind("Client Name,Email,Mobile Phone,Birth Date,Client Status")).toBe("generic_members");
    expect(sniffCsvKind("Name,Email,Phone Number,DOB,Membership Name,Status")).toBe("generic_members");
    expect(sniffCsvKind("Athlete Name,Email,Phone,Start Date,Status")).toBe("generic_members");
    // A generic member list with a plain "Class" column is NOT taken for attendance.
    expect(sniffCsvKind("Name,Email,Class,Start Date,Status")).toBe("generic_members");
  });

  it("says unknown for an empty file or headers it cannot place", () => {
    expect(sniffCsvKind("")).toBe("unknown");
    expect(sniffCsvKind("﻿\r\n")).toBe("unknown");
    expect(sniffCsvKind("foo,bar,baz")).toBe("unknown");
  });
});

describe("the sniff agrees with the parsers (so the two cannot drift)", () => {
  it("every file it calls teamup_memberships, parseTeamUp accepts", () => {
    for (const f of [TEAMUP_FILE, TEAMUP_HEADER.toUpperCase() + "\n" + TEAMUP_ROW]) {
      expect(sniffCsvKind(f)).toBe("teamup_memberships");
      expect(parseTeamUp(f, { asOf: "2026-10-02" }).errors.filter((e) => e.row === 0)).toEqual([]);
    }
  });

  it("every file it calls teamup_attendance, parseAttendanceCsv accepts", () => {
    expect(parseAttendanceCsv(ATTENDANCE_FILE).errors).toEqual([]);
    const real = `${TEAMUP_ATTENDANCE_HEADER}\nAda Lovelace,ada@example.test,2025-10-04T09:00:00+01:00,Adults Gi,Main Mat,,Online,CM-1,MS-1,Adults Unlimited,Web,Attended,,,,,,,GB,,,,,,,`;
    expect(sniffCsvKind(real)).toBe("teamup_attendance");
    expect(parseAttendanceCsv(real).errors).toEqual([]);
  });

  it("every generic_members file, the generic parser finds name or email in", () => {
    for (const [src, f] of [
      ["generic", "name,email\nA,a@example.test"],
      ["mindbody", "Client Name,Email\nA,a@example.test"],
      ["wodify", "Athlete Name,Email\nA,a@example.test"],
    ] as const) {
      expect(sniffCsvKind(f)).toBe("generic_members");
      expect(parseImport(src, f).errors).toEqual([]);
    }
  });
});
