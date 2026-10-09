/**
 * Security lane D (9 Oct 2026) — AH-D1 / SEC-053, planner level.
 *
 * The attendance planner (lib/importers/attendance.ts planAttendanceImport)
 * may bind a TeamUp person to a member by name AND address only when the
 * binding is unambiguous, and once a commit starts it binds only what the
 * owner committed (`decisions.frozenPeople`). The database-level proof that a
 * false match is not COMMITTED is tests/integration/sec-d-attendance-misbinding-db.test.ts.
 */
import { describe, it, expect } from "vitest";
import { teamupPersonKey } from "@/lib/importers/teamup";
import { parseAttendanceCsv, planAttendanceImport, type PlanDecisions, type RosterMember } from "@/lib/importers/attendance";
import { isSynthesisedEmail, synthesiseKidEmail } from "@/lib/synthesise-kid-email";

const HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Status";
const row = (name: string, email: string) => [name, email, "2025-11-03T18:00:00+00:00", "Adults Gi", "Main", "Attended"].join(",");
const DECISIONS = (): PlanDecisions => ({
  person: {},
  offering: { "Adults Gi": { action: "class", targetId: "cls_1" } },
  venue: { Main: { action: "location", targetId: "loc_1" } },
});

function plan(lines: string[], members: RosterMember[], decisions: PlanDecisions = DECISIONS()) {
  const parsed = parseAttendanceCsv([HEADER, ...lines].join("\n"));
  expect(parsed.errors).toEqual([]);
  return planAttendanceImport(parsed.rows, {
    timezone: "Europe/London",
    now: new Date("2026-10-09T00:00:00Z"),
    members,
    classes: [{ id: "cls_1", name: "Adults Gi", isActive: true, historical: false, locationId: null }],
    locations: [{ id: "loc_1", name: "Main" }],
    decisions,
    isSynthesisedEmail,
  });
}

describe("SEC-053 name+email fallback — ambiguity is pending, never a silent pick", () => {
  it("positive control: one member with the name, holding the address → name_and_email", () => {
    const p = plan([row("Dana Solo", "dana@example.test")], [{ id: "m_dana", name: "Dana Solo", email: "dana@example.test", externalRef: null }]);
    expect(p.people[0]).toMatchObject({ memberId: "m_dana", matchMethod: "name_and_email" });
    expect(p.bookings[0].intent).toBe("attendance");
  });

  it("identical names: a second member with the same name (on another address) makes the address holder ambiguous → pending, both offered", () => {
    const members: RosterMember[] = [
      { id: "m_bea", name: "Bea Lane", email: "bea.new@example.test", externalRef: null },
      { id: "m_other", name: "Bea Lane", email: "bea.old@example.test", externalRef: null },
    ];
    const p = plan([row("Bea Lane", "bea.old@example.test")], members);
    expect(p.people[0].memberId).toBeNull();
    expect(p.people[0].matchMethod).toBeNull();
    expect(p.bookings[0].intent).toBe("pending_person");
    expect(p.people[0].candidates.map((c) => c.memberId).sort()).toEqual(["m_bea", "m_other"]);
  });

  it("identical names after normalisation (case, spacing) are still identical", () => {
    const members: RosterMember[] = [
      { id: "m_a", name: "  sam   LEE ", email: "sam@example.test", externalRef: null },
      { id: "m_b", name: "Sam Lee", email: "other@example.test", externalRef: null },
    ];
    expect(plan([row("Sam Lee", "sam@example.test")], members).people[0].memberId).toBeNull();
  });

  it("a parent and a child with one name (child on a synthesised address) → pending, not the parent", () => {
    const members: RosterMember[] = [
      { id: "m_parent", name: "Alex Kerr", email: "family@example.test", externalRef: null },
      { id: "m_child", name: "Alex Kerr", email: synthesiseKidEmail(), externalRef: null },
    ];
    const p = plan([row("Alex Kerr", "family@example.test")], members);
    expect(p.people[0].memberId).toBeNull();
    expect(p.bookings[0].intent).toBe("pending_person");
  });

  it("an externalRef hit is unaffected by a same-name member", () => {
    const members: RosterMember[] = [
      { id: "m_ref", name: "Cy Ward", email: "cy@example.test", externalRef: teamupPersonKey("Cy Ward", "cy@example.test") },
      { id: "m_dup", name: "Cy Ward", email: "cy2@example.test", externalRef: null },
    ];
    expect(plan([row("Cy Ward", "cy@example.test")], members).people[0]).toMatchObject({ memberId: "m_ref", matchMethod: "external_ref" });
  });

  it("missing email or missing name never binds by the fallback", () => {
    const members: RosterMember[] = [{ id: "m_g", name: "Gil Moe", email: "gil@example.test", externalRef: null }];
    expect(plan([row("Gil Moe", "")], members).people[0].memberId).toBeNull();
    expect(plan([row("", "gil@example.test")], members).people[0].memberId).toBeNull();
  });
});

