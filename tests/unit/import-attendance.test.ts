// Attendance history import: parser, planner and controls (lib/importers/attendance.ts).
//
// The header row is TeamUp's attendance export exactly as Total BJJ's real
// file carries it (3 Oct 2026, 26 columns). Every name, email and id below is
// invented; nothing is copied from a real export.

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  parseAttendanceCsv,
  parseOffsetInstant,
  planAttendanceImport,
  attendanceControls,
  bookingKeyOf,
  localToUtc,
  localWallClock,
  dayMarkerFor,
  type AttendancePlan,
  type AttendanceRow,
  type PlanDecisions,
  type PlannedBooking,
  type PlanPerson,
  type PlanSession,
  type PlanOffering,
  type PlanVenue,
  type RosterClass,
  type RosterLocation,
  type RosterMember,
} from "@/lib/importers/attendance";
import { parseTeamUp, teamupPersonKey, teamupIdentity } from "@/lib/importers/teamup";

const TZ = "Europe/London";
const BOM = "﻿";

const HEADER =
  "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";

const PROFILE_HEADERS = [
  "Address Line 1", "Address Line 2", "City", "Region", "Postcode", "Country", "Marketing Preference",
  "Phone", "Gender", "Date of birth", "Emergency Contact Name", "Emergency Contact Phone", "Emergency Contact Relationship",
];

type Cells = Partial<Record<
  "name" | "email" | "start" | "offering" | "venue" | "instructors" | "method" | "cmid" | "mid" | "mname" | "source" | "status" | "checkin" | "addr1" | "phone" | "dob",
  string
>>;

/** One TeamUp attendance row. Cells containing a comma, quote or newline are quoted and escaped. */
function tu(o: Cells = {}): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    o.name ?? "Ada Lovelace", o.email ?? "ada@example.test", o.start ?? "2025-10-04T09:00:00+01:00",
    o.offering ?? "Adults Gi", o.venue ?? "Main Mat", o.instructors ?? "", o.method ?? "Online",
    o.cmid ?? "CM-1", o.mid ?? "MS-1", o.mname ?? "Adults Unlimited", o.source ?? "Web",
    o.status ?? "Attended", o.checkin ?? "",
    o.addr1 ?? "", "", "", "", "", "GB", "", o.phone ?? "", "", o.dob ?? "", "", "", "",
  ].map(q).join(",");
}
const file = (...rows: string[]) => [HEADER, ...rows].join("\n");
const parse = (...rows: string[]) => parseAttendanceCsv(file(...rows));

// ── Roster ───────────────────────────────────────────────────────────────
const SYNTH = (e: string) => e.endsWith("@noemail.matflow.invalid");

const MEMBERS: RosterMember[] = [
  // Matched by name AND email (no externalRef).
  { id: "m_ada", name: "Ada Lovelace", email: "ada@example.test", externalRef: null },
  // Matched by externalRef, stored in an odd case.
  { id: "m_grace", name: "Grace Hopper", email: "grace.h@example.test", externalRef: "TEAMUP:Grace@Example.test|Grace Hopper" },
  // A parent, and her child on a synthesised address with the TeamUp key the members import stored.
  { id: "m_priya", name: "Priya Sharma", email: "priya@example.test", externalRef: null },
  { id: "m_neha", name: "Neha Sharma", email: "kid-x1@noemail.matflow.invalid", externalRef: "teamup:priya@example.test|neha sharma", noLogin: true },
  // A second child with no externalRef: nothing identifies her.
  { id: "m_arjun", name: "Arjun Sharma", email: "kid-x2@noemail.matflow.invalid", externalRef: null, noLogin: true },
  // Two members sharing one address.
  { id: "m_sam", name: "Sam Rice", email: "rice.house@example.test", externalRef: null },
  { id: "m_jo", name: "Jo Rice", email: "rice.house@example.test", externalRef: null },
  // No email at TeamUp: matched only by externalRef.
  { id: "m_musa", name: "Musa Kasim", email: "musa@example.test", externalRef: "teamup:|musa kasim" },
  { id: "m_lin", name: "Lin Chen", email: "", externalRef: null },
  // Name alone / email alone must never match.
  { id: "m_tom", name: "Tom Roper", email: "tom@example.test", externalRef: null },
  // Owner decided to keep this person pending even though the ref would match.
  { id: "m_dan", name: "Dan Coles", email: "dan@example.test", externalRef: "teamup:dan@example.test|dan coles" },
  // Target of a saved "member" decision (different name from the export).
  { id: "m_evelyn", name: "Evelyn Adams", email: "evelyn@example.test", externalRef: null },
];

