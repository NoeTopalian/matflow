// Fixture weeks for the timetable journeys (synthetic data only). GENERATED from the plan's measured prototype
// (.omc/plans/timetable-side-by-side/proto/index.html) — the same three weeks the layout was measured on.
//
// Row: [day, start, end, class name, colour, mat]
//   day  0 = Monday … 6 = Sunday (the order of the printed poster). The app's dayOfWeek is JS's, 0 = Sunday,
//        so a row is seeded with dayOfWeek = (day + 1) % 7 — see `dow`.
//   mat  an index into the week's `mats` (1-based); 0 = no mat. Until mats exist (PR 2) the mat's name is typed
//        into the class's Location; a no-mat class has no location, except where `noMatPlace` names one.
// Classes are grouped by name and mat: one class per pair, with one schedule row per day and start.
// Counts in asserted strings are computed from these rows, never typed.

export const DAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_NAME = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const dow = (day) => (day + 1) % 7;
export const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** The journeys' frozen clock: Thursday 5 November 2026, 18:45 club time (GMT). */
export const FROZEN = "2026-11-05T18:45:00Z";
export const FROZEN_DAY = 3;
export const FROZEN_MIN = 18 * 60 + 45;
/** Thursday classes painted near-black so the Ended, Live and Next pills are measured on the hardest colour. */
export const DARK = "#111111";

/** Total BJJ's printed week: six days, two mats, same-time pairs every day. */
export const POSTER = {
  key: "poster",
  mats: ["Mat 1", "Mat 2"],
  noMatPlace: null,
  dark: ["Beginners Course NoGi|1","Free Mat Space|1","Advanced Gi + Sparring|1"],
  rows: [
  [0,"06:30","07:20","Beginners Course Gi","#3b82f6",1],
  [0,"06:30","07:20","Advanced Free Drilling","#8b5cf6",2],
  [0,"07:20","08:00","Advanced Sparring","#6366f1",2],
  [0,"12:00","12:50","Beginners Course Gi","#3b82f6",1],
  [0,"12:00","12:50","Advanced Free Drilling","#8b5cf6",2],
  [0,"12:50","13:30","Advanced Sparring","#6366f1",2],
  [0,"16:50","17:35","Little Squad","#eab308",2],
  [0,"17:50","18:40","Youth Squad","#f97316",2],
  [0,"18:40","19:30","Beginners Course Gi","#3b82f6",1],
  [0,"18:40","19:00","Free Mat Space","#06b6d4",2],
  [0,"19:30","19:45","Free Mat Space","#06b6d4",1],
  [0,"19:00","20:30","Advanced Gi + Sparring","#6366f1",2],
  [1,"16:45","17:45","Juniors Squad","#22c55e",2],
  [1,"17:50","18:40","Beginners Course Gi","#3b82f6",1],
  [1,"17:45","18:40","Kids Comp Team Gi","#ef4444",2],
  [1,"18:40","19:00","Free Mat Space","#06b6d4",1],
  [1,"18:40","19:00","Free Mat Space","#06b6d4",2],
  [1,"19:00","20:30","Advanced NoGi + Sparring","#6366f1",1],
  [1,"19:00","20:30","Advanced Gi Comp Class","#ec4899",2],
  [2,"06:30","07:20","Beginners Course Gi","#3b82f6",1],
  [2,"06:30","07:20","Advanced Free Drilling","#8b5cf6",2],
  [2,"07:20","08:00","Advanced Sparring","#6366f1",2],
  [2,"12:00","12:50","Beginners Course NoGi","#3b82f6",1],
  [2,"12:00","12:50","Advanced Free Drilling","#8b5cf6",2],
  [2,"12:50","13:30","Advanced Sparring","#6366f1",2],
  [2,"16:50","17:35","Little Squad","#eab308",2],
  [2,"17:50","18:40","Youth Squad","#f97316",2],
  [2,"18:40","19:30","Beginners Course NoGi","#3b82f6",1],
  [2,"18:40","19:00","Free Mat Space","#06b6d4",2],
  [2,"19:30","19:45","Free Mat Space","#06b6d4",1],
  [2,"19:00","20:30","Advanced NoGi + Sparring","#6366f1",2],
  [3,"16:45","17:45","Juniors Squad","#22c55e",2],
  [3,"17:50","18:40","Beginners Course NoGi","#3b82f6",1],
  [3,"17:45","18:40","Kids Comp Team NoGi","#ef4444",2],
  [3,"18:40","19:00","Free Mat Space","#06b6d4",1],
  [3,"18:40","19:00","Free Mat Space","#06b6d4",2],
  [3,"19:00","20:30","Advanced Gi + Sparring","#6366f1",1],
  [3,"19:00","20:30","Advanced NoGi Comp Class","#ec4899",2],
  [4,"06:30","07:20","Beginners Course NoGi","#3b82f6",1],
  [4,"06:30","07:20","Advanced Free Drilling","#8b5cf6",2],
  [4,"07:20","08:00","Advanced Sparring","#6366f1",2],
  [4,"18:00","19:00","Judo for BJJ","#14b8a6",1],
  [4,"18:00","19:00","Free Practice","#06b6d4",2],
  [4,"19:00","20:00","Advanced Sparring","#6366f1",2],
  [5,"09:00","09:45","Little Squad Advanced","#eab308",1],
  [5,"09:00","09:45","Little Squad","#eab308",2],
  [5,"10:00","10:45","Youth Squad Advanced","#f97316",1],
  [5,"10:00","10:45","Youth Squad","#f97316",2],
  [5,"11:20","12:10","Beginners Course Gi","#3b82f6",1],
  [5,"11:00","12:00","Juniors Squad","#22c55e",2],
  [5,"12:30","14:30","Open Mat","#eab308",2],
  ],
};

