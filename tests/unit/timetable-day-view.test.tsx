// @vitest-environment jsdom
//
// Staff Day view (PR C of .omc/plans/timetable-density-plan-2026-11-04.md):
// one day on a time axis, overlapping sessions side by side in lanes, a clash
// wider than three lanes folded into one group, the same hour window and lane
// maths as the member day view (lib/schedule-state). Week ⇄ Day toggle on the
// staff timetable; each block opens its own class.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { DayGrid, MIN_BLOCK_PX, type DayGridItem } from "@/components/schedule/DayGrid";
import { clusterSessions, hourWindow } from "@/lib/schedule-state";
import type { ClassRow } from "@/app/dashboard/timetable/page";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

let nextId = 0;
const cls = (name: string, location: string | null, slots: [number, string, string][]): ClassRow => ({
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
});

const item = (key: string, name: string, startTime: string, endTime: string, over: Partial<DayGridItem> = {}): DayGridItem => ({
  key, name, startTime, endTime, color: "#3b82f6", ...over,
});

const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0)); // Thursday 5 Nov 2026
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

/** Every session block in DOM order (enabled or not — a coach's are disabled). */
const blocks = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>("[data-day-grid-block]"));
const leftOf = (el: HTMLElement) => el.style.left;

describe("DayGrid — lanes, groups and the hour axis", () => {
  it("a staggered trio takes two lanes: the third session drops back into the first lane", () => {
    const { container } = render(
      <DayGrid
        items={[item("a", "Little Champs", "16:30", "17:15"), item("b", "Kids BJJ", "17:00", "17:45"), item("c", "Teens", "17:30", "18:30")]}
        startHour={16} endHour={19} hourHeight={36}
      />,
    );
    const [a, b, c] = blocks(container);
    expect([leftOf(a), leftOf(b), leftOf(c)]).toEqual(["0%", "50%", "0%"]);
    expect(a.style.top).toBe("18px"); // 16:30 at 36 px/h
    expect(a.style.height).toBe(`${MIN_BLOCK_PX}px`); // 45 min is 27 px here, held at the minimum
    expect(c.style.height).toBe("36px");
  });

  it("four at once fold into one group that opens to four blocks and collapses again", () => {
    const onActivate = vi.fn();
    const { container } = render(
      <DayGrid
        items={["Little Champs", "Kids BJJ", "Teens", "Juniors Comp"].map((n, i) => item(`k${i}`, n, "10:00", "10:45", { meta: `Mat ${i + 1}` }))}
        startHour={9} endHour={12} onActivate={onActivate} action="Edit"
      />,
    );
    expect(within(container).queryAllByRole("button", { name: /^Edit / })).toHaveLength(0);
    const group = screen.getByTestId("day-grid-cluster");
    expect(group.textContent).toContain("4 classes at once");
    expect(group.textContent).toContain("10:00–10:45");
    fireEvent.click(group);
    const open = screen.getByTestId("day-grid-cluster-open");
    expect(blocks(open)).toHaveLength(4);
    expect(blocks(open)[1].textContent).toContain("Mat 2");
    fireEvent.click(blocks(open)[2]);
    expect(onActivate).toHaveBeenCalledWith("k2");
    fireEvent.click(within(open).getByRole("button", { name: "Collapse" }));
    expect(screen.queryByTestId("day-grid-cluster-open")).toBeNull();
  });

  it("names each block with its time, state and duplicate flag; short blocks keep the minimum height", () => {
    const { container } = render(
      <DayGrid
        items={[
          item("x", "Beginners Gi", "18:40", "19:30", { meta: "Mat 1", duplicate: true, state: "next" }),
          item("y", "Quick Drill", "19:30", "19:40", { meta: "Mat 2" }),
        ]}
        startHour={18} endHour={21} hourHeight={48} action="Edit" onActivate={vi.fn()}
      />,
    );
    const [x, y] = blocks(container);
    expect(x.getAttribute("aria-label")).toBe("Edit Beginners Gi, 18:40 to 19:30 (next) (possible duplicate)");
    expect(x.textContent).toContain("Duplicate?");
    expect(x.textContent).toContain("18:40–19:30 · Mat 1"); // 40 px: two lines
    expect(y.getAttribute("aria-label")).toBe("Edit Quick Drill, 19:30 to 19:40");
    expect(y.style.height).toBe(`${MIN_BLOCK_PX}px`);
    expect(y.textContent).toContain("Quick Drill · Mat 2"); // short: the mat stays, inline
  });

  it("a short block never paints over the next session in its lane; an overnight block stops at the grid's end", () => {
    const { container } = render(
      <DayGrid
        items={[item("a", "Drill", "18:00", "18:10"), item("b", "Sparring", "18:15", "19:00"), item("c", "Late Open Mat", "22:30", "00:30")]}
        startHour={18} endHour={23} hourHeight={56}
      />,
    );
    const [a, b, c] = blocks(container);
    expect(a.style.height).toBe("14px"); // 10 min would be 9 px → the 28 px minimum → capped at the 15-min gap (14 px)
    expect(b.style.top).toBe("14px");
    expect(c.style.top).toBe("252px"); // 22:30
    expect(c.style.height).toBe("28px"); // 2 h would run 112 px; the grid ends 28 px below its start
  });

  it("draws every hour label and says when there is nothing", () => {
    const { container } = render(<DayGrid items={[]} startHour={6} endHour={9} emptyText="No sessions on this day" />);
    expect(container.textContent).toContain("06:00");
    expect(container.textContent).toContain("09:00");
    expect(container.textContent).toContain("No sessions on this day");
  });
});

