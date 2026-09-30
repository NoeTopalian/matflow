import { describe, it, expect } from "vitest";
import type { MigrationRow } from "@/lib/stripe/migrate-memberships";
import {
  buildCutoverManifest,
  summariseManifest,
  manifestToCsv,
  monthlyEquivalentPence,
  type ManifestInputRow,
} from "@/lib/stripe/cutover-manifest";

/**
 * The cutover manifest (lib/stripe/cutover-manifest.ts) is what Sean signs and
 * acts on in TeamUp. These tests pin: the decision and the TeamUp action per
 * preview outcome, that a payer is never verified by an email match, that an
 * on-hold member stays on the source, the CSV formula guard, the first-cohort
 * rule, deterministic ordering, and that the totals reconcile to the input.
 */

const SNAPSHOT = "2026-10-01T09:00:00.000Z";
const EXPORTED = "2026-10-01T08:30:00.000Z";

function row(over: Partial<ManifestInputRow> & { memberId: string }): ManifestInputRow {
  const base: MigrationRow = {
    memberId: over.memberId,
    memberName: `Member ${over.memberId}`,
    memberEmail: `${over.memberId}@example.test`,
    customerId: `cus_${over.memberId}`,
    action: "replace",
    reason: null,
    subscriptionId: null,
    subscriptionStatus: "active",
    priceId: "price_adv",
    tierId: "tier_adv",
    tierName: "Adults Advanced 2026",
    tierMatchedBy: "amount",
    amountPence: 9800,
    currency: "GBP",
    cycle: "four_weekly",
    cycleLabel: "Every 4 weeks",
    paymentMethod: { id: "pm_1", type: "card", label: "Visa ending 4242" },
    firstChargeAt: "2026-10-20T06:00:00.000Z",
    replacesSubscriptionId: `sub_old_${over.memberId}`,
    otherLiveSubscriptionId: null,
    memberTierName: "Adults Advanced 2026",
  };
  return { ...base, ...over };
}

const skip = (memberId: string, reason: MigrationRow["reason"], over: Partial<ManifestInputRow> = {}) =>
  row({ memberId, action: "skip", reason, replacesSubscriptionId: null, firstChargeAt: null, ...over });

function build(rows: ManifestInputRow[]) {
  return buildCutoverManifest(rows, { snapshotAt: SNAPSHOT, sourceExportedAt: EXPORTED });
}

