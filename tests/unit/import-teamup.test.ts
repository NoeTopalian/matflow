// The TeamUp memberships export, folded into people (lib/importers/teamup.ts).
//
// The fixture below has the export's exact header row and the difficult
// shapes from Total BJJ's real file with every name, address and number
// invented: a family of three on one email, a kid whose email no adult uses,
// a row with no email, a deleted customer, a member on hold, an upgrade
// history, a cancelled-only person, a finished prepaid course, an "(OLD)"
// monthly plan, two adults sharing one address, and a date-of-birth that
// contradicts the plan. Every rule in the module's header is pinned here.

import { describe, it, expect } from "vitest";
import { parseImport } from "@/lib/importers";
import { parseTeamUp, estimateNextCharge, cycleForPlan } from "@/lib/importers/teamup";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";

const TODAY = "2026-09-24";

function row(o: Partial<Record<
  "name" | "email" | "other" | "plan" | "type" | "status" | "proc" | "purchase" | "start" | "expiry" | "cancelled" | "first" | "completed" | "addr1" | "addr2" | "city" | "region" | "postcode" | "country" | "marketing" | "phone" | "gender" | "dob" | "ecName" | "ecPhone" | "ecRel",
  string
>>): string {
  const v = (s?: string) => (s ?? "").includes(",") ? `"${s}"` : (s ?? "");
  return [o.name, o.email, o.other, o.plan, o.type ?? "recurring", o.status, o.proc ?? "Stripe", o.purchase ?? o.start, o.start, o.expiry, o.cancelled, o.first ?? "Yes", o.completed, o.addr1, o.addr2, o.city, o.region, o.postcode, o.country ?? "GB", o.marketing, o.phone, o.gender, o.dob, o.ecName, o.ecPhone, o.ecRel].map(v).join(",");
}

const FIXTURE = [
  HEADER,
  // Adult, active on a 2026 4-weekly plan, Stripe.
  row({ name: "Ada Lovelace", email: "ada@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-14", phone: "07000000001", dob: "1990-04-15", ecName: "Bob Lovelace", ecPhone: "07000000002", ecRel: "Husband" }),
  // Same adult's earlier membership, upgraded away — history only.
  row({ name: "Ada Lovelace", email: "ada@example.test", other: "Adults Advanced 2026", plan: "Beginners Course 2026", status: "upgraded", start: "2025-11-01", expiry: "2026-01-13", first: "Yes" }),
  // Family: parent has an adult row; two kids on the parent's email, one on hold.
  row({ name: "Priya Sharma", email: "priya@example.test", plan: "Advanced Unlimited Adult Classes (OLD)", status: "active", start: "2024-12-01", dob: "1985-06-12", ecName: "Raj Sharma", ecPhone: "07000000003", ecRel: "Husband" }),
  row({ name: "Neha Sharma", email: "priya@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-02-02", dob: "2016-03-21", ecName: "Priya Sharma", ecPhone: "07000000004", ecRel: "Mother" }),
  row({ name: "Arjun Sharma", email: "priya@example.test", plan: "Kids Once-A-Week 2026", status: "hold", start: "2026-02-02", dob: "2013-12-16", ecName: "Priya Sharma", ecPhone: "07000000004", ecRel: "Mother" }),
  // Kid whose email no adult row uses — the payer must be created from the emergency contact.
  row({ name: "Leo Okafor", email: "okafor.family@example.test", plan: "Kids Once-A-Week 2026", status: "active", start: "2026-03-14", dob: "2019-06-24", ecName: "Chidi Okafor", ecPhone: "07000000005", ecRel: "Father" }),
  // Adult with no email at all.
  row({ name: "Musa Kasim", email: "", plan: "Adults Advanced 2026", status: "active", start: "2026-05-04", phone: "07000000006", dob: "1998-01-08" }),
  // Deleted customer — dropped.
  row({ name: "(Deleted Customer)", email: "", plan: "Kids Unlimited Membership (OLD)", status: "cancelled", start: "2024-12-01", expiry: "2025-08-31", cancelled: "2025-08-22" }),
  // Cancelled-only person, marketing declined.
  row({ name: "Tom Roper", email: "tom@example.test", plan: "Advanced Unlimited Adult Classes", status: "cancelled", start: "2025-02-03", expiry: "2025-12-08", cancelled: "2025-12-08", marketing: "No, do not send me any marketing messages", dob: "1999-06-28" }),
  // Finished a prepaid course and nothing since.
  row({ name: "Elvis Webster", email: "elvis@example.test", plan: "8 Week Beginners Course", type: "prepaid", status: "completed", proc: "", start: "2025-01-16", expiry: "2025-07-24", completed: "2025-07-25T01:01:35+01:00", dob: "2003-02-11" }),
  // Two adults sharing one email (partners): the second becomes non-contactable.
  row({ name: "Sam Rice", email: "rice.house@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-06-01", dob: "1992-11-10" }),
  row({ name: "Jo Rice", email: "rice.house@example.test", plan: "Beginners Course 2026", status: "active", start: "2026-06-01", dob: "1994-02-02" }),
  // Adult (by date of birth) on a Kids plan — flagged, not silently made a child.
  row({ name: "Zain Ali", email: "zain@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-04-08", dob: "2000-01-08" }),
  // Two live rows for one person.
  row({ name: "Dan Coles", email: "dan@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-06-17", dob: "1992-11-13" }),
  row({ name: "Dan Coles", email: "dan@example.test", plan: "Advanced Once Per Week 2026", status: "active", start: "2026-06-20", dob: "1992-11-13" }),
].join("\n");

