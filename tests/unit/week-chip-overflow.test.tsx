// @vitest-environment jsdom
// 14 Nov 2026: a class's category pill ("Fundamentals") widened its week chip past its mat column at full-screen
// width. jsdom cannot measure layout, so the geometry is proved by the browser journey timetable-category-pill; this
// pins the two classes it rests on, so neither can be dropped quietly.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WeekChip } from "@/components/schedule/WeekChip";

describe("week chip: a long category never widens the chip", () => {
  it("the chip may shrink to its lane (min-w-0) and the pill truncates with the whole name as its title", () => {
    render(
      <WeekChip
        name="Beginners Course Gi" dayName="Monday" startTime="17:50" endTime="18:40" color="#3b82f6"
        place="Mat 1" showPlace={false} category="Fundamentals and Drilling Class" canManage onEdit={() => {}}
      />,
    );
    const chip = screen.getByRole("button", { name: /Beginners Course Gi, Monday 17:50 to 18:40/ });
    expect(chip.className.split(/\s+/)).toContain("min-w-0");
    const pill = screen.getByTestId("class-chip-category");
    expect(pill.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "max-w-full"]));
    expect(pill.getAttribute("title")).toBe("Fundamentals and Drilling Class");
  });
});