describe("buildCutoverManifest — decisions and TeamUp actions", () => {
  it("replace: TeamUp controls until cutover, action ends TeamUp and protects the replacement", () => {
    const [r] = build([row({ memberId: "a1" })]).rows;
    expect(r.decision).toBe("replace");
    expect(r.collectionController).toBe("TeamUp");
    expect(r.firstMatflowCollectionDate).toBe("2026-10-20");
    expect(r.stripe.sourceSubscriptionId).toBe("sub_old_a1");
    expect(r.sourceAction.owner).toBe("Sean");
    expect(r.sourceAction.dueBy).toBe("2026-10-19");
    expect(r.sourceAction.text).toContain("nothing is taken on or after 2026-10-20");
    expect(r.sourceAction.text).toContain("do NOT cancel the MatFlow subscription");
    expect(r.sourceAction.text).toContain("sub_old_a1");
    expect(r.exceptions).toEqual([]);
    expect(r.cadence).toBe("Every 4 weeks");
  });

  it("adopt: end TeamUp effective the period end, never cancel the adopted subscription", () => {
    const [r] = build([row({ memberId: "a2", action: "adopt", subscriptionId: "sub_keep", replacesSubscriptionId: null })]).rows;
    expect(r.decision).toBe("adopt");
    expect(r.stripe.subscriptionId).toBe("sub_keep");
    expect(r.sourceAction.text).toContain("effective 2026-10-20");
    expect(r.sourceAction.text).toContain("do NOT cancel the Stripe subscription sub_keep");
    expect(r.sourceAction.text).toContain("confirmed in writing");
    expect(r.sourceAction.dueBy).toBe("2026-10-19");
  });

  it("create: final TeamUp charge before the due date, MatFlow subscription identified by member metadata", () => {
    const [r] = build([row({ memberId: "a3", action: "create", replacesSubscriptionId: null, subscriptionStatus: null, priceId: null, tierMatchedBy: "member", firstChargeAt: "2026-10-12T06:00:00.000Z" })]).rows;
    expect(r.decision).toBe("create");
    expect(r.firstMatflowCollectionDate).toBe("2026-10-12");
    expect(r.sourceAction.dueBy).toBe("2026-10-11");
    expect(r.sourceAction.text).toContain("final charge falls before 2026-10-12");
    expect(r.sourceAction.text).toContain("metadata.matflowMemberId = a3");
  });

  it("skip rows remain on the source with the reason and no TeamUp change", () => {
    const [r] = build([skip("a4", "needs_tier")]).rows;
    expect(r.decision).toBe("remain_on_source");
    expect(r.decisionReason).toBe("needs_tier");
    expect(r.collectionController).toBe("TeamUp");
    expect(r.firstMatflowCollectionDate).toBeNull();
    expect(r.sourceAction.dueBy).toBeNull();
    expect(r.sourceAction.text).toContain("Change nothing in TeamUp");
    expect(r.exceptions.map((e) => e.code)).toEqual(["not_ready"]);
  });

  it("on-hold member → remain_on_source with an on_hold exception", () => {
    const [r] = build([skip("a5", "on_hold")]).rows;
    expect(r.decision).toBe("remain_on_source");
    expect(r.decisionReason).toBe("on_hold");
    expect(r.exceptions.map((e) => e.code)).toEqual(["on_hold"]);
  });

  it("maps tier_mismatch, no_payment_method, bacs_not_enabled and period_end_too_soon to exceptions", () => {
    const m = build([
      skip("b1", "tier_mismatch", { memberTierName: "Beginners Course 2026" }),
      skip("b2", "no_payment_method"),
      skip("b3", "bacs_not_enabled"),
      skip("b4", "period_end_too_soon"),
    ]);
    const codes = Object.fromEntries(m.rows.map((r) => [r.beneficiary.memberId, r.exceptions.map((e) => e.code)]));
    expect(codes).toEqual({
      b1: ["tier_mismatch"],
      b2: ["no_payment_method"],
      b3: ["no_payment_method"],
      b4: ["period_end_too_soon"],
    });
    expect(m.rows.find((r) => r.beneficiary.memberId === "b1")!.exceptions[0].detail).toContain("Beginners Course 2026");
  });

  it("an actionable row whose first collection is under 48 hours away is flagged too soon", () => {
    const [r] = build([row({ memberId: "c1", firstChargeAt: "2026-10-02T06:00:00.000Z" })]).rows;
    expect(r.decision).toBe("replace");
    expect(r.exceptions.map((e) => e.code)).toEqual(["period_end_too_soon"]);
  });

  it("already linked with TeamUp's subscription still live: both collecting, end TeamUp today", () => {
    const [r] = build([skip("c2", "already_linked", { subscriptionId: "sub_mf", otherLiveSubscriptionId: "sub_tu" })]).rows;
    expect(r.decision).toBe("already_migrated");
    expect(r.collectionController).toBe("Both");
    expect(r.exceptions.map((e) => e.code)).toEqual(["other_live_subscription"]);
    expect(r.sourceAction.dueBy).toBe("2026-10-01");
    expect(r.sourceAction.text).toContain("sub_tu");
    expect(r.sourceAction.text).toContain("Do NOT cancel sub_mf");
  });

  it("already linked and clean: MatFlow collects, nothing to do", () => {
    const [r] = build([skip("c3", "already_linked", { subscriptionId: "sub_mf" })]).rows;
    expect(r.collectionController).toBe("MatFlow");
    expect(r.exceptions).toEqual([]);
    expect(r.sourceAction.dueBy).toBeNull();
  });
});

