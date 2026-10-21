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
      "Advanced isn't included in your Beginners Unlimited membership. Ask staff about a membership that includes it.",
    );
  });

  it("say plainly when there is no plan", () => {
    expect(tierRefusalSentence("Advanced", null)).toMatch(/don't have a membership plan set yet/);
  });

  it("the roster sentence is the one the check-in has always sent", () => {
    expect(ROSTER_REFUSAL_SENTENCE).toBe("You're not on the roster for this class.");
  });
});