function byName(drafts: ReturnType<typeof parseTeamUp>["drafts"], name: string) {
  const d = drafts.find((x) => x.name === name);
  if (!d) throw new Error(`no draft for ${name}`);
  return d;
}

describe("TeamUp export — people, not rows", () => {
  const result = parseTeamUp(FIXTURE, { today: TODAY });
  const { drafts, errors, summary } = result;

  it("is reachable through parseImport('teamup') and carries its summary", () => {
    const via = parseImport("teamup", FIXTURE);
    expect(via.drafts.map((d) => d.name).sort()).toEqual(drafts.map((d) => d.name).sort());
    expect(via.summary).toBeDefined();
  });

  it("folds 15 rows into 12 people, drops the deleted customer, reports the split", () => {
    expect(summary.sourceRows).toBe(15);
    expect(summary.deletedRows).toBe(1);
    expect(summary.people).toBe(12);
    expect(summary.adults).toBe(9);
    expect(summary.kids).toBe(3);
    expect(summary.parentsSynthesised).toBe(1);
    expect(summary.guardiansFromSharedEmail).toBe(2);
    expect(summary.noEmail).toBe(1);
    expect(summary.sharedEmailAdults).toBe(1);
    expect(summary.multipleLiveMemberships).toBe(1);
    expect(summary.decisionsRequired).toBe(1);
    expect(summary.duplicateRows).toBe(0);
    expect(summary.historicalOnly).toBe(2);
    expect(errors).toEqual([]);
    // 12 people + 1 guardian draft = 13 drafts.
    expect(drafts).toHaveLength(13);
    // Every CSV record has exactly one disposition (teamup-2 ledger).
    expect(result.rows).toHaveLength(15);
    expect(new Set(result.rows.map((r) => r.sourceRow)).size).toBe(15);
    expect(result.rows.filter((r) => r.disposition === "excluded:deleted_customer")).toHaveLength(1);
    expect(result.rows.filter((r) => r.disposition === "member_history")).toHaveLength(14);
  });

  it("keeps the current membership and folds history: Ada is on Adults Advanced 2026, joined when her first row started", () => {
    const ada = byName(drafts, "Ada Lovelace");
    expect(ada.membershipType).toBe("Adults Advanced 2026");
    expect(ada.status).toBe("active");
    expect(ada.paymentStatus).toBe("paid");
    expect(ada.joinedAt).toBe("2025-11-01");
    expect(ada.accountType).toBe("adult");
    expect(ada.emergencyContactName).toBe("Bob Lovelace");
    expect(ada.emergencyContactRelation).toBe("Husband");
    expect(ada.sourceRows).toEqual([2, 3]);
  });

  it("never writes an estimated next-charge date to nextDueAt — it goes to the notes as unverified", () => {
    for (const d of drafts) expect(d.nextDueAt).toBeUndefined();
    const ada = byName(drafts, "Ada Lovelace");
    // 2026-01-14 + 9 × 28 days = 2026-09-23 (past) → 10 × 28 = 2026-10-21.
    expect(ada.notes).toContain("Estimated next charge 2026-10-21");
    expect(ada.notes).toContain("UNVERIFIED");
    const priya = byName(drafts, "Priya Sharma");
    // (OLD) plans are monthly: 1 Dec 2024 stepped by months → 1 Oct 2026.
    expect(priya.notes).toContain("Estimated next charge 2026-10-01");
  });

  it("links the Sharma children to the adult sharing their email and keeps them separate people", () => {
    const neha = byName(drafts, "Neha Sharma");
    const arjun = byName(drafts, "Arjun Sharma");
    expect(neha.accountType).toBe("kids");
    expect(arjun.accountType).toBe("kids");
    expect(neha.parentEmail).toBe("priya@example.test");
    expect(arjun.parentEmail).toBe("priya@example.test");
    expect(isSynthesisedEmail(neha.email)).toBe(true);
    expect(isSynthesisedEmail(arjun.email)).toBe(true);
    expect(neha.email).not.toBe(arjun.email);
    expect(neha.nonContactable).toBe(true);
    // The link is a SUGGESTION from the shared address — the commit writes it
    // unconfirmed and the parent portal gets no access until the owner confirms.
    expect(neha.guardianSuggestedBy).toBe("shared_email");
    // The parent keeps the real address and is NOT marked unverified.
    const priya = byName(drafts, "Priya Sharma");
    expect(priya.email).toBe("priya@example.test");
    expect(priya.unverified).toBeUndefined();
  });

  it("a hold becomes paymentStatus paused with a note, and is counted as on hold not active", () => {
    const arjun = byName(drafts, "Arjun Sharma");
    expect(arjun.status).toBe("active");
    expect(arjun.paymentStatus).toBe("paused");
    expect(arjun.notes).toContain("On hold at TeamUp");
    expect(summary.planCounts["Kids Once-A-Week 2026"]).toEqual({ active: 1, hold: 1 });
    expect(summary.currentOnHold).toBe(1);
  });

  it("creates ONE non-authenticated guardian draft from the emergency contact when no adult shares a kid's email", () => {
    const leo = byName(drafts, "Leo Okafor");
    // The kid points at the payer address as a LOOKUP key; the commit resolves
    // it against the draft's unverifiedEmail, never against a login.
    expect(leo.parentEmail).toBe("okafor.family@example.test");
    expect(leo.guardianSuggestedBy).toBe("emergency_contact");
    // No draft carries the payer's address as a login.
    expect(drafts.find((d) => d.email === "okafor.family@example.test")).toBeUndefined();
    const parent = drafts.find((d) => d.unverifiedEmail === "okafor.family@example.test");
    expect(parent).toBeDefined();
    expect(parent!.name).toBe("Chidi Okafor");
    expect(parent!.accountType).toBe("parent");
    expect(parent!.unverified).toBe(true);
    expect(parent!.nonContactable).toBe(true);
    expect(isSynthesisedEmail(parent!.email)).toBe(true);
    expect(parent!.notes).toContain("NOT CONFIRMED");
    expect(parent!.phone).toBe("07000000005");
    expect(parent!.memberships).toEqual([]);
  });

  it("a person with no email is imported non-contactable, never dropped", () => {
    const musa = byName(drafts, "Musa Kasim");
    expect(isSynthesisedEmail(musa.email)).toBe(true);
    expect(musa.nonContactable).toBe(true);
    expect(musa.notes).toContain("No email at TeamUp");
    expect(musa.status).toBe("active");
  });

  it("two adults on one address: the first keeps it, the second is non-contactable with a note", () => {
    const sam = byName(drafts, "Sam Rice");
    const jo = byName(drafts, "Jo Rice");
    const keepers = [sam, jo].filter((d) => d.email === "rice.house@example.test");
    expect(keepers).toHaveLength(1);
    const other = sam.email === "rice.house@example.test" ? jo : sam;
    expect(isSynthesisedEmail(other.email)).toBe(true);
    expect(other.notes).toContain("Shares rice.house@example.test");
    // The shared address is kept for the owner to confirm — never as a login.
    expect(other.unverifiedEmail).toBe("rice.house@example.test");
  });

  it("cancelled-only people arrive cancelled with the date and the last plan; marketing refusal is kept", () => {
    const tom = byName(drafts, "Tom Roper");
    expect(tom.status).toBe("cancelled");
    expect(tom.paymentStatus).toBe("cancelled");
    expect(tom.cancelledAt).toBe("2025-12-08");
    expect(tom.membershipType).toBe("Advanced Unlimited Adult Classes");
    expect(tom.notes).toContain("Marketing: declined");
    expect(tom.nextDueAt).toBeUndefined();
  });

  it("a finished prepaid course with nothing since is inactive, not cancelled — and no cancellation date is invented", () => {
    const elvis = byName(drafts, "Elvis Webster");
    expect(elvis.status).toBe("inactive");
    // teamup-2: cancelledAt comes ONLY from the Cancelled Date column. The
    // course's own completion instant is kept on its membership row and named
    // in the note; it is not written as a cancellation.
    expect(elvis.cancelledAt).toBeUndefined();
    expect(elvis.notes).toContain("completed, 2025-07-25");
    expect(elvis.memberships?.[0].completedAt).toBe("2025-07-25T00:01:35.000Z");
    expect(elvis.memberships?.[0].entitlement).toBe("history");
  });

  it("date of birth wins over plan name: an adult on a Kids plan stays an adult and is flagged", () => {
    const zain = byName(drafts, "Zain Ali");
    expect(zain.accountType).toBe("adult");
    expect(zain.parentEmail).toBeUndefined();
    expect(zain.notes).toContain("check the date of birth");
  });

  it("two started active memberships: a DECISION, no plan chosen, both named (teamup-2)", () => {
    const dan = byName(drafts, "Dan Coles");
    expect(dan.membershipType).toBeUndefined();
    expect(dan.status).toBe("active");
    expect(dan.decision).toEqual({ kind: "concurrent_memberships", options: ["Adults Advanced 2026", "Advanced Once Per Week 2026"], rows: [15, 16] });
    expect(dan.notes).toContain("DECISION NEEDED");
    expect(dan.memberships?.map((m) => m.entitlement)).toEqual(["current", "current"]);
    // Neither plan is counted as current for anyone until the owner decides.
    expect(summary.planCounts["Advanced Once Per Week 2026"]).toBeUndefined();
  });

  it("plan counts reconcile to the live memberships in the file", () => {
    const total = Object.values(summary.planCounts).reduce((n, c) => n + c.active + c.hold, 0);
    expect(total).toBe(summary.currentActive + summary.currentOnHold);
    expect(summary.planCounts["Adults Advanced 2026"]).toEqual({ active: 3, hold: 0 });
  });

  it("refuses a file that is not this export", () => {
    const r = parseTeamUp("name,email\nJo,jo@example.test", { today: TODAY });
    expect(r.drafts).toEqual([]);
    expect(r.errors[0].reason).toMatch(/TeamUp/);
  });
});

