// Attendance history import planner (lib/importers/attendance.ts).
//
// Synthetic exports only — no real club's file has been inspected yet, so the
// header row below is a TeamUp-STYLE guess (see docs/runbooks/ATTENDANCE-IMPORT.md,
// "format acceptance is BLOCKED"). Every name, email and id is invented.

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  parseAttendanceCsv,
  planAttendanceImport,
  localToUtc,
  sessionDayMarker,
  type AttendancePlan,
  type PlanClass,
  type PlanMember,
  type PlannedRecord,
  type PlannedSession,
} from "@/lib/importers/attendance";

const TZ = "Europe/London";
const HEADER = "Attendance ID,Customer ID,Customer Name,Customer Email,Event Name,Start Date,Start Time,End Time,Status";

type R = { id?: string; cid?: string; name?: string; email?: string; cls?: string; date?: string; start?: string; end?: string; status?: string };
function row(o: R): string {
  const q = (s?: string) => ((s ?? "").includes(",") ? `"${s}"` : (s ?? ""));
  return [o.id, o.cid, o.name, o.email, o.cls ?? "Adults Gi", o.date ?? "2026-05-12", o.start ?? "18:00", o.end ?? "19:00", o.status ?? "Attended"].map(q).join(",");
}
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

const MEMBERS: PlanMember[] = [
  { id: "m_ada", email: "ada@example.test", name: "Ada Lovelace", sourceIds: ["TU-1001"] },
  { id: "m_bob", email: "bob@example.test", name: "Bob Hart" },
  // A parent whose address the export also uses for her child.
  { id: "m_priya", email: "priya@example.test", name: "Priya Sharma" },
  // A child: synthesised address, so only a source id can match them.
  { id: "m_neha", email: "kid-x1@noemail.matflow.invalid", name: "Neha Sharma", sourceIds: ["TU-2002"] },
  // Two members on one address — email alone cannot say which.
  { id: "m_sam", email: "rice.house@example.test", name: "Sam Rice" },
  { id: "m_jo", email: "rice.house@example.test", name: "Jo Rice" },
];
const CLASSES: PlanClass[] = [
  { id: "c_gi", name: "Adults Gi", duration: 60 },
  { id: "c_nogi", name: "No-Gi", duration: 90, aliases: ["No Gi Advanced"] },
  { id: "c_kids", name: "Kids BJJ", duration: 45 },
];
const plan = (text: string, extra: Partial<Parameters<typeof planAttendanceImport>[1]> = {}) =>
  planAttendanceImport(parseAttendanceCsv(text).rows, { members: MEMBERS, classes: CLASSES, timezone: TZ, ...extra });

function reconciles(p: AttendancePlan): void {
  expect(p.records.length + p.excluded.length + p.quarantined.length).toBe(p.totals.inputRows);
  // Duplicates are excluded rows whose provenance lives on the kept record.
  const provenance = p.records.reduce((n, r) => n + r.sourceRowIds.length, 0);
  expect(provenance).toBe(p.records.length + p.totals.duplicates);
  const m = Object.values(p.totals.byMonth).reduce((a, x) => ({ records: a.records + x.records, excluded: a.excluded + x.excluded, quarantined: a.quarantined + x.quarantined }), { records: 0, excluded: 0, quarantined: 0 });
  expect(m).toEqual({ records: p.records.length, excluded: p.excluded.length, quarantined: p.quarantined.length });
  expect(Object.values(p.totals.byPerson).reduce((a, b) => a + b, 0)).toBe(p.records.length);
  expect(Object.values(p.totals.bySession).reduce((a, b) => a + b, 0)).toBe(p.records.length);
}