describe("lib/schedule-state — the shared window and clustering", () => {
  it("hourWindow: earliest − 1 h to latest + 1 h, clamped to 06–23, never under 8 h, 09–21 when empty", () => {
    expect(hourWindow([])).toEqual({ startHour: 9, endHour: 21 });
    expect(hourWindow([{ startTime: "06:30", endTime: "07:20" }, { startTime: "21:00", endTime: "22:00" }])).toEqual({ startHour: 6, endHour: 23 });
    expect(hourWindow([{ startTime: "12:00", endTime: "12:50" }])).toEqual({ startHour: 11, endHour: 19 });
    expect(hourWindow([{ startTime: "20:00", endTime: "21:00" }])).toEqual({ startHour: 15, endHour: 23 });
  });
  it("clusterSessions: lanes are the true maximum at once; an overnight pair is one cluster", () => {
    expect(clusterSessions([
      { startTime: "16:30", endTime: "17:15" }, { startTime: "17:00", endTime: "17:45" }, { startTime: "17:30", endTime: "18:30" },
    ])).toEqual([{ members: [0, 1, 2], lanes: 2, startMin: 990, endMin: 1110 }]);
    expect(clusterSessions([{ startTime: "22:00", endTime: "00:30" }, { startTime: "23:00", endTime: "23:30" }])).toEqual([
      { members: [0, 1], lanes: 2, startMin: 1320, endMin: 1470 },
    ]);
  });
});

