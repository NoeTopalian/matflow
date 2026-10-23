import { describe, it, expect } from "vitest";
import { percent, ratePct1dp, wholePct } from "@/lib/percent";

describe("half-up percentage rounding is robust to float noise (review L6)", () => {
  it("whole percentages: exact .5 rounds up", () => {
    expect(percent(1, 8)).toBe(13); // 12.5
    expect(percent(29, 200)).toBe(15); // 14.5, was 14 through float noise
    expect(percent(0, 0)).toBe(0);
    expect(wholePct(29, 200)).toBe(15);
    expect(wholePct(1, 0)).toBeNull();
  });

  it("one decimal: exact .05 steps round up", () => {
    expect(ratePct1dp(1, 8)).toBe(12.5);
    expect(ratePct1dp(1, 313)).toBe(0.3);
    expect(ratePct1dp(1, 0)).toBeNull();
    // 0.125% -> 0.1 would be wrong half-down; 1 of 800 = 0.125 -> 0.1 (2dp tie not reached), 3 of 800 = 0.375 -> 0.4
    expect(ratePct1dp(3, 800)).toBe(0.4);
    // 1 of 2000 = 0.05% is a tie at one decimal -> rounds up to 0.1
    expect(ratePct1dp(1, 2000)).toBe(0.1);
  });
});
