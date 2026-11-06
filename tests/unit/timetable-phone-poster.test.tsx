// @vitest-environment jsdom
//
// The staff phone's day (plan §4.12): one card holding the poster grid for
// the chosen day — same-time classes on one row line, mat columns while the
// day needs three lanes or fewer, the place line on every chip, the phone
// chip size, "+N more" opening a panel over the grid. The day tabs mark the
// selected and today's tab without the club's colour.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { cls, PROPS, stubFetch } from "./helpers/timetable-fixture";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const MATS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];
const onMat = (matId: string, name: string) => ({ matId, location: name });
// The poster's Monday evening on two mats.
const MONDAY = [
  cls("Beginners Course Gi", "Mat 1", [[1, "18:40", "19:30"]], onMat("m1", "Mat 1")),
  cls("Free Mat Space", "Mat 2", [[1, "18:40", "19:00"]], onMat("m2", "Mat 2")),
  cls("No-Gi Fundamentals", "Mat 2", [[1, "19:00", "20:00"]], onMat("m2", "Mat 2")),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 2, 10, 0)); // Monday 2 November, before any class
  vi.unstubAllGlobals();
  stubFetch();
});
afterEach(() => vi.useRealTimers());

const phoneDay = () => screen.getByTestId("phone-day");
const grid = () => screen.getByTestId("phone-day-grid");
const cellOf = (name: string) => within(grid()).getByRole("button", { name: new RegExp(`^Edit ${name},`) }).closest("[data-cell-key]") as HTMLElement;