const CLASSES: RosterClass[] = [
  { id: "c_gi", name: "Adults Gi", isActive: true, historical: false, locationId: null },
  { id: "c_nogi", name: "No-Gi", isActive: true, historical: false, locationId: "loc_north" },
];
const LOCATIONS: RosterLocation[] = [
  { id: "loc_main", name: "Main Mat" },
  { id: "loc_north", name: "North" },
];

const DECISIONS: PlanDecisions = {
  person: {
    "teamup:dan@example.test|dan coles": { action: "pending" },
    "teamup:eve@example.test|eve adams": { action: "member", targetId: "m_evelyn" },
  },
  offering: {
    "Adults Gi": { action: "class", targetId: "c_gi" },
    "Gi Fundamentals": { action: "class", targetId: "c_gi" },
    "No-Gi": { action: "class", targetId: "c_nogi" },
    "Kids BJJ": { action: "new_class" },
  },
  venue: {
    "Main Mat": { action: "location", targetId: "loc_main" },
    Annex: { action: "club" },
  },
};

const NOW = new Date("2025-11-01T00:00:00Z");

function planRows(rows: AttendanceRow[], over: Partial<Parameters<typeof planAttendanceImport>[1]> = {}): AttendancePlan {
  return planAttendanceImport(rows, {
    timezone: TZ, now: NOW, members: MEMBERS, classes: CLASSES, locations: LOCATIONS, decisions: DECISIONS, isSynthesisedEmail: SYNTH, ...over,
  });
}
const plan = (...rows: string[]) => planRows(parse(...rows).rows);
const bookingOf = (p: AttendancePlan, name: string) => {
  const hits = p.bookings.filter((b) => b.sourceName === name);
  expect(hits, name).toHaveLength(1);
  return hits[0];
};

// ── 1. The TeamUp header ─────────────────────────────────────────────────
describe("parseAttendanceCsv — the TeamUp attendance header", () => {
  it("maps every field to the right TeamUp header", () => {
    const res = parse(tu());
    expect(res.errors).toEqual([]);
    expect(res.mappedColumns).toEqual({
      sourceRowId: null, personId: null, email: "Customer Email", name: "Customer Name",
      className: "Offering Type Name", venue: "Venue Name", startDateTime: "Event Starts At",
      startDate: null, startTime: null, endTime: null, status: "Status", attended: null,
      instructors: "Instructors", bookingMethod: "Booking Method", bookingSource: "Booking Source",
      customerMembershipId: "Customer Membership ID", membershipId: "Membership ID", membershipName: "Membership Name",
      checkinAt: "Checkin Timestamp",
    });
  });

  it("reads each mapped cell into its row field", () => {
    const r = parse(tu({ instructors: "Coach K", checkin: "2025-10-04T08:55:00+01:00", method: "App", source: "iOS", cmid: "CM-9", mid: "MS-7", mname: "Kids Plan" })).rows[0];
    expect(r).toMatchObject({
      personName: "Ada Lovelace", email: "ada@example.test", className: "Adults Gi", venue: "Main Mat",
      startRaw: "2025-10-04T09:00:00+01:00", instructors: "Coach K", bookingMethod: "App", bookingSource: "iOS",
      customerMembershipRef: "CM-9", membershipRef: "MS-7", membershipName: "Kids Plan",
      checkinRaw: "2025-10-04T08:55:00+01:00", status: "attended", rawStatus: "Attended", sourceRowId: "row:2",
    });
  });

  it("lists the 13 profile columns as not imported, not as unmapped", () => {
    const res = parse(tu());
    expect(res.notImportedColumns).toEqual(PROFILE_HEADERS);
    expect(res.unmappedColumns).toEqual([]);
  });

  it("puts an extra unknown column in unmappedColumns", () => {
    const res = parseAttendanceCsv(`${HEADER},Coach Notes\n${tu()},hello`);
    expect(res.unmappedColumns).toEqual(["Coach Notes"]);
    expect(res.notImportedColumns).toHaveLength(13);
  });

  it("reports Instructors and Checkin Timestamp as blank when blank on every row", () => {
    const res = parse(tu(), tu({ name: "Grace Hopper" }));
    expect(res.blankColumns).toEqual(["Instructors", "Checkin Timestamp"]);
  });

  it("does not report a column blank when one row fills it", () => {
    const res = parse(tu(), tu({ instructors: "Coach K" }));
    expect(res.blankColumns).toEqual(["Checkin Timestamp"]);
  });

  it("parses a UTF-8 BOM and CRLF line endings", () => {
    const res = parseAttendanceCsv(`${BOM}${HEADER}\r\n${tu()}\r\n${tu({ name: "Grace Hopper" })}\r\n`);
    expect(res.errors).toEqual([]);
    expect(res.mappedColumns.name).toBe("Customer Name");
    expect(res.rows.map((r) => r.personName)).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(res.rows[1].rawStatus).toBe("Attended");
  });

  it("parses a quoted name containing a comma", () => {
    expect(parse(tu({ name: "Lovelace, Ada" })).rows[0].personName).toBe("Lovelace, Ada");
  });

  it("parses an escaped quote inside a quoted cell", () => {
    expect(parse(tu({ name: 'Ada "The Countess" Lovelace' })).rows[0].personName).toBe('Ada "The Countess" Lovelace');
  });

  it("parses a quoted newline inside a cell and keeps the next record's line", () => {
    const res = parse(tu({ addr1: "1 Mat Lane\nFlat 2" }), tu({ name: "Grace Hopper" }));
    expect(res.errors).toEqual([]);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].personName).toBe("Ada Lovelace");
    expect(res.rows.map((r) => [r.record, r.line])).toEqual([[2, 2], [3, 4]]);
  });

  it("refuses a file with a mapped header twice and returns no rows", () => {
    const res = parseAttendanceCsv(`${HEADER},Status\n${tu()},Registered`);
    expect(res.rows).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/"Status"/);
    expect(res.errors[0]).toMatch(/more than once/);
  });

  it("names a missing required column and returns no rows", () => {
    const header = HEADER.replace("Offering Type Name,", "");
    const row = tu().split(",").filter((_, i) => i !== 3).join(",");
    const res = parseAttendanceCsv(`${header}\n${row}`);
    expect(res.rows).toEqual([]);
    expect(res.errors).toEqual([`Missing required column(s): class or offering (e.g. "Offering Type Name" or "Event Name").`]);
  });

  it("names a missing status column", () => {
    const header = HEADER.replace(",Status,", ",Something,");
    const res = parseAttendanceCsv(`${header}\n${tu()}`);
    expect(res.rows).toEqual([]);
    expect(res.errors[0]).toMatch(/status or attended/);
  });
});

