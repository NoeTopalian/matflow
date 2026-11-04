// @vitest-environment jsdom
//
// Sean (Total BJJ): Beginners Course Gi runs three times on Monday (06:30,
// 12:00, 18:40) and the staff timetable showed one Monday chip. The week grid
// and the phone agenda were built from classes-per-day, so a class with several
// sessions on one day collapsed to its first slot. They are built from
// sessions now: one chip per (class, slot), in time order.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";
import TimetableManager, { chipStatesFor } from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const base = (over: Partial<ClassRow>): ClassRow => ({
  id: "c1",
  name: "Beginners Course Gi",
  coachName: null,
  coachUserId: null,
  coachUser: null,
  location: "Mat 1",
  locationId: null,
  duration: 50,
  maxCapacity: null,
  color: null,
  description: null,
  requiredRankId: null,
  requiredRank: null,
  maxRankId: null,
  maxRank: null,
  schedules: [],
  roster: [],
  lifecycle: "active",
  archivedAt: null,
  ...over,
});

const slot = (id: string, dayOfWeek: number, startTime: string, endTime: string) => ({ id, dayOfWeek, startTime, endTime });

// Sean's class, as the page serves it today: the three Monday slots are not in
// time order (ordered by dayOfWeek only, then insertion).
const GI = base({
  schedules: [
    slot("s-mon-eve", 1, "18:40", "19:30"),
    slot("s-mon-am", 1, "06:30", "07:20"),
    slot("s-mon-noon", 1, "12:00", "12:50"),
    slot("s-tue", 2, "17:50", "18:40"),
    slot("s-wed", 3, "06:30", "07:20"),
    slot("s-sat", 6, "11:20", "12:10"),
  ],
});
const ADVANCED = base({
  id: "c2",
  name: "Advanced Gi Comp Class",
  duration: 90,
  location: "Mat 2",
  schedules: [slot("s-adv-tue", 2, "19:00", "20:30"), slot("s-adv-mon", 1, "19:30", "21:00")],
});

const PROPS = {
  rankSystems: [],
  coachUsers: [],
  primaryColor: "var(--color-primary)",
  role: "owner",
  currentUserId: "u1",
};

beforeEach(() => {
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

/** The desktop week grid's column for a weekday (0 = Monday … 6 = Sunday). */
function gridColumn(container: HTMLElement, index: number): HTMLElement {
  const grid = container.querySelector(".grid-cols-7");
  if (!grid) throw new Error("week grid not rendered");
  return grid.children[index] as HTMLElement;
}
const chipNames = (col: HTMLElement) => within(col).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const chipTimes = (col: HTMLElement) =>
  within(col)
    .getAllByRole("button")
    .map((b) => b.textContent?.match(/\d\d:\d\d/)?.[0]);

describe("one chip per session on the week grid", () => {
  it("shows every Monday session of one class, in time order", () => {
    const { container } = render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    const monday = gridColumn(container, 0);
    expect(chipNames(monday)).toEqual(["Edit Beginners Course Gi", "Edit Beginners Course Gi", "Edit Beginners Course Gi"]);
    expect(chipTimes(monday)).toEqual(["06:30", "12:00", "18:40"]);
    // The other days are untouched: one chip each.
    expect(chipTimes(gridColumn(container, 1))).toEqual(["17:50"]);
    expect(chipTimes(gridColumn(container, 2))).toEqual(["06:30"]);
    expect(chipTimes(gridColumn(container, 5))).toEqual(["11:20"]);
    expect(within(gridColumn(container, 3)).queryAllByRole("button")).toHaveLength(0);
  });

  it("interleaves a different class by time, and every chip opens its own class", () => {
    const { container } = render(<TimetableManager initialClasses={[GI, ADVANCED]} {...PROPS} />);
    const monday = gridColumn(container, 0);
    expect(chipTimes(monday)).toEqual(["06:30", "12:00", "18:40", "19:30"]);
    expect(chipNames(monday)[3]).toBe("Edit Advanced Gi Comp Class");
    const tuesday = gridColumn(container, 1);
    expect(chipTimes(tuesday)).toEqual(["17:50", "19:00"]);
  });

  it("the phone day picker counts sessions, not classes", () => {
    render(<TimetableManager initialClasses={[GI, ADVANCED]} {...PROPS} />);
    const tabs = screen.getAllByRole("tab");
    // Mon 4 · Tue 2 · Wed 1 · Thu — · Fri — · Sat 1 · Sun —
    const counts = tabs.map((t) => t.querySelectorAll("span")[2]?.textContent);
    expect(counts).toEqual(["4", "2", "1", "—", "—", "1", "—"]);
  });
});

describe("chipStatesFor takes sessions, so Live and Next land on the right one", () => {
  const sessions = GI.schedules
    .filter((s) => s.dayOfWeek === 1)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((s) => ({ cls: GI, slot: s }));

  it("at 11:00 the 06:30 session has ended, 12:00 is next, 18:40 is upcoming", () => {
    const now = new Date(2026, 10, 2, 11, 0); // Monday 2 Nov 2026
    expect(chipStatesFor(sessions, true, new Set(), now)).toEqual(["ended", "next", "upcoming"]);
  });

  it("a cancellation is keyed on the session's own start time", () => {
    const now = new Date(2026, 10, 2, 12, 10);
    expect(chipStatesFor(sessions, true, new Set(["c1|12:00"]), now)).toEqual(["ended", "cancelled", "next"]);
  });

  it("is null for every session on another day", () => {
    expect(chipStatesFor(sessions, false)).toEqual([null, null, null]);
  });
});
