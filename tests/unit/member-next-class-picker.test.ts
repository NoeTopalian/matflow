// The member home "NEXT CLASS" card. End-user simulation, 30 Sep 2026: at
// 10:00 on a Wednesday with a 10:30 adult class still to come, Home said
// "NEXT CLASS Kids BJJ Sat 3 Oct". The query was `date >= now`, and an
// instance's `date` is the day's midnight marker, so every class later that
// day had already been dropped. pickNextClass takes today's later classes and
// applies the Schedule tab's roster and rank rules.
import { describe, it, expect } from "vitest";
import { pickNextClass, type NextClassCandidate } from "@/lib/member-stats";

function inst(
  id: string,
  dayIso: string,
  startTime: string,
  over: Partial<NextClassCandidate["class"]> = {},
): NextClassCandidate {
  return {
    id,
    date: new Date(`${dayIso}T00:00:00.000Z`),
    startTime,
    endTime: "23:00",
    class: {
      id: `c-${id}`,
      name: id,
      coachName: null,
      coachUser: null,
      location: null,
      requiredRank: null,
      maxRank: null,
      rosterMembers: [],
      _count: { rosterMembers: 0 },
      tenant: { timezone: "Europe/London" },
      ...over,
    },
  };
}

// Wed 30 Sep 2026, 10:00 London (BST) = 09:00Z.
const NOW = new Date("2026-09-30T09:00:00.000Z");

describe("pickNextClass", () => {
  it("offers a class later today rather than jumping to Saturday", () => {
    const picked = pickNextClass(
      [inst("Kids BJJ Wed", "2026-09-30", "10:00"), inst("Adult BJJ Wed", "2026-09-30", "10:30"), inst("Kids BJJ Sat", "2026-10-03", "10:00")],
      [],
      new Date("2026-09-30T09:05:00.000Z"),
    );
    expect(picked?.id).toBe("Adult BJJ Wed");
  });

  it("skips a class that has already started", () => {
    const picked = pickNextClass([inst("Early", "2026-09-30", "09:30"), inst("Later", "2026-09-30", "18:00")], [], NOW);
    expect(picked?.id).toBe("Later");
  });

  it("skips a roster-only class the member is not on, keeps one they are on", () => {
    const hidden = inst("Comp team", "2026-09-30", "11:00", { _count: { rosterMembers: 4 } });
    const mine = inst("My squad", "2026-09-30", "12:00", { _count: { rosterMembers: 4 }, rosterMembers: [{ id: "r1" }] });
    expect(pickNextClass([hidden, mine], [], NOW)?.id).toBe("My squad");
  });

  it("skips a class above or below the member's rank", () => {
    const ranks = [{ rankSystem: { discipline: "BJJ", order: 1 } }];
    const tooHigh = inst("Advanced", "2026-09-30", "11:00", { requiredRank: { discipline: "BJJ", order: 3 } });
    const tooLow = inst("Fundamentals", "2026-09-30", "11:30", { maxRank: { discipline: "BJJ", order: 0 } });
    const ok = inst("All levels", "2026-09-30", "12:00");
    expect(pickNextClass([tooHigh, tooLow, ok], ranks, NOW)?.id).toBe("All levels");
  });

  it("returns null when nothing ahead is eligible", () => {
    expect(pickNextClass([inst("Gone", "2026-09-30", "08:00")], [], NOW)).toBeNull();
  });
});