/** A busy club with no mats: a staggered trio, exactly three at once, five at once on Saturday. */
export const STRESS = {
  key: "stress",
  mats: [],
  noMatPlace: null,
  dark: [],
  rows: [
  [0,"16:30","17:15","Little Champs","#eab308",0],
  [0,"17:00","17:45","Kids BJJ","#f97316",0],
  [0,"17:30","18:30","Teens","#22c55e",0],
  [0,"18:40","19:30","Beginners Gi","#3b82f6",0],
  [0,"18:40","19:30","No-Gi All Levels","#6366f1",0],
  [0,"18:40","19:30","Womens Class","#14b8a6",0],
  [0,"19:30","21:00","Advanced Gi","#6366f1",0],
  [0,"19:30","20:30","Comp Team","#ec4899",0],
  [1,"09:30","11:00","Open Mat","#eab308",0],
  [1,"10:00","10:45","Morning No-Gi","#6366f1",0],
  [1,"18:40","19:30","Beginners Gi","#3b82f6",0],
  [2,"18:40","19:30","Beginners Gi","#3b82f6",0],
  [2,"19:30","21:00","Advanced Gi","#6366f1",0],
  [3,"17:00","17:45","Kids BJJ","#f97316",0],
  [3,"18:40","19:30","Beginners Gi","#3b82f6",0],
  [3,"19:30","21:00","Advanced Gi","#6366f1",0],
  [4,"18:00","19:00","Judo for BJJ","#14b8a6",0],
  [5,"10:00","10:45","Tots","#eab308",0],
  [5,"10:00","10:45","Little Champs","#eab308",0],
  [5,"10:00","10:45","Kids BJJ","#f97316",0],
  [5,"10:00","10:45","Teens","#22c55e",0],
  [5,"10:00","11:00","Parents Class","#06b6d4",0],
  [5,"11:00","12:30","Open Mat","#eab308",0],
  ],
};