describe("buildCutoverManifest — payer", () => {
  it("an adult matched by email is an unverified payer, never named from the email", () => {
    const [r] = build([row({ memberId: "p1" })]).rows;
    expect(r.payer).toEqual({ stripeCustomerId: "cus_p1", payerMemberId: null, name: null, verified: false, basis: "email_match_unverified" });
  });

  it("a kid (synthesised email) with no payer link is unverified and an exception", () => {
    const [r] = build([skip("k1", "no_customer", { memberEmail: "kid-0123abcd@no-login.matflow.local", customerId: null })]).rows;
    expect(r.beneficiary.junior).toBe(true);
    expect(r.payer.verified).toBe(false);
    expect(r.payer.basis).toBe("none");
    expect(r.exceptions.map((e) => e.code)).toContain("payer_unverified");
  });

  it("a kid on a parent's customer is unverified unless the row carries an explicit payer link", () => {
    const shared = { memberEmail: "parent@example.test", customerId: "cus_parent", isJunior: true };
    const [unlinked] = build([row({ memberId: "k2", ...shared })]).rows;
    expect(unlinked.payer.verified).toBe(false);
    expect(unlinked.payer.name).toBeNull();
    expect(unlinked.exceptions.map((e) => e.code)).toEqual(["payer_unverified"]);

    const [linked] = build([row({ memberId: "k3", ...shared, payerLink: { payerMemberId: "par1", payerName: "Pat Parent", source: "parent_link" } })]).rows;
    expect(linked.payer).toEqual({ stripeCustomerId: "cus_parent", payerMemberId: "par1", name: "Pat Parent", verified: true, basis: "explicit_link" });
    expect(linked.exceptions).toEqual([]);
  });
});

describe("buildCutoverManifest — ordering and timestamps", () => {
  it("is deterministic regardless of input order", () => {
    const input = [
      skip("z", "on_hold", { memberName: "Zed" }),
      row({ memberId: "y", memberName: "Yas", action: "create", replacesSubscriptionId: null, firstChargeAt: "2026-10-10T06:00:00.000Z" }),
      row({ memberId: "x", memberName: "Xan", firstChargeAt: "2026-10-25T06:00:00.000Z" }),
      row({ memberId: "w", memberName: "Wil", firstChargeAt: "2026-10-05T06:00:00.000Z" }),
      row({ memberId: "v", memberName: "Wil", firstChargeAt: "2026-10-05T06:00:00.000Z" }),
    ];
    const a = build(input);
    const b = build([...input].reverse());
    expect(a).toEqual(b);
    expect(a.rows.map((r) => r.beneficiary.memberId)).toEqual(["v", "w", "x", "y", "z"]);
    expect(manifestToCsv(a)).toBe(manifestToCsv(b));
  });

  it("does not mutate the input rows", () => {
    const input = [row({ memberId: "m2" }), row({ memberId: "m1" })];
    const copy = JSON.parse(JSON.stringify(input));
    build(input);
    expect(input).toEqual(copy);
  });

  it("records the snapshot and flags a stale or future source export", () => {
    const fresh = build([]);
    expect(fresh.sourceAgeHours).toBe(0.5);
    expect(fresh.sourceStale).toBe(false);
    const stale = buildCutoverManifest([], { snapshotAt: SNAPSHOT, sourceExportedAt: "2026-09-29T08:00:00.000Z" });
    expect(stale.sourceStale).toBe(true);
    const future = buildCutoverManifest([], { snapshotAt: SNAPSHOT, sourceExportedAt: "2026-10-02T08:00:00.000Z" });
    expect(future.sourceStale).toBe(true);
    expect(() => buildCutoverManifest([], { snapshotAt: "nonsense", sourceExportedAt: EXPORTED })).toThrow();
  });
});

