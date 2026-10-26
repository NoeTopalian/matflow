// D2 (booking preservation, approved 21 Oct 2026): the pure rules behind the
// owner's preview, the member's "not eligible" mark, the register flag and the
// durable record. They must be the DOOR's rules (lib/checkin.ts), so each case
// here mirrors a door behaviour.
import { describe, it, expect } from "vitest";
import {
  OPEN_RULES,
  accessRefusals,
  accessRefusalSentence,
  bookedRefusals,
  groupNotBooked,
  highestRankOrder,
  newRefusals,
  newlyRefusedByTrigger,
  outsidePreviewPopulation,
  rulesAfterEdit,
  type AccessFacts,
  type ClassAccessRules,
} from "@/lib/booking-eligibility";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { ROSTER_REFUSAL_SENTENCE, tierRefusalSentence } from "@/lib/class-tier-gate";

const m = (memberId: string, over: Partial<AccessFacts> = {}): AccessFacts => ({
  memberId, membershipTierId: "t-adv", tierName: "Advanced", rankOrder: 2, ...over,
});
const rules = (over: Partial<ClassAccessRules>): ClassAccessRules => ({ ...OPEN_RULES, ...over });

describe("accessRefusals: the door's rules", () => {
  it("an open class refuses no one", () => {
    expect(accessRefusals(OPEN_RULES, m("a", { membershipTierId: null, rankOrder: null }))).toEqual([]);
  });

  it("rank: the highest rank order of ANY discipline against the gate; unranked fails a required rank, passes a maximum", () => {
    expect(highestRankOrder([{ order: 1 }, { order: 4 }, { order: 2 }])).toBe(4);
    expect(highestRankOrder([])).toBeNull();
    expect(accessRefusals(rules({ requiredRankOrder: 3 }), m("a", { rankOrder: 2 }))).toEqual(["rank_below"]);
    expect(accessRefusals(rules({ requiredRankOrder: 3 }), m("a", { rankOrder: null }))).toEqual(["rank_below"]);
    expect(accessRefusals(rules({ requiredRankOrder: 2 }), m("a", { rankOrder: 2 }))).toEqual([]);
    expect(accessRefusals(rules({ maxRankOrder: 1 }), m("a", { rankOrder: 2 }))).toEqual(["rank_above"]);
    expect(accessRefusals(rules({ maxRankOrder: 1 }), m("a", { rankOrder: null }))).toEqual([]);
  });

  it("squad list: only members on it; an empty list is no list", () => {
    expect(accessRefusals(rules({ rosterMemberIds: ["b"] }), m("a"))).toEqual(["roster_not_listed"]);
    expect(accessRefusals(rules({ rosterMemberIds: ["a"] }), m("a"))).toEqual([]);
    expect(accessRefusals(rules({ rosterMemberIds: [] }), m("a"))).toEqual([]);
  });

  it("membership list: classTierCovers; no plan is not covered; both lists must hold", () => {
    expect(accessRefusals(rules({ allowedTierIds: ["t-beg"] }), m("a"))).toEqual(["tier_not_included"]);
    expect(accessRefusals(rules({ allowedTierIds: ["t-adv"] }), m("a", { membershipTierId: null }))).toEqual(["tier_not_included"]);
    expect(accessRefusals(rules({ rosterMemberIds: ["a"], allowedTierIds: ["t-beg"] }), m("a"))).toEqual(["tier_not_included"]);
  });

  it("in the order the member's own door meets them: rank, squad, membership", () => {
    expect(accessRefusals(rules({ requiredRankOrder: 9, rosterMemberIds: ["b"], allowedTierIds: ["t-beg"] }), m("a"))).toEqual([
      "rank_below", "roster_not_listed", "tier_not_included",
    ]);
  });

  it("the sentence is the door's own (lib/checkin-refusal.ts)", () => {
    expect(accessRefusalSentence("roster_not_listed", "Comp", null)).toBe(ROSTER_REFUSAL_SENTENCE);
    expect(accessRefusalSentence("tier_not_included", "Comp", "Beginners")).toBe(tierRefusalSentence("Comp", "Beginners"));
    expect(accessRefusalSentence("rank_below", "Comp", null)).toBe(checkinRefusal({ kind: "rank_below" })!.body.error);
    expect(accessRefusalSentence("rank_above", "Comp", null)).toBe(checkinRefusal({ kind: "rank_above" })!.body.error);
  });
});

