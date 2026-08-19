// Milestone badges: derivation and relevance filtering.
//
// computeBadges and selectVisibleBadges are both pure and exported, so unlike
// most of tests/unit these need no Prisma or next/server mocks at all.

import { describe, it, expect } from "vitest";
import { computeBadges, selectVisibleBadges, type BadgeRow, type MemberBadge } from "@/lib/member-stats";

const NOW = new Date("2026-08-18T12:00:00.000Z");

/** n check-ins one week apart (so each lands in its own Monday week). */
function weekly(n: number, from = "2026-01-05T10:00:00.000Z", classId: string | null = "c1"): BadgeRow[] {
  const start = new Date(from).getTime();
  return Array.from({ length: n }, (_, i) => ({ at: new Date(start + i * 7 * 86_400_000), classId }));
}

/** n check-ins on consecutive days from a given start. */
function daily(n: number, from: string, classId: string | null = "c1"): BadgeRow[] {
  const start = new Date(from).getTime();
  return Array.from({ length: n }, (_, i) => ({ at: new Date(start + i * 86_400_000), classId }));
}

const byId = (badges: MemberBadge[], id: string) => badges.find((b) => b.id === id)!;

describe("computeBadges — empty history", () => {
  const badges = computeBadges([], 0, NOW);

  it("does not crash and earns nothing", () => {
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.every((b) => !b.earned)).toBe(true);
    expect(badges.every((b) => b.earnedAt === null)).toBe(true);
  });

  it("reports zero progress against the first class", () => {
    expect(byId(badges, "classes-1").progress).toEqual({ current: 0, target: 1, unit: "classes" });
  });

  it("gives tenure no phantom progress when there is no first check-in", () => {
    expect(byId(badges, "tenure-1y").progress).toEqual({ current: 0, target: 12, unit: "months" });
  });
});

describe("computeBadges — volume", () => {
  it("earns on the exact check-in that crossed the threshold", () => {
    const rows = weekly(10);
    const badges = computeBadges(rows, 10, NOW);
    expect(byId(badges, "classes-10").earned).toBe(true);
    expect(byId(badges, "classes-10").earnedAt).toBe(rows[9].at.toISOString());
    // Not the last check-in — the tenth one specifically.
    expect(byId(badges, "classes-1").earnedAt).toBe(rows[0].at.toISOString());
  });

  it("shows live progress while locked", () => {
    const badges = computeBadges(weekly(10), 10, NOW);
    expect(byId(badges, "classes-25").progress).toEqual({ current: 10, target: 25, unit: "classes" });
  });
});

describe("computeBadges — consistency (once earned, always earned)", () => {
  it("earns the 4-week streak on the FIRST qualifying run, even after it breaks", () => {
    // 4 straight weeks, a 3-week gap, then 4 more.
    const first = weekly(4, "2026-01-05T10:00:00.000Z");
    const second = weekly(4, "2026-03-02T10:00:00.000Z");
    const badges = computeBadges([...first, ...second], 0, NOW);

    const streak4 = byId(badges, "streak-4");
    expect(streak4.earned).toBe(true);
    // The 4th week of the FIRST run, not the second.
    expect(streak4.earnedAt).toBe(first[3].at.toISOString());
    // And a currently-zero streak does not un-earn it.
    expect(streak4.progress).toBeNull();
  });

  it("does not earn when weeks are not consecutive", () => {
    const rows = [
      ...weekly(2, "2026-01-05T10:00:00.000Z"),
      ...weekly(2, "2026-02-09T10:00:00.000Z"),
    ];
    expect(byId(computeBadges(rows, 0, NOW), "streak-4").earned).toBe(false);
  });

  it("survives a run crossing a year boundary", () => {
    const rows = weekly(4, "2025-12-15T10:00:00.000Z");
    expect(byId(computeBadges(rows, 4, NOW), "streak-4").earned).toBe(true);
  });

  it("reports the current streak as locked progress", () => {
    const badges = computeBadges(weekly(3, "2026-08-03T10:00:00.000Z"), 3, NOW);
    expect(byId(badges, "streak-4").progress).toEqual({ current: 3, target: 4, unit: "weeks" });
  });
});

