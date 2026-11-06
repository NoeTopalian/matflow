// The poster grid's engine: rows are the real start and end times, columns are
// lanes inside each day. Pure data in, pure data out (plan §4.2–4.4, §5.1).
import { describe, expect, it } from "vitest";

import { buildTimetableGrid, type GridSession, type TimetableGrid } from "@/lib/timetable-grid";

const WEEK = [1, 2, 3, 4, 5, 6, 0];
const s = (key: string, day: number, startTime: string, endTime: string, tie = "", matId: string | null = null): GridSession => ({
  key,
  day,
  startTime,
  endTime,
  matId,
  tie,
});
const byTime = (sessions: GridSession[], days = WEEK) => buildTimetableGrid(sessions, { days, layout: "time", mats: [] });
const session = (g: TimetableGrid, key: string) => {
  const hit = g.items.find((i) => i.type === "session" && i.key === key);
  if (!hit || hit.type !== "session") throw new Error(`no session ${key}`);
  return hit;
};
const mores = (g: TimetableGrid) => g.items.flatMap((i) => (i.type === "more" ? [i] : []));
const day = (g: TimetableGrid, d: number) => {
  const hit = g.days.find((x) => x.day === d);
  if (!hit) throw new Error(`no day ${d}`);
  return hit;
};

describe("rows are the real times", () => {
  it("puts two classes that start together on the same line, on any day", () => {
    const g = byTime([s("a", 1, "18:40", "19:30"), s("b", 1, "18:40", "19:00"), s("c", 3, "18:40", "19:30")]);
    expect(session(g, "a").rowStart).toBe(session(g, "b").rowStart);
    expect(session(g, "a").rowStart).toBe(session(g, "c").rowStart);
    expect(session(g, "b").rowEnd).toBeLessThan(session(g, "a").rowEnd);
  });

  it("starts the time lines at line 3, after the day and mat header rows", () => {
    const g = byTime([s("a", 1, "09:00", "10:00")]);
    expect(g.firstTimeLine).toBe(3);
    expect(session(g, "a").rowStart).toBe(3);
    expect(session(g, "a").rowEnd).toBe(4);
  });

  it("gives touching classes separate tracks", () => {
    const g = byTime([s("a", 1, "09:00", "10:00"), s("b", 1, "10:00", "11:00")]);
    expect(session(g, "a").rowEnd).toBe(session(g, "b").rowStart);
    expect(session(g, "a").lanes).toBe(1);
    expect(session(g, "b").lanes).toBe(1);
  });

  it("floors a short track at 0 and a longer one at 0.6 px a minute", () => {
    const g = byTime([s("a", 1, "16:45", "17:45"), s("b", 2, "16:50", "17:35")]);
    // tracks: 16:45–16:50 (5 min), 16:50–17:35 (45 min), 17:35–17:45 (10 min)
    expect(g.rows.map((r) => [r.kind, r.floorPx])).toEqual([
      ["used", 0],
      ["used", 27],
      ["used", 0],
    ]);
    const fifty = byTime([s("x", 1, "12:00", "12:50")]);
    expect(fifty.rows[0].floorPx).toBe(30);
  });

  it("turns a week-wide empty hour into one break row and a shorter gap into a gap row", () => {
    const g = byTime([s("a", 1, "07:00", "08:00"), s("b", 2, "09:00", "09:45"), s("c", 2, "10:00", "10:45")]);
    expect(g.rows.map((r) => r.kind)).toEqual(["used", "break", "used", "gap", "used"]);
    expect(g.rows[1]).toMatchObject({ fromMin: 480, toMin: 540 });
  });

  it("labels a start only when it is at least 15 minutes after the last labelled one", () => {
    const g = byTime([s("a", 1, "17:45", "18:40"), s("b", 2, "17:50", "18:40"), s("c", 5, "18:00", "19:00"), s("d", 1, "18:40", "19:00")]);
    expect(g.ticks.map((t) => t.minute)).toEqual([17 * 60 + 45, 18 * 60, 18 * 60 + 40]);
    // each label runs to the next labelled line
    expect(g.ticks[0].rowEnd).toBe(g.ticks[1].rowStart);
  });

  it("ends an overnight class on the 24:00 line", () => {
    const g = byTime([s("late", 6, "23:00", "01:00"), s("early", 6, "20:00", "21:00")]);
    const last = g.firstTimeLine + g.rows.length;
    expect(session(g, "late").rowEnd).toBe(last);
    expect(g.rows[g.rows.length - 1].toMin).toBe(1440);
  });

  it("still places a session whose time is malformed", () => {
    const g = byTime([s("odd", 1, "", ""), s("ok", 1, "09:00", "10:00")]);
    expect(session(g, "odd").rowEnd).toBeGreaterThan(session(g, "odd").rowStart);
    expect(day(g, 1).count).toBe(2);
  });

  it("keeps a class that starts in the last ten minutes of the day on its own start line", () => {
    const g = byTime([s("late", 1, "23:55", "23:58"), s("eve", 1, "20:00", "21:00")]);
    expect(g.rows.some((r) => r.fromMin === 23 * 60 + 55 && r.toMin === 23 * 60 + 58)).toBe(true);
    expect(g.ticks.map((t) => t.minute)).toContain(23 * 60 + 55);
  });

  it("a session on a day that is not on show adds no row, no label and no break", () => {
    const shown = byTime([s("a", 1, "18:00", "19:00")], [1]);
    const withStray = byTime([s("a", 1, "18:00", "19:00"), s("stray", 7, "03:00", "04:00"), s("other", 2, "09:00", "10:00")], [1]);
    expect(withStray.rows).toEqual(shown.rows);
    expect(withStray.ticks).toEqual(shown.ticks);
    expect(withStray.items).toEqual(shown.items);
  });

  it("has no rows and seven empty days when there are no sessions", () => {
    const g = byTime([]);
    expect(g.rows).toEqual([]);
    expect(g.items).toEqual([]);
    expect(g.days.map((d) => [d.day, d.count, d.tracks])).toEqual(WEEK.map((d) => [d, 0, 1]));
  });

  it("is deterministic", () => {
    const input = [s("a", 1, "18:40", "19:30"), s("b", 1, "18:40", "19:00"), s("c", 1, "19:00", "20:30")];
    expect(byTime(input)).toEqual(byTime([...input].reverse()));
  });
});

