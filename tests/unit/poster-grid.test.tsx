// @vitest-environment jsdom
//
// The staff week as a poster grid (components/schedule/PosterGrid.tsx,
// WeekChip.tsx), through the real TimetableManager. jsdom has no layout, so
// this pins STRUCTURE: the day groups and their names, the grid lines each
// cell asks for, what a chip says and exposes, and what is hidden from a
// screen reader. Geometry (same top, no overlap, nothing cut) is the browser
// journey's job. Plan: .omc/plans/timetable-side-by-side-plan-2026-11-05.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { buildTimetableGrid } from "@/lib/timetable-grid";
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

// A week shaped like the club's poster on its Thursday: at 18:45 one class has
// ended, two are live side by side, two are next.
const WEEK: ClassRow[] = [
  cls("Juniors Squad", "Mat 2", [[4, "16:45", "17:45"]], { isKids: true }),
  cls("Free Mat Space", "Mat 1", [[4, "18:40", "19:00"]]),
  cls("Free Mat Space", "Mat 2", [[4, "18:40", "19:00"]]),
  cls("Advanced Gi + Sparring", "Mat 1", [[4, "19:00", "20:30"]], { categoryId: "cat-comp", categoryName: "Competition" }),
  cls("Advanced NoGi Comp Class", "Mat 2", [[4, "19:00", "20:30"]]),
  cls("Beginners Course Gi", "Mat 1", [[1, "06:30", "07:20"], [1, "12:00", "12:50"]]),
  cls("Advanced Free Drilling", "Mat 2", [[1, "06:30", "07:20"]]),
  cls("Open Mat", null, [[6, "12:30", "14:30"]], { coachName: "Sam Coach" }),
];

const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 18, 45)); // Thursday 5 Nov 2026, 18:45
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
  vi.restoreAllMocks();
});

describe("days are groups", () => {
  it("names each day with its date, its count and whether it is today", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    expect(weekDay(container, "mon").getAttribute("role")).toBe("group");
    expect(weekDay(container, "mon").getAttribute("aria-label")).toBe("Monday 2 November, 3 sessions");
    expect(weekDay(container, "sat").getAttribute("aria-label")).toBe("Saturday 7 November, 1 session");
    expect(weekDay(container, "thu").getAttribute("aria-label")).toBe("Thursday 5 November, 5 sessions, today");
    expect(weekDay(container, "sun").getAttribute("aria-label")).toBe("Sunday 8 November, no sessions");
  });

  it("marks today with the word, not with the club colour", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const today = weekDay(container, "thu");
    expect(today.hasAttribute("data-today")).toBe(true);
    expect(within(today).getByText("Today")).toBeTruthy();
    expect(weekDay(container, "mon").hasAttribute("data-today")).toBe(false);
    expect(within(weekDay(container, "mon")).queryByText("Today")).toBeNull();
    // The day name never takes the accent: it is the text colour on every day.
    expect(within(today).getByText(/^Thu 5/).className).toContain("text-tx-1");
  });

  it("collapses a day with no sessions to its name and a dash that a screen reader does not hear", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const sunday = weekDay(container, "sun");
    expect(weekChips(sunday)).toHaveLength(0);
    expect(within(sunday).getByText("Sun")).toBeTruthy();
    expect(within(sunday).getByText("—").getAttribute("aria-hidden")).toBe("true");
  });

  it("an empty today shows the word in place of the dash", () => {
    vi.setSystemTime(new Date(2026, 10, 8, 10, 0)); // Sunday
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const sunday = weekDay(container, "sun");
    // An empty day is as wide as the others while there is room, and 40 px when the week is squeezed. Both
    // forms are in the page and the header's own width picks one (a container query; the journey measures it).
    const pills = within(sunday).getAllByText("Today");
    expect(pills).toHaveLength(2);
    // Squeezed: the narrow pill (a size down, no border, no letter-spacing) in the column's body, where the
    // dash would be. The browser journey measures that it stays inside 36 px.
    const pill = pills.find((p) => p.closest(".pg-empty"))!;
    expect(pill.className).toContain("text-[8px]");
    expect(pill.className).not.toMatch(/\bborder\b|tracking-wide/);
    expect(pill.parentElement!.className).toContain("@[96px]:hidden");
    // With room: the full pill beside the name in the header, "No classes" under it, and the dash in the body.
    const wide = sunday.querySelector<HTMLElement>('[data-empty-head="wide"]')!;
    expect(within(wide).getByText("Today").className).toContain("tracking-wide");
    expect(within(wide).getByText("No classes")).toBeTruthy();
    expect(wide.className).toContain("@[96px]:flex");
    expect(within(sunday).getByText("—").className).toContain("@[96px]:inline");
    // A day with classes keeps the full pill in its header.
    vi.setSystemTime(new Date(2026, 10, 5, 10, 0)); // Thursday
    cleanup();
    const again = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const full = within(weekDay(again.container, "thu")).getByText("Today");
    expect(full.className).toContain("text-[9px]");
    expect(full.closest("[data-day-head]")).not.toBeNull();
  });
});

