// T6a, acceptance 5: the member sees a class their plan does not include as
// locked ("Not included in your membership"), never as their next class, and
// cannot book it. Schedule (buildMemberSchedule / /api/member/schedule) and
// Home's next class (pickNextClass) apply the same rule as the door.
import { describe, it, expect, vi } from "vitest";
import { pickNextClass, type NextClassCandidate } from "@/lib/member-stats";
import { buildMemberSchedule } from "@/lib/member-home";

function inst(id: string, startTime: string, over: Partial<NextClassCandidate["class"]> = {}): NextClassCandidate {
  return {
    id,
    date: new Date("2026-10-19T00:00:00.000Z"),
    startTime,
    endTime: "23:00",
    class: {
      id: `c-${id}`, name: id, coachName: null, coachUser: null, location: null,
      requiredRank: null, maxRank: null, rosterMembers: [], _count: { rosterMembers: 0 },
      tenant: { timezone: "Europe/London" },
      ...over,
    },
  };
}
const NOW = new Date("2026-10-19T08:00:00.000Z");

describe("pickNextClass — tier", () => {
  it("skips a class the member's plan does not include", () => {
    const picked = pickNextClass(
      [inst("Advanced", "10:00", { allowedTiers: [{ tierId: "t-adv" }] }), inst("Fundamentals", "12:00")],
      [], NOW, { memberTierId: "t-beg" },
    );
    expect(picked?.id).toBe("Fundamentals");
  });

  it("offers it to a member on an included plan, and to everyone when the class has no tiers", () => {
    expect(pickNextClass([inst("Advanced", "10:00", { allowedTiers: [{ tierId: "t-adv" }] })], [], NOW, { memberTierId: "t-adv" })?.id).toBe("Advanced");
    expect(pickNextClass([inst("Open", "10:00", { allowedTiers: [] })], [], NOW, { memberTierId: null })?.id).toBe("Open");
  });

  it("a rostered member on a plan the roster class excludes is NOT offered it (both must hold, 20 Oct 2026)", () => {
    const picked = pickNextClass(
      [inst("Comp", "10:00", { allowedTiers: [{ tierId: "t-adv" }], rosterMembers: [{ id: "r1" }], _count: { rosterMembers: 3 } })],
      [], NOW, { memberTierId: "t-beg" },
    );
    expect(picked).toBeNull();
  });

  it("a rostered member on an included plan is offered their roster class", () => {
    const picked = pickNextClass(
      [inst("Comp", "10:00", { allowedTiers: [{ tierId: "t-adv" }], rosterMembers: [{ id: "r1" }], _count: { rosterMembers: 3 } })],
      [], NOW, { memberTierId: "t-adv" },
    );
    expect(picked?.id).toBe("Comp");
  });

  it("a caller that does not pass a tier is unchanged", () => {
    expect(pickNextClass([inst("Advanced", "10:00", { allowedTiers: [{ tierId: "t-adv" }] })], [], NOW)?.id).toBe("Advanced");
  });
});

describe("buildMemberSchedule — tier", () => {
  /** `rosteredOn`: the member is on Advanced's roster (and Advanced has one). */
  function tx(memberTierId: string | null, rosteredOn = false) {
    const cls = (id: string, tierIds: string[]) => ({
      id, name: id, color: null, coachName: null, coachUser: null, location: null, maxCapacity: null, isKids: false,
      requiredRank: null, maxRank: null,
      schedules: [{ id: `s-${id}`, dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }],
      allowedTiers: tierIds.map((tierId) => ({ tierId })),
    });
    return {
      class: { findMany: vi.fn(async () => [cls("Advanced", ["t-adv"]), cls("Fundamentals", [])]) },
      classInstance: { findMany: vi.fn(async () => []) },
      memberRank: { findMany: vi.fn(async () => []) },
      classRoster: {
        findMany: vi.fn(async () => (rosteredOn ? [{ classId: "Advanced" }] : [])),
        groupBy: vi.fn(async () => (rosteredOn ? [{ classId: "Advanced", _count: { _all: 3 } }] : [])),
      },
      member: { findFirst: vi.fn(async () => ({ membershipTierId: memberTierId })) },
    };
  }

  it("a rostered member on an excluded plan sees the squad class locked; on an included plan, roster_ok", async () => {
    expect((await buildMemberSchedule(tx("t-beg", true) as never, { tenantId: "t1", memberId: "m1", dateParam: null }))
      .find((r) => r.name === "Advanced")?.eligibility).toBe("tier_not_included");
    expect((await buildMemberSchedule(tx("t-adv", true) as never, { tenantId: "t1", memberId: "m1", dateParam: null }))
      .find((r) => r.name === "Advanced")?.eligibility).toBe("roster_ok");
  });

  it("marks a class outside the member's plan tier_not_included and leaves the rest ok", async () => {
    const rows = await buildMemberSchedule(tx("t-beg") as never, { tenantId: "t1", memberId: "m1", dateParam: null });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.eligibility]));
    expect(byName).toEqual({ Advanced: "tier_not_included", Fundamentals: "ok" });
  });

  it("a member on the included plan sees it as ok; a member with no plan sees it locked", async () => {
    expect((await buildMemberSchedule(tx("t-adv") as never, { tenantId: "t1", memberId: "m1", dateParam: null }))
      .find((r) => r.name === "Advanced")?.eligibility).toBe("ok");
    expect((await buildMemberSchedule(tx(null) as never, { tenantId: "t1", memberId: "m1", dateParam: null }))
      .find((r) => r.name === "Advanced")?.eligibility).toBe("tier_not_included");
  });
});
