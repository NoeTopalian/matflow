// @vitest-environment jsdom
//
// Staff Day view. Since 6 Nov 2026 it is the same one-day poster grid a phone
// shows (Noe: on a wide screen the clock-scale view did not show when the day
// starts): rows are the real start times, a gap says "No classes 07:20 to
// 16:30", chips lead with their time, a clash wider than three is two chips
// and "+N more". Week ⇄ Day on the staff timetable; each chip opens its class.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { clusterSessions } from "@/lib/schedule-state";
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dayView = () => screen.getByTestId("day-view");
const tab = (name: RegExp) => within(dayView()).getByRole("tab", { name });
const grid = () => within(dayView()).getByTestId("phone-day-grid");
const chips = () => [...grid().querySelectorAll<HTMLElement>("[data-cell-key] button")];

describe("lib/schedule-state — clustering", () => {
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

  it("Week is the default; Day shows today (nothing on), then Monday's classes in time order; a chip opens its class", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    expect(screen.getByTestId("week-scroller")).toBeTruthy();
    expect(screen.queryByTestId("day-view")).toBeNull();
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    expect(screen.queryByTestId("week-scroller")).toBeNull();
    expect(dayView().textContent).toContain("No classes scheduled."); // Thursday
    expect(tab(/^Thursday 5, today, no sessions$/).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab(/^Monday 2, 5 sessions$/));
    expect(chips().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Edit Beginners Course Gi, Monday 06:30 to 07:20, Mat 1",
      "Edit Little Champs, Monday 16:30 to 17:15, Mat 1",
      "Edit Kids BJJ, Monday 17:00 to 17:45, Mat 2",
      "Edit Teens, Monday 17:30 to 18:30, Mat 3",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 1",
    ]);
    fireEvent.click(chips()[2]);
    expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Kids BJJ");
  });

  it("the day starts at its first class: the first time on the left is that start, and a gap is said in words", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    fireEvent.click(tab(/^Monday/));
    const ticks = [...grid().querySelectorAll(".pg-tick")].map((t) => t.textContent);
    expect(ticks[0]).toBe("06:30");
    expect(ticks).not.toContain("06:00");
    expect(grid().textContent).toContain("No classes 07:20 to 16:30");
    // Each chip leads with its own time.
    expect(chips()[0].querySelector('[data-chip-part="time"]')?.textContent).toContain("06:30");
  });

  it("Saturday's four-way clash is two chips and '+2 more', which lists all four; another day closes it; Week brings the grid back", async () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    fireEvent.click(tab(/^Saturday 7, 4 sessions$/));
    expect(chips()).toHaveLength(2);
    const more = within(grid()).getByTestId("week-more");
    expect(more.getAttribute("aria-label")).toBe("2 more sessions, 10:00 to 10:45. Show them.");
    fireEvent.click(more);
    expect(within(within(grid()).getByTestId("more-panel")).getAllByTestId("more-row")).toHaveLength(4);
    // An open list does not follow to another day, or come back with this one.
    fireEvent.click(tab(/^Monday/));
    fireEvent.click(tab(/^Saturday/));
    await waitFor(() => expect(within(grid()).queryByTestId("more-panel")).toBeNull());
    fireEvent.click(screen.getByTestId("timetable-view-week"));
    expect(screen.getByTestId("week-scroller")).toBeTruthy();
    expect(screen.queryByTestId("day-view")).toBeNull();
  });

  it("a coach sees the Day view but cannot edit: chips carry no verb and open nothing", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} role="coach" currentUserId="coach-1" />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    fireEvent.click(tab(/^Monday/));
    expect(chips()).toHaveLength(5);
    expect(chips()[2].getAttribute("aria-label")).toBe("Kids BJJ, Monday 17:00 to 17:45, Mat 2");
    fireEvent.click(chips()[2]);
    expect(screen.queryByLabelText("Class Name")).toBeNull();
  });

  it("'Today' returns the Day view to today as well as this week", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    expect(screen.queryByRole("button", { name: "Today" })).toBeNull();
    fireEvent.click(tab(/^Monday/));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(dayView().textContent).toContain("No classes scheduled."); // Thursday again
    expect(tab(/^Thursday 5, today/).getAttribute("aria-selected")).toBe("true");
  });

  it("on a wide window the day's card stops at a readable width instead of stretching one class across the screen", () => {
    render(<TimetableManager initialClasses={BUSY} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    fireEvent.click(tab(/^Monday/));
    expect(within(dayView()).getByTestId("phone-day").style.maxWidth).toBe("880px");
  });
});