describe("summariseManifest", () => {
  it("counts every decision and reconciles totals to the input rows", () => {
    const input = [
      row({ memberId: "r1" }),
      row({ memberId: "r2", action: "adopt", subscriptionId: "sub_a", replacesSubscriptionId: null }),
      row({ memberId: "r3", action: "create", replacesSubscriptionId: null, amountPence: 5500, cycle: "monthly", cycleLabel: "Monthly" }),
      skip("r4", "already_linked", { subscriptionId: "sub_mf" }),
      skip("r5", "on_hold"),
      skip("r6", "no_customer", { amountPence: null, currency: null, cycle: null, cycleLabel: null }),
    ];
    const m = build(input);
    const s = summariseManifest(m);
    expect(s.total).toBe(input.length);
    expect(s.byDecision).toEqual({ replace: 1, adopt: 1, create: 1, already_migrated: 1, remain_on_source: 2 });
    expect(Object.values(s.byDecision).reduce((a, b) => a + b, 0)).toBe(input.length);
    expect(s.rowsWithoutAmount).toBe(1);
    // £98 every 4 weeks = 9800 × 13 / 12 = 10616.67 → 10617 a month.
    const fourWeekly = monthlyEquivalentPence(9800, "four_weekly");
    expect(fourWeekly).toBe(10617);
    expect(s.monthlyEquivalentPence.GBP.migrating).toBe(fourWeekly! * 2 + 5500);
    expect(s.monthlyEquivalentPence.GBP.notMigrating).toBe(fourWeekly! * 2);
    const rowSum = m.rows.reduce((a, r) => a + (r.monthlyEquivalentPence ?? 0), 0);
    expect(s.monthlyEquivalentPence.GBP.total).toBe(rowSum);
    expect(s.monthlyEquivalentPence.GBP.total).toBe(s.monthlyEquivalentPence.GBP.migrating + s.monthlyEquivalentPence.GBP.notMigrating);
    expect(s.withExceptions).toBe(2);
  });

  it("monthly equivalents per cadence", () => {
    expect(monthlyEquivalentPence(1200, "weekly")).toBe(5200);
    expect(monthlyEquivalentPence(1200, "fortnightly")).toBe(2600);
    expect(monthlyEquivalentPence(12000, "annual")).toBe(1000);
    expect(monthlyEquivalentPence(1500, "none")).toBe(0);
    expect(monthlyEquivalentPence(null, "monthly")).toBeNull();
    expect(monthlyEquivalentPence(1500, "fortnightly-ish")).toBeNull();
  });
});

describe("summariseManifest — first cohort", () => {
  it("adults only, one plan, clean actionable rows, no exceptions, at most five", () => {
    const adv = (id: string, over: Partial<ManifestInputRow> = {}) => row({ memberId: id, memberName: `Adv ${id}`, ...over });
    const beg = (id: string) => row({ memberId: id, memberName: `Beg ${id}`, tierName: "Beginners Course 2026", amountPence: 8800 });
    const input = [
      adv("a1"), adv("a2"), adv("a3"), adv("a4"), adv("a5"), adv("a6"),
      adv("a7", { isJunior: true, payerLink: { payerMemberId: "p", payerName: "P", source: "parent_link" } }),
      adv("a8", { firstChargeAt: "2026-10-01T20:00:00.000Z" }), // too soon
      skip("a9", "on_hold", { memberName: "Adv a9" }),
      beg("b1"), beg("b2"),
    ];
    const s = summariseManifest(build(input));
    expect(s.firstCohort.tierName).toBe("Adults Advanced 2026");
    expect(s.firstCohort.memberIds).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("picks the plan with the most clean adults, ties broken by plan name, and is empty when nothing is clean", () => {
    const tie = [
      row({ memberId: "t1", tierName: "Zeta" }),
      row({ memberId: "t2", tierName: "Alpha" }),
    ];
    expect(summariseManifest(build(tie)).firstCohort).toEqual({ tierName: "Alpha", memberIds: ["t2"] });
    expect(summariseManifest(build([skip("s1", "on_hold")])).firstCohort).toEqual({ tierName: null, memberIds: [] });
  });
});

describe("manifestToCsv", () => {
  it("guards formula injection and quoting in user-controlled cells", () => {
    const m = build([
      row({ memberId: "i1", memberName: "=HYPERLINK(\"http://evil\",\"x\")" }),
      row({ memberId: "i2", memberName: "+44 Smith, John" }),
      row({ memberId: "i3", memberName: "@SUM(A1)", tierName: "-Tier" }),
    ]);
    const csv = manifestToCsv(m);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0].startsWith("Member ID,Member,Junior,Payer")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(`"'+44 Smith, John"`);
    expect(csv).toContain(",'@SUM(A1),");
    expect(csv).toContain(",'-Tier,");
    // No cell begins with a raw formula trigger.
    expect(csv).not.toMatch(/(^|,)[=+@]/m);
  });

  it("writes unverified payers as NO and keeps amounts numeric", () => {
    const csv = manifestToCsv(build([row({ memberId: "n1" })]));
    const cells = csv.split("\r\n")[1];
    expect(cells).toContain(",Unconfirmed,,NO,email_match_unverified,");
    expect(cells).toContain(",9800,GBP,Every 4 weeks,10617,TeamUp,2026-10-20,");
  });
});
