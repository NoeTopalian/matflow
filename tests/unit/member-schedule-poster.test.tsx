// @vitest-environment jsdom
//
// The members' day is the poster grid (plan §4.13): rows are the real times,
// mat columns when the club splits by mat, the place on the last line where it
// tells classes apart, the coach under a pinned mat name. Structure and grid
// lines only — never pixels (jsdom has no layout).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));

import MemberSchedulePage from "@/app/member/schedule/page";

type Row = Record<string, unknown>;
function row(id: string, name: string, startTime: string, endTime: string, location: string, matId: string | null, over: Row = {}): Row {
  return {
    id: `${id}-s`, classId: id, scheduleId: `${id}-s`, name, color: "#3b82f6", startTime, endTime,
    coach: "Sam Doe", location, matId, capacity: 20, dayOfWeek: new Date().getDay(), classInstanceId: null,
    eligibility: "ok", requiredRankName: null, maxRankName: null, ...over,
  };
}
const MATS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];
// The poster's Monday evening: a pair at 18:40 on the two mats, and a 20-minute class before the 19:00 one on Mat 2.
const EVENING = [
  row("gi", "Beginners Course Gi", "18:40", "19:30", "Mat 1", "m1"),
  row("free", "Free Mat Space", "18:40", "19:00", "Mat 2", "m2"),
  row("nogi", "No-Gi Fundamentals", "19:00", "20:00", "Mat 2", "m2"),
];

let timetable: () => Promise<Response> | Response;
let calls: string[];
function stub(rows: Row[], booked: string[] = []) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith("/api/member/schedule")) return { ok: true, status: 200, json: async () => rows } as Response;
      if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: booked }) } as Response;
      if (url.startsWith("/api/member/timetable")) return timetable();
      if (url.startsWith("/api/member/class-subscriptions/")) return { ok: true, status: 201, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}
const byMat = () => ({ ok: true, status: 200, json: async () => ({ layout: "mat", mats: MATS }) }) as Response;
const byTime = () => ({ ok: true, status: 200, json: async () => ({ layout: "time", mats: MATS }) }) as Response;

let scrolled: Element[];
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollTo = function scrollTo(this: Element) { scrolled.push(this); };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
  timetable = byMat;
});

/** Today's pane (the centre of the three) and its grid. */
async function today() {
  const pane = await screen.findByTestId("schedule-pane");
  const day = await within(pane).findByTestId("schedule-day");
  return { pane, day };
}
const cellOf = (day: HTMLElement, name: string) => {
  const block = within(day).getByRole("button", { name: new RegExp(`^${name},`) });
  return block.closest("[data-cell-key]") as HTMLElement;
};