describe("columns by time", () => {
  it("gives a class alone the full day width", () => {
    const g = byTime([s("a", 1, "07:20", "08:00"), s("b", 1, "09:00", "10:00"), s("c", 1, "09:00", "10:00")]);
    expect(day(g, 1).tracks).toBe(2);
    expect(session(g, "a")).toMatchObject({ col: 1, span: 2, lanes: 1 });
    expect(session(g, "b")).toMatchObject({ col: 1, span: 1, lanes: 2 });
    expect(session(g, "c")).toMatchObject({ col: 2, span: 1, lanes: 2 });
  });

  it("packs a staggered trio into two lanes and reuses the first", () => {
    const g = byTime([s("lc", 1, "16:30", "17:15"), s("kids", 1, "17:00", "17:45"), s("teens", 1, "17:30", "18:30")]);
    expect(session(g, "lc")).toMatchObject({ lane: 0, lanes: 2 });
    expect(session(g, "kids")).toMatchObject({ lane: 1, lanes: 2 });
    expect(session(g, "teens")).toMatchObject({ lane: 0, lanes: 2 });
    expect(mores(g)).toEqual([]);
  });

  it("shows exactly three at once as three lanes with nothing folded", () => {
    const g = byTime([s("a", 1, "18:40", "19:30", "1"), s("b", 1, "18:40", "19:30", "2"), s("c", 1, "18:40", "19:30", "3")]);
    expect(day(g, 1).tracks).toBe(3);
    expect(["a", "b", "c"].map((k) => session(g, k).col)).toEqual([1, 2, 3]);
    expect(mores(g)).toEqual([]);
  });

  it("folds exactly four at once into two plus '+2 more'", () => {
    const g = byTime(["a", "b", "c", "d"].map((k, i) => s(k, 1, "10:00", "10:45", String(i))));
    expect(g.items.filter((i) => i.type === "session").map((i) => i.key)).toEqual(["a", "b"]);
    expect(session(g, "a")).toMatchObject({ col: 1, span: 1, lanes: 3 });
    const [more] = mores(g);
    expect(more.keys).toEqual(["c", "d"]);
    expect(more.clusterKeys).toEqual(["a", "b", "c", "d"]);
    expect(more).toMatchObject({ day: 1, col: 3, span: 1, startMin: 600, endMin: 645 });
  });

  it("folds five at once into two plus '+3 more' covering the folded classes' range", () => {
    const g = byTime([
      s("tots", 6, "10:00", "10:45", "1"),
      s("champs", 6, "10:00", "10:45", "2"),
      s("kids", 6, "10:00", "10:45", "3"),
      s("teens", 6, "10:00", "10:45", "4"),
      s("parents", 6, "10:00", "11:00", "0"),
    ]);
    const [more] = mores(g);
    expect(more.keys).toHaveLength(3);
    // the longer class is placed first, so it is one of the two on show
    expect(g.items.filter((i) => i.type === "session").map((i) => i.key)).toEqual(["parents", "tots"]);
    expect(more.rowStart).toBe(session(g, "tots").rowStart);
    expect(more.clusterRowStart).toBe(session(g, "parents").rowStart);
  });

  it("pins which classes fold in a cluster that is a pair early and four-way later", () => {
    const g = byTime([
      s("long", 1, "09:00", "11:00", "0"),
      s("early", 1, "09:00", "09:45", "1"),
      s("x", 1, "10:00", "10:45", "2"),
      s("y", 1, "10:00", "10:45", "3"),
      s("z", 1, "10:00", "10:45", "4"),
    ]);
    // lanes: long 0, early 1, x 1 (reuses), y 2, z 3 → four lanes → y and z fold
    const [more] = mores(g);
    expect(more.keys).toEqual(["y", "z"]);
    expect(more.rowStart).toBe(session(g, "x").rowStart);
    expect(more.rowEnd).toBe(session(g, "x").rowEnd);
    expect(session(g, "early").lanes).toBe(3);
  });

  it("folds only where more than three are on: a pair beside an all-day class stays on show though the evening is crowded", () => {
    const g = byTime([
      s("open", 1, "06:00", "22:00", "0"),
      s("a", 1, "07:00", "08:00", "1"),
      s("b", 1, "07:00", "08:00", "2"),
      s("c", 1, "18:00", "19:00", "1"),
      s("d", 1, "18:00", "19:00", "2"),
      s("e", 1, "18:00", "19:00", "3"),
    ]);
    // One overlap cluster (the all-day class joins everything). At 07:00 three are on: nothing folds there.
    expect(g.items.filter((i) => i.type === "session").map((i) => i.key)).toEqual(["open", "a", "b", "c"]);
    expect(session(g, "b").lane).toBe(2);
    const [more, ...rest] = mores(g);
    expect(rest).toEqual([]);
    expect(more.keys).toEqual(["d", "e"]);
    expect([more.startMin, more.endMin]).toEqual([18 * 60, 19 * 60]);
    expect(more.rowStart).toBe(session(g, "c").rowStart);
    expect(more.rowEnd).toBe(session(g, "c").rowEnd);
    // The classes on around that "+2 more": the all-day one and the three at 18:00, not the morning pair.
    expect(more.clusterKeys).toEqual(["open", "c", "d", "e"]);
    expect(more.clusterRowStart).toBe(session(g, "open").rowStart);
    expect(day(g, 1).tracks).toBe(3);
  });

  it("a class in the third lane with nothing beyond it is shown; the '+N more' covers only the crowded stretch", () => {
    const g = byTime([
      s("i1", 1, "10:00", "12:00", "1"),
      s("i2", 1, "10:00", "12:00", "2"),
      s("i3", 1, "10:00", "10:30", "3"),
      s("i4", 1, "10:00", "10:30", "4"),
      s("i5", 1, "11:00", "11:30", "5"),
    ]);
    // 10:00: four at once → i3 and i4 fold. 11:00: three at once → i5 is on show, in the third lane.
    const [more, ...rest] = mores(g);
    expect(rest).toEqual([]);
    expect(more.keys).toEqual(["i3", "i4"]);
    expect([more.startMin, more.endMin]).toEqual([10 * 60, 10 * 60 + 30]);
    expect(session(g, "i5").lane).toBe(2);
    expect(session(g, "i5").col).toBe(more.col);
    expect(session(g, "i5").rowStart).toBeGreaterThanOrEqual(more.rowEnd);
  });

  it("two crowded stretches in one cluster give two '+N more', each over its own classes", () => {
    const g = byTime([
      s("open", 1, "06:00", "22:00", "0"),
      s("m1", 1, "07:00", "08:00", "1"),
      s("m2", 1, "07:00", "08:00", "2"),
      s("m3", 1, "07:00", "08:00", "3"),
      s("e1", 1, "18:00", "19:00", "1"),
      s("e2", 1, "18:00", "19:00", "2"),
      s("e3", 1, "18:00", "19:00", "3"),
    ]);
    const found = mores(g);
    expect(found.map((m) => m.keys)).toEqual([["m2", "m3"], ["e2", "e3"]]);
    expect(new Set(found.map((m) => m.id)).size).toBe(2);
    // Nothing on show shares a lane and a row with a "+N more".
    for (const m of found) {
      for (const i of g.items) {
        if (i.type !== "session" || i.col !== m.col) continue;
        expect(i.rowEnd <= m.rowStart || i.rowStart >= m.rowEnd).toBe(true);
      }
    }
  });

  it("uses six tracks on a day that has both a pair and a trio", () => {
    const g = byTime([
      s("p1", 1, "09:00", "10:00", "1"),
      s("p2", 1, "09:00", "10:00", "2"),
      s("t1", 1, "18:00", "19:00", "1"),
      s("t2", 1, "18:00", "19:00", "2"),
      s("t3", 1, "18:00", "19:00", "3"),
      s("solo", 1, "12:00", "13:00"),
    ]);
    expect(day(g, 1)).toMatchObject({ tracks: 6, lanes: 3 });
    expect(session(g, "p2")).toMatchObject({ col: 4, span: 3 });
    expect(session(g, "t3")).toMatchObject({ col: 5, span: 2 });
    expect(session(g, "solo")).toMatchObject({ col: 1, span: 6 });
  });

  it("orders equal starts and lengths by the tie text, number-aware, then key", () => {
    const g = byTime([s("m10", 1, "09:00", "10:00", "Mat 10"), s("m2", 1, "09:00", "10:00", "Mat 2"), s("m1", 1, "09:00", "10:00", "Mat 1")]);
    expect(["m1", "m2", "m10"].map((k) => session(g, k).col)).toEqual([1, 2, 3]);
  });

  it("lists items in day, start, column, lane order with '+N more' at its start", () => {
    const g = byTime([
      s("tue", 2, "09:00", "10:00"),
      s("late", 1, "19:00", "20:00"),
      ...["a", "b", "c", "d"].map((k, i) => s(k, 1, "10:00", "10:45", String(i))),
    ]);
    expect(g.items.map((i) => (i.type === "more" ? "more" : i.key))).toEqual(["a", "b", "more", "late", "tue"]);
  });
});