describe("parseAttendanceCsv", () => {
  it("reads a TeamUp-style export with the default mapping", () => {
    const res = parseAttendanceCsv(csv(row({ id: "A1", cid: "TU-1001", name: "Ada Lovelace", email: "ADA@Example.test", date: "12/05/2026", start: "6:30 pm" })));
    expect(res.errors).toEqual([]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      sourceRowId: "A1", line: 2, personKey: "tu-1001", email: "ada@example.test", personName: "Ada Lovelace",
      className: "Adults Gi", startLocal: "2026-05-12 18:30", endLocalTime: "19:00", status: "attended",
    });
    expect(res.mappedColumns).toMatchObject({ startDate: "Start Date", startTime: "Start Time", startDateTime: null, email: "Customer Email" });
  });

  it("uses the email as the person key when there is no customer id, and the line when there is no row id", () => {
    const r = parseAttendanceCsv(csv(row({ email: "Bob@Example.test" }))).rows[0];
    expect(r.personKey).toBe("bob@example.test");
    expect(r.sourceRowId).toBe("row:2");
  });

  it("reports unknown and blank columns rather than guessing", () => {
    const text = ["Customer Email,Event Name,Start Date,Start Time,Status,Instructor,,Location", "ada@example.test,Adults Gi,2026-05-12,18:00,Attended,Sean,,"].join("\n");
    const res = parseAttendanceCsv(text);
    expect(res.unmappedColumns).toEqual(["Instructor", "Location"]);
    expect(res.blankColumns).toEqual(["#7"]);
    expect(res.rows[0].status).toBe("attended");
  });

  it("names every missing required column and returns no rows", () => {
    const res = parseAttendanceCsv("Customer Name,Notes\nAda,hello");
    expect(res.rows).toEqual([]);
    expect(res.errors[0]).toMatch(/class/);
    expect(res.errors[0]).toMatch(/start date/);
    expect(res.errors[0]).toMatch(/status or attended/);
    expect(res.errors[0]).toMatch(/customer id or email/);
  });

  it("accepts a combined start column and a custom mapping", () => {
    const text = "Who,Session,When,Present\nada@example.test,Adults Gi,2026-05-12T18:00:00,Yes";
    const res = parseAttendanceCsv(text, { mapping: { email: ["who"], className: ["session"], startDateTime: ["when"], attended: ["present"] } });
    expect(res.errors).toEqual([]);
    expect(res.rows[0]).toMatchObject({ startLocal: "2026-05-12 18:00", status: "attended" });
  });

  it("treats an empty file as a file-level error", () => {
    expect(parseAttendanceCsv("").errors).toEqual(["The file is empty or has no data rows."]);
    expect(parseAttendanceCsv(HEADER).errors).toEqual(["The file is empty or has no data rows."]);
    const p = planAttendanceImport([], { members: MEMBERS, classes: CLASSES, timezone: TZ });
    expect(p.records).toEqual([]);
    expect(p.totals.inputRows).toBe(0);
    reconciles(p);
  });

  it("flags malformed, missing and offset dates instead of reading them", () => {
    const rows = parseAttendanceCsv(csv(
      row({ id: "a", date: "31/02/2026" }),
      row({ id: "b", date: "May 12th" }),
      row({ id: "c", date: "" }),
      row({ id: "d", start: "" }),
      row({ id: "e", start: "25:00" }),
      row({ id: "f", date: "2026-13-01" }),
    )).rows;
    expect(rows.map((r) => [r.sourceRowId, r.startLocal, r.dateIssue])).toEqual([
      ["a", null, "malformed_date"],
      ["b", null, "malformed_date"],
      ["c", null, "missing_date"],
      ["d", null, "missing_time"],
      ["e", null, "malformed_date"],
      ["f", null, "malformed_date"],
    ]);
    const offset = parseAttendanceCsv("Customer Email,Event Name,Start,Status\nada@example.test,Adults Gi,2026-05-12T17:00:00Z,Attended").rows[0];
    expect(offset.dateIssue).toBe("offset_not_supported");
  });
});