describe("staff timetable — the Day view", () => {
  const BUSY = [
    cls("Beginners Course Gi", "Mat 1", [[1, "06:30", "07:20"], [1, "18:40", "19:30"]]),
    cls("Little Champs", "Mat 1", [[1, "16:30", "17:15"], [6, "10:00", "10:45"]]),
    cls("Kids BJJ", "Mat 2", [[1, "17:00", "17:45"], [6, "10:00", "10:45"]]),
    cls("Teens", "Mat 3", [[1, "17:30", "18:30"], [6, "10:00", "10:45"]]),
    cls("Juniors Comp", "Mat 4", [[6, "10:00", "10:45"]]),
  ];

  it("Week is the default; Day shows today's (empty) grid, then Monday's sessions in lanes; a block opens its class", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    expect(screen.getByTestId("week-scroller")).toBeTruthy();
    expect(screen.queryByTestId("day-view")).toBeNull();
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    const day = screen.getByTestId("day-view");
    expect(screen.queryByTestId("week-scroller")).toBeNull();
    expect(day.textContent).toContain("No sessions on this day"); // Thursday
    fireEvent.click(within(day).getByRole("button", { name: /^Monday/ }));
    const mon = blocks(screen.getByTestId("day-grid"));
    expect(mon.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Edit Beginners Course Gi, 06:30 to 07:20",
      "Edit Little Champs, 16:30 to 17:15",
      "Edit Kids BJJ, 17:00 to 17:45",
      "Edit Teens, 17:30 to 18:30",
      "Edit Beginners Course Gi, 18:40 to 19:30",
    ]);
    expect([leftOf(mon[1]), leftOf(mon[2]), leftOf(mon[3])]).toEqual(["0%", "50%", "0%"]);
    expect(mon[2].textContent).toContain("Mat 2");
    fireEvent.click(mon[2]);
    expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Kids BJJ");
  });

  it("Saturday's four-way clash is one group until opened; Week brings the grid back", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    fireEvent.click(within(screen.getByTestId("day-view")).getByRole("button", { name: /^Saturday/ }));
    expect(screen.getByTestId("day-grid-cluster").textContent).toContain("4 classes at once");
    fireEvent.click(screen.getByTestId("day-grid-cluster"));
    expect(blocks(screen.getByTestId("day-grid-cluster-open"))).toHaveLength(4);
    // Focus follows the group as it opens, and returns to it on collapse.
    expect(document.activeElement).toBe(blocks(screen.getByTestId("day-grid-cluster-open"))[0]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(document.activeElement).toBe(screen.getByTestId("day-grid-cluster"));
    // An open group does not leak to another day: Monday, then back to Saturday, is folded again.
    fireEvent.click(screen.getByTestId("day-grid-cluster"));
    fireEvent.click(within(screen.getByTestId("day-view")).getByRole("button", { name: /^Monday/ }));
    fireEvent.click(within(screen.getByTestId("day-view")).getByRole("button", { name: /^Saturday/ }));
    expect(screen.queryByTestId("day-grid-cluster-open")).toBeNull();
    fireEvent.click(screen.getByTestId("timetable-view-week"));
    expect(screen.getByTestId("week-scroller")).toBeTruthy();
    expect(screen.queryByTestId("day-view")).toBeNull();
  });

  it("a coach sees the Day view but cannot edit: blocks are disabled, carry no verb, and open nothing", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} role="coach" currentUserId="coach-1" />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    fireEvent.click(within(screen.getByTestId("day-view")).getByRole("button", { name: /^Monday/ }));
    const mon = within(screen.getByTestId("day-grid")).getAllByRole("button", { name: /, \d\d:\d\d to / });
    expect(mon).toHaveLength(5);
    expect(mon.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(mon.map((b) => b.getAttribute("aria-label"))[2]).toBe("Kids BJJ, 17:00 to 17:45");
    fireEvent.click(mon[2]);
    expect(screen.queryByLabelText("Class Name")).toBeNull();
  });

  it("'Today' returns the Day view to today as well as this week", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    expect(screen.queryByRole("button", { name: "Today" })).toBeNull();
    fireEvent.click(within(screen.getByTestId("day-view")).getByRole("button", { name: /^Monday/ }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId("day-view").textContent).toContain("No sessions on this day"); // Thursday again
    expect(within(screen.getByTestId("day-view")).getByRole("button", { name: /^Thursday 5, today/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the Day view uses the club's hour window across the week", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    const grid = screen.getByTestId("day-grid");
    // 06:30 earliest → 05 → clamped to 06; 19:30 latest → ceil 20 + 1 → 21: 06–21 (15 h) at 56 px/h.
    expect(grid.textContent).toContain("06:00");
    expect(grid.textContent).toContain("21:00");
    expect(grid.textContent).not.toContain("22:00");
    expect(grid.style.height).toBe(`${15 * 56}px`);
  });
});
