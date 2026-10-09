/**
 * Imports after a contact-email change (admin hub ledger AH-05, 9 Oct 2026).
 *
 * The pure matchers only — no database. A member's login/contact address can
 * be corrected in MatFlow (owner PATCH today; the operator contact-email route
 * later). The person's SOURCE identity is `Member.externalRef`
 * ("teamup:<email>|<name>" from the first import), which no edit rewrites. So:
 *  - the TeamUp status refresh (lib/importers/teamup-refresh planRefresh)
 *    matches only on externalRef and never reads or writes an address;
 *  - the attendance planner (lib/importers/attendance planAttendanceImport)
 *    matches on the owner's saved decision, then externalRef, then — only when
 *    no ref hits — on name AND the member's CURRENT address, and only when
 *    exactly one member carries both. Everything else stays pending.
 * The DB-level proof (real routes, real rows) is
 * tests/integration/contact-email-change-imports-db.test.ts.
 */
import { describe, it, expect } from "vitest";
import { parseTeamUp, teamupPersonKey } from "@/lib/importers/teamup";
import { planRefresh, refreshWrite, REFRESH_OWNED_FIELDS, type RefreshMember } from "@/lib/importers/teamup-refresh";
import {
  parseAttendanceCsv,
  planAttendanceImport,
  type AttendancePlan,
  type PlanDecisions,
  type RosterMember,
} from "@/lib/importers/attendance";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

const OLD = "alex.old@example.test";
const NEW = "alex.new@example.test";
const BEA_OLD = "bea.old@example.test";
const BEA_NEW = "bea.new@example.test";

// ── Attendance ───────────────────────────────────────────────────────────────

const A_HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Status";
const aRow = (name: string, email: string, hhmm = "18:00") => [name, email, `2025-11-03T${hhmm}:00+00:00`, "Adults Gi", "Main", "Attended"].join(",");
const CLASSES = [{ id: "cls_1", name: "Adults Gi", isActive: true, historical: false, locationId: null }];
const LOCATIONS = [{ id: "loc_1", name: "Main" }];
const BASE_DECISIONS = (): PlanDecisions => ({
  person: {},
  offering: { "Adults Gi": { action: "class", targetId: "cls_1" } },
  venue: { Main: { action: "location", targetId: "loc_1" } },
});

/** Alex was imported on OLD and corrected to NEW; Bea was added by hand (no externalRef) and corrected too. */
const ROSTER = (): RosterMember[] => [
  { id: "m_alex", name: "Alex Moss", email: NEW, externalRef: teamupPersonKey("Alex Moss", OLD) },
  { id: "m_bea", name: "Bea Lane", email: BEA_NEW, externalRef: null },
];

function planOf(lines: string[], over: { members?: RosterMember[]; decisions?: PlanDecisions } = {}): AttendancePlan {
  const parsed = parseAttendanceCsv([A_HEADER, ...lines].join("\n"));
  expect(parsed.errors).toEqual([]);
  return planAttendanceImport(parsed.rows, {
    timezone: "Europe/London",
    now: new Date("2026-10-09T00:00:00Z"),
    members: over.members ?? ROSTER(),
    classes: CLASSES,
    locations: LOCATIONS,
    decisions: over.decisions ?? BASE_DECISIONS(),
    isSynthesisedEmail,
  });
}
const personOf = (p: AttendancePlan, name: string, email: string) => {
  const hit = p.people.find((x) => x.name === name && x.email === email);
  expect(hit, `${name} <${email}>`).toBeDefined();
  return hit!;
};