// ── 2. Instants and DST ──────────────────────────────────────────────────
describe("start instants", () => {
  it("reads an offset instant as that exact UTC instant", () => {
    expect(parseOffsetInstant("2025-10-04T09:00:00+01:00")?.toISOString()).toBe("2025-10-04T08:00:00.000Z");
  });

  it("keeps a +00:00 instant exact", () => {
    expect(parseOffsetInstant("2025-12-04T09:00:00+00:00")?.toISOString()).toBe("2025-12-04T09:00:00.000Z");
  });

  it("reads a Z instant", () => {
    expect(parseOffsetInstant("2025-12-04T09:00:00Z")?.toISOString()).toBe("2025-12-04T09:00:00.000Z");
  });

  it("stores the parsed instant on the row and keeps the raw cell", () => {
    const r = parse(tu({ start: "2025-10-04T09:00:00+01:00" })).rows[0];
    expect(r.startInstant).toBe("2025-10-04T08:00:00.000Z");
    expect(r.startLocal).toBeNull();
    expect(r.startRaw).toBe("2025-10-04T09:00:00+01:00");
    expect(r.dateIssue).toBeUndefined();
  });

  for (const bad of ["2025-13-01T09:00:00+01:00", "2025-10-04T25:00:00+01:00", "2025-10-04T09:00:00+15:00", "04/10/2025 09:00+01:00"]) {
    it(`flags ${bad} as malformed_date and the planner rejects it with the raw cell`, () => {
      expect(parseOffsetInstant(bad)).toBeNull();
      const rows = parse(tu({ start: bad })).rows;
      expect(rows[0]).toMatchObject({ dateIssue: "malformed_date", startRaw: bad, startInstant: null, startLocal: null });
      const p = planRows(rows);
      expect(p.bookings).toEqual([]);
      expect(p.rejected).toEqual([{ record: 2, line: 2, reason: "malformed_date", detail: bad }]);
    });
  }

  it("gives the club date, not the UTC date, for a late-evening instant", () => {
    const b = plan(tu({ start: "2025-10-04T23:30:00+00:00" })).bookings[0];
    expect([b.startUtc, b.localDate, b.localTime]).toEqual(["2025-10-04T23:30:00.000Z", "2025-10-05", "00:30"]);
  });

  it("autumn change (26 Oct 2025): instants either side get the right club date and wall clock", () => {
    const p = plan(
      tu({ name: "Ada Lovelace", start: "2025-10-26T00:30:00+01:00" }),
      tu({ name: "Grace Hopper", email: "grace@example.test", start: "2025-10-26T02:30:00+00:00" }),
    );
    expect([bookingOf(p, "Ada Lovelace").localDate, bookingOf(p, "Ada Lovelace").localTime]).toEqual(["2025-10-26", "00:30"]);
    expect(bookingOf(p, "Ada Lovelace").startUtc).toBe("2025-10-25T23:30:00.000Z");
    expect([bookingOf(p, "Grace Hopper").localDate, bookingOf(p, "Grace Hopper").localTime]).toEqual(["2025-10-26", "02:30"]);
    expect(bookingOf(p, "Grace Hopper").startUtc).toBe("2025-10-26T02:30:00.000Z");
  });

  it("spring change (29 Mar 2026): instants either side get the right club date and wall clock", () => {
    const p = planRows(parse(
      tu({ name: "Ada Lovelace", start: "2026-03-29T00:30:00+00:00" }),
      tu({ name: "Grace Hopper", email: "grace@example.test", start: "2026-03-29T02:30:00+01:00" }),
    ).rows, { now: new Date("2026-04-01T00:00:00Z") });
    expect([bookingOf(p, "Ada Lovelace").localDate, bookingOf(p, "Ada Lovelace").localTime]).toEqual(["2026-03-29", "00:30"]);
    expect([bookingOf(p, "Grace Hopper").localDate, bookingOf(p, "Grace Hopper").localTime]).toEqual(["2026-03-29", "02:30"]);
    expect(bookingOf(p, "Grace Hopper").startUtc).toBe("2026-03-29T01:30:00.000Z");
  });

  describe("the autumn repeated hour: 01:30+01:00 and 01:30+00:00 on 26 Oct 2025", () => {
    const p = plan(
      tu({ start: "2025-10-26T01:30:00+01:00" }),
      tu({ start: "2025-10-26T01:30:00+00:00" }),
    );

    it("are two different instants with the same club wall clock", () => {
      expect(p.bookings.map((b) => b.startUtc).sort()).toEqual(["2025-10-26T00:30:00.000Z", "2025-10-26T01:30:00.000Z"]);
      expect(p.bookings.map((b) => `${b.localDate} ${b.localTime}`)).toEqual(["2025-10-26 01:30", "2025-10-26 01:30"]);
    });

    it("are two different booking keys, neither a duplicate", () => {
      expect(p.bookings).toHaveLength(2);
      expect(p.bookings[0].bookingKey).not.toBe(p.bookings[1].bookingKey);
      expect(p.duplicates).toEqual([]);
    });

    it("are two different provisional sessions", () => {
      expect(p.sessions).toHaveLength(2);
      expect(new Set(p.sessions.map((s) => s.sourceKey)).size).toBe(2);
    });

    // A session slot is (class, club date, wall clock): the schema cannot hold
    // two sessions at the same wall-clock time on one day. Both bookings are
    // kept but held as a source conflict for the owner, never merged into one
    // session and never counted as two visits to one (3 Oct 2026).
    it("are held as a source conflict, not merged into one session", () => {
      expect(p.bookings.map((b) => b.intent)).toEqual(["source_conflict", "source_conflict"]);
      expect(p.bookings.map((b) => b.conflict)).toEqual(["repeated_local_time", "repeated_local_time"]);
      expect(p.sessions.every((s) => s.state === "pending")).toBe(true);
    });
  });

  describe("a wall-clock export (Start Date, Start Time; no offset)", () => {
    const WALL = "Customer Name,Customer Email,Offering Type Name,Venue Name,Start Date,Start Time,Status";
    const wall = (date: string, time: string) => parseAttendanceCsv(`${WALL}\nAda Lovelace,ada@example.test,Adults Gi,Main Mat,${date},${time},Attended`).rows;

    it("reads the cells as club wall clock", () => {
      expect(wall("04/10/2025", "09:00")[0]).toMatchObject({ startInstant: null, startLocal: "2025-10-04 09:00", startRaw: "04/10/2025 09:00" });
    });

    it("rejects 01:30 on 29/03/2026 as nonexistent_local_time (never shifted)", () => {
      const p = planRows(wall("29/03/2026", "01:30"), { now: new Date("2026-04-01T00:00:00Z") });
      expect(p.bookings).toEqual([]);
      expect(p.rejected).toHaveLength(1);
      expect(p.rejected[0].reason).toBe("nonexistent_local_time");
      expect(localToUtc("2026-03-29 01:30", TZ)).toBeNull();
    });

    it("accepts 01:30 on 26/10/2025 deterministically", () => {
      const a = planRows(wall("26/10/2025", "01:30"));
      const b = planRows(wall("26/10/2025", "01:30"));
      expect(a.rejected).toEqual([]);
      expect(a.bookings).toHaveLength(1);
      expect(a.bookings[0]).toMatchObject({ localDate: "2025-10-26", localTime: "01:30" });
      // The repeated hour resolves to its second (GMT) occurrence.
      expect(a.bookings[0].startUtc).toBe("2025-10-26T01:30:00.000Z");
      expect(b.bookings[0].startUtc).toBe(a.bookings[0].startUtc);
      expect(b.bookings[0].bookingKey).toBe(a.bookings[0].bookingKey);
    });
  });

  it("localWallClock and localToUtc round-trip an ordinary BST time", () => {
    const at = localToUtc("2025-10-04 09:00", TZ)!;
    expect(at.toISOString()).toBe("2025-10-04T08:00:00.000Z");
    expect(localWallClock(at, TZ)).toBe("2025-10-04 09:00");
  });

  it("dayMarkerFor spells a club date as its UTC midnight", () => {
    expect(dayMarkerFor("2025-10-26").toISOString()).toBe("2025-10-26T00:00:00.000Z");
  });
});

