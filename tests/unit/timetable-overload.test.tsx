// @vitest-environment jsdom
//
// A busy week on the staff timetable. On the desktop week, sessions that
// overlap sit SIDE BY SIDE on the row of their start time (the poster grid,
// .omc/plans/timetable-side-by-side-plan-2026-11-05.md): a staggered
// 16:30 / 17:00 / 17:30 needs two lanes, not three; every chip shows start–end
// and its place. On the phone they still sit in a group with a rail and
// "Up to N at once". The same name, day, start and mat twice is flagged
// "Duplicate?"; the form refuses an identical slot in one class.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import React from "react";
import TimetableManager, { DENSE_DAY, groupSessions, groupLabel } from "@/components/dashboard/TimetableManager";
import { duplicateSessionKeys } from "@/lib/schedule-state";
import type { ClassRow } from "@/app/dashboard/timetable/page";
import { weekCells, weekChips, weekDay, weekGrid } from "./helpers/week";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

let nextId = 0;
const cls = (name: string, location: string | null, slots: [number, string, string][], over: Partial<ClassRow> = {}): ClassRow => ({
  id: `c${++nextId}`,
  name,
  coachName: null,
  coachUserId: null,
  coachUser: null,
  location,
  locationId: null,
  duration: 60,
  maxCapacity: null,
  color: null,
  description: null,
  requiredRankId: null,
  requiredRank: null,
  maxRankId: null,
  maxRank: null,
  schedules: slots.map(([dayOfWeek, startTime, endTime]) => ({ id: `s${++nextId}`, dayOfWeek, startTime, endTime })),
  roster: [],
  lifecycle: "active",
  archivedAt: null,
  ...over,
});

// The busy-gym Monday from the plan (§6): 14 sessions, five overlap groups,
// one staggered trio, one three-way clash with a duplicate, plus a quiet Tuesday.
const BUSY: ClassRow[] = [
  cls("Beginners Course Gi", "Mat 1", [[1, "06:30", "07:20"], [1, "12:00", "12:50"], [1, "18:40", "19:30"], [2, "17:50", "18:40"]]),
  cls("Morning No-Gi", "Mat 2", [[1, "07:00", "08:00"]]),
  cls("Open Mat", null, [[1, "09:30", "11:00"]]),
  cls("Lunch No-Gi", "Mat 2", [[1, "12:00", "12:50"]]),
  cls("Little Champs", "Mat 1", [[1, "16:30", "17:15"]]),
  cls("Kids BJJ", "Mat 2", [[1, "17:00", "17:45"]]),
  cls("Teens", "Mat 1", [[1, "17:30", "18:30"]]),
  cls("Beginners Course Gi", "Mat 2", [[1, "18:40", "19:30"]]),
  cls("Beginners Course Gi", "Mat 1", [[1, "18:40", "19:30"]]), // the accidental duplicate of the first class's 18:40
  cls("Advanced Gi Comp Class", "Mat 1", [[1, "19:30", "21:00"], [2, "19:00", "20:30"]]),
  cls("No-Gi All Levels", "Mat 2", [[1, "19:30", "20:30"]]),
  cls("Comp Team", null, [[1, "21:00", "22:00"]]),
];
const QUIET: ClassRow[] = [cls("Gi", "Mat 1", [[1, "18:00", "19:00"], [2, "18:00", "19:00"]]), cls("No-Gi", "Mat 1", [[1, "19:00", "20:00"]])];

const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0)); // Thursday: no fixture sessions, no state suffixes
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
      if (url === "/api/coach/today") return { ok: true, json: async () => [] };
      return { ok: false, json: async () => ({}) };
    }),
  );
});
afterEach(() => vi.useRealTimers());

const chipsIn = (el: HTMLElement) => within(el).getAllByRole("button", { name: /^Edit / });
const groupsIn = (el: HTMLElement) => within(el).queryAllByRole("group");
/** A Monday cell of the week grid by its start time and (optionally) a word of its text. */
const cellAt = (container: HTMLElement, start: string, word = "") => {
  const hit = weekCells(weekDay(container, "mon")).filter((c) => c.textContent?.startsWith(`${start}–`) && c.textContent.includes(word));
  if (hit.length !== 1) throw new Error(`${hit.length} Monday cells start at ${start} with "${word}"`);
  return hit[0];
};
const lane = (cell: HTMLElement) => Number(cell.dataset.lane);
const span = (cell: HTMLElement) => cell.style.getPropertyValue("--s");