describe("cells sit on the engine's lines", () => {
  it("every cell asks for the row lines and column the engine gave it", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const sessions = WEEK.flatMap((c) => c.schedules.map((slot) => ({ key: slot.id, day: slot.dayOfWeek, startTime: slot.startTime, endTime: slot.endTime, matId: null, tie: c.location ?? "" })));
    const grid = buildTimetableGrid(sessions, { days: [1, 2, 3, 4, 5, 6, 0], layout: "time", mats: [] });
    const cells = Array.from(weekGrid(container)!.querySelectorAll<HTMLElement>("[data-cell-key]"));
    expect(cells).toHaveLength(sessions.length);
    for (const cell of cells) {
      const item = grid.items.find((i) => i.type === "session" && i.key === cell.dataset.cellKey);
      if (!item || item.type !== "session") throw new Error("cell without an engine item");
      expect([cell.dataset.rowStart, cell.dataset.rowEnd, cell.dataset.col, cell.dataset.lane]).toEqual([item.rowStart, item.rowEnd, item.col, item.lane].map(String));
      expect(cell.style.getPropertyValue("--c")).toBe(String(item.col));
      expect(cell.style.getPropertyValue("--s")).toBe(String(item.span));
      expect(cell.style.getPropertyValue("--r1")).toBe(String(item.rowStart));
    }
  });

  it("two classes at the same time are two cells on one row line, and each day carries its own column offset", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const live = weekCells(weekDay(container, "thu")).filter((c) => c.textContent?.startsWith("18:40–"));
    expect(live).toHaveLength(2);
    expect(live[0].dataset.rowStart).toBe(live[1].dataset.rowStart);
    expect(live.map((c) => c.dataset.lane)).toEqual(["0", "1"]);
    const offsets = ["mon", "tue", "wed", "thu"].map((d) => Number(weekDay(container, d).style.getPropertyValue("--d")));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(offsets).size).toBe(4);
  });

  it("the DOM order inside a day is time, then column", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const order = weekCells(weekDay(container, "thu")).map((c) => `${c.textContent?.slice(0, 5)} ${c.dataset.col}`);
    expect(order).toEqual(["16:45 1", "18:40 1", "18:40 2", "19:00 1", "19:00 2"]);
  });

  it("hides the time gutter and the 'No classes' rows from a screen reader", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const grid = weekGrid(container)!;
    const ticks = Array.from(grid.querySelectorAll(".pg-tick"));
    expect(ticks.length).toBeGreaterThan(3);
    expect(ticks.every((t) => t.getAttribute("aria-hidden") === "true")).toBe(true);
    const breaks = Array.from(grid.querySelectorAll(".pg-break"));
    expect(breaks.map((b) => b.textContent)).toContain("No classes 07:20 to 12:00");
    expect(breaks.every((b) => b.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});

describe("a chip", () => {
  it("says the class, the day, the time range and the place; states and duplicates follow", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const names = weekChips(weekDay(container, "thu")).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Edit Juniors Squad, Thursday 16:45 to 17:45, Mat 2 (ended)",
      "Edit Free Mat Space, Thursday 18:40 to 19:00, Mat 1 (live)",
      "Edit Free Mat Space, Thursday 18:40 to 19:00, Mat 2 (live)",
      "Edit Advanced Gi + Sparring, Thursday 19:00 to 20:30, Mat 1 (next)",
      "Edit Advanced NoGi Comp Class, Thursday 19:00 to 20:30, Mat 2 (next)",
    ]);
    expect(weekChips(weekDay(container, "thu")).map((b) => b.dataset.sessionState)).toEqual(["ended", "live", "live", "next", "next"]);
    // Another day carries no state.
    expect(weekChips(weekDay(container, "mon")).every((b) => b.dataset.sessionState === undefined)).toBe(true);
    // No typed place: the coach stands in, as on the list it replaces.
    expect(weekChips(weekDay(container, "sat"))[0].getAttribute("aria-label")).toBe("Edit Open Mat, Saturday 12:30 to 14:30, Sam Coach");
  });

  it("leads with the time, shows the whole name and the place, and never clamps time or name", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const chip = weekChips(weekDay(container, "thu"))[3];
    const [time, name, place] = ["time", "name", "place"].map((part) => chip.querySelector<HTMLElement>(`[data-chip-part="${part}"]`)!);
    expect(chip.textContent?.startsWith("19:00–20:30Advanced Gi + Sparring")).toBe(true);
    expect(place.textContent).toBe("Mat 1");
    for (const el of [time, name]) expect(el.className).not.toMatch(/truncate|line-clamp|whitespace-nowrap/);
    expect(chip.className).toContain("whitespace-normal");
    expect(chip.className).not.toContain("whitespace-nowrap");
  });

  it("carries the same tags as before: state, Kids and category", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const [juniors, , , advanced] = weekChips(weekDay(container, "thu"));
    expect(within(juniors).getByText("Ended")).toBeTruthy();
    expect(within(juniors).getByText("Kids")).toBeTruthy();
    expect(within(advanced).getByText("Next")).toBeTruthy();
    expect(within(advanced).getByTestId("class-chip-category").textContent).toBe("Competition");
  });

  it("opens its own class for an owner", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    fireEvent.click(weekChips(weekDay(container, "sat"))[0]);
    expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Open Mat");
  });

  it("is a disabled button for a coach, at full strength, named without 'Edit'", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} role="coach" />);
    const chip = weekChips(weekDay(container, "sat"))[0];
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute("aria-label")).toBe("Open Mat, Saturday 12:30 to 14:30, Sam Coach");
    expect(chip.className).toContain("disabled:opacity-100");
    expect(chip.className).not.toContain("disabled:opacity-50");
  });
});