// ── 3. Statuses ──────────────────────────────────────────────────────────
describe("statuses", () => {
  it("maps TeamUp's four statuses to four distinct values and keeps the raw text", () => {
    const rows = parse(
      tu({ status: "Attended" }), tu({ status: "Registered" }), tu({ status: "Late Cancelled" }), tu({ status: "No show" }),
    ).rows;
    expect(rows.map((r) => [r.status, r.rawStatus])).toEqual([
      ["attended", "Attended"], ["registered", "Registered"], ["late_cancelled", "Late Cancelled"], ["no_show", "No show"],
    ]);
  });

  it("rejects an unknown status as unknown_status", () => {
    const p = plan(tu({ status: "Maybe" }));
    expect(p.bookings).toEqual([]);
    expect(p.rejected).toEqual([{ record: 2, line: 2, reason: "unknown_status", detail: "Maybe" }]);
  });

  it("rejects a blank status as missing_status", () => {
    const p = plan(tu({ status: "" }));
    expect(p.bookings).toEqual([]);
    expect(p.rejected).toEqual([{ record: 2, line: 2, reason: "missing_status" }]);
  });
});

// ── 4. Planner ───────────────────────────────────────────────────────────
describe("planAttendanceImport — who is each person", () => {
  it("a saved member decision wins, with method decision", () => {
    const b = bookingOf(plan(tu({ name: "Eve Adams", email: "eve@example.test" })), "Eve Adams");
    expect([b.memberId, b.matchMethod]).toEqual(["m_evelyn", "decision"]);
  });

  it("a saved pending decision stays pending even though the externalRef would match", () => {
    const p = plan(tu({ name: "Dan Coles", email: "dan@example.test" }));
    const b = bookingOf(p, "Dan Coles");
    expect([b.memberId, b.matchMethod, b.intent]).toEqual([null, null, "pending_person"]);
    expect(p.people[0].decidedPending).toBe(true);
  });

  it("matches the externalRef teamup:<email>|<name> regardless of case and surrounding spaces", () => {
    const b = bookingOf(plan(tu({ name: "  GRACE HOPPER ", email: " Grace@Example.TEST " })), "GRACE HOPPER");
    expect([b.memberId, b.matchMethod]).toEqual(["m_grace", "external_ref"]);
  });

  it("matches one member with the same name AND email", () => {
    const b = bookingOf(plan(tu({ name: "ada lovelace", email: "ADA@example.test" })), "ada lovelace");
    expect([b.memberId, b.matchMethod]).toEqual(["m_ada", "name_and_email"]);
  });

  it("never matches on name alone", () => {
    expect(bookingOf(plan(tu({ name: "Tom Roper", email: "t.roper@example.test" })), "Tom Roper").memberId).toBeNull();
  });

  it("never matches on email alone", () => {
    expect(bookingOf(plan(tu({ name: "Thomas Roper", email: "tom@example.test" })), "Thomas Roper").memberId).toBeNull();
  });

  it("a child booked on the parent's address does not match the parent", () => {
    const b = bookingOf(plan(tu({ name: "Arjun Sharma", email: "priya@example.test" })), "Arjun Sharma");
    expect(b.memberId).toBeNull();
  });

  it("a child with a synthesised email and the TeamUp key as externalRef does match", () => {
    const p = plan(tu({ name: "Priya Sharma", email: "priya@example.test" }), tu({ name: "Neha Sharma", email: "priya@example.test" }));
    expect([bookingOf(p, "Neha Sharma").memberId, bookingOf(p, "Neha Sharma").matchMethod]).toEqual(["m_neha", "external_ref"]);
    expect([bookingOf(p, "Priya Sharma").memberId, bookingOf(p, "Priya Sharma").matchMethod]).toEqual(["m_priya", "name_and_email"]);
  });

  it("two members sharing an email each match only their own rows", () => {
    const p = plan(tu({ name: "Sam Rice", email: "rice.house@example.test" }), tu({ name: "Jo Rice", email: "rice.house@example.test" }));
    expect(bookingOf(p, "Sam Rice").memberId).toBe("m_sam");
    expect(bookingOf(p, "Jo Rice").memberId).toBe("m_jo");
  });

  it("a person with no email is matched by externalRef", () => {
    const b = bookingOf(plan(tu({ name: "Musa Kasim", email: "" })), "Musa Kasim");
    expect([b.memberId, b.matchMethod]).toEqual(["m_musa", "external_ref"]);
  });

  it("a person with no email and no ref is not matched by name", () => {
    const p = plan(tu({ name: "Lin Chen", email: "" }));
    expect(bookingOf(p, "Lin Chen").memberId).toBeNull();
    expect(p.people[0].missingEmail).toBe(true);
  });

  it("offers same_name / same_email candidates for an unresolved person without setting memberId", () => {
    const p = plan(tu({ name: "Arjun Sharma", email: "priya@example.test" }));
    const person = p.people.find((x) => x.name === "Arjun Sharma")!;
    expect(person.memberId).toBeNull();
    expect(person.candidates).toEqual([
      { memberId: "m_arjun", reason: "same_name" },
      { memberId: "m_priya", reason: "same_email" },
    ]);
    expect(bookingOf(p, "Arjun Sharma").memberId).toBeNull();
  });
});