describe("attendance planner — a member whose address was corrected", () => {
  it("the ORIGINAL source row (name + old address) still resolves to the same member by external_ref", () => {
    const p = planOf([aRow("Alex Moss", OLD)]);
    const who = personOf(p, "Alex Moss", OLD);
    expect(who.memberId).toBe("m_alex");
    expect(who.matchMethod).toBe("external_ref");
    expect(p.bookings[0].intent).toBe("attendance");
  });

  it("a row carrying the corrected address matches by name_and_email (no ref hit, exactly one holder)", () => {
    const p = planOf([aRow("Alex Moss", NEW)]);
    const who = personOf(p, "Alex Moss", NEW);
    expect(who.memberId).toBe("m_alex");
    expect(who.matchMethod).toBe("name_and_email");
  });

  it("FALLBACK: no externalRef, name + the OLD address → pending, never a different member", () => {
    // Cat now holds Bea's released address. Neither name+email pair matches.
    const members = [...ROSTER(), { id: "m_cat", name: "Cat Reed", email: BEA_OLD, externalRef: null }];
    const p = planOf([aRow("Bea Lane", BEA_OLD)], { members });
    const who = personOf(p, "Bea Lane", BEA_OLD);
    expect(who.memberId).toBeNull();
    expect(who.matchMethod).toBeNull();
    expect(p.bookings[0].intent).toBe("pending_person");
    // Suggestions only — the owner decides.
    expect(who.candidates).toEqual(expect.arrayContaining([
      { memberId: "m_bea", reason: "same_name" },
      { memberId: "m_cat", reason: "same_email" },
    ]));
  });

  it("FALLBACK: no externalRef, name + the NEW address → name_and_email, only while exactly one member carries both", () => {
    expect(personOf(planOf([aRow("Bea Lane", BEA_NEW)]), "Bea Lane", BEA_NEW).memberId).toBe("m_bea");
    // Two rows on one canonical address (legacy, written before the lowercase
    // trigger of 15 Sep 2026; impossible today under unique(tenantId, email)):
    // ambiguous, so pending — nothing is picked.
    const legacy = [...ROSTER(), { id: "m_bea2", name: "Bea Lane", email: BEA_NEW.toUpperCase(), externalRef: null }];
    const who = personOf(planOf([aRow("Bea Lane", BEA_NEW)], { members: legacy }), "Bea Lane", BEA_NEW);
    expect(who.memberId).toBeNull();
    expect(who.candidates.map((c) => c.memberId).sort()).toEqual(["m_bea", "m_bea2"]);
  });

  it("FALLBACK residual (documented): another member with the SAME name who now holds the released address is matched", () => {
    // The fallback's definition of identity is name AND current address; with
    // no externalRef there is no address history to consult. Pinned so a
    // change here is deliberate; the preview shows the match before commit.
    const members = [...ROSTER(), { id: "m_bea_other", name: "Bea Lane", email: BEA_OLD, externalRef: null }];
    const who = personOf(planOf([aRow("Bea Lane", BEA_OLD)], { members }), "Bea Lane", BEA_OLD);
    expect(who.memberId).toBe("m_bea_other");
    expect(who.matchMethod).toBe("name_and_email");
  });

  it("an externalRef hit is never overridden by the fallback, even when another member holds the row's address now", () => {
    // Alex moved off OLD; Dan took OLD. The source row is Alex's.
    const members = [...ROSTER(), { id: "m_dan", name: "Alex Moss", email: OLD, externalRef: null }];
    const who = personOf(planOf([aRow("Alex Moss", OLD)], { members }), "Alex Moss", OLD);
    expect(who.memberId).toBe("m_alex");
    expect(who.matchMethod).toBe("external_ref");
  });

  it("duplicate externalRef on two roster rows → ambiguous, pending, and the fallback is NOT consulted", () => {
    const members = [
      { id: "m_x", name: "Alex Moss", email: NEW, externalRef: teamupPersonKey("Alex Moss", OLD) },
      // m_y also carries the row's name AND address, so a fallback that ran here would pick it.
      { id: "m_y", name: "Alex Moss", email: OLD, externalRef: teamupPersonKey("Alex Moss", OLD) },
    ];
    const p = planOf([aRow("Alex Moss", OLD)], { members });
    expect(personOf(p, "Alex Moss", OLD).memberId).toBeNull();
    expect(p.bookings.map((b) => b.intent)).toEqual(["pending_person"]);
  });

  it("a saved person decision still wins after the change; 'keep pending' stays pending though the fallback would match", () => {
    const alias = teamupPersonKey("A. Moss", "alias@example.test");
    const decisions = BASE_DECISIONS();
    decisions.person[alias] = { action: "member", targetId: "m_alex" };
    decisions.person[teamupPersonKey("Bea Lane", BEA_NEW)] = { action: "pending" };
    const p = planOf([aRow("A. Moss", "alias@example.test"), aRow("Bea Lane", BEA_NEW, "19:00")], { decisions });
    expect(personOf(p, "A. Moss", "alias@example.test")).toMatchObject({ memberId: "m_alex", matchMethod: "decision" });
    expect(personOf(p, "Bea Lane", BEA_NEW)).toMatchObject({ memberId: null, decidedPending: true });
  });

  it("a decision pointing at a member who is no longer in the club is pending, never re-matched", () => {
    const decisions = BASE_DECISIONS();
    decisions.person[teamupPersonKey("Alex Moss", OLD)] = { action: "member", targetId: "m_gone" };
    const who = personOf(planOf([aRow("Alex Moss", OLD)], { decisions }), "Alex Moss", OLD);
    expect(who).toMatchObject({ memberId: null, decidedPending: true });
  });

  it("a synthesised no-login address is never a fallback key", () => {
    const synthetic = "kid-abc@no-login.matflow.local";
    expect(isSynthesisedEmail(synthetic)).toBe(true);
    const members = [{ id: "m_kid", name: "Kit Moss", email: synthetic, externalRef: null }];
    const who = personOf(planOf([aRow("Kit Moss", synthetic)], { members }), "Kit Moss", synthetic);
    expect(who.memberId).toBeNull();
  });
});

