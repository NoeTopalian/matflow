// Labels the end-user simulation (30 Sep 2026) found saying the wrong thing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { capacityState, capacityLabel, spacesLeftText } from "@/lib/capacity-label";
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

// End-user round 3: "7 booked · 1 spaces left", "Full" for 4 in a class of 3,
// "Full spots", "ALMOST FULL" in capitals.
describe("capacity words", () => {
  it("pluralises places left", () => {
    expect(spacesLeftText(1)).toBe("1 space left");
    expect(spacesLeftText(3)).toBe("3 spaces left");
    expect(spacesLeftText(0)).toBe("0 spaces left");
  });
  it("a class past its capacity says so, with the numbers", () => {
    expect(capacityLabel(3, 4)).toMatchObject({ badge: "Over capacity", tone: "danger", primary: "Over capacity", secondary: "4 of 3" });
    expect(capacityLabel(3, 4)?.short).toBe("Over · 4 of 3");
  });
  it("exactly full reads Full, with the numbers — never 'Full spots'", () => {
    expect(capacityLabel(3, 3)).toMatchObject({ badge: "Full", primary: "Full", secondary: "3 of 3", short: "Full" });
  });
  it("3 of 4 is 'Almost full' in sentence case, 1 space left", () => {
    expect(capacityLabel(4, 3)).toMatchObject({ badge: "Almost full", tone: "warning", primary: "1 space left", secondary: "of 4", short: "1 left" });
  });
  it("an ordinary class has no badge; no capacity gives no label", () => {
    expect(capacityLabel(20, 2)).toMatchObject({ badge: null, tone: "muted", primary: "18 spaces left" });
    expect(capacityLabel(null, 5)).toBeNull();
  });
  it("the dashboard and timetable take their words from the helper", () => {
    const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
    for (const p of ["components/dashboard/WeeklyCalendar.tsx", "components/dashboard/DashboardStats.tsx"]) {
      const src = read(p);
      expect(src).toContain("capacityLabel");
      expect(src).not.toMatch(/ALMOST FULL|spaces left`|"spots left"/);
    }
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