/** Three mats, one with a 24-character name, a class with no mat, and two classes sharing a mat. */
export const THREE_MATS = {
  key: "three-mats",
  mats: ["Mat 1", "Mat 2", "Competition Mat Upstairs"],
  noMatPlace: "Sports hall",
  dark: [],
  rows: [
  [0,"17:00","17:45","Kids BJJ","#f97316",1],
  [0,"17:00","17:45","Little Champs","#eab308",2],
  [0,"17:00","18:00","Wrestling","#14b8a6",3],
  [0,"18:40","19:30","Beginners Gi","#3b82f6",1],
  [0,"18:40","19:30","No-Gi All Levels","#6366f1",2],
  [0,"18:40","19:30","Yoga for BJJ","#06b6d4",0],
  [0,"19:30","21:00","Advanced Gi","#6366f1",1],
  [0,"19:30","20:30","Comp Team","#ec4899",1],
  [1,"18:40","19:30","Beginners Gi","#3b82f6",1],
  [1,"18:40","19:30","Womens Class","#14b8a6",2],
  [2,"18:40","19:30","Beginners Gi","#3b82f6",1],
  [2,"19:30","21:00","Advanced Gi","#6366f1",2],
  [3,"17:00","17:45","Kids BJJ","#f97316",1],
  [3,"18:40","19:30","Beginners Gi","#3b82f6",1],
  [3,"18:40","19:30","Private lesson","#06b6d4",3],
  [4,"18:00","19:00","Judo for BJJ","#14b8a6",1],
  [5,"10:00","10:45","Tots","#eab308",1],
  [5,"10:00","10:45","Fundamentals for Beginners","#f97316",2],
  [5,"10:00","10:45","Teens Competition","#22c55e",3],
  [5,"11:00","12:30","Open Mat","#eab308",1],
  ],
};

const placeOf = (week, mat) => (mat ? week.mats[mat - 1] : week.noMatPlace);

/** The week as classes: one per name and mat, each with its schedule rows in day, start order. */
export function classesOf(week) {
  const byKey = new Map();
  for (const [day, startTime, endTime, name, color, mat] of week.rows) {
    const key = `${name}|${mat}`;
    if (!byKey.has(key)) byKey.set(key, { name, location: placeOf(week, mat), color: week.dark.includes(key) ? DARK : color, mat, schedules: [] });
    byKey.get(key).schedules.push({ dayOfWeek: dow(day), startTime, endTime });
  }
  return [...byKey.values()];
}

/** Sessions of one day (0 = Monday), in start order, each with its place. */
export function sessionsOn(week, day) {
  return week.rows
    .filter((r) => r[0] === day)
    .map(([, startTime, endTime, name, , mat]) => ({ startTime, endTime, name, place: placeOf(week, mat), start: toMin(startTime), end: toMin(endTime) }))
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || String(a.place ?? "").localeCompare(String(b.place ?? ""), "en", { numeric: true }));
}
export const countOn = (week, day) => week.rows.filter((r) => r[0] === day).length;
export const daysWithClasses = (week) => [...new Set(week.rows.map((r) => r[0]))].sort((a, b) => a - b);
/** A week chip's accessible name, less the "Edit " a manager sees and any state suffix. */
export const chipName = (s, day) => `${s.name}, ${DAY_NAME[day]} ${s.startTime} to ${s.endTime}${s.place ? `, ${s.place}` : ""}`;

/**
 * Creates the week through the app's own create API from a signed-in page (as timetable-overload does).
 * `adopt: true` (PR 2 onwards) then turns that week's typed places into mats, so the club is split by mat.
 * Returns { classes, sessions }.
 */
export async function seedWeek(page, week, { adopt = false } = {}) {
  const classes = classesOf(week);
  const statuses = [];
  for (const c of classes) {
    statuses.push(await page.evaluate(async (body) => {
      const r = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return r.status;
    }, { name: c.name, location: c.location, color: c.color, duration: toMin(c.schedules[0].endTime) - toMin(c.schedules[0].startTime), schedules: c.schedules }));
  }
  const failed = statuses.filter((s) => s !== 201);
  if (failed.length) throw new Error(`seedWeek(${week.key}): ${failed.length} of ${classes.length} creates were refused (${[...new Set(failed)].join(", ")})`);
  if (adopt) {
    const status = await page.evaluate(async (names) => {
      const r = await fetch("/api/mats/adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names }) });
      return r.status;
    }, week.mats);
    if (status !== 200) throw new Error(`seedWeek(${week.key}): adopting the mats answered ${status}`);
  }
  return { classes: classes.length, sessions: week.rows.length };
}
