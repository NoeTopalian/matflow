/**
 * teamup-2 (2 Oct 2026): a TeamUp-billed member with no plan MatFlow could
 * state (decision required, plan without tier, scheduled start) is refused on
 * the self/kiosk path with "ask at the desk", never "buy a pack". Same reason
 * code (no_coverage) so the member sheet still treats it as a refusal.
 */
import { describe, it, expect } from "vitest";
import { checkinRefusal, TEAMUP_NO_PLAN_REFUSAL } from "@/lib/checkin-refusal";

describe("no-plan refusal copy for a TeamUp-billed member", () => {
  it("TeamUp-billed → the desk sentence, 402, reason no_coverage", () => {
    const r = checkinRefusal({ kind: "no_coverage", billedBy: "teamup" } as never, { paymentRail: "stripe" });
    expect(r).toEqual({ status: 402, body: { error: TEAMUP_NO_PLAN_REFUSAL, reason: "no_coverage" } });
    expect(TEAMUP_NO_PLAN_REFUSAL).not.toMatch(/buy/i);
  });
  it("MatFlow-billed keeps the rail-dependent sentence", () => {
    expect(checkinRefusal({ kind: "no_coverage", billedBy: "matflow" } as never, { paymentRail: "pay_at_desk" })!.body.error).toBe("No plan yet — ask the desk to add one.");
    expect(checkinRefusal({ kind: "no_coverage" } as never, {})!.body.error).toMatch(/Buy a pack/);
  });
});
