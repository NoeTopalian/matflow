// Labels the end-user simulation (30 Sep 2026) found saying the wrong thing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { capacityState } from "@/lib/capacity-label";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { atRiskMemberWhere } from "@/lib/dashboard-action-items";

describe("capacity label follows places taken", () => {
  it("an empty class of 3 is not 'almost full'", () => {
    expect(capacityState(3, 0)).toEqual({ spotsLeft: 3, full: false, almostFull: false });
  });
  it("an empty class of 4 is not 'almost full'", () => {
    expect(capacityState(4, 0).almostFull).toBe(false);
  });
  it("2 of 3 taken is almost full; 3 of 3 is full", () => {
    expect(capacityState(3, 2)).toEqual({ spotsLeft: 1, full: false, almostFull: true });
    expect(capacityState(3, 3)).toEqual({ spotsLeft: 0, full: true, almostFull: false });
  });
  it("a class of 20 is almost full with 3 left, not with 4", () => {
    expect(capacityState(20, 17).almostFull).toBe(true);
    expect(capacityState(20, 16).almostFull).toBe(false);
  });
  it("over capacity reads full with 0 left; no capacity reads nothing", () => {
    expect(capacityState(4, 5)).toEqual({ spotsLeft: 0, full: true, almostFull: false });
    expect(capacityState(null, 5)).toEqual({ spotsLeft: null, full: false, almostFull: false });
  });
});

describe("check-in window refusal quotes the club's setting", () => {
  it("says 180 when the club set 180", () => {
    const r = checkinRefusal({ kind: "outside_window", when: "before", beforeMin: 30, afterMin: 180 });
    expect(r?.body.error).toBe("Check-in is only available from 30 min before until 180 min after class.");
    expect(r?.body.reason).toBe("outside_window");
  });
  it("falls back to 30/30 when the result carries no window", () => {
    const r = checkinRefusal({ kind: "outside_window", when: "after" });
    expect(r?.body.error).toBe("Check-in is only available from 30 min before until 30 min after class.");
  });
});

describe("'Not seen in 14+ days' excludes members who joined inside the window", () => {
  it("requires an earlier join or some attendance history", () => {
    const now = new Date("2026-09-30T09:00:00.000Z");
    const where = atRiskMemberWhere("t1", now);
    expect(where.tenantId).toBe("t1");
    expect(where.status).toBe("active");
    const since = where.attendances.none.checkInTime.gte;
    expect(now.getTime() - since.getTime()).toBeGreaterThanOrEqual(13.9 * 86_400_000);
    expect(where.OR).toEqual([{ joinedAt: { lt: since } }, { attendances: { some: {} } }]);
  });
});

describe("owner wizard: 'Finish setup' only on the last step", () => {
  it("appears once, in the step 9 block", () => {
    const src = readFileSync(path.join(process.cwd(), "components/onboarding/OwnerOnboardingWizard.tsx"), "utf8");
    const hits = [...src.matchAll(/"Finish setup →"/g)].map((m) => m.index!);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBeGreaterThan(src.indexOf("Step 9 of {TOTAL_STEPS}"));
    expect(src).not.toMatch(/>One last thing</);
  });
});

describe("'Waiver missing' has one definition: active or taster, unsigned", () => {
  it("counts active and taster, never inactive or cancelled", async () => {
    const { isWaiverMissing } = await import("@/components/dashboard/MembersList");
    expect(isWaiverMissing({ status: "active", waiverAccepted: false })).toBe(true);
    expect(isWaiverMissing({ status: "taster", waiverAccepted: false })).toBe(true);
    expect(isWaiverMissing({ status: "inactive", waiverAccepted: false })).toBe(false);
    expect(isWaiverMissing({ status: "cancelled", waiverAccepted: false })).toBe(false);
    expect(isWaiverMissing({ status: "active", waiverAccepted: true })).toBe(false);
  });
  it("the dashboard count uses the same statuses", () => {
    const src = readFileSync(path.join(process.cwd(), "app/dashboard/page.tsx"), "utf8");
    expect(src).toMatch(/status: \{ in: \["active", "taster"\] \}, waiverAccepted: false/);
  });
});
