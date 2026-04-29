import { describe, it, expect } from "vitest";
import { resolveCoachName, resolveCoach } from "@/lib/class-coach";

// ── Sprint 4-A US-402: maxRank gating semantics ────────────────────────────────
//
// Pure-function tests for the rank ordering logic enforced in /api/checkin.
// memberOrder vs requiredRank.order vs maxRank.order:
//   - requiredRank: member must have a rank; member.order >= required.order
//   - maxRank:      if member has a rank, member.order <= max.order
//   - unranked:     allowed under maxRank, rejected under requiredRank

function isAllowed(args: {
  memberOrder: number | null;
  requiredOrder: number | null;
  maxOrder: number | null;
}): { allowed: boolean; reason?: "below_required" | "above_max" } {
  const { memberOrder, requiredOrder, maxOrder } = args;
  if (requiredOrder !== null) {
    if (memberOrder === null || memberOrder < requiredOrder) {
      return { allowed: false, reason: "below_required" };
    }
  }
  if (maxOrder !== null && memberOrder !== null && memberOrder > maxOrder) {
    return { allowed: false, reason: "above_max" };
  }
  return { allowed: true };
}

describe("Sprint 4-A US-402: rank gating semantics", () => {
  it("allows when no rank constraints are set", () => {
    expect(isAllowed({ memberOrder: 5, requiredOrder: null, maxOrder: null })).toEqual({ allowed: true });
    expect(isAllowed({ memberOrder: null, requiredOrder: null, maxOrder: null })).toEqual({ allowed: true });
  });

  it("rejects unranked member against requiredRank", () => {
    expect(isAllowed({ memberOrder: null, requiredOrder: 2, maxOrder: null })).toEqual({
      allowed: false, reason: "below_required",
    });
  });

  it("allows unranked member against maxRank only", () => {
    expect(isAllowed({ memberOrder: null, requiredOrder: null, maxOrder: 2 })).toEqual({ allowed: true });
  });

  it("rejects when member rank above maxRank", () => {
    expect(isAllowed({ memberOrder: 3, requiredOrder: null, maxOrder: 2 })).toEqual({
      allowed: false, reason: "above_max",
    });
  });

  it("allows when member rank equals maxRank (boundary)", () => {
    expect(isAllowed({ memberOrder: 2, requiredOrder: null, maxOrder: 2 })).toEqual({ allowed: true });
  });

  it("allows when member rank between required and max", () => {
    expect(isAllowed({ memberOrder: 2, requiredOrder: 1, maxOrder: 3 })).toEqual({ allowed: true });
  });
});

// ── Sprint 4-A US-403: coach resolution ────────────────────────────────────────

describe("Sprint 4-A US-403: resolveCoach helper", () => {
  it("prefers FK coach over coachName string", () => {
    expect(resolveCoach({ coachName: "Old Name", coachUser: { id: "u1", name: "Coach FK" } }))
      .toEqual({ id: "u1", name: "Coach FK" });
    expect(resolveCoachName({ coachName: "Old Name", coachUser: { id: "u1", name: "Coach FK" } }))
      .toBe("Coach FK");
  });

  it("falls back to coachName when coachUser is null", () => {
    expect(resolveCoach({ coachName: "Coach String", coachUser: null }))
      .toEqual({ id: null, name: "Coach String" });
    expect(resolveCoachName({ coachName: "Coach String", coachUser: null }))
      .toBe("Coach String");
  });

  it("trims coachName whitespace", () => {
    expect(resolveCoachName({ coachName: "  Trimmed  " })).toBe("Trimmed");
  });

  it("returns null when both sources empty", () => {
    expect(resolveCoach({ coachName: null })).toEqual({ id: null, name: null });
    expect(resolveCoach({ coachName: "" })).toEqual({ id: null, name: null });
    expect(resolveCoach({ coachName: "   " })).toEqual({ id: null, name: null });
    expect(resolveCoachName({ coachName: null })).toBeNull();
  });
});