describe("stable source keys (TeamUp bridge, 30 Sep 2026)", () => {
  // A status refresh matches people on this key; it must be present, stable
  // across exports and unique within one file.
  it("every draft carries a TeamUp source key, unique in the file", () => {
    const { drafts } = parseTeamUp(FIXTURE, { today: TODAY });
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(d.sourceKey, d.name).toMatch(/^teamup(-payer)?:/);
    expect(new Set(drafts.map((d) => d.sourceKey)).size).toBe(drafts.length);
    const again = parseTeamUp(FIXTURE, { today: "2026-10-24" }).drafts.map((d) => d.sourceKey).sort();
    expect(again).toEqual(drafts.map((d) => d.sourceKey).sort());
  });
});

describe("error lines (verifier lane 5, P4-T)", () => {
  // Blank lines and a quoted cell running over two lines: the error must cite
  // the line the row starts on in the file, not its position among the rows.
  it("cites the real file line after blank lines and a multi-line cell", () => {
    const csv = [
      "Customer Name,Customer Email,Membership Name,Type,Status,Start Date,Date of birth",
      "",
      'Ada Adult,ada@example.test,"Adults',
      'Unlimited",recurring,active,2025-01-01,1990-01-01',
      "",
      "",
      "Ivo Orphan,,Kids BJJ,recurring,active,2025-01-01,2019-01-01",
    ].join("\n");
    const { errors } = parseTeamUp(csv, { today: "2026-09-30" });
    const ivo = errors.find((e) => e.reason.startsWith("Ivo Orphan"));
    expect(ivo?.row).toBe(7);
  });
});

