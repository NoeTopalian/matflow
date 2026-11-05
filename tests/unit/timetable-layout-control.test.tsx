// @vitest-environment jsdom
//
// The staff week split by mat, and the control that chooses the split (plan
// §4.4, §4.9, Appendix B 10–11). jsdom lays nothing out: this pins which
// columns and headers exist, what each chip says, what the control sends and
// what the reader is told. Geometry is the browser journey's job.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { weekChips, weekDay, weekGrid } from "./helpers/week";
import { PROPS, cls, stubFetch, type Call } from "./helpers/timetable-fixture";

const { refresh, toast } = vi.hoisted(() => ({ refresh: vi.fn(), toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const MATS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];
const gi = () => cls("Gi", "Mat 1", [[1, "18:40", "19:30"]], { matId: "m1" });
const nogi = () => cls("No-Gi", "Mat 2", [[1, "18:40", "19:30"]], { matId: "m2" });
const openMat = () => cls("Open Mat", null, [[1, "20:00", "21:00"]]);
const yoga = () => cls("Yoga", "Sports hall", [[2, "10:00", "11:00"]]);
/** Two mats in use, a class with no place, a class with a typed place. */
const week = () => [gi(), nogi(), openMat(), yoga()];

const matHeads = (day: HTMLElement) => Array.from(day.querySelectorAll(".pg-mat")).map((h) => h.textContent);
const label = (chip: HTMLElement) => chip.getAttribute("aria-label");
const byMat = () => screen.getByTestId("timetable-split-mat");
const byTime = () => screen.getByTestId("timetable-split-time");
const sent = (calls: Call[]) => calls.filter((c) => c.url === "/api/timetable/layout");

let calls: Call[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0)); // Thursday: no fixture session is today
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  calls = stubFetch();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the week split by mat", () => {
  it("with nothing chosen and two mats in use, each day shows the club's mats in order, with 'No mat' last where needed", () => {
    const { container } = render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    expect(weekGrid(container)?.getAttribute("data-mats")).toBe("true");
    expect(matHeads(weekDay(container, "mon"))).toEqual(["Mat 1", "Mat 2", "No mat"]);
    // A two-mat club shows both mats on every day with classes, like its poster.
    expect(matHeads(weekDay(container, "tue"))).toEqual(["Mat 1", "Mat 2", "No mat"]);
    expect(matHeads(weekDay(container, "wed"))).toEqual([]);
    // The pinned band is the day names and the mat names: 44 + 34 px, plus room for the focus ring.
    expect(screen.getByTestId("week-scroller").style.scrollPaddingTop).toBe("84px");
  });

  it("a chip under a mat header leaves its place line out and keeps the mat in its name; under 'No mat' the place line stays", () => {
    const { container } = render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    const [giChip, nogiChip, openChip] = weekChips(weekDay(container, "mon"));
    expect(label(giChip)).toBe("Edit Gi, Monday 18:40 to 19:30, Mat 1");
    expect(giChip.querySelector('[data-chip-part="place"]')).toBeNull();
    expect(giChip.closest("[data-cell-key]")?.getAttribute("data-mat")).toBe("m1");
    expect(nogiChip.closest("[data-cell-key]")?.getAttribute("data-mat")).toBe("m2");
    expect(Number(giChip.closest<HTMLElement>("[data-cell-key]")?.dataset.col)).toBeLessThan(Number(nogiChip.closest<HTMLElement>("[data-cell-key]")?.dataset.col));
    // No mat and no typed place: the name says so.
    expect(label(openChip)).toBe("Edit Open Mat, Monday 20:00 to 21:00, no mat");
    const [yogaChip] = weekChips(weekDay(container, "tue"));
    expect(label(yogaChip)).toBe("Edit Yoga, Tuesday 10:00 to 11:00, Sports hall");
    expect(yogaChip.querySelector('[data-chip-part="place"]')?.textContent).toBe("Sports hall");
  });

  it("a mat the club no longer has is shown under 'No mat', never as a column of its own", () => {
    const orphan = cls("Wrestling", "Old mat", [[1, "18:40", "19:30"]], { matId: "removed" });
    const { container } = render(<TimetableManager initialClasses={[gi(), nogi(), orphan]} mats={MATS} {...PROPS} />);
    expect(matHeads(weekDay(container, "mon"))).toEqual(["Mat 1", "Mat 2", "No mat"]);
  });

  it("is by time while fewer than two mats have a class, and for a club with no mats at all", () => {
    const one = render(<TimetableManager initialClasses={[gi(), openMat()]} mats={MATS} {...PROPS} />);
    expect(weekGrid(one.container)?.getAttribute("data-mats")).toBeNull();
    // By time, every chip says its place.
    expect(weekChips(weekDay(one.container, "mon"))[0].querySelector('[data-chip-part="place"]')?.textContent).toBe("Mat 1");
    one.unmount();
    const none = render(<TimetableManager initialClasses={[yoga()]} {...PROPS} />);
    expect(weekGrid(none.container)?.getAttribute("data-mats")).toBeNull();
    // A club with no mats is not told "no mat" on every class.
    const bare = render(<TimetableManager initialClasses={[openMat()]} {...PROPS} />);
    expect(label(weekChips(weekDay(bare.container, "mon"))[0])).toBe("Edit Open Mat, Monday 20:00 to 21:00");
  });

  it("a stored choice wins: by time with two mats in use, by mat with one", () => {
    const time = render(<TimetableManager initialClasses={week()} mats={MATS} storedLayout="time" {...PROPS} />);
    expect(weekGrid(time.container)?.getAttribute("data-mats")).toBeNull();
    expect(byTime().getAttribute("aria-pressed")).toBe("true");
    // Mat 1 keeps its place left of Mat 2 when the week is by time.
    expect(weekChips(weekDay(time.container, "mon")).slice(0, 2).map(label)).toEqual(["Edit Gi, Monday 18:40 to 19:30, Mat 1", "Edit No-Gi, Monday 18:40 to 19:30, Mat 2"]);
    time.unmount();
    const mat = render(<TimetableManager initialClasses={[gi(), openMat()]} mats={MATS} storedLayout="mat" {...PROPS} />);
    expect(weekGrid(mat.container)?.getAttribute("data-mats")).toBe("true");
  });
});

