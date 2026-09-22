import { describe, it, expect } from "vitest";
import {
  resolveSignupCredit,
  initialCreditType,
  type SignupCreditType,
} from "@/lib/signup-credit";

// Attribution (M1) capture — the polymorphic sign-up credit is a DB-enforced
// XOR: at most ONE of creditedToUserId / creditedToMemberId / creditedToLabel
// may be set. The form's whole job is to never send more than one, so the
// resolver is where that guarantee lives and where it must be pinned.

describe("resolveSignupCredit — mutual exclusion", () => {
  it("staff sets ONLY creditedToUserId and nulls the other two", () => {
    const r = resolveSignupCredit({
      creditType: "staff",
      creditedToUserId: "u1",
      // Stale values from a previous type selection must be discarded, not leaked.
      creditedToMemberId: "m9",
      creditedToLabel: "Instagram ad",
    });
    expect(r).toEqual({ creditedToUserId: "u1", creditedToMemberId: null, creditedToLabel: null });
  });

  it("member sets ONLY creditedToMemberId and nulls the other two", () => {
    const r = resolveSignupCredit({
      creditType: "member",
      creditedToUserId: "u1",
      creditedToMemberId: "m2",
      creditedToLabel: "walk-in",
    });
    expect(r).toEqual({ creditedToUserId: null, creditedToMemberId: "m2", creditedToLabel: null });
  });

  it("other sets ONLY creditedToLabel and nulls the other two", () => {
    const r = resolveSignupCredit({
      creditType: "other",
      creditedToUserId: "u1",
      creditedToMemberId: "m2",
      creditedToLabel: "Instagram ad",
    });
    expect(r).toEqual({ creditedToUserId: null, creditedToMemberId: null, creditedToLabel: "Instagram ad" });
  });

  it("none nulls everything", () => {
    const r = resolveSignupCredit({
      creditType: "none",
      creditedToUserId: "u1",
      creditedToMemberId: "m2",
      creditedToLabel: "x",
    });
    expect(r).toEqual({ creditedToUserId: null, creditedToMemberId: null, creditedToLabel: null });
  });

  it("treats empty/whitespace as cleared and trims real values", () => {
    expect(resolveSignupCredit({ creditType: "other", creditedToLabel: "   " })).toEqual({
      creditedToUserId: null,
      creditedToMemberId: null,
      creditedToLabel: null,
    });
    expect(resolveSignupCredit({ creditType: "other", creditedToLabel: "  Facebook  " }).creditedToLabel).toBe(
      "Facebook",
    );
    expect(resolveSignupCredit({ creditType: "staff", creditedToUserId: "" }).creditedToUserId).toBeNull();
  });

  it("never returns two non-null targets for any type", () => {
    const types: SignupCreditType[] = ["none", "staff", "member", "other"];
    for (const creditType of types) {
      const r = resolveSignupCredit({
        creditType,
        creditedToUserId: "u1",
        creditedToMemberId: "m2",
        creditedToLabel: "lbl",
      });
      const setCount = [r.creditedToUserId, r.creditedToMemberId, r.creditedToLabel].filter(
        (v) => v !== null,
      ).length;
      expect(setCount).toBeLessThanOrEqual(1);
    }
  });
});

describe("initialCreditType — opens the edit form on the stored target", () => {
  it("maps each stored value to its type, staff first", () => {
    expect(initialCreditType({ creditedToUserId: "u1" })).toBe("staff");
    expect(initialCreditType({ creditedToMemberId: "m2" })).toBe("member");
    expect(initialCreditType({ creditedToLabel: "Instagram ad" })).toBe("other");
    expect(initialCreditType({})).toBe("none");
  });

  it("prefers the staff target when a corrupt row carries more than one", () => {
    expect(initialCreditType({ creditedToUserId: "u1", creditedToMemberId: "m2" })).toBe("staff");
    expect(initialCreditType({ creditedToMemberId: "m2", creditedToLabel: "x" })).toBe("member");
  });
});
