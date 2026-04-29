import { describe, it, expect } from "vitest";
import { filterTodoItems } from "@/lib/dashboard-todo";

describe("filterTodoItems", () => {
  it("returns empty array when all counts are zero", () => {
    const items = [
      { label: "Missing waivers", count: 0 },
      { label: "Overdue payments", count: 0 },
      { label: "Missing phone numbers", count: 0 },
      { label: "Members not seen in 14 days", count: 0 },
    ];
    expect(filterTodoItems(items)).toEqual([]);
  });

  it("returns only items with count > 0 in original order", () => {
    const items = [
      { label: "Missing waivers", count: 0 },
      { label: "Overdue payments", count: 3 },
      { label: "Missing phone numbers", count: 0 },
      { label: "Members not seen in 14 days", count: 7 },
    ];
    const result = filterTodoItems(items);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("Overdue payments");
    expect(result[1].label).toBe("Members not seen in 14 days");
  });

  it("returns all items unchanged when all counts are positive", () => {
    const items = [
      { label: "Missing waivers", count: 1 },
      { label: "Overdue payments", count: 2 },
      { label: "Missing phone numbers", count: 3 },
      { label: "Members not seen in 14 days", count: 4 },
    ];
    expect(filterTodoItems(items)).toEqual(items);
  });
});