describe("computeBadges — intensity", () => {
  it("earns on the third session within one week", () => {
    const rows = daily(3, "2026-03-02T10:00:00.000Z"); // Mon, Tue, Wed
    const badges = computeBadges(rows, 1, NOW);
    const week3 = byId(badges, "week-3");
    expect(week3.earned).toBe(true);
    expect(week3.earnedAt).toBe(rows[2].at.toISOString());
  });

  it("counts sessions, not distinct days", () => {
    const day = "2026-03-02T";
    const rows: BadgeRow[] = [
      { at: new Date(`${day}07:00:00.000Z`), classId: "c1" },
      { at: new Date(`${day}12:00:00.000Z`), classId: "c1" },
      { at: new Date(`${day}18:00:00.000Z`), classId: "c1" },
    ];
    expect(byId(computeBadges(rows, 1, NOW), "week-3").earned).toBe(true);
  });

  it("reports the BEST-EVER bucket as progress, not the current one", () => {
    // A big week long ago, then a quiet week now. Progress must not regress.
    const rows = [
      ...daily(4, "2026-01-05T10:00:00.000Z"),
      { at: new Date("2026-08-17T10:00:00.000Z"), classId: "c1" },
    ];
    expect(byId(computeBadges(rows, 1, NOW), "week-5").progress).toEqual({
      current: 4,
      target: 5,
      unit: "sessions",
    });
  });
});

describe("computeBadges — tenure", () => {
  it("earns on a real check-in at or after the anniversary, not the calendar date", () => {
    const rows: BadgeRow[] = [
      { at: new Date("2025-01-10T10:00:00.000Z"), classId: "c1" },
      { at: new Date("2025-06-10T10:00:00.000Z"), classId: "c1" },
      { at: new Date("2026-03-01T10:00:00.000Z"), classId: "c1" }, // first after the 1y mark
    ];
    const oneYear = byId(computeBadges(rows, 0, NOW), "tenure-1y");
    expect(oneYear.earned).toBe(true);
    expect(oneYear.earnedAt).toBe(rows[2].at.toISOString());
  });

  it("does NOT award tenure to someone who stopped before the anniversary", () => {
    // First class in January 2024, still training that August, then gone. The
    // clock has since passed two years; they were never there for it. Six
    // months is earned because they turned up after that mark — a year is not.
    const rows: BadgeRow[] = [
      { at: new Date("2024-01-10T10:00:00.000Z"), classId: "c1" },
      { at: new Date("2024-08-10T10:00:00.000Z"), classId: "c1" },
    ];
    const badges = computeBadges(rows, 0, NOW);
    expect(byId(badges, "tenure-6m").earned).toBe(true);
    expect(byId(badges, "tenure-1y").earned).toBe(false);
  });

  it("counts elapsed months as locked progress", () => {
    const rows: BadgeRow[] = [{ at: new Date("2026-05-18T10:00:00.000Z"), classId: "c1" }];
    // 18 May to 18 Aug is exactly 3 whole months.
    expect(byId(computeBadges(rows, 0, NOW), "tenure-6m").progress).toEqual({
      current: 3,
      target: 6,
      unit: "months",
    });
  });

  it("clamps month arithmetic instead of rolling over a short month", () => {
    // 31 August + 6 months must be 28 February, not 3 March. A check-in on
    // 28 Feb therefore earns it.
    const rows: BadgeRow[] = [
      { at: new Date("2025-08-31T10:00:00.000Z"), classId: "c1" },
      { at: new Date("2026-02-28T10:00:00.000Z"), classId: "c1" },
    ];
    expect(byId(computeBadges(rows, 0, NOW), "tenure-6m").earned).toBe(true);
  });

  it("handles a leap day anchor", () => {
    const rows: BadgeRow[] = [
      { at: new Date("2024-02-29T10:00:00.000Z"), classId: "c1" },
      { at: new Date("2025-02-28T10:00:00.000Z"), classId: "c1" },
    ];
    expect(byId(computeBadges(rows, 0, NOW), "tenure-1y").earned).toBe(true);
  });
});

describe("computeBadges — breadth", () => {
  it("earns on the check-in that introduced the third distinct class", () => {
    const rows: BadgeRow[] = [
      { at: new Date("2026-01-05T10:00:00.000Z"), classId: "gi" },
      { at: new Date("2026-01-06T10:00:00.000Z"), classId: "gi" },
      { at: new Date("2026-01-07T10:00:00.000Z"), classId: "nogi" },
      { at: new Date("2026-01-08T10:00:00.000Z"), classId: "openmat" },
    ];
    const variety = byId(computeBadges(rows, 1, NOW), "variety-3");
    expect(variety.earned).toBe(true);
    expect(variety.earnedAt).toBe(rows[3].at.toISOString());
  });

  it("ignores check-ins with no class attached", () => {
    const rows: BadgeRow[] = [
      { at: new Date("2026-01-05T10:00:00.000Z"), classId: "gi" },
      { at: new Date("2026-01-06T10:00:00.000Z"), classId: null },
      { at: new Date("2026-01-07T10:00:00.000Z"), classId: null },
    ];
    const badges = computeBadges(rows, 1, NOW);
    expect(byId(badges, "variety-3").earned).toBe(false);
    expect(byId(badges, "variety-3").progress).toEqual({ current: 1, target: 3, unit: "class types" });
  });
});

