import { describe, expect, it } from "vitest";

import {
  packLanes,
  sessionProgress,
  sessionState,
  sessionStateLabel,
  sessionStates,
  spanMinutes,
  timeToMin,
} from "@/lib/schedule-state";

const span = (start: string, end: string, cancelled = false) => ({ ...spanMinutes(start, end), cancelled });

describe("spanMinutes — [start, end) with overnight normalisation", () => {
  it("reads hh:mm as minutes since midnight", () => {
    expect(timeToMin("18:30")).toBe(1110);
    expect(timeToMin("00:00")).toBe(0);
    expect(timeToMin("garbage")).toBe(0);
  });

  it("an end at or before the start crosses midnight", () => {
    expect(spanMinutes("23:00", "00:30")).toEqual({ startMin: 1380, endMin: 1470 });
    expect(spanMinutes("22:00", "22:00")).toEqual({ startMin: 1320, endMin: 2760 });
    expect(spanMinutes("18:00", "19:00")).toEqual({ startMin: 1080, endMin: 1140 });
  });
});

describe("sessionState — live at the start minute, ended at the end minute", () => {
  const s = span("18:00", "19:00");
  it("is upcoming before the start", () => expect(sessionState(s, 1079)).toBe("upcoming"));
  it("is live AT the start minute (start inclusive)", () => expect(sessionState(s, 1080)).toBe("live"));
  it("is live one minute before the end", () => expect(sessionState(s, 1139)).toBe("live"));
  it("is ended AT the end minute (end exclusive)", () => expect(sessionState(s, 1140)).toBe("ended"));
  it("cancellation wins whatever the clock says", () => {
    expect(sessionState(span("18:00", "19:00", true), 1100)).toBe("cancelled");
    expect(sessionState(span("18:00", "19:00", true), 0)).toBe("cancelled");
  });
  it("an overnight session is live after midnight of its start day", () => {
    const late = span("23:00", "00:30");
    expect(sessionState(late, 1440 + 20)).toBe("live");
    expect(sessionState(late, 1440 + 30)).toBe("ended");
  });
});

describe("sessionStates — the day's states and the next-session tie rule", () => {
  const day = [
    span("09:00", "10:00"), // ended
    span("18:00", "19:00"), // live
    span("19:30", "20:30"), // next
    span("19:30", "20:15"), // next (tie)
    span("21:00", "22:00"), // upcoming
    span("19:15", "20:00", true), // cancelled — earlier than "next" but never next
  ];
  it("labels every session of today from one clock", () => {
    expect(sessionStates(day, timeToMin("18:15"), true)).toEqual([
      "ended",
      "live",
      "next",
      "next",
      "upcoming",
      "cancelled",
    ]);
  });
  it("another day has no live, ended or next", () => {
    expect(sessionStates(day, timeToMin("18:15"), false)).toEqual([
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
      "cancelled",
    ]);
  });
  it("with nothing left to start there is no next", () => {
    expect(sessionStates(day, timeToMin("22:30"), true)).toEqual([
      "ended",
      "ended",
      "ended",
      "ended",
      "ended",
      "cancelled",
    ]);
  });
  it("keeps input order and handles an empty day", () => {
    expect(sessionStates([], 600, true)).toEqual([]);
  });
});

describe("sessionProgress", () => {
  const s = span("18:00", "19:00");
  it("runs 0 → 1 across the session and clamps outside it", () => {
    expect(sessionProgress(s, 1000)).toBe(0);
    expect(sessionProgress(s, 1080)).toBe(0);
    expect(sessionProgress(s, 1110)).toBe(0.5);
    expect(sessionProgress(s, 1140)).toBe(1);
    expect(sessionProgress(s, 1400)).toBe(1);
  });
  it("labels read as plain words", () => {
    expect(sessionStateLabel("live")).toBe("Live");
    expect(sessionStateLabel("next")).toBe("Next");
    expect(sessionStateLabel("ended")).toBe("Ended");
    expect(sessionStateLabel("cancelled")).toBe("Cancelled");
    expect(sessionStateLabel("upcoming")).toBe("Upcoming");
  });
});