// ── TeamUp status refresh ────────────────────────────────────────────────────

const T_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const tRow = (name: string, email: string, status: string) =>
  [name, email, "", "Adults Unlimited", "recurring", status, "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", "1990-04-15", "", "", ""].join(",");
const JOB = { id: "job_refresh", sourceExportedAt: "2026-09-20T08:00:00.000Z" };

const refreshMember = (over: Partial<RefreshMember> & { id: string; name: string }): RefreshMember => ({
  externalRef: null, billedBy: "teamup", status: "active", paymentStatus: "paid", cancelledAt: null,
  membershipType: "Adults Unlimited", membershipTierId: null, billingStatusAsOf: new Date("2026-09-01T08:00:00Z"), billingStatusSource: "job_create",
  ...over,
});

function refresh(lines: string[], members: RefreshMember[]) {
  const { drafts, errors } = parseTeamUp([T_HEADER, ...lines].join("\n"), { asOf: "2026-09-20" });
  return planRefresh({ drafts, errors, members, tiers: [], job: JOB });
}

describe("TeamUp status refresh — a member whose address was corrected", () => {
  it("the ORIGINAL source row matches the same member id by externalRef; the matcher never sees an address", () => {
    const alex = refreshMember({ id: "m_alex", name: "Alex Moss", externalRef: teamupPersonKey("Alex Moss", OLD) });
    // RefreshMember carries no email at all: a corrected address cannot affect matching.
    expect(Object.keys(alex)).not.toContain("email");
    const plan = refresh([tRow("Alex Moss", OLD, "hold")], [alex]);
    expect(plan.matched.map((c) => c.memberId)).toEqual(["m_alex"]);
    expect(plan.matched[0].fields).toContain("paymentStatus");
    expect(plan.exceptions.notInMatFlow).toEqual([]);
    expect(plan.reconciles).toBe(true);
  });

  it("the write a refresh makes holds standing fields only — never email, name, unverifiedEmail or externalRef", () => {
    const alex = refreshMember({ id: "m_alex", name: "Alex Moss", externalRef: teamupPersonKey("Alex Moss", OLD) });
    const plan = refresh([tRow("Alex Moss", OLD, "hold")], [alex]);
    const keys = Object.keys(refreshWrite(plan.matched[0].after)).sort();
    expect(keys).toEqual([...REFRESH_OWNED_FIELDS, "billingStatusAsOf", "billingStatusSource"].sort());
    for (const k of ["email", "name", "unverifiedEmail", "externalRef", "phone"]) expect(keys).not.toContain(k);
  });

  it("a SOURCE-side address change (the row now carries the new address) is an exception, never a guess by name", () => {
    const alex = refreshMember({ id: "m_alex", name: "Alex Moss", externalRef: teamupPersonKey("Alex Moss", OLD) });
    const plan = refresh([tRow("Alex Moss", NEW, "active")], [alex]);
    expect(plan.matched).toEqual([]);
    expect(plan.exceptions.notInMatFlow.map((x) => x.sourceKey)).toEqual([teamupPersonKey("Alex Moss", NEW)]);
    expect(plan.exceptions.notInFile).toEqual([{ memberId: "m_alex", name: "Alex Moss" }]);
  });

  it("a TeamUp-billed member with NO externalRef is never matched by name or address", () => {
    const bea = refreshMember({ id: "m_bea", name: "Bea Lane", externalRef: null });
    const plan = refresh([tRow("Bea Lane", BEA_NEW, "hold")], [bea]);
    expect(plan.matched).toEqual([]);
    expect(plan.exceptions.notInFile).toEqual([{ memberId: "m_bea", name: "Bea Lane" }]);
    expect(plan.exceptions.notInMatFlow).toHaveLength(1);
  });

  it("matching is byte-exact on the stored key (no case folding): a key that differs only in case is not a match", () => {
    const legacy = refreshMember({ id: "m_alex", name: "Alex Moss", externalRef: teamupPersonKey("Alex Moss", OLD).toUpperCase() });
    const plan = refresh([tRow("Alex Moss", OLD, "hold")], [legacy]);
    expect(plan.matched).toEqual([]);
    expect(plan.exceptions.notInMatFlow).toHaveLength(1);
  });
});
