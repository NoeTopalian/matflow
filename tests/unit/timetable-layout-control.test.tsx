// @vitest-environment jsdom
//
// The staff week split by mat, and the control that chooses the split (plan
// §4.4, §4.9, Appendix B 10–11). jsdom lays nothing out: this pins which
// columns and headers exist, what each chip says, what the control sends and
// what the reader is told. Geometry is the browser journey's job.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  // Noe, 7 Nov 2026 ("Yes, allow support"): an EDIT support session is signed in as the owner and sees the owner's
  // controls (the page passes supportReadOnly false). A read-only (view) session is refused them by the proxy, so it
  // is offered none (UI-RULES §7).
  it("in an EDIT support session By mat / By time and the Mats button are there, as the owner sees them, and pressing By mat sends it", async () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} storedLayout="time" {...PROPS} role="owner" supportReadOnly={false} />);
    const group = screen.getByRole("group", { name: "Split same-time classes (whole club)" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["By mat", "By time"]);
    expect(screen.queryByTestId("timetable-split-text")).toBeNull();
    expect(screen.queryByText(/the club's to set/)).toBeNull();
    expect(screen.queryByText(/read-only/)).toBeNull();
    expect(screen.getByTestId("timetable-mats")).toBeTruthy();
    expect(screen.getByTestId("timetable-mats-phone")).toBeTruthy();
    fireEvent.click(byMat());
    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0].body).toEqual({ layout: "mat" });
  });

  it("in a read-only support session the split is text with the read-only line, and there is no Mats button or sheet", () => {
    render(<TimetableManager initialClasses={week()} mats={MATS} {...PROPS} role="owner" supportReadOnly />);
    expect(screen.getByTestId("timetable-split-text").textContent).toBe("Split by mat");
    expect(screen.getByTestId("timetable-split-hint").textContent).toBe("MatFlow support session, read-only: the split and the mats are shown, not changed.");
    expect(screen.queryByTestId("timetable-split-mat")).toBeNull();
    expect(screen.queryByTestId("timetable-split-time")).toBeNull();
    expect(screen.queryByTestId("timetable-mats")).toBeNull();
    expect(screen.queryByTestId("timetable-mats-phone")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The week itself still follows the club's mats.
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBe("true");
  });

  it("a read-only support session on a club with no classes has no Mats button either", () => {
    render(<TimetableManager initialClasses={[]} mats={MATS} {...PROPS} role="owner" supportReadOnly />);
    expect(screen.queryByTestId("timetable-mats-empty")).toBeNull();
  });

  it("the Timetable page marks read-only only a support session whose scope is not exactly edit", () => {
    const page = readFileSync(resolve(__dirname, "../../app/dashboard/timetable/page.tsx"), "utf8");
    expect(page).toMatch(/supportReadOnly=\{isSupportSession\(session\) && \(session!\.user as \{ supportScope\?: unknown \}\)\.supportScope !== "edit"\}/);
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

  /** The Mats sheet's reads, and one typed place ("Mat 1", two classes) it offers to turn into a mat. */
  const matsServer = (over: (call: Call) => { ok: boolean; status?: number; json: () => Promise<unknown> } | undefined = () => undefined) =>
    stubFetch((call) => {
      const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
      const mine = over(call);
      if (mine) return mine;
      if (call.method === "GET" && call.url === "/api/mats") return ok({ mats: [], layout: { stored: null, effective: "time" } });
      if (call.method === "GET" && call.url === "/api/mats/suggestions") return ok({ suggestions: [{ key: "mat 1", name: "Mat 1", classCount: 2, matId: null }], noPlaceCount: 0, matCount: 0 });
      if (call.method === "POST" && call.url === "/api/mats/adopt") return ok({ mats: [{ id: "m1", name: "Mat 1", created: true, classCount: 2 }], matsAdded: 1, classesAttached: 2, skipped: [], layout: { stored: null, effective: "time" }, layoutChanged: false });
      return undefined;
    });
  const typedOnly = () => [cls("Gi", "Mat 1", [[1, "18:40", "19:30"]]), cls("No-Gi", "mat  1", [[3, "18:40", "19:30"]]), yoga()];

  it("By mat is never a dead button: with no class on a mat it says what it will do, naming the places already typed", () => {
    calls = matsServer();
    // Mats exist, no class is on one.
    const some = render(<TimetableManager initialClasses={[yoga()]} mats={MATS} {...PROPS} />);
    expect(byMat().getAttribute("aria-disabled")).toBeNull();
    expect((byMat() as HTMLButtonElement).disabled).toBe(false);
    expect(byMat().getAttribute("aria-describedby")).toBe("timetable-split-hint");
    expect(document.getElementById("timetable-split-hint")?.textContent).toBe("By mat gives each mat its own column. Press it to put your classes on their mats.");
    some.unmount();
    // No mats at all: the sentence names the places the club has already typed (one line per place, whatever its capitals).
    const none = render(<TimetableManager initialClasses={typedOnly()} {...PROPS} />);
    expect(document.getElementById("timetable-split-hint")?.textContent).toBe("By mat gives each mat its own column. Press it to set up your mats: your classes say Mat 1 and Sports hall.");
    none.unmount();
    // No mats and nothing typed.
    render(<TimetableManager initialClasses={[openMat()]} {...PROPS} />);
    expect(document.getElementById("timetable-split-hint")?.textContent).toBe("By mat gives each mat its own column. Press it to add your mats.");
  });

  it("pressing By mat with no mats opens the set-up; adding the typed places as mats then splits the club by mat, says so, and closes the sheet", async () => {
    calls = matsServer();
    render(<TimetableManager initialClasses={typedOnly()} {...PROPS} />);
    fireEvent.click(byMat());
    const sheet = await screen.findByRole("dialog");
    // Nothing is saved by the press itself: the split waits for the mats.
    expect(sent(calls)).toEqual([]);
    fireEvent.click(await within(sheet).findByRole("button", { name: "Add these as mats" }));
    await waitFor(() => expect(sent(calls).map((c) => [c.method, c.body])).toEqual([["PATCH", { layout: "mat" }]]));
    expect(calls.find((c) => c.url === "/api/mats/adopt")?.body).toEqual({ keys: ["mat 1"] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast).toHaveBeenCalledWith("Your timetable is now split by mat. Saved for the whole club.", "success");
  });

  it("closing the set-up without adding anything forgets the press: mats added later from the Mats button do not flip the split", async () => {
    calls = matsServer();
    render(<TimetableManager initialClasses={typedOnly()} {...PROPS} />);
    fireEvent.click(byMat());
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByTestId("timetable-mats"));
    fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Add these as mats" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/mats/adopt")).toBe(true));
    await act(async () => {});
    expect(sent(calls)).toEqual([]);
  });

  it("if the club still has no class on a mat (the server says 409), the set-up stays open and nothing is claimed", async () => {
    calls = matsServer((call) => (call.url === "/api/timetable/layout" ? { ok: false, status: 409, json: async () => ({ error: "No class is on a mat yet." }) } : undefined));
    render(<TimetableManager initialClasses={typedOnly()} {...PROPS} />);
    fireEvent.click(byMat());
    fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Add these as mats" }));
    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(toast).not.toHaveBeenCalledWith("Your timetable is now split by mat. Saved for the whole club.", "success");
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
