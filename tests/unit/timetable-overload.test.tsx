// @vitest-environment jsdom
//
// Timetable overload: a busy day (DENSE_DAY+ sessions) widens the week and
// uses the compact two-line chip; sessions that overlap sit in a group with a
// rail and "Up to N at once" (N = how many run at the same moment, so a
// staggered 16:30 / 17:00 / 17:30 is "up to 2", not 3); chips inside a group
// show start–end and their mat; the same name, day, start and mat twice is
// flagged "Duplicate?"; the form refuses an identical slot in one class.
// Plan: .omc/plans/timetable-density-plan-2026-11-04.md.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import React from "react";
import TimetableManager, { DENSE_DAY, groupSessions, groupLabel } from "@/components/dashboard/TimetableManager";
import { duplicateSessionKeys } from "@/lib/schedule-state";
import type { ClassRow } from "@/app/dashboard/timetable/page";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
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

const grid = (container: HTMLElement) => container.querySelector(".grid-cols-7") as HTMLElement;
const column = (container: HTMLElement, index: number) => grid(container).children[index] as HTMLElement;
const chipsIn = (el: HTMLElement) => within(el).getAllByRole("button", { name: /^Edit / });
const groupsIn = (el: HTMLElement) => within(el).queryAllByRole("group");

describe("a busy day widens the week and uses compact chips", () => {
  it("14 sessions on Monday: the grid is dense, Monday's chips are compact, Tuesday's are not", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    expect(BUSY.flatMap((c) => c.schedules).filter((s) => s.dayOfWeek === 1)).toHaveLength(14);
    expect(14).toBeGreaterThanOrEqual(DENSE_DAY);
    expect(grid(container).dataset.dense).toBe("true");
    expect(grid(container).className).toContain("min-w-[1260px]");
    const monday = column(container, 0);
    expect(chipsIn(monday)).toHaveLength(14);
    expect(chipsIn(monday).every((b) => b.dataset.chipSize === "compact")).toBe(true);
    expect(within(monday).getByText("14 sessions")).toBeTruthy();
    const tuesday = column(container, 1);
    expect(chipsIn(tuesday)).toHaveLength(2);
    expect(chipsIn(tuesday).some((b) => b.dataset.chipSize === "compact")).toBe(false);
    expect(within(tuesday).getByText("2 sessions")).toBeTruthy();
  });

  it("a quiet week keeps the 980 px grid and the normal chip", () => {
    const { container } = render(<TimetableManager initialClasses={QUIET} {...PROPS} />);
    expect(grid(container).dataset.dense).toBeUndefined();
    expect(grid(container).className).toContain("min-w-[980px]");
    expect(chipsIn(column(container, 0)).some((b) => b.dataset.chipSize === "compact")).toBe(false);
    expect(within(column(container, 0)).queryByText(/sessions?$/)).toBeNull();
  });
});

describe("overlapping sessions sit in a group", () => {
  it("Monday has five groups, labelled by how many run at once, in time order", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    const groups = groupsIn(column(container, 0));
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "2 at once, 06:30 to 08:00",
      "2 at once, 12:00 to 12:50",
      "Up to 2 at once, 16:30 to 18:30",
      "3 at once, 18:40 to 19:30",
      "2 at once, 19:30 to 21:00",
    ]);
    // Open Mat and Comp Team overlap nothing: plain chips outside any group.
    const outside = chipsIn(column(container, 0)).filter((b) => !b.closest('[role="group"]'));
    expect(outside.map((b) => b.getAttribute("aria-label"))).toEqual(["Edit Open Mat", "Edit Comp Team"]);
  });

  it("chips inside a group show start–end and their mat; a staggered trio reads 'Up to 2'", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    const trio = groupsIn(column(container, 0))[2];
    expect(within(trio).getByText("Up to 2 at once")).toBeTruthy();
    const rows = chipsIn(trio).map((b) => b.textContent);
    expect(rows[0]).toContain("16:30–17:15");
    expect(rows[0]).toContain("Mat 1");
    expect(rows[0]).toContain("Little Champs");
    expect(rows[1]).toContain("17:00–17:45");
    expect(rows[1]).toContain("Mat 2");
    expect(rows[2]).toContain("17:30–18:30");
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
    expect(texts[0]).toContain("18:40–19:30");
    expect(texts[0]).toContain("Duplicate?"); // the flag takes the place's spot
    expect(texts[1]).toContain("· Mat 2");
    expect(chipsIn(clash).some((b) => b.dataset.chipSize === "compact")).toBe(false);
  });
});

describe("duplicates are flagged, never merged", () => {
  it("the same name, day, start and mat twice gets 'Duplicate?' on both; the Mat 2 session does not", () => {
    const { container } = render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    const clash = groupsIn(column(container, 0))[3];
    const chips = chipsIn(clash);
    expect(chips.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Edit Beginners Course Gi (possible duplicate)",
      "Edit Beginners Course Gi",
      "Edit Beginners Course Gi (possible duplicate)",
    ]);
    expect(within(clash).getAllByText("Duplicate?")).toHaveLength(2);
    expect(within(column(container, 0)).getAllByText("Duplicate?")).toHaveLength(2);
    expect(chipsIn(clash)).toHaveLength(3); // all three still drawn
  });

  it("duplicateSessionKeys ignores case and spacing in the name, and treats a different place as distinct", () => {
    const flagged = duplicateSessionKeys([
      { key: "a", name: "Beginners Gi", dayOfWeek: 1, startTime: "18:40", place: "Mat 1" },
      { key: "b", name: " beginners  gi ", dayOfWeek: 1, startTime: "18:40", place: "mat 1" },
      { key: "c", name: "Beginners Gi", dayOfWeek: 1, startTime: "18:40", place: "Mat 2" },
      { key: "d", name: "Beginners Gi", dayOfWeek: 2, startTime: "18:40", place: "Mat 1" },
      { key: "e", name: "Beginners Gi", dayOfWeek: 1, startTime: "18:45", place: "Mat 1" },
    ]);
    expect([...flagged].sort()).toEqual(["a", "b"]);
  });
});

describe("the form refuses an identical slot in one class", () => {
  it("two Monday 18:00–19:00 rows: says so, disables Create; changing one day clears it", async () => {
    render(<TimetableManager initialClasses={QUIET} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add class" })[0]);
    fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: "Wrestling" } });
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    const days = screen.getAllByLabelText("Day of the week");
    expect(days).toHaveLength(2);
    expect(screen.getByText(/Monday 18:00–19:00 is already in this class/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create class" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(days[1], { target: { value: "2" } });
    expect(screen.queryByText(/already in this class/)).toBeNull();
    expect((screen.getByRole("button", { name: "Create class" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