describe("planAttendanceImport — offerings and venues", () => {
  it("an offering with no decision is pending_offering", () => {
    const b = plan(tu({ offering: "Open Mat" })).bookings[0];
    expect([b.intent, b.classKey, b.sessionKey]).toEqual(["pending_offering", null, null]);
  });

  it("an offering mapped to an existing class gets sessionKey <classId>@<date> <time>", () => {
    const b = plan(tu({ start: "2025-10-04T09:00:00+01:00" })).bookings[0];
    expect([b.classKey, b.sessionKey]).toEqual(["c_gi", "c_gi@2025-10-04 09:00"]);
  });

  it("a new_class offering gets classKey new:<normalised offering>|<venueKey>", () => {
    const b = plan(tu({ offering: "Kids BJJ" })).bookings[0];
    expect(b.classKey).toBe("new:kids bjj|loc:loc_main");
    expect(b.sessionKey).toBe("new:kids bjj|loc:loc_main@2025-10-04 09:00");
  });

  it("a venue with no decision is pending_venue", () => {
    expect(plan(tu({ venue: "Pop-up" })).bookings[0].intent).toBe("pending_venue");
  });

  it("a venue mapped to the club gives venueKey club", () => {
    expect(plan(tu({ offering: "Kids BJJ", venue: "Annex" })).bookings[0].classKey).toBe("new:kids bjj|club");
  });

  it("a venue mapped to a known location gives venueKey loc:<id>", () => {
    expect(plan(tu({ offering: "Kids BJJ", venue: "Main Mat" })).bookings[0].classKey).toBe("new:kids bjj|loc:loc_main");
  });

  it("a class whose location differs from the mapped location is venue_conflict", () => {
    const b = plan(tu({ offering: "No-Gi", venue: "Main Mat" })).bookings[0];
    expect([b.intent, b.sessionKey]).toEqual(["venue_conflict", null]);
  });
});

