// T6a: the one rule every surface (engine, booking, schedule, register) uses.
// 20 Oct 2026: the roster no longer decides on its own; the tier list is
// judged for every class, rostered or not, and there is no staff ask.
import { describe, it, expect } from "vitest";
import * as gate from "@/lib/class-tier-gate";
import { classTierCovers, tierRefusalSentence, ROSTER_REFUSAL_SENTENCE } from "@/lib/class-tier-gate";

describe("classTierCovers", () => {
  it("no tiers selected = open to everyone, with or without a plan", () => {
    expect(classTierCovers({ allowedTierIds: [], memberTierId: null })).toBe(true);
    expect(classTierCovers({ allowedTierIds: [], memberTierId: "t-1" })).toBe(true);
  });

  it("tiers selected admit only those tiers", () => {
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: "t-adv" })).toBe(true);
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: "t-beg" })).toBe(false);
  });

  it("a member with no tier is not covered by a restricted class", () => {
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: null })).toBe(false);
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: undefined })).toBe(false);
  });

  it("a roster no longer short-circuits the tier list: a rostered class is judged on its tiers too", () => {
    // The old input carried `hasRoster`; passing it must not change the answer.
    const withRoster = { allowedTierIds: ["t-adv"], memberTierId: "t-beg", hasRoster: true } as Parameters<typeof classTierCovers>[0];
    expect(classTierCovers(withRoster)).toBe(false);
  });
});

describe("no staff override vocabulary is left", () => {
  it("exports no ask sentence, override reason or gate mode", () => {
    expect(gate).not.toHaveProperty("tierAskSentence");
    expect(gate).not.toHaveProperty("TIER_OVERRIDE_REASON");
  });
});

describe("sentences", () => {
  it("name the class and the plan", () => {
    expect(tierRefusalSentence("Advanced", "Beginners Unlimited")).toBe(
      "Advanced isn't included in your Beginners Unlimited membership. For further information, please speak to a coach.",
    );
  });

  it("say plainly when there is no plan", () => {
    expect(tierRefusalSentence("Advanced", null)).toBe(
      "Advanced is only open to certain memberships, and you don't have a membership plan set yet. For further information, please speak to a coach.",
    );
  });

  it("the roster sentence ends with the owner's coach sentence", () => {
    expect(ROSTER_REFUSAL_SENTENCE).toBe("You're not on the roster for this class. For further information, please speak to a coach.");
  });

  // Owner's wording (27 Oct 2026): a member turned away is told to speak to a coach.
  it("the kiosk's empty squad search ends with the coach sentence", () => {
    expect(gate.SQUAD_NO_MATCH_SENTENCE).toBe(
      "No one on the squad list matches that name. Only members on the squad list can check in to this class. For further information, please speak to a coach.",
    );
  });
});