describe("the scroll box", () => {
  it("is one labelled, focusable region with room kept clear under the pinned header", () => {
    render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const box = screen.getByRole("region", { name: "Week timetable" });
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("data-testid")).toBe("week-scroller");
    // The 44 px day-name band and the 36 px gutter, each plus room for a focused chip's ring (3 px out).
    expect(box.style.scrollPaddingTop).toBe("50px");
    expect(box.style.scrollPaddingLeft).toBe("40px");
  });

  it("renders without ResizeObserver and says nothing about width", () => {
    expect(typeof ResizeObserver).toBe("undefined");
    render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    expect(screen.getByTestId("week-wider").textContent).toBe("");
  });

});

// jsdom lays nothing out, so the box and the cell it should open on are given
// positions here; what is pinned is the arithmetic and WHEN it runs.
describe("where the box opens", () => {
  const rect = (top: number, left: number, width = 100) => ({ top, left, right: left + width, bottom: top + 50, width, height: 50, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  /** The box sits at (100, 50); `at` says where one cell sits, picked by `pick`. */
  const layOut = (pick: (el: Element) => boolean, at: { top: number; left: number }) =>
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.matches('[data-testid="week-scroller"]')) return rect(100, 50, 900);
      if (pick(this)) return rect(at.top, at.left);
      return rect(0, 0, 0);
    });
  const isLiveCell = (el: Element) => el.matches("[data-cell-key]") && el.querySelector('[data-session-state="live"]') !== null;
  const box = () => screen.getByTestId("week-scroller");

  it("puts today's live class just under the pinned day names and brings its column into view, by assigning scroll positions", () => {
    const scrollIntoView = vi.fn();
    const had = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      layOut(isLiveCell, { top: 700, left: 600 });
      render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
      // 700 − 100 (the box's top) − 44 (the day-name band) − 4
      expect(box().scrollTop).toBe(552);
      // 600 − 50 (the box's left) − 36 (the gutter) − 6 (the day gap)
      expect(box().scrollLeft).toBe(508);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body);
    } finally {
      if (had) Object.defineProperty(Element.prototype, "scrollIntoView", had);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("does it once: when the live class ends and the next begins, an ordinary re-render leaves the box where the reader scrolled it", () => {
    layOut(isLiveCell, { top: 700, left: 600 });
    render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    expect(box().scrollTop).toBe(552);
    box().scrollTop = 20; // the reader scrolls to the morning
    box().scrollLeft = 0;
    vi.setSystemTime(new Date(2026, 10, 5, 19, 5)); // 18:40 has ended, 19:00 is live: a different target
    fireEvent.click(screen.getByTestId("timetable-expand")); // any state change re-renders the page
    expect(weekChips(weekDay(document.body, "thu")).map((b) => b.dataset.sessionState)).toContain("ended");
    expect(box().scrollTop).toBe(20);
    expect(box().scrollLeft).toBe(0);
  });

  it("positions again when the week on show changes: another week starts at the top", () => {
    layOut(isLiveCell, { top: 700, left: 600 });
    render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    expect(box().scrollTop).toBe(552);
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(box().scrollTop).toBe(0);
    expect(box().scrollLeft).toBe(0);
  });

  it("opens on the '+N more' button when today's live class is folded behind it", () => {
    // Five at once now. The page's own order is by name, so "Aaa" is its first live class; the grid
    // keeps the two that sort first by place, and "Aaa" (Mat 9) is one of the three it folds.
    const crowded: ClassRow[] = [
      cls("Aaa", "Mat 9", [[4, "18:40", "19:30"]]),
      cls("Bbb", "Mat 1", [[4, "18:40", "19:30"]]),
      cls("Ccc", "Mat 2", [[4, "18:40", "19:30"]]),
      cls("Ddd", "Mat 3", [[4, "18:40", "19:30"]]),
      cls("Eee", "Mat 4", [[4, "18:40", "19:30"]]),
    ];
    layOut((el) => el.matches("[data-cell-more]"), { top: 400, left: 300 });
    const { container } = render(<TimetableManager initialClasses={crowded} {...PROPS} />);
    expect(weekChips(weekDay(container, "thu")).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Edit Bbb, Thursday 18:40 to 19:30, Mat 1 (live)",
      "Edit Ccc, Thursday 18:40 to 19:30, Mat 2 (live)",
    ]);
    // 400 − 100 − 44 − 4
    expect(box().scrollTop).toBe(252);
  });
});