describe("packLanes — no two overlapping sessions share a lane", () => {
  const lanesOf = (sessions: ReturnType<typeof span>[], maxLanes?: number) =>
    packLanes(sessions, { maxLanes }).placements.map((p) => [p.lane, p.lanes]);

  it("a lone session takes the full width", () => {
    expect(lanesOf([span("18:00", "19:00")])).toEqual([[0, 1]]);
  });

  it("two concurrent sessions split into two lanes", () => {
    expect(lanesOf([span("18:00", "19:00"), span("18:00", "19:00")])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it("touching sessions ([18,19) then [19,20)) do not overlap and stay full width", () => {
    const r = packLanes([span("18:00", "19:00"), span("19:00", "20:00")]);
    expect(r.clusters).toHaveLength(2);
    expect(r.placements.map((p) => p.lanes)).toEqual([1, 1]);
  });

  it("a nested session shares its parent's cluster and takes the second lane", () => {
    const r = packLanes([span("18:00", "20:00"), span("18:30", "19:00")]);
    expect(r.clusters).toHaveLength(1);
    expect(r.placements).toEqual([
      { lane: 0, lanes: 2, cluster: 0 },
      { lane: 1, lanes: 2, cluster: 0 },
    ]);
  });

  it("a transitive chain (A∩B, B∩C, A∌C) is one cluster and C reuses A's lane", () => {
    const r = packLanes([span("18:00", "18:45"), span("18:30", "19:15"), span("19:00", "19:45")]);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]).toMatchObject({ startMin: 1080, endMin: 1185, lanes: 2, dense: false });
    expect(r.placements.map((p) => p.lane)).toEqual([0, 1, 0]);
  });

  it("four concurrent sessions need four lanes and are dense above three", () => {
    const four = [span("18:00", "19:00"), span("18:00", "19:00"), span("18:00", "19:00"), span("18:00", "19:00")];
    const r = packLanes(four, { maxLanes: 3 });
    expect(r.clusters[0].lanes).toBe(4);
    expect(r.clusters[0].dense).toBe(true);
    expect(new Set(r.placements.map((p) => p.lane)).size).toBe(4);
    expect(packLanes(four, { maxLanes: 4 }).clusters[0].dense).toBe(false);
  });

  it("six concurrent sessions never share a lane and are dense", () => {
    const six = Array.from({ length: 6 }, () => span("18:00", "19:00"));
    const r = packLanes(six);
    expect(r.clusters[0].lanes).toBe(6);
    expect(r.clusters[0].dense).toBe(true);
  });

  it("short and cancelled sessions still occupy a lane so they stay visible", () => {
    const r = packLanes([span("18:00", "19:00"), span("18:00", "18:10"), span("18:20", "18:40", true)]);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].lanes).toBe(2);
    expect(r.placements.map((p) => p.lane)).toEqual([0, 1, 1]);
  });

  it("an overnight session clusters with one that starts after midnight of its day", () => {
    const r = packLanes([span("23:00", "01:00"), { startMin: 1440 + 10, endMin: 1440 + 40 }]);
    expect(r.clusters).toHaveLength(1);
    expect(r.placements.map((p) => p.lane)).toEqual([0, 1]);
  });

  it("input order is preserved in placements and the result is deterministic", () => {
    const sessions = [span("19:00", "20:00"), span("18:00", "19:30"), span("18:00", "18:30")];
    const a = packLanes(sessions);
    const b = packLanes(sessions);
    expect(a).toEqual(b);
    // Longer session first on a tie at 18:00, so it keeps lane 0.
    expect(a.placements.map((p) => p.lane)).toEqual([1, 0, 1]);
  });

  it("an empty day packs to nothing", () => {
    expect(packLanes([])).toEqual({ placements: [], clusters: [] });
  });
});