describe("planAttendanceImport — intents", () => {
  it("attended + resolved + started is attendance", () => {
    expect(plan(tu({ status: "Attended" })).bookings[0].intent).toBe("attendance");
  });

  for (const status of ["Registered", "No show", "Late Cancelled"]) {
    it(`${status} is booking_only, never attendance`, () => {
      expect(plan(tu({ status })).bookings[0].intent).toBe("booking_only");
    });
  }

  it("a start after now is future", () => {
    expect(plan(tu({ start: "2025-12-01T09:00:00+00:00" })).bookings[0].intent).toBe("future");
  });

  it("an unresolved person is pending_person", () => {
    expect(plan(tu({ name: "Nobody Known", email: "nobody@example.test" })).bookings[0].intent).toBe("pending_person");
  });
});

describe("planAttendanceImport — sessions and visits", () => {
  it("two offerings at the same start are two sessions", () => {
    const p = plan(tu({ name: "Ada Lovelace", offering: "Adults Gi" }), tu({ name: "Sam Rice", email: "rice.house@example.test", offering: "Kids BJJ" }));
    expect(p.sessions).toHaveLength(2);
    expect(new Set(p.bookings.map((b) => b.sessionKey)).size).toBe(2);
  });

  it("two offerings at the same start mapped to the same class share one sessionKey", () => {
    const p = plan(tu({ name: "Ada Lovelace", offering: "Adults Gi" }), tu({ name: "Sam Rice", email: "rice.house@example.test", offering: "Gi Fundamentals" }));
    expect(p.bookings.map((b) => b.sessionKey)).toEqual(["c_gi@2025-10-04 09:00", "c_gi@2025-10-04 09:00"]);
  });

  const twoAtOnce = [tu({ offering: "Adults Gi" }), tu({ offering: "Kids BJJ" })];

  it("the same person attended in two offerings at one instant is one attendance and one same_start_visit", () => {
    const p = plan(...twoAtOnce);
    const intents = p.bookings.map((b) => b.intent).sort();
    expect(intents).toEqual(["attendance", "same_start_visit"]);
    const visit = p.bookings.find((b) => b.intent === "attendance")!;
    const linked = p.bookings.find((b) => b.intent === "same_start_visit")!;
    expect(linked.visitOf).toBe(visit.bookingKey);
  });

  it("which booking keeps the visit does not depend on file order", () => {
    const a = plan(...twoAtOnce);
    const b = plan(...[...twoAtOnce].reverse());
    const pick = (p: AttendancePlan) => p.bookings.map((x) => [x.offeringLabel, x.intent, x.visitOf ?? null]);
    expect(pick(b)).toEqual(pick(a));
  });
});