describe("SEC-053 frozen resolutions — a commit binds only what was committed", () => {
  const key = teamupPersonKey("Cal Drift", "cal@example.test");
  const cal: RosterMember = { id: "m_cal", name: "Cal Drift", email: "cal@example.test", externalRef: null };

  it("a person frozen as unresolved stays pending though the live roster now matches", () => {
    const d = { ...DECISIONS(), frozenPeople: { [key]: { memberId: null, method: null, decidedPending: false } } };
    const p = plan([row("Cal Drift", "cal@example.test")], [cal], d);
    expect(p.people[0].memberId).toBeNull();
    expect(p.bookings[0].intent).toBe("pending_person");
  });

  it("a person absent from the frozen set is pending (no live re-match)", () => {
    const d = { ...DECISIONS(), frozenPeople: {} };
    expect(plan([row("Cal Drift", "cal@example.test")], [cal], d).people[0].memberId).toBeNull();
  });

  it("a frozen binding keeps its member and method, even if the live roster would pick another", () => {
    const other: RosterMember = { id: "m_new", name: "Cal Drift", email: "cal2@example.test", externalRef: key };
    const d = { ...DECISIONS(), frozenPeople: { [key]: { memberId: "m_cal", method: "name_and_email" as const, decidedPending: false } } };
    const p = plan([row("Cal Drift", "cal@example.test")], [cal, other], d);
    expect(p.people[0]).toMatchObject({ memberId: "m_cal", matchMethod: "name_and_email" });
  });

  it("a frozen binding to a member that no longer exists → pending", () => {
    const d = { ...DECISIONS(), frozenPeople: { [key]: { memberId: "m_gone", method: "external_ref" as const, decidedPending: false } } };
    expect(plan([row("Cal Drift", "cal@example.test")], [cal], d).people[0].memberId).toBeNull();
  });

  it("a prototype key in the source cannot reach Object.prototype through the frozen map", () => {
    const d = { ...DECISIONS(), frozenPeople: {} };
    const p = plan([row("__proto__", "")], [{ id: "m_x", name: "__proto__", email: "x@example.test", externalRef: null }], d);
    expect(p.people[0].memberId).toBeNull();
  });
});

describe("SEC-053 retest (reviewer R): folded names and released addresses", () => {
  const E_ACUTE = String.fromCharCode(0xe9);
  const COMBINING_ACUTE = String.fromCharCode(0x301);
  const ZWSP = String.fromCharCode(0x200b);
  const BOM = String.fromCharCode(0xfeff);
  const other: RosterMember = { id: "m_other", name: "Bea Lane", email: "bea.old@example.test", externalRef: null };
  for (const [label, name] of [
    ["precomposed accent", `B${E_ACUTE}a Lane`],
    ["combining accent", `Be${COMBINING_ACUTE}a Lane`],
    ["zero-width space", `Be${ZWSP}a Lane`],
    ["BOM + case + spacing", `${BOM}BEA   lane`],
  ] as const) {
    it(`fold collision (${label}) counts as the same name → pending, both offered`, () => {
      const p = plan([row("Bea Lane", "bea.old@example.test")], [{ id: "m_orig", name, email: "bea.new@example.test", externalRef: null }, other]);
      expect(p.people[0].memberId).toBeNull();
      expect(p.people[0].candidates.map((c) => c.memberId).sort()).toEqual(["m_orig", "m_other"]);
    });
  }

  it("released address (rename case): the original renamed 'Beatrice Lane' released it → the new holder is not bound; both offered", () => {
    const parsed = parseAttendanceCsv([HEADER, row("Bea Lane", "bea.old@example.test")].join("\n"));
    const p = planAttendanceImport(parsed.rows, {
      timezone: "Europe/London", now: new Date("2026-10-09T00:00:00Z"),
      members: [{ id: "m_orig", name: "Beatrice Lane", email: "bea.new@example.test", externalRef: null }, other],
      classes: [{ id: "cls_1", name: "Adults Gi", isActive: true, historical: false, locationId: null }],
      locations: [{ id: "loc_1", name: "Main" }], decisions: DECISIONS(), isSynthesisedEmail,
      releasedBy: (email) => (email === "bea.old@example.test" ? ["m_orig"] : undefined),
    } as Parameters<typeof planAttendanceImport>[1]);
    expect(p.people[0].memberId).toBeNull();
    expect(p.bookings[0].intent).toBe("pending_person");
    expect(p.people[0].candidates.map((c) => c.memberId).sort()).toEqual(["m_orig", "m_other"]);
  });

  it("an address released by a staff login (no member id) still refuses the fallback", () => {
    const parsed = parseAttendanceCsv([HEADER, row("Bea Lane", "bea.old@example.test")].join("\n"));
    const p = planAttendanceImport(parsed.rows, {
      timezone: "Europe/London", now: new Date("2026-10-09T00:00:00Z"), members: [other],
      classes: [{ id: "cls_1", name: "Adults Gi", isActive: true, historical: false, locationId: null }],
      locations: [{ id: "loc_1", name: "Main" }], decisions: DECISIONS(), isSynthesisedEmail,
      releasedBy: (email) => (email === "bea.old@example.test" ? [] : undefined),
    } as Parameters<typeof planAttendanceImport>[1]);
    expect(p.people[0].memberId).toBeNull();
  });

  it("positive control: an address nobody released still matches by name and email", () => {
    const parsed = parseAttendanceCsv([HEADER, row("Bea Lane", "bea.old@example.test")].join("\n"));
    const p = planAttendanceImport(parsed.rows, {
      timezone: "Europe/London", now: new Date("2026-10-09T00:00:00Z"), members: [other],
      classes: [{ id: "cls_1", name: "Adults Gi", isActive: true, historical: false, locationId: null }],
      locations: [{ id: "loc_1", name: "Main" }], decisions: DECISIONS(), isSynthesisedEmail,
      releasedBy: () => undefined,
    } as Parameters<typeof planAttendanceImport>[1]);
    expect(p.people[0]).toMatchObject({ memberId: "m_other", matchMethod: "name_and_email" });
  });
});