describe("when the week is wider than its box", () => {
  let fire: () => void = () => {};
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
  });
  const makeWider = (box: HTMLElement, wider: boolean) => {
    Object.defineProperty(box, "scrollWidth", { configurable: true, value: wider ? 1400 : 900 });
    Object.defineProperty(box, "clientWidth", { configurable: true, value: 1000 });
    React.act(() => fire());
  };

  it("says so, and offers to expand the timetable where the browser can", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const box = screen.getByTestId("week-scroller");
    makeWider(box, true);
    expect(screen.getByTestId("week-wider").textContent).toBe("Wider than this window. Scroll sideways, or expand the timetable.");
    makeWider(box, false);
    expect(screen.getByTestId("week-wider").textContent).toBe("");
  });

  it("drops the offer once the timetable is expanded, and where the browser cannot expand it", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const view = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    makeWider(screen.getByTestId("week-scroller"), true);
    fireEvent.click(screen.getByTestId("timetable-expand"));
    expect(screen.getByTestId("week-wider").textContent).toBe("Wider than this window. Scroll sideways.");
    view.unmount();
    vi.stubGlobal("CSS", { supports: () => false });
    render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    makeWider(screen.getByTestId("week-scroller"), true);
    expect(screen.getByTestId("week-wider").textContent).toBe("Wider than this window. Scroll sideways.");
  });
});