describe("cycle and estimate helpers", () => {
  it("reads the cycle from the plan wording", () => {
    expect(cycleForPlan("Adults Advanced 2026")).toBe("four_weekly");
    expect(cycleForPlan("Kids Unlimited Membership (OLD)")).toBe("monthly");
    expect(cycleForPlan("8 Week Beginners Course")).toBe("none");
    expect(cycleForPlan("Beginners Course 2026")).toBe("four_weekly");
    // The un-suffixed legacy plans bill every 4 weeks too — only the 8-week
    // course is prepaid (catalogue, 24 Sep).
    expect(cycleForPlan("Beginner Course")).toBe("four_weekly");
    expect(cycleForPlan("Kids Unlimited Membership")).toBe("four_weekly");
  });

  it("steps to the first boundary after today and never behind it", () => {
    expect(estimateNextCharge("2026-09-01", "four_weekly", "2026-09-24")).toBe("2026-09-29");
    expect(estimateNextCharge("2026-09-24", "four_weekly", "2026-09-24")).toBe("2026-10-22");
    expect(estimateNextCharge("2024-12-01", "monthly", "2026-09-24")).toBe("2026-10-01");
    expect(estimateNextCharge("2026-01-01", "none", "2026-09-24")).toBeUndefined();
  });
});

