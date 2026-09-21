import { describe, it, expect } from "vitest";
import {
  computeConversionRate,
  buildStaffConversionRows,
  MIN_TRIALS_FOR_RATE,
} from "@/lib/attribution";

// The conversion math carries the three honesty guards: min-N (no rate under a
// few trials), the feature epoch (owned by the caller — tested via the query's
// contract, not here), and import exclusion (import events never enter the
// converted set the builder receives).

describe("computeConversionRate — min-N guard", () => {
  it("returns null below the trials threshold", () => {
    expect(MIN_TRIALS_FOR_RATE).toBe(3);
    expect(computeConversionRate(0, 0)).toBeNull();
    expect(computeConversionRate(2, 2)).toBeNull(); // even a perfect 2/2 is too few
  });

  it("computes a one-decimal percentage at or above the threshold", () => {
    expect(computeConversionRate(3, 3)).toBe(100);
    expect(computeConversionRate(4, 1)).toBe(25);
    expect(computeConversionRate(3, 1)).toBe(33.3); // rounded to one decimal
    expect(computeConversionRate(10, 0)).toBe(0);
  });
});

describe("buildStaffConversionRows", () => {
  const staff = [
    { id: "u1", name: "Alice" },
    { id: "u2", name: "Bob" },
    { id: "u3", name: "Never" },
  ];

  it("counts trials, sign-ups and conversions per coach", () => {
    const rows = buildStaffConversionRows({
      staff,
      trialMembers: [
        { id: "m1", trialRunById: "u1" },
        { id: "m2", trialRunById: "u1" },
        { id: "m3", trialRunById: "u1" },
        { id: "m4", trialRunById: "u2" },
      ],
      signUpMembers: [
        { creditedToUserId: "u1" },
        { creditedToUserId: "u2" },
        { creditedToUserId: "u2" },
      ],
      // m1 and m2 reached active; m3 did not. m4 (Bob's) did not.
      convertedMemberIds: new Set(["m1", "m2"]),
    });

    const alice = rows.find((r) => r.userId === "u1")!;
    expect(alice.trialsRun).toBe(3);
    expect(alice.conversions).toBe(2);
    expect(alice.signUps).toBe(1);
    expect(alice.conversionRate).toBe(66.7); // 2/3

    const bob = rows.find((r) => r.userId === "u2")!;
    expect(bob.trialsRun).toBe(1);
    expect(bob.conversions).toBe(0);
    expect(bob.signUps).toBe(2);
    expect(bob.conversionRate).toBeNull(); // 1 trial → too few
  });

  it("omits staff with no trials and no sign-ups", () => {
    const rows = buildStaffConversionRows({
      staff,
      trialMembers: [{ id: "m1", trialRunById: "u1" }],
      signUpMembers: [],
      convertedMemberIds: new Set(),
    });
    expect(rows.map((r) => r.userId)).toEqual(["u1"]);
    expect(rows.some((r) => r.userId === "u3")).toBe(false);
  });

  it("only credits a conversion when the converted member is that coach's trial", () => {
    // m9 reached active but was nobody's trial — it must not inflate any coach.
    const rows = buildStaffConversionRows({
      staff,
      trialMembers: [
        { id: "m1", trialRunById: "u1" },
        { id: "m2", trialRunById: "u1" },
        { id: "m3", trialRunById: "u1" },
      ],
      signUpMembers: [],
      convertedMemberIds: new Set(["m1", "m9"]),
    });
    const alice = rows.find((r) => r.userId === "u1")!;
    expect(alice.trialsRun).toBe(3);
    expect(alice.conversions).toBe(1); // m9 ignored
    expect(alice.conversionRate).toBe(33.3);
  });

  it("sorts by trials run, then sign-ups, then name", () => {
    const rows = buildStaffConversionRows({
      staff: [
        { id: "u1", name: "Alice" },
        { id: "u2", name: "Bob" },
      ],
      trialMembers: [
        { id: "m1", trialRunById: "u2" },
        { id: "m2", trialRunById: "u2" },
        { id: "m3", trialRunById: "u1" },
      ],
      signUpMembers: [],
      convertedMemberIds: new Set(),
    });
    // Bob has 2 trials, Alice 1 → Bob first.
    expect(rows.map((r) => r.name)).toEqual(["Bob", "Alice"]);
  });
});