describe("a busy day on the week grid", () => {
  it("14 sessions on Monday: every one is a chip, in time order, and the header counts them", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    expect(BUSY.flatMap((c) => c.schedules).filter((s) => s.dayOfWeek === 1)).toHaveLength(14);
    expect(14).toBeGreaterThanOrEqual(DENSE_DAY);
    const monday = weekDay(container, "mon");
    expect(weekChips(monday)).toHaveLength(14);
    const starts = weekCells(monday).map((c) => c.textContent?.slice(0, 5));
    expect(starts).toEqual([...starts].sort());
    expect(within(monday).getByText("14 sessions")).toBeTruthy();
    expect(monday.getAttribute("aria-label")).toBe("Monday 2 November, 14 sessions");
    const tuesday = weekDay(container, "tue");
    expect(weekChips(tuesday)).toHaveLength(2);
    expect(within(tuesday).getByText("2 sessions")).toBeTruthy();
    // The old list's width switch and brackets are gone from the week.
    expect(weekGrid(container)?.dataset.dense).toBeUndefined();
    expect(monday.querySelector('[data-testid="overlap-group"]')).toBeNull();
  });

  it("a quiet week: every session is alone, so each takes its day's full width", () => {
    const { container } = render(<TimetableManager initialClasses={QUIET} {...PROPS} />);
    for (const cell of [...weekCells(weekDay(container, "mon")), ...weekCells(weekDay(container, "tue"))]) {
      expect(cell.dataset.col).toBe("1");
      expect(span(cell)).toBe("1");
    }
    expect(container.querySelector('[data-testid="week-more"]')).toBeNull();
  });
});

describe("overlapping sessions sit side by side", () => {
  it("sessions that start together share a row line and take different lanes", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    const gi = cellAt(container, "12:00", "Beginners");
    const lunch = cellAt(container, "12:00", "Lunch");
    expect(gi.dataset.rowStart).toBe(lunch.dataset.rowStart);
    expect([lane(gi), lane(lunch)].sort()).toEqual([0, 1]);
    // Monday's widest moment is three at once, so the day is six tracks: a pair takes three each.
    expect(span(gi)).toBe("3");
    // Open Mat and Comp Team overlap nothing: the full day width.
    expect(span(cellAt(container, "09:30"))).toBe("6");
    expect(span(cellAt(container, "21:00"))).toBe("6");
  });

  it("a staggered trio needs two lanes, the first reused; each chip shows start–end and its place", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    const [champs, kids, teens] = [cellAt(container, "16:30"), cellAt(container, "17:00"), cellAt(container, "17:30")];
    expect([lane(champs), lane(kids), lane(teens)]).toEqual([0, 1, 0]);
    expect(champs.textContent).toContain("16:30–17:15");
    expect(champs.textContent).toContain("Mat 1");
    expect(champs.textContent).toContain("Little Champs");
    expect(kids.textContent).toContain("17:00–17:45");
    expect(kids.textContent).toContain("Mat 2");
    expect(teens.textContent).toContain("17:30–18:30");
    // A later start is a later row line.
    expect(Number(kids.dataset.rowStart)).toBeGreaterThan(Number(champs.dataset.rowStart));
  });

  it("three at once are three lanes, ordered by place, and nothing is folded", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    const clash = weekCells(weekDay(container, "mon")).filter((c) => c.textContent?.startsWith("18:40–"));
    expect(clash.map((c) => c.dataset.col)).toEqual(["1", "3", "5"]);
    expect(clash.map((c) => /Mat \d/.exec(c.textContent ?? "")?.[0])).toEqual(["Mat 1", "Mat 1", "Mat 2"]);
    expect(container.querySelector('[data-testid="week-more"]')).toBeNull();
  });

  it("groupSessions: lanes are the real maximum running at once", () => {
    const [gi, , , , champs, kids, teens] = BUSY;
    const staggered = [champs, kids, teens].map((c) => ({ cls: c, slot: c.schedules[0] }));
    expect(groupSessions(staggered).map((g) => [g.members, g.lanes])).toEqual([[[0, 1, 2], 2]]);
    const trio = [gi, BUSY[7], BUSY[8]].map((c) => ({ cls: c, slot: c.schedules.find((s) => s.startTime === "18:40")! }));
    expect(groupSessions(trio).map(groupLabel)).toEqual(["3 at once"]);
    const apart = [gi.schedules[0], gi.schedules[1]].map((slot) => ({ cls: gi, slot }));
    expect(groupSessions(apart).map((g) => g.members)).toEqual([[0], [1]]);
  });

  it("the phone agenda shows the same groups with full-width rows", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("tab")[0]); // Monday
    const agenda = screen.getByRole("tablist", { name: "Day of week" }).nextElementSibling as HTMLElement;
    expect(groupsIn(agenda)).toHaveLength(5);
    const clash = groupsIn(agenda)[3];
    const texts = chipsIn(clash).map((b) => b.textContent);
    // Same name and start: ordered by place, so the two Mat 1 entries sit together.
    expect(texts[0]).toContain("18:40–19:30");
    expect(texts[0]).toContain("· Mat 1");
    expect(texts[0]).toContain("Duplicate?");
    expect(texts[1]).toContain("Duplicate?");
    expect(texts[2]).toContain("· Mat 2");
    expect(texts[2]).not.toContain("Duplicate?");
    expect(chipsIn(clash).some((b) => b.dataset.chipSize === "compact")).toBe(false);
  });
});

