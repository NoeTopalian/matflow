import { describe, it, expect } from "vitest";
import { classStatus } from "@/lib/class-time";

// `classStatus` now takes the club's timezone, because a class at "14:00" means
// 14:00 AT THE GYM and resolving that without a zone is what made the check-in
// window an hour out through British Summer Time (see class-time-timezone.test.ts).
//
// These cases are unchanged in intent. What changed is that they no longer
// depend on the zone of the machine running them: `now` is stated as an explicit
// UTC instant rather than a bare local-time string, so the suite gives the same
// answer on a laptop in Bali as on a UTC runner. The old version would have
// quietly produced different results on each.
//
// 27 April 2026 is inside BST (29 Mar – 25 Oct), so a 14:00–15:00 London class
// runs 13:00–14:00 UTC. Every instant below is derived from that.

const DATE = "2026-04-27";
const ZONE = "Europe/London";

/** A `ClassInstance.date` as Prisma round-trips it: a UTC wall clock. */
function makeInst(startTime: string, endTime: string) {
  return { startTime, endTime, date: new Date(`${DATE}T00:00:00.000Z`) };
}

/** A 14:00–15:00 London class is 13:00–14:00 UTC on this date. */
const START_UTC = `${DATE}T13:00:00.000Z`;
const END_UTC = `${DATE}T14:00:00.000Z`;

describe("classStatus", () => {
  it("returns future with 'Starts at HH:mm' label when 90 min before start", () => {
    const result = classStatus(makeInst("14:00", "15:00"), ZONE, new Date(`${DATE}T11:30:00.000Z`));
    expect(result.variant).toBe("future");
    expect(result.label).toMatch(/^Starts at /);
    // The label is the club's local time, not the server's.
    expect(result.label).toMatch(/2:00\s?PM/);
  });

  it("returns soon with 'Starts in 30 min' when 30 min before start", () => {
    const result = classStatus(makeInst("14:00", "15:00"), ZONE, new Date(`${DATE}T12:30:00.000Z`));
    expect(result.variant).toBe("soon");
    expect(result.label).toBe("Starts in 30 min");
  });

  it("returns ongoing when now is during class", () => {
    const result = classStatus(makeInst("14:00", "15:00"), ZONE, new Date(`${DATE}T13:30:00.000Z`));
    expect(result.variant).toBe("ongoing");
    expect(result.label).toBe("Ongoing");
  });

  it("returns ended when now is after class end", () => {
    const result = classStatus(makeInst("14:00", "15:00"), ZONE, new Date(`${DATE}T14:30:00.000Z`));
    expect(result.variant).toBe("ended");
    expect(result.label).toBe("Ended");
  });

  it("edge: exactly at start → ongoing", () => {
    const result = classStatus(makeInst("14:00", "15:00"), ZONE, new Date(START_UTC));
    expect(result.variant).toBe("ongoing");
  });

  it("edge: exactly at end → ongoing (not yet past)", () => {
    const result = classStatus(makeInst("14:00", "15:00"), ZONE, new Date(END_UTC));
    expect(result.variant).toBe("ongoing");
  });

  it("edge: 1 second after end → ended", () => {
    const now = new Date(new Date(END_UTC).getTime() + 1000);
    const result = classStatus(makeInst("14:00", "15:00"), ZONE, now);
    expect(result.variant).toBe("ended");
  });
});
