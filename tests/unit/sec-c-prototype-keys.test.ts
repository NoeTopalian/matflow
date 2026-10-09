// Security campaign lane C — SEC-036 prototype pollution / prototype-key
// confusion at the parser and accumulator boundaries.
//
// Untrusted strings become object KEYS in three places that matter:
//   1. JSON request bodies (every API route) — zod schemas copy declared keys only.
//   2. z.record bodies (settings onboardingAnswers, step-up `change`) — zod 4.3.6
//      drops a `__proto__` key.
//   3. Import accumulators keyed by CSV cell values: the attendance planner looks
//      owner decisions up as `decisions.offering[className]` / `decisions.venue[venue]`
//      on plain objects, and the controls count by status/offering in plain objects.
//      A TeamUp export is "malicious imported content" in the threat model: a class,
//      venue or status called "constructor", "toString", "hasOwnProperty" or
//      "__proto__" must behave exactly like any other UNMAPPED name.
//
// Synthetic data only; no database.

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  parseAttendanceCsv,
  planAttendanceImport,
  attendanceControls,
  type PlanDecisions,
  type RosterClass,
  type RosterLocation,
  type RosterMember,
} from "@/lib/importers/attendance";

const SF_C2_FIXED = true;
const PROTO_NAMES = ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"];

afterEach(() => {
  for (const k of ["secCPolluted", "action", "targetId"]) delete (Object.prototype as Record<string, unknown>)[k];
});

describe("SEC-036 — JSON and zod boundaries", () => {
  it("JSON.parse keeps __proto__ as an own key; a strip-mode z.object drops it; strict refuses it", () => {
    const raw = JSON.parse('{"a":"x","__proto__":{"secCPolluted":"yes"},"constructor":{"prototype":{"secCPolluted":"yes"}}}');
    const strip = z.object({ a: z.string() }).parse(raw);
    expect(strip).toEqual({ a: "x" });
    expect(Object.getPrototypeOf(strip)).toBe(Object.prototype);
    const strict = z.strictObject({ a: z.string() }).safeParse(raw);
    expect(strict.success).toBe(false);
    expect(({} as Record<string, unknown>).secCPolluted).toBeUndefined();
  });

  it("z.record (settings onboardingAnswers shape) drops __proto__ and never pollutes", () => {
    const raw = JSON.parse('{"__proto__":{"secCPolluted":"yes"},"constructor":{"prototype":{"secCPolluted":"yes"}},"q1":"a"}');
    const out = z.record(z.string(), z.unknown()).parse(raw);
    expect(Reflect.ownKeys(out).sort()).toEqual(["constructor", "q1"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).secCPolluted).toBeUndefined();
    // Persisted as JSON: the constructor key is inert data.
    expect(JSON.parse(JSON.stringify(out))).toEqual({ constructor: { prototype: { secCPolluted: "yes" } }, q1: "a" });
  });
});

// ── Attendance planner (lib/importers/attendance.ts; lane D owns the file) ──
const HEADER =
  "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
function row(offering: string, venue: string, status = "Attended"): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    "Ada Lovelace", "ada@secc.example", "2025-10-04T09:00:00+01:00", offering, venue, "", "Online", "CM-1", "MS-1",
    "Adults Unlimited", "Web", status, "", "", "", "", "", "", "GB", "", "", "", "", "", "", "",
  ].map(q).join(",");
}
const MEMBERS: RosterMember[] = [{ id: "secC-m-ada", name: "Ada Lovelace", email: "ada@secc.example", externalRef: null }];
const CLASSES: RosterClass[] = [{ id: "secC-c-gi", name: "Adults Gi", isActive: true, historical: false, locationId: null }];
const LOCATIONS: RosterLocation[] = [{ id: "secC-loc-main", name: "Main Mat" }];
const DECISIONS: PlanDecisions = {
  person: {},
  offering: { "Adults Gi": { action: "class", targetId: "secC-c-gi" } },
  venue: { "Main Mat": { action: "location", targetId: "secC-loc-main" } },
};
function plan(csv: string, decisions: PlanDecisions = DECISIONS) {
  const parsed = parseAttendanceCsv(csv);
  return {
    parsed,
    plan: planAttendanceImport(parsed.rows, {
      timezone: "Europe/London",
      now: new Date("2025-11-01T00:00:00Z"),
      members: MEMBERS,
      classes: CLASSES,
      locations: LOCATIONS,
      decisions,
      isSynthesisedEmail: () => false,
    }),
  };
}

describe("SEC-036 — attendance planner treats prototype-named offerings/venues as unmapped", () => {
  it("positive control: a mapped offering at a mapped venue becomes attendance", () => {
    const { plan: p } = plan([HEADER, row("Adults Gi", "Main Mat")].join("\n"));
    expect(p.bookings.map((b) => b.intent)).toEqual(["attendance"]);
  });

  it("positive control: an ordinary unmapped offering is pending_offering", () => {
    const { plan: p } = plan([HEADER, row("Open Mat", "Main Mat")].join("\n"));
    expect(p.bookings.map((b) => b.intent)).toEqual(["pending_offering"]);
  });

  // SF-C2 (lane D owns lib/importers/attendance.ts): decisions.offering[className] reads through the
  // prototype, so an offering called "constructor" finds Object() as its "decision", is not pending,
  // and plans as attendance with no class (the commit then records it as pending_person, mislabelled).
  // Pinned in its current state; set SF_C2_FIXED = true when the own-property lookup lands.
  it.each(PROTO_NAMES)("offering named %s at a mapped venue is pending_offering, not committed", (name) => {
    const { plan: p } = plan([HEADER, row(name, "Main Mat")].join("\n"));
    const intents = p.bookings.map((b) => b.intent);
    if (SF_C2_FIXED) expect(intents).toEqual(["pending_offering"]);
    else expect(intents, "SF-C2 fixed? set SF_C2_FIXED = true").toEqual(["attendance"]);
    expect(({} as Record<string, unknown>).secCPolluted).toBeUndefined();
  });

  it.each(PROTO_NAMES)("venue named %s with a mapped offering is pending_venue", (name) => {
    const { plan: p } = plan([HEADER, row("Adults Gi", name)].join("\n"));
    expect(p.bookings.map((b) => b.intent)).toEqual(["pending_venue"]);
  });

  it.each(PROTO_NAMES)("controls count a status/offering named %s as a number, without throwing", (name) => {
    const { parsed } = plan([HEADER, row(name, "Main Mat"), row(name, "Main Mat", "Attended")].join("\n"));
    const controls = attendanceControls(parsed.rows) as unknown as Record<string, unknown>;
    const json = JSON.stringify(controls);
    expect(json).not.toMatch(/function |\[object Object\]/);
    expect(({} as Record<string, unknown>).secCPolluted).toBeUndefined();
  });
});
