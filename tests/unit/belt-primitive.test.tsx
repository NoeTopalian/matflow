// `RankSystem.color` is free text and BOTH live shapes are real data in the
// same column: RanksManager writes hex literals, while MembersList only ever
// resolved colour WORDS and passed anything else straight through to CSS. The
// belt primitive has to read both, and must not pass an unresolvable value to
// CSS — a string the browser does not recognise paints nothing, which is how a
// belt disappears off a card that has already been laminated.

import { describe, it, expect } from "vitest";
import { resolveBeltColour, isUngraded } from "@/components/ui/Belt";

describe("resolveBeltColour", () => {
  it("resolves the colour WORDS the members list wrote", () => {
    expect(resolveBeltColour("blue")).toBe("#3b82f6");
    expect(resolveBeltColour("Purple")).toBe("#8b5cf6");
    expect(resolveBeltColour("  BROWN  ")).toBe("#92400e");
  });

  it("resolves the hex literals the ranks manager writes", () => {
    expect(resolveBeltColour("#92400e")).toBe("#92400e");
    expect(resolveBeltColour("#8B5CF6")).toBe("#8b5cf6");
    expect(resolveBeltColour("111111")).toBe("#111111");
    expect(resolveBeltColour("#abc")).toBe("#aabbcc");
  });

  it("returns null rather than passing an unresolvable value to CSS", () => {
    expect(resolveBeltColour(null)).toBeNull();
    expect(resolveBeltColour(undefined)).toBeNull();
    expect(resolveBeltColour("")).toBeNull();
    expect(resolveBeltColour("   ")).toBeNull();
    expect(resolveBeltColour("chartreuse-ish")).toBeNull();
    expect(resolveBeltColour("#12345")).toBeNull();
  });
});

describe("isUngraded", () => {
  it("treats a missing rank as ungraded", () => {
    expect(isUngraded(null)).toBe(true);
    expect(isUngraded(undefined)).toBe(true);
    expect(isUngraded({ name: "   " })).toBe(true);
  });

  it("does not treat a white belt as ungraded", () => {
    expect(isUngraded({ name: "White Belt", color: "white", stripes: 0 })).toBe(false);
  });
});