describe("the members' day by mat", () => {
  it("two mat columns, headed in the club's order", async () => {
    stub(EVENING);
    render(<MemberSchedulePage />);
    const { day } = await today();
    expect(day.dataset.mats).toBe("true");
    expect(day.dataset.tone).toBe("member");
    expect(day.dataset.pinMats).toBe("true");
    expect([...day.querySelectorAll("[data-mat-head]")].map((h) => h.textContent?.trim())).toEqual(["Mat 1", "Mat 2"]);
    expect(cellOf(day, "Beginners Course Gi").dataset.mat).toBe("m1");
    expect(cellOf(day, "No-Gi Fundamentals").dataset.mat).toBe("m2");
  });

  it("two classes that start together share a line; a 20-minute class ends before the next one starts", async () => {
    stub(EVENING);
    render(<MemberSchedulePage />);
    const { day } = await today();
    const gi = cellOf(day, "Beginners Course Gi");
    const free = cellOf(day, "Free Mat Space");
    const nogi = cellOf(day, "No-Gi Fundamentals");
    expect(gi.dataset.rowStart).toBe(free.dataset.rowStart);
    expect(Number(free.dataset.rowEnd)).toBeLessThanOrEqual(Number(nogi.dataset.rowStart));
  });

  it("each block leads with its time; neither the time nor the name is cut; under a mat name the last line is the coach", async () => {
    stub(EVENING);
    render(<MemberSchedulePage />);
    const { day } = await today();
    const block = within(day).getByRole("button", { name: /^Beginners Course Gi,/ });
    const parts = [...block.querySelectorAll("[data-block-part]")].map((p) => (p as HTMLElement).dataset.blockPart);
    expect(parts[0]).toBe("time");
    for (const part of ["time", "name"]) {
      const el = block.querySelector(`[data-block-part="${part}"]`) as HTMLElement;
      expect(el.className).not.toMatch(/\btruncate\b|line-clamp|whitespace-nowrap/);
    }
    expect(block.querySelector('[data-block-part="place"]')?.textContent).toBe("Sam Doe");
    expect(block.querySelector('[data-testid="schedule-cell-place"]')).toBeNull();
    // The mat is in the block's name, since the pinned header is not read with it.
    // (the real clock may add ", next" or ", ended" after it)
    expect(block.getAttribute("aria-label")).toMatch(/^Beginners Course Gi, 18:40 to 19:30, Mat 1(, [a-z]+)?$/);
  });

  it("a class on no mat sits under No mat and keeps its typed place", async () => {
    stub([...EVENING, row("hall", "Strength", "18:40", "19:30", "Sports hall", null)]);
    render(<MemberSchedulePage />);
    const { day } = await today();
    expect([...day.querySelectorAll("[data-mat-head]")].map((h) => h.textContent?.trim())).toEqual(["Mat 1", "Mat 2", "No mat"]);
    const hall = within(day).getByRole("button", { name: /^Strength,/ });
    expect(hall.querySelector('[data-testid="schedule-cell-place"]')?.textContent).toBe("Sports hall");
  });

  it("a day needing more than three lanes by mat is drawn by time, says so, and every block names its mat", async () => {
    stub([
      ...EVENING,
      row("hall", "Strength", "18:40", "19:30", "Sports hall", null),
      row("gi2", "Kids Gi", "18:40", "19:30", "Mat 1", "m1"),
    ]);
    render(<MemberSchedulePage />);
    const { pane, day } = await today();
    expect(within(pane).getByTestId("schedule-fallback").textContent).toBe("Too much on at once to show by mat on this screen. Each class shows its mat.");
    expect(day.dataset.mats).toBeUndefined();
    const gi = within(day).getByRole("button", { name: /^Beginners Course Gi,/ });
    expect(gi.querySelector('[data-testid="schedule-cell-place"]')?.textContent).toBe("Mat 1");
  });

  it("an ended class is not faded: its fill is paler and its ink unchanged", async () => {
    stub([row("early", "Sunrise Gi", "00:00", "00:10", "Mat 1", "m1")]);
    render(<MemberSchedulePage />);
    const { day } = await today();
    const block = within(day).getByRole("button", { name: /^Sunrise Gi,/ });
    // 00:10 has passed whenever this runs, except in its first ten minutes of the day.
    if (block.dataset.sessionState === "ended") expect(block.style.opacity).toBe("");
  });

  it("a booked block's last line is in the block's own ink, not a see-through one", async () => {
    // The class is today at 18:40 to 19:30: on the real clock it is not upcoming in that window and the bell is not
    // drawn, so the test failed every evening (CI on PR #77, 7 Nov 2026, 19:05). The morning of the same day, with
    // only the date frozen (timers stay real for waitFor).
    const morning = new Date();
    morning.setHours(10, 0, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(morning);
    try {
      stub(EVENING, ["gi"]);
      render(<MemberSchedulePage />);
      const { day } = await today();
      const block = within(day).getByRole("button", { name: /^Beginners Course Gi,/ });
      await waitFor(() => expect(block.style.background).toContain("linear-gradient"));
      await waitFor(() => expect(block.querySelector("svg")).not.toBeNull()); // the Bell: booked
      const last = block.querySelector<HTMLElement>('[data-block-part="place"]')!;
      expect(last.style.color).toBe(block.style.color);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a booked class that has ended is greyed, its ink unchanged", async () => {
    stub([row("early", "Sunrise Gi", "00:00", "00:10", "Mat 1", "m1")], ["early"]);
    render(<MemberSchedulePage />);
    const { day } = await today();
    const block = within(day).getByRole("button", { name: /^Sunrise Gi,/ });
    await waitFor(() => expect(block.querySelector("svg, [data-block-part]")).not.toBeNull());
    // 00:10 has passed whenever this runs, except in its first ten minutes of the day.
    if (block.dataset.sessionState === "ended") {
      await waitFor(() => expect(block.style.filter).toBe("saturate(0.35)"));
      expect(block.style.opacity).toBe("");
    }
  });
});

describe("the members' day by time", () => {
  it("side-by-side classes name their place; a class alone names its coach", async () => {
    timetable = byTime;
    stub([
      row("gi-a", "Beginners Gi", "18:40", "19:30", "Mat 1", "m1"),
      row("gi-b", "Beginners Gi", "18:40", "19:30", "Mat 2", "m2"),
      row("open", "Open Mat", "20:00", "21:00", "Mat 1", "m1"),
    ]);
    render(<MemberSchedulePage />);
    const { day } = await today();
    expect(day.dataset.mats).toBeUndefined();
    const pair = within(day).getAllByRole("button", { name: /^Beginners Gi,/ });
    expect(pair.map((b) => b.querySelector('[data-testid="schedule-cell-place"]')?.textContent).sort()).toEqual(["Mat 1", "Mat 2"]);
    const open = within(day).getByRole("button", { name: /^Open Mat,/ });
    expect(open.querySelector('[data-testid="schedule-cell-place"]')).toBeNull();
    expect(open.textContent).toContain("Sam Doe");
  });

  it("if the layout cannot be read the day is drawn by time, with every class", async () => {
    timetable = () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
    stub(EVENING);
    render(<MemberSchedulePage />);
    const { day } = await today();
    expect(day.dataset.mats).toBeUndefined();
    expect(day.querySelectorAll("[data-cell-key]")).toHaveLength(3);
    expect(screen.queryByText(/Couldn.t load your timetable/)).toBeNull();
  });
});

describe("loading, scrolling and the side panes", () => {
  it("nothing is drawn until the layout is in as well as the classes", async () => {
    let release!: (r: Response) => void;
    timetable = () => new Promise<Response>((resolve) => { release = resolve; });
    stub(EVENING);
    render(<MemberSchedulePage />);
    await waitFor(() => expect(calls.some((c) => c.includes("/api/member/timetable"))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("schedule-day")).toBeNull();
    release(byMat());
    const { day } = await today();
    expect(day.dataset.mats).toBe("true");
  });

  it("the centre pane is scrolled and focus does not move; the side panes are inert", async () => {
    stub(EVENING);
    render(<MemberSchedulePage />);
    const { pane } = await today();
    await waitFor(() => expect(scrolled.some((el) => pane.contains(el))).toBe(true));
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByTestId("schedule-pane-prev").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("schedule-pane-next").hasAttribute("inert")).toBe(true);
    expect(pane.hasAttribute("inert")).toBe(false);
  });

  it("a block opens the class sheet, and booking posts the real class id", async () => {
    stub(EVENING);
    render(<MemberSchedulePage />);
    const { day } = await today();
    fireEvent.click(within(day).getByRole("button", { name: /^Beginners Course Gi,/ }));
    const book = await screen.findByRole("button", { name: /Subscribe to class/ });
    fireEvent.click(book);
    await waitFor(() => expect(calls).toContain("POST /api/member/class-subscriptions/gi"));
  });
});

describe("more than three at once", () => {
  const FIVE = ["A", "B", "C", "D", "E"].map((n) => row(`k${n}`, `Class ${n}`, "10:00", "10:45", "", null));
  it("two blocks and '+3 more'; it lists all five over the grid, each opens its sheet, Escape closes it", async () => {
    timetable = byTime;
    stub(FIVE);
    render(<MemberSchedulePage />);
    const { day } = await today();
    const more = within(day).getByTestId("schedule-more");
    expect(more.getAttribute("aria-label")).toBe("3 more classes, 10:00 to 10:45. Show them.");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const panel = await within(day).findByTestId("more-panel");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getAllByRole("button", { name: /^Class [A-E],/ })).toHaveLength(5);
    expect(document.activeElement).toBe(within(panel).getAllByRole("button")[0]);
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(within(day).queryByTestId("more-panel")).toBeNull());
    expect(document.activeElement).toBe(more);
  });

  it("a tap on a row that moves focus to nothing (Safari) still opens that class's sheet", async () => {
    timetable = byTime;
    stub(FIVE);
    render(<MemberSchedulePage />);
    const { day } = await today();
    fireEvent.click(within(day).getByTestId("schedule-more"));
    const panel = await within(day).findByTestId("more-panel");
    const rowD = within(panel).getByRole("button", { name: /^Class D,/ });
    // Safari: the tapped button does not take focus, so focus leaves the panel for nothing.
    fireEvent.pointerDown(rowD);
    fireEvent.blur(within(panel).getAllByRole("button")[0], { relatedTarget: null });
    expect(within(day).queryByTestId("more-panel")).not.toBeNull();
    fireEvent.click(rowD);
    expect(await screen.findByRole("button", { name: /Subscribe to class/ })).toBeTruthy();
  });

  it("a press outside closes it; Tab past its last row closes it too", async () => {
    timetable = byTime;
    stub(FIVE);
    render(<MemberSchedulePage />);
    const { day } = await today();
    const more = within(day).getByTestId("schedule-more");
    fireEvent.click(more);
    await within(day).findByTestId("more-panel");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(within(day).queryByTestId("more-panel")).toBeNull());
    fireEvent.click(more);
    const panel = await within(day).findByTestId("more-panel");
    const buttons = within(panel).getAllByRole("button");
    fireEvent.blur(buttons[buttons.length - 1], { relatedTarget: more });
    await waitFor(() => expect(within(day).queryByTestId("more-panel")).toBeNull());
  });

  it("it closes on a day change and stays closed on the way back", async () => {
    timetable = byTime;
    stub(FIVE);
    render(<MemberSchedulePage />);
    const { day } = await today();
    fireEvent.click(within(day).getByTestId("schedule-more"));
    await within(day).findByTestId("more-panel");
    const pills = screen.getAllByRole("button", { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*\d/ });
    expect(pills).toHaveLength(7);
    const todayAt = (new Date().getDay() + 6) % 7;
    fireEvent.click(pills[(todayAt + 1) % 7]);
    fireEvent.click(pills[todayAt]);
    const back = await today();
    await within(back.day).findByTestId("schedule-more");
    expect(within(back.pane).queryByTestId("more-panel")).toBeNull();
  });

  it("'+N more' says when it hides the class that is on now, so opening the day scrolls to it", async () => {
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes();
    const at = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const from = at(Math.max(0, min - 5)), to = at(Math.min(23 * 60 + 59, min + 30));
    timetable = byTime;
    stub(["A", "B", "C", "D", "E"].map((n) => row(`l${n}`, `Live ${n}`, from, to, "", null)));
    render(<MemberSchedulePage />);
    const { day } = await today();
    const more = within(day).getByTestId("schedule-more");
    if (from !== to) await waitFor(() => expect(more.dataset.foldedState).toBe("live"));
  });
});