describe("planAttendanceImport — duplicates and reconciliation", () => {
  it("an exact repeated row is a duplicate of the first record", () => {
    const p = plan(tu(), tu());
    expect(p.bookings).toHaveLength(1);
    expect(p.duplicates).toEqual([{ record: 3, line: 3, bookingKey: p.bookings[0].bookingKey, duplicateOf: 2 }]);
  });

  it("a row differing only in Status is ALSO a duplicate (status is not in the booking key)", () => {
    const p = plan(tu({ status: "Registered" }), tu({ status: "Attended" }));
    expect(p.bookings).toHaveLength(1);
    expect(p.duplicates).toHaveLength(1);
    expect(p.duplicates[0]).toMatchObject({ record: 3, duplicateOf: 2, bookingKey: p.bookings[0].bookingKey });
  });

  it("the booking key is (person, instant, offering, venue)", () => {
    const b = plan(tu()).bookings[0];
    expect(b.bookingKey).toBe(bookingKeyOf("teamup:ada@example.test|ada lovelace", "2025-10-04T08:00:00.000Z", "Adults Gi", "Main Mat"));
  });

  const mixed = [
    tu({ name: "Ada Lovelace" }),
    tu({ name: "Sam Rice", email: "rice.house@example.test", status: "Registered" }),
    tu({ name: "Ada Lovelace" }), // duplicate
    tu({ name: "Jo Rice", email: "rice.house@example.test", status: "Maybe" }), // rejected
    tu({ name: "Grace Hopper", email: "grace@example.test", start: "2025-13-01T09:00:00+01:00" }), // rejected
    tu({ name: "Neha Sharma", email: "priya@example.test", offering: "Kids BJJ", status: "No show" }),
    tu({ name: "Musa Kasim", email: "", start: "2025-12-01T09:00:00+00:00" }),
  ];

  it("booking keys are identical across a re-ordered file", () => {
    const a = plan(...mixed);
    const b = plan(...[...mixed].reverse());
    expect(b.bookings.map((x) => x.bookingKey)).toEqual(a.bookings.map((x) => x.bookingKey));
  });

  it("bookings are sorted by key", () => {
    const keys = plan(...mixed).bookings.map((b) => b.bookingKey);
    expect(keys).toEqual([...keys].sort());
  });

  it("bookings + duplicates + rejected = inputRows and totals.reconciles is true", () => {
    const p = plan(...mixed);
    expect([p.bookings.length, p.duplicates.length, p.rejected.length]).toEqual([4, 1, 2]);
    expect(p.bookings.length + p.duplicates.length + p.rejected.length).toBe(p.totals.inputRows);
    expect(p.totals.inputRows).toBe(7);
    expect(p.totals.reconciles).toBe(true);
  });
});

describe("the plan carries no credit / payment / message / rank / waiver field", () => {
  type Forbidden = `${string}${"credit" | "payment" | "invoice" | "send" | "notif" | "rank" | "waiver" | "belt"}${string}`;
  type BadKeys<T> = Extract<Lowercase<keyof T & string>, Forbidden>;

  it("at the type level", () => {
    expectTypeOf<BadKeys<AttendancePlan>>().toBeNever();
    expectTypeOf<BadKeys<AttendancePlan["totals"]>>().toBeNever();
    expectTypeOf<BadKeys<PlannedBooking>>().toBeNever();
    expectTypeOf<BadKeys<PlanPerson>>().toBeNever();
    expectTypeOf<BadKeys<PlanOffering>>().toBeNever();
    expectTypeOf<BadKeys<PlanVenue>>().toBeNever();
    expectTypeOf<BadKeys<PlanSession>>().toBeNever();
    expectTypeOf<BadKeys<AttendancePlan["duplicates"][number]>>().toBeNever();
    expectTypeOf<BadKeys<AttendancePlan["rejected"][number]>>().toBeNever();
  });

  it("at runtime, scanning every key of a populated plan", () => {
    const p = plan(
      tu(), tu({ status: "Registered", offering: "Kids BJJ" }), tu({ status: "Maybe" }), tu(),
      tu({ name: "Arjun Sharma", email: "priya@example.test" }),
    );
    const keys = new Set<string>();
    const walk = (v: unknown, structural: boolean) => {
      if (Array.isArray(v)) { for (const x of v) walk(x, true); return; }
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (structural) keys.add(k);
          // byStatus / byIntent are data-keyed records, not fields.
          walk(x, !(k === "byStatus" || k === "byIntent"));
        }
      }
    };
    walk(p, true);
    expect(keys.size).toBeGreaterThan(20);
    const bad = [...keys].filter((k) => /credit|payment|invoice|send|notif|rank|waiver|belt/i.test(k));
    expect(bad).toEqual([]);
  });
});