describe("the staff phone's day", () => {
  it("one card: the day's name, the Today pill and the count, then the grid", () => {
    render(<TimetableManager initialClasses={MONDAY} mats={MATS} {...PROPS} />);
    const card = phoneDay();
    expect(within(card).getByRole("heading", { name: "Monday" })).toBeTruthy();
    expect(within(card).getByText("Today")).toBeTruthy();
    expect(within(card).getByText("3 sessions")).toBeTruthy();
    expect(grid().getAttribute("aria-label")).toBe("Monday 2 November, 3 sessions");
  });

  it("by mat: mat names over the columns; a same-time pair shares a line; a 20-minute class ends before the next starts", () => {
    render(<TimetableManager initialClasses={MONDAY} mats={MATS} {...PROPS} />);
    expect(grid().dataset.mats).toBe("true");
    expect([...grid().querySelectorAll("[data-mat-head]")].map((h) => h.textContent?.trim())).toEqual(["Mat 1", "Mat 2"]);
    expect(cellOf("Beginners Course Gi").dataset.rowStart).toBe(cellOf("Free Mat Space").dataset.rowStart);
    expect(Number(cellOf("Free Mat Space").dataset.rowEnd)).toBeLessThanOrEqual(Number(cellOf("No-Gi Fundamentals").dataset.rowStart));
  });

  it("every chip shows its place, even under a mat name, and uses the phone size", () => {
    render(<TimetableManager initialClasses={MONDAY} mats={MATS} {...PROPS} />);
    for (const name of ["Beginners Course Gi", "Free Mat Space", "No-Gi Fundamentals"]) {
      const chip = within(cellOf(name)).getByRole("button");
      expect(chip.querySelector('[data-chip-part="place"]')).not.toBeNull();
      expect(chip.dataset.chipSize).toBe("phone");
    }
  });

  it("a day needing more than three lanes by mat is laid out by time and says so", () => {
    const busy = [
      ...MONDAY,
      cls("Kids Gi", "Mat 1", [[1, "18:40", "19:30"]], onMat("m1", "Mat 1")),
      cls("Strength", "Sports hall", [[1, "18:40", "19:30"]]),
    ];
    render(<TimetableManager initialClasses={busy} mats={MATS} {...PROPS} />);
    expect(screen.getByTestId("phone-day-fallback").textContent).toBe("Too much on at once to show by mat on this screen. Each class shows its mat.");
    expect(grid().dataset.mats).toBeUndefined();
  });

  it("a club with no mats: by time, same grid", () => {
    render(<TimetableManager initialClasses={[cls("Gi", null, [[1, "18:00", "19:00"]]), cls("No-Gi", null, [[1, "18:00", "19:00"]])]} {...PROPS} />);
    expect(grid().dataset.mats).toBeUndefined();
    const cells = [...grid().querySelectorAll<HTMLElement>("[data-cell-key]")];
    expect(cells.map((c) => c.dataset.lane)).toEqual(["0", "1"]);
    expect(new Set(cells.map((c) => c.dataset.rowStart)).size).toBe(1);
  });

  it("an empty day says so in the card", () => {
    render(<TimetableManager initialClasses={MONDAY} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("tab")[1]); // Tuesday
    expect(within(phoneDay()).getByText("No classes scheduled.")).toBeTruthy();
  });

  it("the day tabs: counts as before; selected and today are marked without the club colour", () => {
    render(<TimetableManager initialClasses={MONDAY} mats={MATS} {...PROPS} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].textContent).toContain("3");
    expect(tabs[1].textContent).toContain("—");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].className).toContain("border-bd-active");
    expect(tabs[0].dataset.today).toBe("true");
    expect(tabs[0].querySelector(".underline")).not.toBeNull();
    for (const tab of tabs) expect(tab.getAttribute("style") ?? "").not.toMatch(/color-primary|rgba/);
    fireEvent.click(tabs[2]);
    expect(tabs[2].className).toContain("border-bd-active");
    expect(tabs[0].className).not.toContain("border-bd-active");
  });

  it("'+N more' opens every class of the clash over the grid; each row opens its class; Escape and Show fewer give focus back", async () => {
    const five = ["A", "B", "C", "D", "E"].map((n) => cls(`Class ${n}`, null, [[1, "10:00", "10:45"]]));
    render(<TimetableManager initialClasses={five} {...PROPS} />);
    const more = within(grid()).getByTestId("week-more");
    expect(more.getAttribute("aria-label")).toBe("3 more sessions, 10:00 to 10:45. Show them.");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const panel = within(grid()).getByTestId("more-panel");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const rows = within(panel).getAllByTestId("more-row");
    expect(rows.map((r) => r.textContent)).toEqual(["10:00–10:45Class A", "10:00–10:45Class B", "10:00–10:45Class C", "10:00–10:45Class D", "10:00–10:45Class E"]);
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(within(grid()).queryByTestId("more-panel")).toBeNull());
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.click(within(within(grid()).getByTestId("more-panel")).getByRole("button", { name: "Show fewer" }));
    await waitFor(() => expect(within(grid()).queryByTestId("more-panel")).toBeNull());
    expect(document.activeElement).toBe(more);
    // A row behaves as its chip: it opens the class.
    fireEvent.click(more);
    fireEvent.click(within(within(grid()).getByTestId("more-panel")).getAllByTestId("more-row")[3]);
    expect((await screen.findByLabelText("Class Name") as HTMLInputElement).value).toBe("Class D");
  });

  it("the panel closes when another day is chosen", () => {
    const five = ["A", "B", "C", "D", "E"].map((n) => cls(`Class ${n}`, null, [[1, "10:00", "10:45"], [2, "10:00", "10:45"]]));
    render(<TimetableManager initialClasses={five} {...PROPS} />);
    fireEvent.click(within(grid()).getByTestId("week-more"));
    expect(within(grid()).getByTestId("more-panel")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(within(grid()).queryByTestId("more-panel")).toBeNull();
  });
});

describe("the split control on every view", () => {
  it("shows on the phone and in the Day view, worded for the whole club; saving says so", async () => {
    const calls = stubFetch((call) => (call.url === "/api/timetable/layout" ? { ok: true, status: 200, json: async () => ({ layout: "time" }) } : undefined));
    const toast = vi.fn();
    const ToastModule = await import("@/components/ui/Toast");
    vi.spyOn(ToastModule, "useToast").mockReturnValue({ toast } as never);
    render(<TimetableManager initialClasses={MONDAY} mats={MATS} {...PROPS} />);
    expect(screen.getByText("Split same-time classes (whole club)")).toBeTruthy();
    fireEvent.click(screen.getByTestId("timetable-view-day"));
    expect(screen.getByTestId("timetable-split")).toBeTruthy();
    fireEvent.click(screen.getByTestId("timetable-split-time"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/timetable/layout" && c.method === "PATCH")).toBe(true));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved for the whole club.", "success"));
  });
});
