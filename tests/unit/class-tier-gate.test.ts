// T6a: the one rule every surface (engine, booking, schedule, register) uses.
import { describe, it, expect } from "vitest";
import { classTierCovers, tierRefusalSentence, tierAskSentence } from "@/lib/class-tier-gate";

describe("classTierCovers", () => {
  it("no tiers selected = open to everyone, with or without a plan", () => {
    expect(classTierCovers({ allowedTierIds: [], memberTierId: null, hasRoster: false })).toBe(true);
    expect(classTierCovers({ allowedTierIds: [], memberTierId: "t-1", hasRoster: false })).toBe(true);
  });

  it("tiers selected admit only those tiers", () => {
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: "t-adv", hasRoster: false })).toBe(true);
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: "t-beg", hasRoster: false })).toBe(false);
  });

  it("a member with no tier is not covered by a restricted class", () => {
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: null, hasRoster: false })).toBe(false);
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: undefined, hasRoster: false })).toBe(false);
  });

  it("a class with a roster is governed by the roster, not the tiers", () => {
    expect(classTierCovers({ allowedTierIds: ["t-adv"], memberTierId: "t-beg", hasRoster: true })).toBe(true);
  });
});

describe("sentences", () => {
  it("name the class and the plan", () => {
    expect(tierRefusalSentence("Advanced", "Beginners Unlimited")).toBe(
      "Advanced isn't included in your Beginners Unlimited membership. Ask staff about a membership that includes it.",
    );
    expect(tierAskSentence("Ava", "Advanced", "Beginners Unlimited")).toBe(
      "Advanced isn't included in Ava's Beginners Unlimited membership. Admit anyway?",
    );
  });

  it("say plainly when there is no plan", () => {
    expect(tierRefusalSentence("Advanced", null)).toMatch(/don't have a membership plan set yet/);
    expect(tierAskSentence("Ava", "Advanced", null)).toMatch(/Ava has no membership plan set\. Admit anyway\?$/);
  });
});