describe("the control: Split same-time classes", () => {
  it("is a labelled pair of buttons for an owner and a manager, showing the split in effect", () => {
    for (const role of ["owner", "manager"]) {
      const view = render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} role={role} />);
      const group = screen.getByRole("group", { name: "Split same-time classes (whole club)" });
      expect(within(group).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["By mat", "true"], ["By time", "false"]]);
      expect(screen.getByTestId("timetable-mats")).toBeTruthy();
      view.unmount();
    }
  });

  it("a coach reads the split as text and has no Mats button", () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} role="coach" />);
    expect(screen.getByTestId("timetable-split-text").textContent).toBe("Split by mat");
    expect(screen.queryByTestId("timetable-split-mat")).toBeNull();
    expect(screen.queryByTestId("timetable-mats")).toBeNull();
    expect(screen.queryByTestId("timetable-mats-phone")).toBeNull();
  });

  it("in a MatFlow support session neither the control nor the Mats button is shown", () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} supportSession {...PROPS} />);
    expect(screen.queryByTestId("timetable-split")).toBeNull();
    expect(screen.queryByTestId("timetable-mats")).toBeNull();
    expect(screen.queryByTestId("timetable-mats-phone")).toBeNull();
    // The week itself still follows the club's mats.
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBe("true");
  });

  it("is on the Day view too, now every screen follows the split", () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    expect(screen.getByTestId("timetable-split")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Split same-time classes (whole club)" })).toBeTruthy();
    expect(screen.getByTestId("timetable-mats")).toBeTruthy();
  });

  it("pressing By time saves it for the club, redraws at once, says so once and asks for fresh data", async () => {
    const { container } = render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    fireEvent.click(byTime());
    expect(weekGrid(container)?.getAttribute("data-mats")).toBeNull();
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved for the whole club.", "success"));
    expect(sent(calls)).toEqual([{ url: "/api/timetable/layout", method: "PATCH", body: { layout: "time" } }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The control's own toast is the only one: no second "the split changed" line.
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("with nothing stored, pressing the choice already in effect still saves it", async () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    fireEvent.click(byMat());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved for the whole club.", "success"));
    expect(sent(calls).map((c) => c.body)).toEqual([{ layout: "mat" }]);
  });

  it("pressing a choice that is already saved sends nothing", () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} storedLayout="mat" {...PROPS} />);
    fireEvent.click(byMat());
    expect(sent(calls)).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it.each([
    ["a server error", () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }), "Couldn't save that. Try again."],
    ["a refusal the server explains", () => ({ ok: false, status: 409, json: async () => ({ error: "Put a class on a mat first." }) }), "Put a class on a mat first."],
  ])("after %s the old choice is back, the reader is told, and one retry sends one request", async (_what, reply, message) => {
    let fail = true;
    calls = stubFetch((call) => (call.url === "/api/timetable/layout" && fail ? reply() : undefined));
    const { container } = render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    fireEvent.click(byTime());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(message, "error"));
    expect(weekGrid(container)?.getAttribute("data-mats")).toBe("true");
    expect(byMat().getAttribute("aria-pressed")).toBe("true");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(byTime());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved for the whole club.", "success"));
    expect(sent(calls)).toHaveLength(2);
  });

  it("after a request that never arrives the old choice is back and the reader is told", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
      if (url === "/api/coach/today") return { ok: true, json: async () => [] };
      throw new TypeError("Failed to fetch");
    }));
    const { container } = render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    fireEvent.click(byTime());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save that. Try again.", "error"));
    expect(weekGrid(container)?.getAttribute("data-mats")).toBe("true");
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("By mat cannot be pressed until a class is on a mat: it stays focusable and says what to do first", () => {
    // Mats exist, no class is on one.
    const some = render(<TimetableManager initialClasses={[yoga()]} mats={MATS} {...PROPS} />);
    expect(byMat().getAttribute("aria-disabled")).toBe("true");
    expect((byMat() as HTMLButtonElement).disabled).toBe(false);
    expect(byMat().getAttribute("aria-describedby")).toBe("timetable-split-hint");
    expect(document.getElementById("timetable-split-hint")?.textContent).toBe("Put a class on a mat first: open a class and choose its mat.");
    fireEvent.click(byMat());
    expect(sent(calls)).toEqual([]);
    expect(byTime().getAttribute("aria-pressed")).toBe("true");
    some.unmount();
    // No mats at all.
    render(<TimetableManager initialClasses={[yoga()]} {...PROPS} />);
    expect(document.getElementById("timetable-split-hint")?.textContent).toBe("Add your mats first.");
    expect(byMat().getAttribute("aria-disabled")).toBe("true");
  });

  it("has no hint once a class is on a mat", () => {
    render(<TimetableManager initialClasses={[gi()]} mats={MATS} {...PROPS} />);
    expect(byMat().getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByTestId("timetable-split-hint")).toBeNull();
  });
});