// ── teamup-2 (2 Oct 2026): as-of entitlement, per-row ledger, source-only dates ──
describe("teamup-2 — entitlement at an as-of date, per membership", () => {
  const AS_OF = "2026-10-02";
  const csv = [
    HEADER,
    // Started active + a second active that starts AFTER the as-of date: scheduled.
    row({ name: "Sal Schedule", email: "sal@example.test", plan: "Beginners Course 2026", status: "active", start: "2026-07-01", dob: "1990-01-01" }),
    row({ name: "Sal Schedule", email: "sal@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-10-19", dob: "1990-01-01" }),
    // Only a future start: active at TeamUp, nothing current yet.
    row({ name: "Fay Future", email: "fay@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-10-05", dob: "1991-01-01" }),
    // Started active AND a hold on a different plan: the hold is not applied.
    row({ name: "Hal Held", email: "hal@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-03-01", dob: "1992-01-01" }),
    row({ name: "Hal Held", email: "hal@example.test", plan: "8 Week Beginners Course", type: "prepaid", status: "hold", start: "2026-01-05", dob: "1992-01-01" }),
    // Hold only: current via the hold, paused.
    row({ name: "Olly Onhold", email: "olly@example.test", plan: "Kids Unlimited Membership", status: "hold", start: "2025-09-01", dob: "1989-01-01" }),
    // Exact duplicate rows.
    row({ name: "Dee Dupe", email: "dee@example.test", plan: "Advanced Unlimited Adult Classes", status: "cancelled", start: "2024-01-01", expiry: "2024-06-01", cancelled: "2024-06-01", dob: "1988-01-01" }),
    row({ name: "Dee Dupe", email: "dee@example.test", plan: "Advanced Unlimited Adult Classes", status: "cancelled", start: "2024-01-01", expiry: "2024-06-01", cancelled: "2024-06-01", dob: "1988-01-01" }),
    // Cancelled without a date: stays undated.
    row({ name: "Una Undated", email: "una@example.test", plan: "Beginner Course", status: "cancelled", start: "2023-02-01", dob: "1987-01-01" }),
    // Emergency contact differs between one person's rows.
    row({ name: "Eve Conflict", email: "eve@example.test", plan: "Kids Once A Week Membership", status: "cancelled", start: "2024-01-01", cancelled: "2024-12-01", dob: "1986-01-01", ecName: "Pat One", ecRel: "Partner" }),
    row({ name: "Eve Conflict", email: "eve@example.test", plan: "Adults Advanced 2026", status: "active", start: "2025-01-01", dob: "1986-01-01", ecName: "Pat Two", ecRel: "Partner" }),
    // A kid under 13 with no email: quarantined, still accounted for.
    row({ name: "Kit Orphan", email: "", plan: "Kids Unlimited 2026", status: "active", start: "2026-01-01", dob: "2018-05-05" }),
    // Two adults share an email AND a kid is on it: the emergency-contact name picks the guardian suggestion.
    row({ name: "Ann Adult", email: "house@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-01", dob: "1985-01-01" }),
    row({ name: "Ben Adult", email: "house@example.test", plan: "Beginners Course 2026", status: "active", start: "2026-01-01", dob: "1984-01-01" }),
    row({ name: "Cal Kid", email: "house@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-01-01", dob: "2017-01-01", ecName: "Ben Adult", ecRel: "Father" }),
  ].join("\n");
  const r = parseTeamUp(csv, { asOf: AS_OF });
  const d = (name: string) => byName(r.drafts, name);

  it("a scheduled start does not displace the started plan; a future-only person has no current plan yet", () => {
    const sal = d("Sal Schedule");
    expect(sal.membershipType).toBe("Beginners Course 2026");
    expect(sal.scheduled).toEqual({ planLabel: "Adults Advanced 2026", startDate: "2026-10-19", sourceRow: 3 });
    expect(sal.memberships?.map((m) => [m.planLabel, m.entitlement])).toEqual([["Beginners Course 2026", "current"], ["Adults Advanced 2026", "scheduled"]]);
    expect(sal.notes).toContain("Scheduled at TeamUp: Adults Advanced 2026 starts 2026-10-19");
    const fay = d("Fay Future");
    expect(fay.status).toBe("active");
    expect(fay.membershipType).toBeUndefined();
    expect(fay.scheduled?.startDate).toBe("2026-10-05");
    expect(fay.decision).toBeUndefined();
    expect(r.summary.scheduledStarts).toBe(2);
    // Read the same file after the start date: the scheduled plan is current.
    const later = parseTeamUp(csv, { asOf: "2026-10-20" });
    expect(byName(later.drafts, "Sal Schedule").decision?.kind).toBe("concurrent_memberships");
    expect(byName(later.drafts, "Fay Future").membershipType).toBe("Adults Advanced 2026");
  });

  it("a hold on another plan is not applied; a hold-only person is current and paused", () => {
    const hal = d("Hal Held");
    expect(hal.membershipType).toBe("Adults Advanced 2026");
    expect(hal.paymentStatus).toBe("paid");
    expect(hal.notes).toContain("Also on hold at TeamUp: 8 Week Beginners Course");
    expect(hal.memberships?.find((m) => m.planLabel === "8 Week Beginners Course")?.entitlement).toBe("held");
    expect(r.summary.heldAlongsideActive).toBe(1);
    const olly = d("Olly Onhold");
    expect(olly.paymentStatus).toBe("paused");
    expect(olly.membershipType).toBe("Kids Unlimited Membership");
  });

  it("exact duplicate rows are linked to the first copy and folded once", () => {
    expect(r.summary.duplicateRows).toBe(1);
    const dee = d("Dee Dupe");
    expect(dee.memberships).toHaveLength(1);
    expect(dee.sourceRows).toEqual([8]);
    expect(r.rows.find((x) => x.sourceRow === 9)?.disposition).toBe("duplicate_of:8");
  });

  it("a cancellation without a date stays undated and is flagged — no end date is invented", () => {
    const una = d("Una Undated");
    expect(una.status).toBe("cancelled");
    expect(una.cancelledAt).toBeUndefined();
    expect(una.notes).toContain("cancellation date not in the export");
    expect(r.summary.cancelledWithoutDate).toBe(1);
  });

  it("conflicting emergency contacts are noted; the current row's contact is kept", () => {
    const eve = d("Eve Conflict");
    expect(eve.emergencyContactName).toBe("Pat Two");
    expect(eve.notes).toContain("Emergency contact differs");
    expect(r.summary.emergencyContactConflicts).toBe(1);
  });

  it("a kid under 13 with no email is quarantined and its row still has a disposition", () => {
    expect(r.errors.find((e) => e.reason.startsWith("Kit Orphan"))).toBeDefined();
    expect(r.drafts.find((x) => x.name === "Kit Orphan")).toBeUndefined();
    expect(r.rows.find((x) => x.sourceRow === 13)?.disposition).toBe("quarantined:kid_without_parent");
    expect(r.summary.kidsWithoutParent).toBe(1);
  });

  it("several adults on a child's address: the emergency-contact name picks the suggestion; the other adult is non-contactable", () => {
    const cal = d("Cal Kid");
    expect(cal.parentEmail).toBe("house@example.test");
    expect(cal.guardianSuggestedBy).toBe("shared_email");
    const ben = d("Ben Adult");
    const ann = d("Ann Adult");
    // One of the two adults keeps the login address; the other keeps it as unverified.
    expect([ann.email, ben.email]).toContain("house@example.test");
    const other = ann.email === "house@example.test" ? ben : ann;
    expect(other.unverifiedEmail).toBe("house@example.test");
  });

  it("every CSV record has exactly one disposition and the ledger sums to the record count", () => {
    expect(r.summary.sourceRows).toBe(15);
    expect(r.rows).toHaveLength(15);
    expect(new Set(r.rows.map((x) => x.sourceRow)).size).toBe(15);
    const kinds = r.rows.reduce<Record<string, number>>((m, x) => ((m[x.disposition.split(":")[0]] = (m[x.disposition.split(":")[0]] ?? 0) + 1), m), {});
    expect(kinds).toEqual({ member_history: 13, duplicate_of: 1, quarantined: 1 });
  });

  it("date-only columns are kept date-only and never shifted by a timezone", () => {
    const sal = d("Sal Schedule");
    expect(sal.memberships?.[0].startDate).toBe("2026-07-01");
    expect(sal.joinedAt).toBe("2026-07-01");
  });
});