describe("the wide page and Expand timetable", () => {
  const marker = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-page-width]")!;

  it("marks the Timetable as the wide page", () => {
    const { container } = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    expect(marker(container).dataset.pageWidth).toBe("wide");
    expect(marker(container).dataset.expandTimetable).toBeUndefined();
  });

  it("expands on a press (the menu and the width cap give way), names the way back, and does not remember it", () => {
    const view = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const button = screen.getByTestId("timetable-expand");
    expect(button.textContent).toBe("Expand timetable");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.hasAttribute("data-needs-has")).toBe(true);
    fireEvent.click(button);
    expect(marker(view.container).dataset.expandTimetable).toBe("true");
    expect(button.textContent).toBe("Shrink timetable");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(marker(view.container).dataset.expandTimetable).toBeUndefined();
    // A fresh visit starts with the menu showing and the page at its usual width: nothing was stored.
    fireEvent.click(button);
    view.unmount();
    const again = render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    expect(marker(again.container).dataset.expandTimetable).toBeUndefined();
    expect(Object.keys(localStorage).some((k) => /menu|width/i.test(k))).toBe(false);
  });

  it("cannot stay expanded when there is no button to bring the menu back", () => {
    const { container } = render(<TimetableManager initialClasses={[]} {...PROPS} />);
    expect(screen.queryByTestId("timetable-expand")).toBeNull();
    expect(marker(container).dataset.expandTimetable).toBeUndefined();
  });
});

describe("the two new files", () => {
  it("use the Button primitive: no raw button element, no hex colour", () => {
    for (const file of ["components/schedule/PosterGrid.tsx", "components/schedule/WeekChip.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/<button\b/);
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    }
  });
});

describe("the seven days share the width", () => {
  it("every day is an equal share, an empty day too; a day never goes under what its lanes need", () => {
    render(<TimetableManager initialClasses={WEEK} {...PROPS} />);
    const columns = screen.getByTestId("week-grid").style.gridTemplateColumns;
    // The gutter, then per day a 6 px gap and its tracks. Monday and Thursday have two lanes (half a share
    // each, never under 82 px); Saturday has one; Tuesday, Wednesday, Friday and Sunday are empty (a whole
    // share, giving way to 40 px when the week is squeezed).
    expect(columns).toBe([
      "36px",
      "6px minmax(82px, 0.5fr) minmax(82px, 0.5fr)", // Mon
      "6px minmax(40px, 1fr)", // Tue
      "6px minmax(40px, 1fr)", // Wed
      "6px minmax(82px, 0.5fr) minmax(82px, 0.5fr)", // Thu
      "6px minmax(40px, 1fr)", // Fri
      "6px minmax(82px, 1fr)", // Sat
      "6px minmax(40px, 1fr)", // Sun
    ].join(" "));
    // No fixed maximum: the week fills its box, which is what lets "Expand timetable" make it larger.
    expect(columns).not.toMatch(/, \d+px\)/);
  });
});
