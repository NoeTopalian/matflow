// Scanner hold rule (lib/scan-holds.ts): one continuous hold sends at most one
// request; after a retryable failure every NEW hold sends a fresh one — the
// third-hold defect was a token kept "seen" after the second failure.
import { describe, it, expect } from "vitest";
import { HoldTracker, HOLD_GAP_MS } from "@/lib/scan-holds";

/** Reads `token` every 250 ms over [from, to), returning how many said submit. */
function holdFor(t: HoldTracker, token: string, from: number, to: number): number {
  let submits = 0;
  for (let now = from; now < to; now += 250) if (t.read(token, now) === "submit") submits++;
  return submits;
}

describe("HoldTracker", () => {
  it("submits a card once however long it is held, before and after a final answer", () => {
    const t = new HoldTracker();
    expect(holdFor(t, "A", 0, 5000)).toBe(1);
    t.settled("A", false);
    expect(holdFor(t, "A", 5000, 10_000)).toBe(0);
    // A settled card stays settled even across a new hold.
    expect(holdFor(t, "A", 20_000, 21_000)).toBe(0);
  });

  it("drops repeat reads while the request is in flight, even across a lift", () => {
    const t = new HoldTracker();
    expect(t.read("A", 0)).toBe("submit");
    expect(holdFor(t, "A", 250, 2000)).toBe(0);
    expect(t.read("A", 5000)).toBe("ignore");
  });

  it("does not resend a card left still under the lens after a retryable failure", () => {
    const t = new HoldTracker();
    expect(t.read("A", 0)).toBe("submit");
    t.settled("A", true);
    expect(holdFor(t, "A", 250, 60_000)).toBe(0);
  });

  it("resends on the first, second and third new hold after retryable failures", () => {
    const t = new HoldTracker();
    let now = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(holdFor(t, "A", now, now + 1000)).toBe(1);
      t.settled("A", true);
      now += 1000 + HOLD_GAP_MS; // lifted away, then held again
    }
  });

  it("a lift shorter than the gap is the same hold", () => {
    const t = new HoldTracker();
    t.read("A", 0);
    t.settled("A", true);
    expect(t.read("A", HOLD_GAP_MS - 1)).toBe("ignore");
    expect(t.read("A", HOLD_GAP_MS - 1 + HOLD_GAP_MS)).toBe("submit");
  });

  it("a new hold begun while the request was in flight resends as soon as the failure lands", () => {
    const t = new HoldTracker();
    t.read("A", 0);
    expect(t.read("A", 3000)).toBe("ignore"); // re-held while pending
    t.settled("A", true);
    expect(t.read("A", 3250)).toBe("submit");
  });

  it("tracks tokens independently", () => {
    const t = new HoldTracker();
    expect(t.read("A", 0)).toBe("submit");
    expect(t.read("B", 0)).toBe("submit");
    t.settled("A", true);
    t.settled("B", false);
    expect(t.read("A", 5000)).toBe("submit");
    expect(t.read("B", 5000)).toBe("ignore");
  });
});