describe("planAttendanceImport", () => {
  it("happy path: attended rows become one session and one record each, keyed stably", () => {
    const p = plan(csv(
      row({ id: "A1", cid: "TU-1001", name: "Ada Lovelace", email: "ada@example.test" }),
      row({ id: "A2", name: "Bob Hart", email: "bob@example.test" }),
      row({ id: "A3", name: "Bob Hart", email: "bob@example.test", cls: "No Gi Advanced", date: "2026-06-02", start: "19:00", end: "" }),
    ));
    expect(p.quarantined).toEqual([]);
    expect(p.excluded).toEqual([]);
    expect(p.sessions).toEqual<PlannedSession[]>([
      // 12 May 18:00 BST = 17:00Z; end time from the export.
      { key: "class:c_gi@2026-05-12T17:00:00.000Z", classId: "c_gi", className: "Adults Gi", startUtc: "2026-05-12T17:00:00.000Z", endUtc: "2026-05-12T18:00:00.000Z", localDate: "2026-05-12", startTime: "18:00", endTime: "19:00" },
      // Alias resolves to No-Gi; no end time in the export → class duration (90 min).
      { key: "class:c_nogi@2026-06-02T18:00:00.000Z", classId: "c_nogi", className: "No-Gi", startUtc: "2026-06-02T18:00:00.000Z", endUtc: "2026-06-02T19:30:00.000Z", localDate: "2026-06-02", startTime: "19:00", endTime: "20:30" },
    ]);
    expect(p.records.map((r) => r.key)).toEqual([
      "class:c_gi@2026-05-12T17:00:00.000Z#m_ada",
      "class:c_gi@2026-05-12T17:00:00.000Z#m_bob",
      "class:c_nogi@2026-06-02T18:00:00.000Z#m_bob",
    ]);
    expect(p.records[0]).toEqual<PlannedRecord>({
      key: "class:c_gi@2026-05-12T17:00:00.000Z#m_ada", memberId: "m_ada", sessionKey: "class:c_gi@2026-05-12T17:00:00.000Z",
      checkInTimeUtc: "2026-05-12T17:00:00.000Z", checkInMethod: "import", sourceRowIds: ["A1"],
    });
    expect(p.totals).toMatchObject({
      inputRows: 3, attended: 3, excluded: 0, quarantined: 0, duplicates: 0,
      byMonth: { "2026-05": { records: 2, excluded: 0, quarantined: 0 }, "2026-06": { records: 1, excluded: 0, quarantined: 0 } },
      byPerson: { m_ada: 1, m_bob: 2 },
    });
    expect(sessionDayMarker(p.sessions[0]).toISOString()).toBe("2026-05-12T00:00:00.000Z");
    reconciles(p);
  });

  it("excludes every non-attended status with its reason and quarantines unknown ones", () => {
    const statuses = ["Booked", "Cancelled", "Canceled", "Late Cancel", "Late cancellation", "No Show", "No-show", "Absent", "Waitlisted", "Reserved"];
    const p = plan(csv(
      ...statuses.map((s, i) => row({ id: `x${i}`, email: "ada@example.test", status: s })),
      row({ id: "u1", email: "ada@example.test", status: "Pending review" }),
      row({ id: "u2", email: "ada@example.test", status: "" }),
    ));
    expect(p.records).toEqual([]);
    expect(p.excluded.map((e) => e.reason)).toEqual(["booked", "cancelled", "cancelled", "late_cancel", "late_cancel", "no_show", "no_show", "no_show", "waitlisted", "booked"]);
    expect(p.quarantined.map((q) => [q.sourceRowId, q.reason])).toEqual([["u1", "unknown_status"], ["u2", "missing_status"]]);
    reconciles(p);
  });

  it("combines a status column with an attended flag without guessing", () => {
    const text = [
      "Customer Email,Event Name,Start Date,Start Time,Status,Attended",
      "ada@example.test,Adults Gi,2026-05-12,18:00,Booked,Yes", // booking ticked as attended → record
      "bob@example.test,Adults Gi,2026-05-12,18:00,Booked,No", // booked, not attended → excluded booked
      "ada@example.test,Adults Gi,2026-05-13,18:00,Cancelled,Yes", // cancellation stands
      "ada@example.test,Adults Gi,2026-05-14,18:00,Attended,No", // contradiction → quarantine
      "ada@example.test,Adults Gi,2026-05-15,18:00,,No", // no status, flag no → not attended
      "ada@example.test,Adults Gi,2026-05-16,18:00,,Maybe", // unreadable flag
    ].join("\n");
    const p = plan(text);
    expect(p.records.map((r) => r.memberId)).toEqual(["m_ada"]);
    expect(p.excluded.map((e) => e.reason)).toEqual(["booked", "cancelled", "not_attended"]);
    expect(p.quarantined.map((q) => q.reason)).toEqual(["conflicting_status", "unknown_status"]);
    reconciles(p);
  });

  it("matches by source id first, then email; never by name alone", () => {
    const p = plan(csv(
      // Source id wins even though the email is a stale one.
      row({ id: "s1", cid: "TU-1001", name: "Ada Lovelace", email: "old-ada@example.test" }),
      // The child, booked on her mother's address, matched by her own source id.
      row({ id: "s2", cid: "TU-2002", name: "Neha Sharma", email: "priya@example.test", cls: "Kids BJJ" }),
      // Same child with no source id: email says Priya, name says Neha → quarantine, never credited to the parent.
      row({ id: "s3", name: "Neha Sharma", email: "priya@example.test", cls: "Kids BJJ", date: "2026-05-19" }),
      // A name that matches a member but no id and no email.
      row({ id: "s4", name: "Bob Hart", email: "" }),
      // Unknown id AND unknown email.
      row({ id: "s5", cid: "TU-9999", name: "Ghost", email: "ghost@example.test" }),
      // Two members share the address.
      row({ id: "s6", name: "Sam Rice", email: "rice.house@example.test" }),
      // Unknown id but a known email falls through to the email.
      row({ id: "s7", cid: "TU-7777", name: "Bob Hart", email: "bob@example.test" }),
    ));
    expect(p.records.map((r) => [r.sourceRowIds[0], r.memberId])).toEqual([
      ["s1", "m_ada"],
      ["s7", "m_bob"],
      ["s2", "m_neha"],
    ]);
    expect(p.quarantined.map((q) => [q.sourceRowId, q.reason])).toEqual([
      ["s3", "email_name_mismatch"],
      ["s4", "no_person_key"],
      ["s5", "unresolved_person"],
      ["s6", "ambiguous_email"],
    ]);
    expect(p.records.some((r) => r.memberId === "m_priya")).toBe(false);
    reconciles(p);
  });

  it("never invents a class: an unknown name gets a classless session and its rows are quarantined", () => {
    const p = plan(csv(
      row({ id: "k1", email: "ada@example.test", cls: "Open Mat Sunday", date: "2026-05-17", start: "11:00", end: "12:30" }),
      row({ id: "k2", email: "bob@example.test", cls: "open mat  sunday", date: "2026-05-17", start: "11:00", end: "12:30" }),
      row({ id: "k3", email: "bob@example.test", cls: "" }),
    ));
    expect(p.records).toEqual([]);
    expect(p.sessions).toEqual([
      { key: "name:open mat sunday@2026-05-17T10:00:00.000Z", classId: null, className: "Open Mat Sunday", startUtc: "2026-05-17T10:00:00.000Z", endUtc: "2026-05-17T11:30:00.000Z", localDate: "2026-05-17", startTime: "11:00", endTime: "12:30" },
    ]);
    expect(p.quarantined.map((q) => [q.sourceRowId, q.reason])).toEqual([["k1", "unknown_class"], ["k2", "unknown_class"], ["k3", "missing_class"]]);
    reconciles(p);
  });

  it("quarantines a class name two classes share", () => {
    const p = plan(csv(row({ id: "d1", email: "ada@example.test", cls: "Fundamentals" })), {
      classes: [...CLASSES, { id: "c_f1", name: "Fundamentals" }, { id: "c_f2", name: "fundamentals" }],
    });
    expect(p.quarantined).toEqual([{ sourceRowId: "d1", line: 2, reason: "ambiguous_class", detail: "Fundamentals" }]);
    expect(p.sessions[0].classId).toBeNull();
    reconciles(p);
  });

  it("collapses the same person twice in one session to one record and counts the duplicate", () => {
    const p = plan(csv(
      row({ id: "d1", cid: "TU-1001", email: "ada@example.test" }),
      row({ id: "d2", email: "ada@example.test", status: "Checked in" }),
      row({ id: "d3", email: "ADA@example.test" }),
      row({ id: "d4", email: "bob@example.test" }),
    ));
    expect(p.records).toHaveLength(2);
    const ada = p.records.find((r) => r.memberId === "m_ada")!;
    expect(ada.sourceRowIds).toEqual(["d1", "d2", "d3"]);
    expect(p.excluded.map((e) => [e.sourceRowId, e.reason])).toEqual([["d2", "duplicate"], ["d3", "duplicate"]]);
    expect(p.totals.duplicates).toBe(2);
    expect(p.totals.bySession).toEqual({ "class:c_gi@2026-05-12T17:00:00.000Z": 2 });
    reconciles(p);
  });

  describe("club timezone and DST (Europe/London, 2026)", () => {
    it("29 Mar: 10:00 the day before is GMT, 10:00 on the day is BST", () => {
      expect(localToUtc("2026-03-28 10:00", TZ)!.toISOString()).toBe("2026-03-28T10:00:00.000Z");
      expect(localToUtc("2026-03-29 00:30", TZ)!.toISOString()).toBe("2026-03-29T00:30:00.000Z");
      expect(localToUtc("2026-03-29 02:00", TZ)!.toISOString()).toBe("2026-03-29T01:00:00.000Z");
      expect(localToUtc("2026-03-29 10:00", TZ)!.toISOString()).toBe("2026-03-29T09:00:00.000Z");
    });

    it("29 Mar: 01:30 does not exist and is quarantined, not shifted", () => {
      expect(localToUtc("2026-03-29 01:30", TZ)).toBeNull();
      const p = plan(csv(row({ id: "g1", email: "ada@example.test", date: "2026-03-29", start: "01:30" })));
      expect(p.quarantined).toEqual([{ sourceRowId: "g1", line: 2, reason: "nonexistent_local_time", detail: "2026-03-29 01:30 does not exist in Europe/London" }]);
      reconciles(p);
    });

    it("25 Oct: 10:00 the day before is BST, 10:00 on the day is GMT", () => {
      expect(localToUtc("2026-10-24 10:00", TZ)!.toISOString()).toBe("2026-10-24T09:00:00.000Z");
      expect(localToUtc("2026-10-25 10:00", TZ)!.toISOString()).toBe("2026-10-25T10:00:00.000Z");
      expect(localToUtc("2026-10-25 00:30", TZ)!.toISOString()).toBe("2026-10-24T23:30:00.000Z");
    });

    it("25 Oct: the repeated 01:30 resolves to the second (GMT) occurrence, every time", () => {
      expect(localToUtc("2026-10-25 01:30", TZ)!.toISOString()).toBe("2026-10-25T01:30:00.000Z");
      expect(localToUtc("2026-10-25 01:30", TZ)!.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    });

    it("plans sessions across both boundaries in UTC with club-local dates and times", () => {
      const p = plan(csv(
        row({ id: "t1", email: "ada@example.test", date: "28/03/2026", start: "10:00", end: "11:00" }),
        row({ id: "t2", email: "ada@example.test", date: "29/03/2026", start: "10:00", end: "11:00" }),
        row({ id: "t3", email: "ada@example.test", date: "24/10/2026", start: "10:00", end: "11:00" }),
        row({ id: "t4", email: "ada@example.test", date: "25/10/2026", start: "10:00", end: "11:00" }),
      ));
      expect(p.sessions.map((s) => [s.localDate, s.startTime, s.startUtc, s.endUtc])).toEqual([
        ["2026-03-28", "10:00", "2026-03-28T10:00:00.000Z", "2026-03-28T11:00:00.000Z"],
        ["2026-03-29", "10:00", "2026-03-29T09:00:00.000Z", "2026-03-29T10:00:00.000Z"],
        ["2026-10-24", "10:00", "2026-10-24T09:00:00.000Z", "2026-10-24T10:00:00.000Z"],
        ["2026-10-25", "10:00", "2026-10-25T10:00:00.000Z", "2026-10-25T11:00:00.000Z"],
      ]);
      expect(p.totals.byMonth).toEqual({ "2026-03": { records: 2, excluded: 0, quarantined: 0 }, "2026-10": { records: 2, excluded: 0, quarantined: 0 } });
      reconciles(p);
    });

    it("uses the club's zone, not London's, when the club is elsewhere", () => {
      const p = plan(csv(row({ email: "ada@example.test", date: "2026-05-12", start: "18:00" })), { timezone: "Asia/Makassar" });
      expect(p.sessions[0].startUtc).toBe("2026-05-12T10:00:00.000Z");
    });

    it("refuses an invalid timezone instead of defaulting", () => {
      expect(() => plan(csv(row({ email: "ada@example.test" })), { timezone: "Mars/Olympus" })).toThrow(/not a valid IANA timezone/);
    });
  });

  it("quarantines malformed dates and reconciles them under an unknown month", () => {
    const p = plan(csv(
      row({ id: "b1", email: "ada@example.test", date: "32/05/2026" }),
      row({ id: "b2", email: "ada@example.test", date: "2026-05-12", start: "" }),
      row({ id: "b3", email: "ada@example.test" }),
    ));
    expect(p.quarantined.map((q) => [q.sourceRowId, q.reason])).toEqual([["b1", "malformed_date"], ["b2", "missing_time"]]);
    expect(p.totals.byMonth.unknown).toEqual({ records: 0, excluded: 0, quarantined: 2 });
    expect(p.records).toHaveLength(1);
    reconciles(p);
  });

  it("is deterministic and idempotent: a re-run and a re-ordered file give identical keys", () => {
    const lines = [
      row({ id: "i1", cid: "TU-1001", email: "ada@example.test", date: "2026-05-12" }),
      row({ id: "i2", email: "bob@example.test", date: "2026-05-12" }),
      row({ id: "i3", email: "bob@example.test", cls: "No-Gi", date: "2026-06-02", start: "19:00", end: "20:30" }),
      row({ id: "i4", email: "ada@example.test", cls: "Kids BJJ", date: "2026-07-01", status: "Cancelled" }),
      row({ id: "i5", cid: "TU-2002", email: "priya@example.test", name: "Neha Sharma", cls: "Kids BJJ", date: "2026-07-01", start: "16:00", end: "16:45" }),
    ];
    const first = plan(csv(...lines));
    const second = plan(csv(...lines));
    expect(second).toEqual(first);
    const shuffled = plan(csv(...[...lines].reverse()));
    expect(shuffled.sessions).toEqual(first.sessions);
    expect(shuffled.records.map((r) => r.key)).toEqual(first.records.map((r) => r.key));
    expect(shuffled.totals.byPerson).toEqual(first.totals.byPerson);
    reconciles(first);
  });

  it("reconciles a mixed file: records + excluded + quarantined = input rows", () => {
    const p = plan(csv(
      row({ id: "1", email: "ada@example.test" }),
      row({ id: "2", email: "ada@example.test" }),
      row({ id: "3", email: "bob@example.test", status: "No Show" }),
      row({ id: "4", email: "nobody@example.test" }),
      row({ id: "5", email: "bob@example.test", cls: "Mystery Class" }),
      row({ id: "6", email: "bob@example.test", date: "not a date" }),
      row({ id: "7", email: "bob@example.test", date: "2026-06-01" }),
      row({ id: "8", email: "bob@example.test", status: "Cancelled", date: "2026-06-03" }),
    ));
    expect(p.totals).toMatchObject({ inputRows: 8, attended: 2, excluded: 3, quarantined: 3, duplicates: 1 });
    expect(p.totals.byMonth).toEqual({
      "2026-05": { records: 1, excluded: 2, quarantined: 2 },
      "2026-06": { records: 1, excluded: 1, quarantined: 0 },
      unknown: { records: 0, excluded: 0, quarantined: 1 },
    });
    reconciles(p);
  });

  it("carries no credit, payment, invitation, notification or waiver field — in the types or at runtime", () => {
    type Forbidden =
      | "credits" | "creditsUsed" | "consumeCredit" | "classPackId" | "payment" | "paymentId" | "amount" | "invoice"
      | "invite" | "invitation" | "sendInvite" | "notify" | "notification" | "email" | "waiver" | "waiverId";
    expectTypeOf<Extract<keyof AttendancePlan, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof PlannedRecord, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof PlannedSession, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<PlannedRecord["checkInMethod"]>().toEqualTypeOf<"import">();

    const p = plan(csv(row({ email: "ada@example.test" })));
    const forbidden = /credit|pack|payment|amount|invoice|invit|notif|waiver|^email$/i;
    expect(Object.keys(p).filter((k) => forbidden.test(k))).toEqual([]);
    for (const r of p.records) expect(Object.keys(r).filter((k) => forbidden.test(k))).toEqual([]);
    for (const s of p.sessions) expect(Object.keys(s).filter((k) => forbidden.test(k))).toEqual([]);
  });
});