describe("columns by mat", () => {
  const TWO = [{ id: "m1" }, { id: "m2" }];
  const THREE = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
  const byMat = (sessions: GridSession[], mats: { id: string }[], extra: { maxTracks?: number } = {}) =>
    buildTimetableGrid(sessions, { days: WEEK, layout: "mat", mats, ...extra });
  const cols = (g: TimetableGrid, d: number) => day(g, d).columns.map((c) => c.matId);

  it("shows both mats of a two-mat club on a day that uses one", () => {
    const g = byMat([s("a", 1, "07:20", "08:00", "", "m2")], TWO);
    expect(cols(g, 1)).toEqual(["m1", "m2"]);
    expect(session(g, "a")).toMatchObject({ col: 2, span: 1 });
    expect(day(g, 1)).toMatchObject({ tracks: 2, lanes: 2, layout: "mat", fellBack: false });
  });

  it("shows only the mats in use for a club with three or more", () => {
    const g = byMat([s("a", 1, "18:40", "19:30", "", "m1"), s("b", 1, "18:40", "19:30", "", "m3")], THREE);
    expect(cols(g, 1)).toEqual(["m1", "m3"]);
    expect(session(g, "b").col).toBe(2);
  });

  it("keeps the club's order whatever order the classes come in", () => {
    const g = byMat([s("z", 1, "06:30", "07:20", "", "m2"), s("y", 1, "06:30", "07:20", "", "m1")], TWO);
    expect(session(g, "y").col).toBe(1);
    expect(session(g, "z").col).toBe(2);
  });

  it("puts classes with no mat, or a mat that is not in the list, in a last column shown only when needed", () => {
    const g = byMat([s("a", 1, "18:40", "19:30", "", "m1"), s("none", 1, "18:40", "19:30"), s("gone", 2, "18:40", "19:30", "", "removed")], TWO);
    expect(cols(g, 1)).toEqual(["m1", "m2", null]);
    expect(session(g, "none").col).toBe(3);
    expect(cols(g, 2)).toEqual(["m1", "m2", null]);
    // A mat that is no longer the club's is "No mat" on the placement too, not the id that has gone.
    expect(session(g, "gone").matId).toBeNull();
    expect(session(g, "gone").col).toBe(3);
    expect(cols(byMat([s("a", 3, "18:40", "19:30", "", "m1")], TWO), 3)).toEqual(["m1", "m2"]);
  });

  it("splits a mat that is used twice at once, and lets a class alone on it span the column", () => {
    const g = byMat([s("a", 1, "18:40", "19:30", "1", "m1"), s("b", 1, "18:40", "19:30", "2", "m1"), s("solo", 1, "20:00", "21:00", "", "m1")], TWO);
    expect(day(g, 1).columns).toEqual([
      { matId: "m1", col: 1, span: 2 },
      { matId: "m2", col: 3, span: 1 },
    ]);
    expect(session(g, "a")).toMatchObject({ col: 1, span: 1, lanes: 2 });
    expect(session(g, "b")).toMatchObject({ col: 2, span: 1, lanes: 2 });
    expect(session(g, "solo")).toMatchObject({ col: 1, span: 2 });
  });

  it("shows three on one mat as three lanes and folds a fourth", () => {
    const three = byMat(["a", "b", "c"].map((k, i) => s(k, 1, "18:40", "19:30", String(i), "m1")), TWO);
    expect(day(three, 1).columns[0]).toEqual({ matId: "m1", col: 1, span: 3 });
    expect(mores(three)).toEqual([]);
    const four = byMat(["a", "b", "c", "d"].map((k, i) => s(k, 1, "18:40", "19:30", String(i), "m1")), TWO);
    const [more] = mores(four);
    expect(more.keys).toEqual(["c", "d"]);
    expect(more.col).toBe(3);
  });

  it("gives a pair one lane each in a column that also holds a trio", () => {
    const g = byMat(
      [
        s("p1", 1, "09:00", "10:00", "1", "m1"),
        s("p2", 1, "09:00", "10:00", "2", "m1"),
        s("t1", 1, "18:00", "19:00", "1", "m1"),
        s("t2", 1, "18:00", "19:00", "2", "m1"),
        s("t3", 1, "18:00", "19:00", "3", "m1"),
      ],
      TWO,
    );
    expect(day(g, 1).columns[0]).toEqual({ matId: "m1", col: 1, span: 3 });
    expect(session(g, "p1")).toMatchObject({ col: 1, span: 1 });
    expect(session(g, "p2")).toMatchObject({ col: 2, span: 1 });
    expect(session(g, "t3")).toMatchObject({ col: 3, span: 1 });
  });

  it("falls back to by time on a narrow screen when the day needs more than three tracks", () => {
    const FOUR = [...THREE, { id: "m4" }];
    const fourMats = byMat(["m1", "m2", "m3", "m4"].map((m) => s(m, 1, "18:40", "19:30", "", m)), FOUR, { maxTracks: 3 });
    expect(day(fourMats, 1)).toMatchObject({ layout: "time", fellBack: true, columns: [] });
    const threePlusNone = byMat([...["m1", "m2", "m3"].map((m) => s(m, 1, "18:40", "19:30", "", m)), s("none", 1, "20:00", "21:00")], THREE, { maxTracks: 3 });
    expect(day(threePlusNone, 1).fellBack).toBe(true);
    const bothDouble = byMat(
      [s("a", 1, "09:00", "10:00", "1", "m1"), s("b", 1, "09:00", "10:00", "2", "m1"), s("c", 1, "18:00", "19:00", "1", "m2"), s("d", 1, "18:00", "19:00", "2", "m2")],
      TWO,
      { maxTracks: 3 },
    );
    expect(day(bothDouble, 1).fellBack).toBe(true);
    const plain = byMat([s("a", 1, "18:40", "19:30", "", "m1"), s("b", 1, "18:40", "19:30", "", "m2")], TWO, { maxTracks: 3 });
    expect(day(plain, 1)).toMatchObject({ layout: "mat", fellBack: false, tracks: 2 });
  });

  it("carries each session's mat on its placement", () => {
    const g = byMat([s("a", 1, "18:40", "19:30", "", "m2"), s("none", 1, "18:40", "19:30")], TWO);
    expect(session(g, "a").matId).toBe("m2");
    expect(session(g, "none").matId).toBeNull();
  });
});
