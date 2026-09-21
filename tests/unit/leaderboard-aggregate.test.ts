// Aggregate ranking + opt-out exclusion for the public attendance leaderboard.
//
// These drive the PURE core (`buildLeaderboard`), so they need no database and
// fail red the instant either the ranking, the tie-break, the name masking, the
// opt-out exclusion or the movement/cold-start logic regresses.

import { describe, it, expect } from "vitest";
import { buildLeaderboard, formatDisplayName, zonedMonthStart } from "@/lib/leaderboard";

const members = [
  { id: "m1", name: "Alex Johnson", leaderboardOptOut: false },
  { id: "m2", name: "Bella Ng", leaderboardOptOut: false },
  { id: "m3", name: "Chris Young", leaderboardOptOut: false },
  { id: "m4", name: "Dana Opt", leaderboardOptOut: true }, // opted out
  { id: "m5", name: "Eze", leaderboardOptOut: false }, // single-token name
];

describe("formatDisplayName", () => {
  it("is first name + last initial only", () => {
    expect(formatDisplayName("Alex Johnson")).toBe("Alex J.");
  });
  it("keeps a single-token name as-is", () => {
    expect(formatDisplayName("Eze")).toBe("Eze");
  });
  it("uses the FINAL token for the initial and uppercases it", () => {
    expect(formatDisplayName("mary jane watson")).toBe("mary W.");
  });
  it("never returns a blank row", () => {
    expect(formatDisplayName("   ")).toBe("Anonymous");
  });
});

describe("buildLeaderboard ranking", () => {
  it("ranks by check-ins desc, tie-broken deterministically by memberId asc", () => {
    const res = buildLeaderboard({
      monthLabel: "September 2026",
      members,
      // m2 and m3 tie on 5 — m2 must precede m3 (memberId asc), not DB order.
      currentRows: [
        { memberId: "m3", count: 5 },
        { memberId: "m1", count: 9 },
        { memberId: "m2", count: 5 },
        { memberId: "m5", count: 2 },
      ],
      priorRows: [],
    });
    expect(res.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(res.entries.map((e) => e.name)).toEqual(["Alex J.", "Bella N.", "Chris Y.", "Eze"]);
    expect(res.entries.map((e) => e.checkIns)).toEqual([9, 5, 5, 2]);
  });

  it("excludes opted-out members entirely, however high their count", () => {
    const res = buildLeaderboard({
      monthLabel: "September 2026",
      members,
      currentRows: [
        { memberId: "m4", count: 99 }, // opted out — must never appear
        { memberId: "m1", count: 3 },
      ],
      priorRows: [],
    });
    expect(res.entries.map((e) => e.name)).toEqual(["Alex J."]);
    expect(res.entries.some((e) => e.name.startsWith("Dana"))).toBe(false);
  });

  it("leaks no id, email or photo in the entries", () => {
    const res = buildLeaderboard({
      monthLabel: "September 2026",
      members,
      currentRows: [{ memberId: "m1", count: 3 }],
      priorRows: [],
    });
    const keys = Object.keys(res.entries[0]).sort();
    expect(keys).toEqual(["checkIns", "movement", "name", "rank"]);
  });
});

describe("buildLeaderboard movement", () => {
  it("marks up / down / same / new against last month", () => {
    const res = buildLeaderboard({
      monthLabel: "September 2026",
      members,
      // this month: m1(1st), m2(2nd), m5(3rd)
      currentRows: [
        { memberId: "m1", count: 10 },
        { memberId: "m2", count: 8 },
        { memberId: "m5", count: 4 },
      ],
      // last month: m2(1st), m1(2nd), m3(3rd) — m5 is new, m3 dropped off
      priorRows: [
        { memberId: "m2", count: 20 },
        { memberId: "m1", count: 12 },
        { memberId: "m3", count: 3 },
      ],
    });
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e.movement]));
    expect(res.coldStart).toBe(false);
    expect(byName["Alex J."]).toBe("up"); // 2nd -> 1st
    expect(byName["Bella N."]).toBe("down"); // 1st -> 2nd
    expect(byName["Eze"]).toBe("new"); // absent last month
  });

  it("cold-starts: no prior month means null movement and coldStart=true", () => {
    const res = buildLeaderboard({
      monthLabel: "September 2026",
      members,
      currentRows: [{ memberId: "m1", count: 4 }],
      priorRows: [],
    });
    expect(res.coldStart).toBe(true);
    expect(res.entries[0].movement).toBeNull();
  });

  it("an all-opted-out prior month is a cold start (no one to compare against)", () => {
    const res = buildLeaderboard({
      monthLabel: "September 2026",
      members,
      currentRows: [{ memberId: "m1", count: 4 }],
      priorRows: [{ memberId: "m4", count: 50 }], // only the opted-out member trained last month
    });
    expect(res.coldStart).toBe(true);
    expect(res.entries[0].movement).toBeNull();
  });
});

describe("zonedMonthStart", () => {
  it("returns true local midnight on the 1st for a positive-offset zone", () => {
    // 21 Sep 2026, 12:00 UTC → in Asia/Makassar (UTC+8, no DST) the month
    // start is 1 Sep 2026 00:00 local = 31 Aug 2026 16:00 UTC.
    const start = zonedMonthStart(new Date("2026-09-21T12:00:00Z"), "Asia/Makassar", 0);
    expect(start.toISOString()).toBe("2026-08-31T16:00:00.000Z");
  });

  it("shifts whole months with the offset", () => {
    const next = zonedMonthStart(new Date("2026-09-21T12:00:00Z"), "UTC", 1);
    expect(next.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    const prev = zonedMonthStart(new Date("2026-09-21T12:00:00Z"), "UTC", -1);
    expect(prev.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});
