// A4-xiv: a detector that rejects five times in a row is declared dead; one that
// ever resolves starts the count again. Plan X-5 §2-16 / A4-xiv (Q10-F2).
import { describe, it, expect } from "vitest";
import { nextDetectorState, DETECTOR_FAILURE_LIMIT } from "@/lib/scan-detector";

describe("nextDetectorState", () => {
  it("keeps going for the first four rejections", () => {
    let failures = 0;
    for (let i = 1; i < DETECTOR_FAILURE_LIMIT; i++) {
      const next = nextDetectorState(failures);
      expect(next.kind).toBe("keep-going");
      failures = next.failures;
    }
    expect(failures).toBe(DETECTOR_FAILURE_LIMIT - 1);
  });

  it("declares the detector dead on the fifth consecutive rejection", () => {
    expect(nextDetectorState(DETECTOR_FAILURE_LIMIT - 1)).toEqual({
      kind: "dead",
      failures: DETECTOR_FAILURE_LIMIT,
    });
  });

  it("a reset caller (any resolved detect) needs five more rejections", () => {
    // The caller sets failures back to 0 on a resolved call; from there the
    // fourth rejection is still not dead.
    expect(nextDetectorState(3).kind).toBe("keep-going");
    expect(nextDetectorState(4).kind).toBe("dead");
  });

  it("the limit is five, not the earlier twenty", () => {
    // Twenty was five seconds of a dead camera in front of a customer.
    expect(DETECTOR_FAILURE_LIMIT).toBe(5);
  });
});
