// @vitest-environment jsdom
//
// More than three classes at once on the staff week: two are on show and the
// rest sit behind "+N more". Pressing it must show every one of them
// (acceptance check 3): it opens the Day view on that day with that clash
// already listed. Plan: .omc/plans/timetable-side-by-side-plan-2026-11-05.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";
import { weekChips, weekDay } from "./helpers/week";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

let nextId = 0;
const cls = (name: string, location: string | null, slot: [number, string, string]): ClassRow => ({
  id: `c${++nextId}`,
  name,
  coachName: null,
  coachUserId: null,
  coachUser: null,
  location,
  locationId: null,
  duration: 45,
  maxCapacity: null,
  color: null,
  description: null,
  requiredRankId: null,
  requiredRank: null,
  maxRankId: null,
  maxRank: null,
  schedules: [{ id: `s${++nextId}`, dayOfWeek: slot[0], startTime: slot[1], endTime: slot[2] }],
  roster: [],
  lifecycle: "active",
  archivedAt: null,
});

// Saturday 10:00: five at once. Monday 18:40: exactly three.
const WEEK: ClassRow[] = [
  cls("Tots", "Mat 1", [6, "10:00", "10:45"]),
  cls("Little Champs", "Mat 2", [6, "10:00", "10:45"]),
  cls("Kids BJJ", "Mat 3", [6, "10:00", "10:45"]),
  cls("Teens", "Mat 4", [6, "10:00", "10:45"]),
  cls("Parents Class", "Cafe", [6, "10:00", "11:00"]),
  cls("Beginners Gi", "Mat 1", [1, "18:40", "19:30"]),
  cls("No-Gi All Levels", "Mat 2", [1, "18:40", "19:30"]),
  cls("Womens Class", "Mat 3", [1, "18:40", "19:30"]),
];
const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0)); // Thursday: no fixture sessions today
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

describe("'+N more' on the week", () => {
  it("shows two of five and one button naming the rest; three at once fold nothing", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const saturday = weekDay(container, "sat");
    // The longer class is placed first, then the first by place.
    expect(weekChips(saturday).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Edit Parents Class, Saturday 10:00 to 11:00, Cafe",
      "Edit Tots, Saturday 10:00 to 10:45, Mat 1",
    ]);
    const more = within(saturday).getByTestId("week-more");
    expect(more.textContent).toBe("+3 moreOpen the day");
    expect(more.getAttribute("aria-label")).toBe("3 more sessions, Saturday 10:00 to 10:45. Open the day.");
    expect(weekChips(weekDay(container, "mon"))).toHaveLength(3);
    expect(within(weekDay(container, "mon")).queryByTestId("week-more")).toBeNull();
  });

  const saturday = () => within(screen.getByTestId("day-view")).getByRole("tab", { name: /^Saturday 7, 5 sessions$/ });
  const panel = () => within(screen.getByTestId("day-view")).queryByTestId("more-panel");

  it("opens the Day view on that day with the clash listed and every class on show", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    fireEvent.click(within(weekDay(container, "sat")).getByTestId("week-more"));
    expect(screen.getByTestId("timetable-view-day").getAttribute("aria-pressed")).toBe("true");
    expect(saturday().getAttribute("aria-selected")).toBe("true");
    const rows = within(panel()!).getAllByTestId("more-row");
    const names = rows.map((r) => r.getAttribute("aria-label")?.replace(/^Edit /, "").split(",")[0]);
    expect(names.sort()).toEqual(["Kids BJJ", "Little Champs", "Parents Class", "Teens", "Tots"]);
    expect(document.activeElement).toBe(rows[0]);
  });

  it("is used once: after closing the list, leaving Saturday and coming back does not reopen it or take focus", async () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    fireEvent.click(within(weekDay(container, "sat")).getByTestId("week-more"));
    const day = screen.getByTestId("day-view");
    fireEvent.click(within(panel()!).getByRole("button", { name: "Show fewer" }));
    await waitFor(() => expect(panel()).toBeNull());
    const friday = within(day).getByRole("tab", { name: /^Friday 6,/ });
    fireEvent.click(friday);
    friday.focus();
    fireEvent.click(saturday());
    expect(within(day).getByTestId("week-more").textContent).toContain("+3 more");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(friday);
    // Week, then Day again: the same.
    fireEvent.click(screen.getByTestId("timetable-view-week"));
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    expect(panel()).toBeNull();
  });

  it("is there for a coach too: seeing what is on is not editing", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} role="coach" />);
    const more = within(weekDay(container, "sat")).getByTestId("week-more") as HTMLButtonElement;
    expect(more.disabled).toBe(false);
    fireEvent.click(more);
    expect(within(panel()!).getAllByTestId("more-row")).toHaveLength(5);
  });
});
