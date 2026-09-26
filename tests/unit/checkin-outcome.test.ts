/**
 * F-6 (customer simulation, 26 Sep 2026): the member sheet said "signed in!"
 * on a 409 "This class is full — 3 of 2 places are taken". These pin the one
 * decision every door now makes: success only for a committed record or the
 * server's own already-checked-in reason; every other answer is shown as the
 * refusal it is, in the server's words.
 */
import { describe, it, expect } from "vitest";
import { classifyCheckinResponse } from "@/lib/checkin-outcome";
import { checkinRefusal } from "@/lib/checkin-refusal";

describe("classifyCheckinResponse", () => {
  it("a 2xx is a recorded check-in", () => {
    expect(classifyCheckinResponse(201, { success: true })).toEqual({ kind: "recorded" });
  });

  it("a full class is a refusal in the server's words, never a success (F-6)", () => {
    const body = { error: "This class is full — 3 of 2 places are taken. Ask staff if there is room.", reason: "class_full" };
    const out = classifyCheckinResponse(409, body);
    expect(out.kind).toBe("refused");
    expect(out).toMatchObject({ message: body.error, reason: "class_full" });
  });

  it("outside the window and a cancelled class are refusals too", () => {
    expect(classifyCheckinResponse(409, { error: "Check-in is only available from 30 min before until 30 min after class.", reason: "outside_window" }).kind).toBe("refused");
    expect(classifyCheckinResponse(409, { error: "Class has been cancelled", reason: "class_cancelled" }).kind).toBe("refused");
  });

  it("only the server's own already_checked_in reason counts as already done", () => {
    expect(classifyCheckinResponse(409, { error: "Already checked in", reason: "already_checked_in" }).kind).toBe("already_checked_in");
    // A 409 that merely mentions the words is not trusted: the decision is on the reason.
    expect(classifyCheckinResponse(409, { error: "Already checked in" }).kind).toBe("refused");
  });

  it("a 401 says the session is gone; status 0 says the network is", () => {
    expect(classifyCheckinResponse(401, { error: "Unauthorized" }).kind).toBe("signed_out");
    expect(classifyCheckinResponse(0, null).kind).toBe("unreachable");
  });

  it("a refusal with no sentence still gets one", () => {
    const out = classifyCheckinResponse(403, {});
    expect(out.kind).toBe("refused");
    expect(out).toMatchObject({ message: expect.stringMatching(/try again|ask staff/i) });
  });
});

describe("checkinRefusal", () => {
  it("every refusal carries a machine reason and a customer sentence", () => {
    const cases = [
      { kind: "class_full", taken: 3, maxCapacity: 2 },
      { kind: "duplicate" },
      { kind: "outside_window", when: "after" },
      { kind: "class_cancelled" },
      { kind: "no_coverage" },
      { kind: "waiver_unsigned" },
      { kind: "on_hold", holdUntil: new Date("2026-10-10T00:00:00Z") },
      { kind: "on_hold", holdUntil: null },
      { kind: "venue_not_covered", classVenue: "Riverside", tierVenue: "Town" },
      { kind: "rank_below" },
      { kind: "rank_above" },
      { kind: "roster_not_listed" },
      { kind: "class_not_found" },
      { kind: "member_not_found" },
    ] as const;
    for (const c of cases) {
      const r = checkinRefusal(c as never);
      expect(r, c.kind).not.toBeNull();
      expect(r!.body.reason, c.kind).toBeTruthy();
      expect(r!.body.error.length, c.kind).toBeGreaterThan(10);
    }
  });

  it("the full-class sentence carries the numbers; the hold sentence the date", () => {
    expect(checkinRefusal({ kind: "class_full", taken: 3, maxCapacity: 2 })!.body).toMatchObject({
      error: expect.stringContaining("3 of 2 places"),
      reason: "class_full",
    });
    expect(checkinRefusal({ kind: "on_hold", holdUntil: new Date("2026-10-10T00:00:00Z") })!.body.error).toContain("10 Oct 2026");
  });

  it("duplicate maps to already_checked_in at 409; success and error are not refusals", () => {
    expect(checkinRefusal({ kind: "duplicate" })).toEqual({ status: 409, body: { error: "Already checked in", reason: "already_checked_in" } });
    expect(checkinRefusal({ kind: "error", error: new Error("x") })).toBeNull();
  });
});
