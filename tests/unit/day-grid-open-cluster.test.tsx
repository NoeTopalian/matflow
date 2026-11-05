// @vitest-environment jsdom
//
// The Day view folds a clash wider than three lanes into one closed group.
// `openCluster` lets a caller open the group that holds a given session — the
// week's "+N more" lands here, so the classes it folded are on screen and not
// behind a second button (plan §4.11).

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { DayGrid, type DayGridItem } from "@/components/schedule/DayGrid";

afterEach(cleanup);

const item = (key: string, name: string, startTime: string, endTime: string): DayGridItem => ({ key, name, startTime, endTime, color: "var(--color-primary)" });
// Five at 10:00 (a folded group), then one class alone at 12:00.
const DAY: DayGridItem[] = [
  item("tots", "Tots", "10:00", "10:45"),
  item("champs", "Little Champs", "10:00", "10:45"),
  item("kids", "Kids BJJ", "10:00", "10:45"),
  item("teens", "Teens", "10:00", "10:45"),
  item("parents", "Parents Class", "10:00", "11:00"),
  item("open", "Open Mat", "12:00", "13:00"),
];
const grid = (openCluster?: string | null) => <DayGrid items={DAY} startHour={9} endHour={14} action="Edit" onActivate={() => {}} openCluster={openCluster} />;

describe("DayGrid openCluster", () => {
  it("leaves the group folded when nothing asks for it", () => {
    render(grid());
    expect(screen.getByTestId("day-grid-cluster").textContent).toContain("5 classes at once");
    expect(screen.queryByTestId("day-grid-cluster-open")).toBeNull();
  });

  it("opens the group that holds the session and puts focus on its first class", () => {
    render(grid("kids"));
    const open = screen.getByTestId("day-grid-cluster-open");
    const names = Array.from(open.querySelectorAll("[data-day-grid-block]")).map((b) => b.getAttribute("aria-label"));
    expect(names).toHaveLength(5);
    expect(names.join(" | ")).toContain("Edit Kids BJJ, 10:00 to 10:45");
    expect(document.activeElement).toBe(open.querySelector("[data-day-grid-block]"));
    expect(screen.queryByTestId("day-grid-cluster")).toBeNull();
  });

  it("does nothing for a session that is not in a folded group, or not on this day", () => {
    const view = render(grid("open"));
    expect(screen.getByTestId("day-grid-cluster")).toBeTruthy();
    view.rerender(grid("not-here"));
    expect(screen.getByTestId("day-grid-cluster")).toBeTruthy();
    expect(screen.queryByTestId("day-grid-cluster-open")).toBeNull();
  });

  it("opens when the request arrives later, and stays shut after the reader collapses it", () => {
    const view = render(grid(null));
    view.rerender(grid("tots"));
    expect(screen.getByTestId("day-grid-cluster-open")).toBeTruthy();
    screen.getByRole("button", { name: "Collapse" }).click();
    view.rerender(grid("tots"));
    expect(screen.queryByTestId("day-grid-cluster-open")).toBeNull();
  });
});
