// @vitest-environment jsdom
//
// `RankSystem.color` is free text and BOTH live shapes are real data in the
// same column: RanksManager writes hex literals, while MembersList only ever
// resolved colour WORDS and passed anything else straight through to CSS. The
// belt primitive has to read both, and must not pass an unresolvable value to
// CSS — a string the browser does not recognise paints nothing, which is how a
// belt disappears off a card that has already been laminated.
//
// The RENDER cases below matter more than the helpers. The behaviour this
// primitive exists to fix is the earned-vs-maximum stripe split, which all
// three implementations it replaces got wrong, and it was the one thing with
// no test: someone simplifying the render to paint all `max` stripes solid
// would have every card claim a full set of stripes for every member, and the
// suite would stay green.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { Belt, resolveBeltColour, isUngraded } from "@/components/ui/Belt";

afterEach(cleanup);

function bar(): HTMLElement {
  return document.querySelector("[data-belt-hairline]") as HTMLElement;
}

function marks(kind: "earned" | "slot" | "count") {
  return Array.from(document.querySelectorAll(`[data-belt-stripe="${kind}"]`));
}

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

describe("earned stripes vs the belt maximum", () => {
  it("draws MemberRank.stripes solid and the rest as empty slots", () => {
    render(<Belt rank={{ name: "Blue Belt", color: "blue", stripes: 2, maxStripes: 4 }} />);

    expect(marks("earned")).toHaveLength(2);
    expect(marks("slot")).toHaveLength(2);
  });

  it("draws no solid marks at all for a freshly awarded belt", () => {
    render(<Belt rank={{ name: "White Belt", color: "white", stripes: 0, maxStripes: 4 }} />);

    expect(marks("earned")).toHaveLength(0);
    expect(marks("slot")).toHaveLength(4);
  });

  it("never hides an awarded stripe when the data disagrees with itself", () => {
    // MemberRank says 5, the RankSystem maximum says 3. The awarded count wins:
    // a card must not understate a grade because a rank was edited later.
    render(<Belt rank={{ name: "Blue Belt", color: "blue", stripes: 5, maxStripes: 3 }} />);

    expect(marks("earned")).toHaveLength(5);
    expect(marks("slot")).toHaveLength(0);
  });

  it("names both numbers for a screen reader", () => {
    render(<Belt rank={{ name: "Blue Belt", color: "blue", stripes: 2, maxStripes: 4 }} />);

    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Blue Belt, 2 of 4 stripes");
  });
});

describe("stripe counts beyond a BJJ belt", () => {
  it("still draws every slot for a twelve-stripe curriculum", () => {
    // A kids' or non-BJJ syllabus. The marks shrink to fit the tab; the slot
    // count is not reduced, because a card showing fewer stripes than were
    // awarded is an understated grade printed as fact.
    render(
      <Belt rank={{ name: "Kids Grey", color: "grey", stripes: 7, maxStripes: 12 }} size="lg" />,
    );

    expect(marks("earned")).toHaveLength(7);
    expect(marks("slot")).toHaveLength(5);
    expect(marks("count")).toHaveLength(0);
  });

  it("states the number instead of drawing marks nobody could count", () => {
    // Past the legibility floor the tab prints the fact rather than a row of
    // hairlines — still honest, and impossible to miscount.
    render(<Belt rank={{ name: "Sash", color: "red", stripes: 4, maxStripes: 30 }} size="sm" />);

    expect(marks("earned")).toHaveLength(0);
    expect(marks("slot")).toHaveLength(0);
    expect(marks("count")[0].textContent).toBe("4/30");
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Sash, 4 of 30 stripes");
  });
});

describe("unresolvable colours and hairlines", () => {
  it("falls back to a neutral bar rather than painting nothing", () => {
    render(<Belt rank={{ name: "House Colour", color: "chartreuse-ish", stripes: 1, maxStripes: 2 }} />);

    const belt = document.querySelector("[data-belt-state]") as HTMLElement;
    expect(belt.getAttribute("data-belt-state")).toBe("graded-unknown-colour");
    // Still a belt: the marks are drawn on the neutral fill, not dropped.
    expect(marks("earned")).toHaveLength(1);
    expect(marks("slot")).toHaveLength(1);
  });

  it("gives a white belt a hairline so it does not vanish on a white card", () => {
    render(<Belt rank={{ name: "White Belt", color: "white", stripes: 0, maxStripes: 4 }} />);
    expect(bar().getAttribute("data-belt-hairline")).toBe("on");
  });

  it("gives a black belt a hairline so it does not vanish on the dark shell", () => {
    render(<Belt rank={{ name: "Black Belt", color: "black", stripes: 0, maxStripes: 6 }} />);
    expect(bar().getAttribute("data-belt-hairline")).toBe("on");
  });

  it("does not outline a mid-tone belt that needs no help", () => {
    render(<Belt rank={{ name: "Purple Belt", color: "purple", stripes: 0, maxStripes: 4 }} />);
    expect(bar().getAttribute("data-belt-hairline")).toBe("off");
  });
});