describe("what an edit newly turns away", () => {
  it("compares by trigger: a member already refused on the squad list is newly refused on membership grounds only", () => {
    const before = rules({ rosterMemberIds: ["b"] });
    const after = rules({ rosterMemberIds: ["b"], allowedTierIds: ["t-beg"] });
    expect(newRefusals(before, after, m("a"))).toEqual(["tier_not_included"]);
    expect(newRefusals(after, after, m("a"))).toEqual([]);
  });

  it("per trigger, sorted, for the durable record", () => {
    const before = OPEN_RULES;
    const after = rules({ rosterMemberIds: ["a", "c"], allowedTierIds: ["t-adv"], requiredRankOrder: 3 });
    const booked = [
      { facts: m("c", { membershipTierId: "t-beg", rankOrder: 5 }) }, // membership
      { facts: m("b", { rankOrder: 1 }) }, // rank + squad
      { facts: m("a", { rankOrder: 3 }) }, // admitted
    ];
    expect(newlyRefusedByTrigger(before, after, booked)).toEqual({ rank: ["b"], squad: ["b"], membership: ["c"] });
  });

  it("booked refusals: newly or already, and whether staff doors still admit (rank only)", () => {
    const before = rules({ allowedTierIds: ["t-adv"] });
    const after = rules({ allowedTierIds: ["t-adv"], requiredRankOrder: 3 });
    const out = bookedRefusals(before, after, [
      { facts: m("x", { rankOrder: 1 }), name: "Xan" },
      { facts: m("y", { membershipTierId: "t-beg", rankOrder: 1 }), name: "Yas" },
      { facts: m("z", { rankOrder: 4 }), name: "Zed" },
    ]);
    expect(out).toEqual([
      { memberId: "x", name: "Xan", reasons: ["rank_below"], newlyRefused: true, staffDoorsAdmit: true },
      { memberId: "y", name: "Yas", reasons: ["rank_below", "tier_not_included"], newlyRefused: true, staffDoorsAdmit: false },
    ]);
  });
});

describe("rulesAfterEdit: the PATCH route's precedence", () => {
  const before = rules({ rosterMemberIds: ["a"], allowedTierIds: ["t1"], requiredRankOrder: 2, maxRankOrder: 5 });

  it("a roster replaces the list and clears both rank gates", () => {
    expect(rulesAfterEdit(before, { roster: ["c", "b"], namesRank: false })).toEqual(rules({ rosterMemberIds: ["b", "c"], allowedTierIds: ["t1"] }));
  });

  it("naming a rank clears the squad list; undefined leaves a gate, null clears it", () => {
    expect(rulesAfterEdit(before, { namesRank: true, requiredRankOrder: 3 })).toEqual(rules({ allowedTierIds: ["t1"], requiredRankOrder: 3, maxRankOrder: 5 }));
    expect(rulesAfterEdit(before, { namesRank: false, requiredRankOrder: null, maxRankOrder: null })).toEqual(rules({ rosterMemberIds: ["a"], allowedTierIds: ["t1"] }));
    expect(rulesAfterEdit(before, { namesRank: false })).toEqual(before);
  });

  it("a membership list replaces the list", () => {
    expect(rulesAfterEdit(before, { namesRank: false, allowedTierIds: [] }).allowedTierIds).toEqual([]);
  });
});

describe("the not-booked preview", () => {
  it("leaves out guardian and payer accounts and members who are not training", () => {
    expect(outsidePreviewPopulation({ accountType: "parent", status: "active" })).toBe(true);
    expect(outsidePreviewPopulation({ accountType: "adult", status: "active", externalRef: "teamup-payer:1" })).toBe(true);
    expect(outsidePreviewPopulation({ accountType: "adult", status: "cancelled" })).toBe(true);
    expect(outsidePreviewPopulation({ accountType: "adult", status: "inactive" })).toBe(true);
    expect(outsidePreviewPopulation({ accountType: "kids", status: "active" })).toBe(false);
    expect(outsidePreviewPopulation({ accountType: "adult", status: "taster" })).toBe(false);
  });

  it("groups by the first reason the member's own door meets; no plan apart from a plan not included; recent attenders first", () => {
    const row = (id: string, name: string, facts: Partial<AccessFacts>, reasons: Parameters<typeof groupNotBooked>[0][number]["reasons"], attended = false, active = false) => ({
      facts: m(id, facts), name, reasons, attendedThisClass: attended, recentlyActive: active,
    });
    const { groups, total } = groupNotBooked([
      row("1", "Bea", {}, ["tier_not_included"]),
      row("2", "Al", {}, ["tier_not_included"], true, true),
      row("3", "Cy", { membershipTierId: null }, ["tier_not_included"], false, true),
      row("4", "Di", {}, ["roster_not_listed", "tier_not_included"]),
      row("5", "Ed", {}, ["rank_below", "roster_not_listed"]),
    ]);
    expect(total).toBe(5);
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["roster_not_listed", 1], ["plan_not_included", 2], ["no_plan", 1], ["rank_below", 1],
    ]);
    expect(groups[1].members.map((x) => x.name)).toEqual(["Al", "Bea"]);
    expect(groups[1].attendedThisClassCount).toBe(1);
  });
});