describe("computeBadges — resilience", () => {
  it("earns comeback at a 30-day gap but not at 29", () => {
    const at29: BadgeRow[] = [
      { at: new Date("2026-01-01T10:00:00.000Z"), classId: "c1" },
      { at: new Date("2026-01-30T10:00:00.000Z"), classId: "c1" },
    ];
    const at30: BadgeRow[] = [
      { at: new Date("2026-01-01T10:00:00.000Z"), classId: "c1" },
      { at: new Date("2026-01-31T10:00:00.000Z"), classId: "c1" },
    ];
    expect(byId(computeBadges(at29, 0, NOW), "comeback").earned).toBe(false);
    expect(byId(computeBadges(at30, 0, NOW), "comeback").earned).toBe(true);
  });

  it("earns 'back for good' after four straight weeks following a break", () => {
    const rows: BadgeRow[] = [
      { at: new Date("2026-01-05T10:00:00.000Z"), classId: "c1" },
      ...weekly(4, "2026-03-02T10:00:00.000Z"),
    ];
    expect(byId(computeBadges(rows, 4, NOW), "comeback-4").earned).toBe(true);
  });

  it("never offers progress on the resilience track", () => {
    const badges = computeBadges(weekly(5), 5, NOW);
    expect(byId(badges, "comeback").progress).toBeNull();
    expect(byId(badges, "comeback-4").progress).toBeNull();
  });
});

describe("selectVisibleBadges", () => {
  it("never shows a far-off rung to a brand-new member", () => {
    // One check-in, a few days ago — someone who has just joined.
    const badges = computeBadges([{ at: new Date("2026-08-15T10:00:00.000Z"), classId: "gi" }], 1, NOW);
    const { earned, next } = selectVisibleBadges(badges);

    expect(earned.map((b) => b.id)).toEqual(["classes-1"]);
    // The whole point of the request: no "250 classes — 1 of 250".
    const ids = next.map((b) => b.id);
    expect(ids).toContain("classes-10");
    expect(ids).not.toContain("classes-25");
    expect(ids).not.toContain("classes-250");
  });

  it("only ever offers the immediate next rung per track", () => {
    const badges = computeBadges(weekly(10), 10, NOW);
    const { next } = selectVisibleBadges(badges);
    const volume = next.filter((b) => b.track === "volume");
    expect(volume).toHaveLength(1);
    expect(volume[0].id).toBe("classes-25");
  });

  it("never offers a resilience badge as a goal", () => {
    const badges = computeBadges(weekly(6), 6, NOW);
    const { next } = selectVisibleBadges(badges);
    expect(next.some((b) => b.track === "resilience")).toBe(false);
    expect(next.every((b) => b.progress !== null)).toBe(true);
  });

  it("caps the card and reports what is hidden", () => {
    const badges = computeBadges(weekly(60), 60, NOW);
    const v = selectVisibleBadges(badges);
    expect(v.earned.length).toBeLessThanOrEqual(6);
    expect(v.next.length).toBeLessThanOrEqual(3);
    expect(v.earnedTotal).toBeGreaterThanOrEqual(v.earned.length);
    expect(v.hiddenCount).toBe(badges.length - v.earned.length - v.next.length);
  });

  it("leads a long-standing member with their most recent badges", () => {
    const badges = computeBadges(weekly(60), 60, NOW);
    const { earned } = selectVisibleBadges(badges);
    const dates = earned.map((b) => b.earnedAt ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(earned.map((b) => b.id)).not.toContain("classes-1");
  });

  it("offers reachable goals when nothing is earned yet", () => {
    const { earned, next } = selectVisibleBadges(computeBadges([], 0, NOW));
    expect(earned).toHaveLength(0);
    expect(next.length).toBeGreaterThan(0);
    // Every candidate is a tier 1, so nothing unreachable is dangled.
    expect(next.every((b) => b.tier === 1)).toBe(true);
  });
});