describe("when the split changes by itself", () => {
  it("a refresh that puts a class on a second mat says the week is now split by mat, once", () => {
    const first = gi();
    const view = render(<TimetableManager initialClasses={[first, openMat()]} mats={MATS} {...PROPS} />);
    expect(toast).not.toHaveBeenCalled();
    act(() => view.rerender(<TimetableManager initialClasses={[first, nogi()]} mats={MATS} {...PROPS} />));
    expect(toast).toHaveBeenCalledWith("The timetable is now split by mat.", "info");
    expect(toast).toHaveBeenCalledTimes(1);
    act(() => view.rerender(<TimetableManager initialClasses={[first, nogi(), yoga()]} mats={MATS} {...PROPS} />));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("a refresh after a mat was removed says the week is now split by time", () => {
    const view = render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    const off = cls("No-Gi", "Mat 2", [[1, "18:40", "19:30"]]);
    act(() => view.rerender(<TimetableManager initialClasses={[gi(), off]} mats={[MATS[0]]} {...PROPS} />));
    expect(toast).toHaveBeenCalledWith("The timetable is now split by time.", "info");
  });

  it("says nothing on first load, whatever the split is", () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} />);
    expect(toast).not.toHaveBeenCalled();
  });

  it("a stored choice arriving with a refresh is adopted", () => {
    const classes = week();
    const view = render(<TimetableManager initialClasses={classes} mats={MATS} {...PROPS} />);
    act(() => view.rerender(<TimetableManager initialClasses={classes} mats={MATS} storedLayout="time" {...PROPS} />));
    expect(byTime().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBeNull();
  });
});
