// @vitest-environment jsdom
//
// The staff Day view by mat (plan §4.11): one column per mat on the clock
// scale, in the club's order, headed and pinned; several classes on one mat
// split that column; each block names its mat. By time it is unchanged.

import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import React from "react";
import { DayGrid, type DayGridItem } from "@/components/schedule/DayGrid";

const item = (key: string, name: string, start: string, end: string, column: string | null): DayGridItem => ({
  key, name, startTime: start, endTime: end, color: "#3b82f6", meta: null, column,
});
const COLUMNS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];
const props = { startHour: 17, endHour: 21, action: "Edit", onActivate: () => {} };
const columnOf = (el: HTMLElement) => el.closest("[data-day-grid-column]")?.getAttribute("data-day-grid-column");

describe("Day view by mat", () => {
  it("columns follow the club's order with their names, inside a labelled, focusable box", () => {
    render(<DayGrid {...props} columns={COLUMNS} items={[item("b", "No-Gi", "19:00", "20:00", "m2"), item("a", "Gi", "18:40", "19:30", "m1")]} />);
    const box = screen.getByRole("region", { name: "Day timetable" });
    expect(box.getAttribute("tabindex")).toBe("0");
    expect([...box.querySelectorAll("[data-mat-head]")].map((h) => h.textContent)).toEqual(["Mat 1", "Mat 2"]);
    expect(columnOf(screen.getByRole("button", { name: /^Edit Gi,/ }))).toBe("m1");
    expect(columnOf(screen.getByRole("button", { name: /^Edit No-Gi,/ }))).toBe("m2");
  });

  it("each block's name ends with its mat", () => {
    render(<DayGrid {...props} columns={COLUMNS} items={[item("a", "Gi", "18:40", "19:30", "m1")]} />);
    expect(screen.getByRole("button", { name: "Edit Gi, 18:40 to 19:30, Mat 1" })).toBeTruthy();
  });

  it("two classes on one mat at once split that mat's column, not the other", () => {
    render(
      <DayGrid
        {...props}
        columns={COLUMNS}
        items={[item("a", "Gi", "18:40", "19:30", "m1"), item("b", "Kids", "18:40", "19:30", "m1"), item("c", "No-Gi", "18:40", "19:30", "m2")]}
      />,
    );
    const width = (name: string) => (screen.getByRole("button", { name: new RegExp(`^Edit ${name},`) }) as HTMLElement).style.width;
    expect(width("Gi")).toMatch(/^calc\(50%/);
    expect(width("Kids")).toMatch(/^calc\(50%/);
    expect(width("No-Gi")).toMatch(/^calc\(100%/);
    const grid = screen.getByTestId("day-grid");
    // The split mat is two lanes wide, at least 120 px each.
    expect(grid.style.gridTemplateColumns).toBe("48px minmax(240px, 2fr) minmax(120px, 1fr)");
  });

  it("a class on a mat the club no longer lists is drawn in the last column", () => {
    render(<DayGrid {...props} columns={[...COLUMNS, { id: null, name: "No mat" }]} items={[item("a", "Gi", "18:40", "19:30", "gone")]} />);
    expect(columnOf(screen.getByRole("button", { name: /^Edit Gi,/ }))).toBe("none");
  });

  it("more than three on one mat fold into its column's group, which opens there", () => {
    const four = ["A", "B", "C", "D"].map((n) => item(n, `Class ${n}`, "18:00", "19:00", "m2"));
    render(<DayGrid {...props} columns={COLUMNS} items={[item("g", "Gi", "18:00", "19:00", "m1"), ...four]} />);
    const group = screen.getByTestId("day-grid-cluster");
    expect(columnOf(group)).toBe("m2");
    fireEvent.click(group);
    const open = screen.getByTestId("day-grid-cluster-open");
    expect(within(open).getAllByRole("button", { name: /^Edit Class/ })).toHaveLength(4);
    expect(document.activeElement).toBe(within(open).getAllByRole("button")[0]);
    expect(screen.getByRole("button", { name: /^Edit Gi,/ })).toBeTruthy();
  });

  it("openCluster opens the group in the right column", () => {
    const four = ["A", "B", "C", "D"].map((n) => item(n, `Class ${n}`, "18:00", "19:00", "m2"));
    render(<DayGrid {...props} columns={COLUMNS} items={four} openCluster="C" />);
    expect(columnOf(screen.getByTestId("day-grid-cluster-open"))).toBe("m2");
  });
});

describe("Day view by time", () => {
  it("without columns: no box, no mat names, the plain axis as before", () => {
    render(<DayGrid {...props} items={[item("a", "Gi", "18:40", "19:30", "m1"), item("b", "No-Gi", "18:40", "19:30", "m2")]} />);
    expect(screen.queryByRole("region", { name: "Day timetable" })).toBeNull();
    expect(document.querySelector("[data-mat-head]")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Gi, 18:40 to 19:30" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Edit No-Gi,/ }) as HTMLElement).style.width).toMatch(/^calc\(50%/);
  });
});