// ── 5. Controls ──────────────────────────────────────────────────────────
describe("attendanceControls", () => {
  const rows = parse(
    tu({ name: "Ada Lovelace", status: "Attended", method: "Online", cmid: "CM-1", mid: "MS-1" }),
    tu({ name: "Ada Lovelace", status: "Registered", start: "2025-10-05T09:00:00+01:00", method: "Staff", cmid: "CM-1", mid: "MS-1" }),
    tu({ name: "Sam Rice", email: "rice.house@example.test", status: "No show", method: "", cmid: "CM-2", mid: "MS-2", instructors: "Coach K" }),
    tu({ name: "Jo Rice", email: "rice.house@example.test", status: "Late Cancelled", offering: "Kids BJJ", cmid: "", mid: "MS-2", checkin: "2025-10-04T08:59:00+01:00" }),
    tu({ name: "Musa Kasim", email: "", status: "Attended", venue: "Annex", start: "2025-12-01T09:00:00Z", cmid: "", mid: "" }),
  ).rows;
  const c = attendanceControls(rows);

  it("counts rows and statuses", () => {
    expect(c.rows).toBe(5);
    expect(c.byStatus).toEqual({ Attended: 2, Registered: 1, "No show": 1, "Late Cancelled": 1 });
  });

  it("counts identities, distinct and shared emails", () => {
    expect(c.identities).toBe(4);
    expect(c.distinctEmails).toBe(2);
    expect(c.sharedEmails).toBe(1);
  });

  it("counts missing-email rows and identities", () => {
    expect(c.missingEmailRows).toBe(1);
    expect(c.missingEmailIdentities).toBe(1);
  });

  it("counts offerings, venues, distinct starts and provisional sessions", () => {
    expect(c.offerings).toBe(2);
    expect(c.venues).toBe(2);
    expect(c.distinctStarts).toBe(3);
    expect(c.provisionalSessions).toBe(4);
  });

  it("counts booking methods and membership refs", () => {
    expect(c.byBookingMethod).toEqual({ Online: 3, Staff: 1, "(blank)": 1 });
    expect(c.byBookingSource).toEqual({ Web: 5 });
    expect(c.customerMembershipRefs).toBe(2);
    expect(c.membershipRefs).toBe(2);
  });

  it("counts blank instructor and check-in rows", () => {
    expect(c.instructorsBlankRows).toBe(4);
    expect(c.checkinBlankRows).toBe(4);
  });

  it("counts offsets and gives the first and last start", () => {
    expect(c.byOffset).toEqual({ "+01:00": 4, Z: 1 });
    expect(c.firstStart).toBe("2025-10-04T08:00:00.000Z");
    expect(c.lastStart).toBe("2025-12-01T09:00:00.000Z");
  });
});

// ── 6. The person key agrees with the members import ─────────────────────
describe("teamupPersonKey", () => {
  it("trims and lower-cases name and email", () => {
    expect(teamupPersonKey(" Ada Lovelace ", " ADA@Example.test ")).toBe("teamup:ada@example.test|ada lovelace");
    expect(teamupIdentity(" Ada Lovelace ", " ADA@Example.test ")).toBe("ada@example.test|ada lovelace");
  });

  it("is exactly the sourceKey parseTeamUp stores for the same name and email", () => {
    const MEMBERSHIPS =
      "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
    const row = " Ada Lovelace , ADA@Example.test ,,Adults Advanced 2026,recurring,active,Stripe,2026-01-14,2026-01-14,,,Yes,,,,,,,GB,,07000000001,,1990-04-15,,,";
    const { drafts, errors } = parseTeamUp(`${MEMBERSHIPS}\n${row}`, { asOf: "2026-10-02" });
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceKey).toBe(teamupPersonKey(" Ada Lovelace ", " ADA@Example.test "));
    expect(drafts[0].sourceKey).toBe("teamup:ada@example.test|ada lovelace");
  });

  it("is the personKey the attendance parser gives the same person", () => {
    expect(parse(tu({ name: " Ada Lovelace ", email: " ADA@Example.test " })).rows[0].personKey).toBe("teamup:ada@example.test|ada lovelace");
  });
});