describe("duplicates are flagged, never merged", () => {
  it("the same name, day, start and mat twice gets 'Duplicate?' on both; the Mat 2 session does not", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    const monday = weekDay(container, "mon");
    const chips = weekChips(monday).filter((b) => b.textContent?.startsWith("18:40–"));
    expect(chips.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 1 (possible duplicate)",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 1 (possible duplicate)",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 2",
    ]);
    expect(within(monday).getAllByText("Duplicate?")).toHaveLength(2);
    expect(chips).toHaveLength(3); // all three still drawn
  });

  it("duplicateSessionKeys ignores case and spacing in the name, and treats a different place or venue as distinct", () => {
    const flagged = duplicateSessionKeys([
      { key: "a", name: "Beginners Gi", dayOfWeek: 1, startTime: "18:40", place: "Mat 1" },
      { key: "b", name: " beginners  gi ", dayOfWeek: 1, startTime: "18:40", place: "mat 1" },
      { key: "c", name: "Beginners Gi", dayOfWeek: 1, startTime: "18:40", place: "Mat 2" },
      { key: "d", name: "Beginners Gi", dayOfWeek: 2, startTime: "18:40", place: "Mat 1" },
      { key: "e", name: "Beginners Gi", dayOfWeek: 1, startTime: "18:45", place: "Mat 1" },
      { key: "f", name: "Beginners Gi", dayOfWeek: 1, startTime: "18:40", place: "Mat 1", venue: "venue-b" },
    ]);
    expect([...flagged].sort()).toEqual(["a", "b"]);
  });

  it("groupSessions: an overnight pair is one group of two lanes", () => {
    const late = cls("Late Open Mat", null, [[5, "22:00", "00:30"]]);
    const wrestling = cls("Wrestling", null, [[5, "23:00", "23:30"]]);
    const g = groupSessions([late, wrestling].map((c) => ({ cls: c, slot: c.schedules[0] })));
    expect(g).toEqual([{ members: [0, 1], lanes: 2, startMin: 22 * 60, endMin: 24 * 60 + 30 }]);
  });
});

describe("the form refuses the same day and start twice in one class", () => {
  it("two Monday 18:00 rows: says so once, disables Create; a different end is still the same session; changing the day clears it", async () => {
    render(<TimetableManager initialClasses={QUIET} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add class" })[0]);
    fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: "Wrestling" } });
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    const days = screen.getAllByLabelText("Day of the week");
    expect(days).toHaveLength(3);
    // Three identical rows name the slot once.
    expect(screen.getAllByText(/Monday 18:00 is already in this class/)).toHaveLength(1);
    expect(screen.getByText(/Monday 18:00 is already in this class/).textContent).not.toMatch(/Monday 18:00, Monday 18:00/);
    expect((screen.getByRole("button", { name: "Create class" }) as HTMLButtonElement).disabled).toBe(true);
    // A longer second row (same start, later end) is the same session downstream: still refused.
    const ends = screen.queryAllByLabelText("End time");
    if (ends.length) fireEvent.change(ends[1], { target: { value: "19:30" } });
    else fireEvent.change(screen.getAllByLabelText("Duration (mins)")[1], { target: { value: "90" } });
    expect(screen.getAllByText(/Monday 18:00 is already in this class/)).toHaveLength(1);
    fireEvent.change(days[1], { target: { value: "2" } });
    fireEvent.change(days[2], { target: { value: "3" } });
    expect(screen.queryByText(/already in this class/)).toBeNull();
    expect((screen.getByRole("button", { name: "Create class" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
